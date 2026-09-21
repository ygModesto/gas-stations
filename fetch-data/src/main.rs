// Descarga los precios de MITECO y genera los ficheros que consume index.html:
//   public/gasolineras.fgb       completo (con rotulo, direccion, horario...)
//   public/gasolineras-lite.fgb  ligero, solo geometria + marca + precios
//   public/meta.json             fecha de MITECO y numero de estaciones
//
// Uso: fetch-data [fichero.json]   (sin argumento descarga el JSON de MITECO)

use std::error::Error;
use std::fs::{self, File};
use std::io::{BufReader, BufWriter};
use std::sync::Arc;

use flatgeobuf::{ColumnType, FgbCrs, FgbWriter, FgbWriterOptions, GeometryType};
use geozero::error::Result as GeoResult;
use geozero::{ColumnValue, GeomProcessor, GeozeroGeometry, PropertyProcessor};
use serde_json::{Value, json};

const URL: &str = "https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/PreciosCarburantes/EstacionesTerrestres/";
const OUT_DIR: &str = "public";

// Marcas reconocidas sobre el rotulo, por numero de estaciones. Estas 14 cubren el 63,4%
// del parque; el resto queda a None. El orden importa: gana la primera que casa.
const BRANDS: [&str; 14] = [
    "REPSOL",
    "BP",
    "MOEVE",
    "CEPSA",
    "GALP",
    "BALLENOIL",
    "SHELL",
    "PLENERGY",
    "PETROPRIX",
    "PETRONOR",
    "CARREFOUR",
    "DISA",
    "AVIA",
    "Q8",
];

// El rotulo de MITECO no esta normalizado (3.486 valores distintos para 11.384
// gasolineras): la misma marca aparece como BP, BP OIL ESPANA o BP <localidad>, y hasta
// entrecomillada. Por eso no se compara la cadena entera: se trocea en palabras y se
// busca la marca entre ellas. Solo asi BP pasa de 150 a 672 estaciones.
// Devolver None y no "Otras" es intencionado: en FlatGeobuf un nulo no ocupa bytes, y
// como el 36,6% de las estaciones no casa con ninguna marca eso recorta un 35% el coste
// de la columna. El cliente lo lee como "Otras".
fn brand_of(rotulo: &str) -> Option<&'static str> {
    let upper = rotulo.to_uppercase();
    let words: Vec<&str> = upper.split(|c: char| !c.is_ascii_alphanumeric()).collect();
    BRANDS.into_iter().find(|b| words.contains(b))
}

struct Station {
    lng: f64,
    lat: f64,
    id: Option<String>,
    rotulo: String,
    brand: Option<&'static str>,
    direccion: String,
    municipio: String,
    provincia: String,
    horario: String,
    ga: Option<f64>,
    g95: Option<f64>,
    g98: Option<f64>,
    gapp: Option<f64>,
}

// Numero con coma decimal. Un campo vacio o ausente es None (sin precio); uno con texto que no
// es un numero es Err y descarta la estacion entera, igual que hacia el ValueError del script.
fn parse_num(s: &str) -> Result<f64, std::num::ParseFloatError> {
    s.trim().replace(',', ".").parse()
}

fn price(e: &Value, key: &str) -> Result<Option<f64>, Box<dyn Error>> {
    match e.get(key).and_then(Value::as_str) {
        None | Some("") => Ok(None),
        Some(s) => Ok(Some(parse_num(s)?)),
    }
}

fn text(e: &Value, key: &str) -> String {
    e.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}

fn parse_station(e: &Value) -> Result<Station, Box<dyn Error>> {
    let coord = |key: &str| -> Result<f64, Box<dyn Error>> {
        let s = e
            .get(key)
            .and_then(Value::as_str)
            .ok_or("falta coordenada")?;
        Ok(parse_num(s)?)
    };
    let rotulo = text(e, "Rótulo");
    Ok(Station {
        lat: coord("Latitud")?,
        lng: coord("Longitud (WGS84)")?,
        id: e.get("IDEESS").and_then(Value::as_str).map(str::to_string),
        rotulo: rotulo.trim().to_string(),
        brand: brand_of(&rotulo),
        direccion: text(e, "Dirección").trim().to_string(),
        municipio: text(e, "Municipio").trim().to_string(),
        provincia: text(e, "Provincia").trim().to_string(),
        horario: text(e, "Horario"),
        ga: price(e, "Precio Gasoleo A")?,
        g95: price(e, "Precio Gasolina 95 E5")?,
        g98: price(e, "Precio Gasolina 98 E5")?,
        gapp: price(e, "Precio Gasoleo Premium")?,
    })
}

// Un punto, con X/longitud primero e Y/latitud despues
struct Point(f64, f64);

impl GeozeroGeometry for Point {
    fn process_geom<P: GeomProcessor>(&self, p: &mut P) -> GeoResult<()> {
        p.point_begin(0)?;
        p.xy(self.0, self.1, 0)?;
        p.point_end(0)
    }
}

// Las propiedades se escriben por indice de columna; una columna que no se escribe queda nula.
// Por eso los Option a None simplemente se saltan.
enum Prop<'a> {
    Str(&'a str),
    Num(f64),
}

fn write_fgb<'a>(
    path: &str,
    columns: &[(&str, ColumnType)],
    stations: &'a [Station],
    props: impl Fn(&'a Station) -> Vec<(&'static str, Prop<'a>)>,
) -> Result<(), Box<dyn Error>> {
    let mut fgb = FgbWriter::create_with_options(
        "gasolineras",
        GeometryType::Point,
        // CRS WGS84 (EPSG:4326)
        FgbWriterOptions {
            crs: FgbCrs {
                org: Some("EPSG"),
                code: 4326,
                ..Default::default()
            },
            ..Default::default()
        },
    )?;
    for (name, ty) in columns {
        fgb.add_column(name, *ty, |_, _| {});
    }
    for s in stations {
        let values = props(s);
        fgb.add_feature_geom(Point(s.lng, s.lat), |feat| {
            for (name, value) in &values {
                let Some(i) = columns.iter().position(|(c, _)| c == name) else {
                    continue;
                };
                let value = match value {
                    Prop::Str(v) => ColumnValue::String(v),
                    Prop::Num(v) => ColumnValue::Double(*v),
                };
                feat.property(i, name, &value).unwrap();
            }
        })?;
    }
    // Escribe un fichero binario indexado espacialmente (Hilbert + R-tree)
    fgb.write(BufWriter::new(File::create(path)?))?;
    Ok(())
}

// Valor de cada propiedad, o nada si es nulo
fn opt_str<'a>(name: &'static str, v: Option<&'a str>) -> Option<(&'static str, Prop<'a>)> {
    v.map(|v| (name, Prop::Str(v)))
}

fn opt_num(name: &'static str, v: Option<f64>) -> Option<(&'static str, Prop<'static>)> {
    v.map(|v| (name, Prop::Num(v)))
}

fn main() -> Result<(), Box<dyn Error>> {
    // 1. JSON original de MITECO (o un fichero local, util para probar sin red)
    let data: Value = match std::env::args().nth(1) {
        Some(path) => serde_json::from_reader(File::open(path)?)?,
        None => {
            // El servidor de MITECO solo admite TLS 1.2 con intercambio de claves RSA (sin
            // ECDHE), que rustls no implementa; de ahi el TLS del sistema (Schannel/OpenSSL)
            let agent = ureq::AgentBuilder::new()
                .tls_connector(Arc::new(native_tls::TlsConnector::new()?))
                .build();
            let resp = agent.get(URL).set("Accept", "application/json").call()?;
            serde_json::from_reader(BufReader::new(resp.into_reader()))?
        }
    };

    // 2. Procesamiento: las estaciones con datos que no se pueden interpretar se descartan
    let stations: Vec<Station> = data
        .get("ListaEESSPrecio")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(|e| parse_station(e).ok()).collect())
        .unwrap_or_default();

    if stations.is_empty() {
        return Ok(());
    }
    fs::create_dir_all(OUT_DIR)?;

    const STR: ColumnType = ColumnType::String;
    const DOUBLE: ColumnType = ColumnType::Double;
    write_fgb(
        &format!("{OUT_DIR}/gasolineras.fgb"),
        &[
            ("id", STR),
            ("rotulo", STR),
            ("brand", STR),
            ("direccion", STR),
            ("municipio", STR),
            ("provincia", STR),
            ("horario", STR),
            ("ga", DOUBLE),
            ("g95", DOUBLE),
            ("g98", DOUBLE),
            ("gapp", DOUBLE),
        ],
        &stations,
        |s| {
            [
                opt_str("id", s.id.as_deref()),
                opt_str("rotulo", Some(&s.rotulo)),
                opt_str("brand", s.brand),
                opt_str("direccion", Some(&s.direccion)),
                opt_str("municipio", Some(&s.municipio)),
                opt_str("provincia", Some(&s.provincia)),
                opt_str("horario", Some(&s.horario)),
                opt_num("ga", s.ga),
                opt_num("g95", s.g95),
                opt_num("g98", s.g98),
                opt_num("gapp", s.gapp),
            ]
            .into_iter()
            .flatten()
            .collect()
        },
    )?;

    // Version ligera para el zoom alejado (solo puntos de color): geometria, los 4 precios
    // y la marca, sin los campos de texto pesados (rotulo, direccion, horario...). Evita
    // bajar todo el pais completo cuando en pantalla solo se ven puntos; la web elige un
    // fichero u otro segun el zoom.
    //
    // "brand" entra aqui a proposito aunque sea texto: cuesta ~84 KB (+5,1%) y a cambio el
    // filtro de marcas funciona en zoom alejado sin bajar el completo, que son 2,90 MB
    // frente a 1,73 MB. Un id numerico con la tabla en meta.json solo ahorraria ~15 KB mas
    // y obligaria a mantener los dos ficheros sincronizados.
    write_fgb(
        &format!("{OUT_DIR}/gasolineras-lite.fgb"),
        &[
            ("brand", STR),
            ("g95", DOUBLE),
            ("g98", DOUBLE),
            ("ga", DOUBLE),
            ("gapp", DOUBLE),
        ],
        &stations,
        |s| {
            [
                opt_str("brand", s.brand),
                opt_num("g95", s.g95),
                opt_num("g98", s.g98),
                opt_num("ga", s.ga),
                opt_num("gapp", s.gapp),
            ]
            .into_iter()
            .flatten()
            .collect()
        },
    )?;

    // Metadatos adicionales (como la fecha de actualizacion) en un json ligero
    let meta = json!({ "fecha": data.get("Fecha"), "total": stations.len() });
    fs::write(
        format!("{OUT_DIR}/meta.json"),
        serde_json::to_string(&meta)?,
    )?;
    Ok(())
}
