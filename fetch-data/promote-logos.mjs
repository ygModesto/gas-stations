// Elige el mejor asset de cada marca en logos-raw/ (descargado por fetch-logos-raw.mjs desde la
// Brand API) y lo copia a public/logos/, que es la carpeta que realmente usa index.html en
// tiempo de ejecucion (via manifest.json). No vuelve a llamar a Brandfetch -- solo reorganiza
// ficheros ya descargados.
//
// Criterio de seleccion por marca: puntuacion = cuadratura + formato + type, porque el campo
// "type" de Brandfetch no es fiable por si solo -- varias marcas (Shell, Eroski, Naturgy...)
// tienen su icono compacto clasificado como "logo" en vez de "symbol"/"icon", con un wordmark
// ancho en otro sitio. Lo que de verdad importa para el hueco circular del pin (LOGO_HOLE_* en
// index.html) es que la imagen sea razonablemente cuadrada, y en igualdad de cuadratura, SVG >
// PNG > JPEG > WebP. El type solo desempata suavemente cuando la cuadratura y el formato ya son
// parecidos.
const FORMAT_SCORE = { svg: 3, png: 2, jpeg: 1, webp: 0 };
const TYPE_SCORE = { symbol: 2, icon: 1, logo: 0 };
// Por debajo de esto el recorte circular del pin (LOGO_HOLE_*) muestra un trozo de texto en vez
// de una marca reconocible -- p.ej. BALLENOIL/VALCARCE/BEROIL/IBERDOEX solo tienen en Brandfetch
// un wordmark ancho (sin symbol/icon compacto), y recortarlo deja un fragmento como "ALLI" en vez
// del logo. Mejor no mostrar nada (cae en el circulo neutro de makeBadgeImage) que mostrar eso.
const MIN_SQUARENESS = 0.4;

function scoreFormat(type, theme, fmt) {
  const squareness = Math.min(fmt.width, fmt.height) / Math.max(fmt.width, fmt.height);
  // Desempate fino: en Brandfetch "theme" no es el fondo donde se vería bien el logo, es el color
  // del propio logo -- "dark" tira a colores vivos/oscuros (van bien sobre nuestro hueco blanco),
  // "light" tira a blanco puro (pensado para fondo oscuro, invisible sobre blanco). Confirmado con
  // ENI: sus variantes dark/light empataban en tamaño y formato, y ganaba "light" -- blanco sobre
  // blanco, logo invisible. El peso es pequeño a propósito: solo decide empates reales.
  return squareness * 10 + (FORMAT_SCORE[fmt.format] ?? 0) * 2 + (TYPE_SCORE[type] ?? 0) +
    (theme === 'dark' ? 0.01 : 0);
}
//
// Marcas de marcas.yaml que NO se promocionan aqui:
//   - las que no estan en la lista BRANDS de fetch-data/src/main.rs (no se colorean/agrupan en el
//     mapa hoy, asi que su logo nunca se usaria): ASC CARBURANTES, CONFORT AUTO, FAMILY ENERGY,
//     PETROMIRALLES. CONFORT AUTO ademas tiene un asset erroneo confirmado (foto de una mascota,
//     no un logo) -- motivo de mas para no promocionarla si algun dia se anade a BRANDS.
//   - PETROCAT DIRECTE: mismo dominio y misma empresa que PETROCAT (ver marcas.yaml), brand_of()
//     en main.rs ya la reconoce como "PETROCAT" por coincidencia de palabra -- un solo asset basta.
//   - marcas con web: null en marcas.yaml (CAMPSA, GM OIL, FARRUCO S.A., (SIN RÓTULO),
//     CAMPSA EXPRESS, LIBRE): nunca se intento descargar nada para ellas.
import fs from 'node:fs/promises';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const RAW_DIR = path.join(HERE, 'logos-raw');
const OUT_DIR = path.join(HERE, '..', 'public', 'logos');
const YAML_PATH = path.join(HERE, 'marcas.yaml');

// marca (tal cual en marcas.yaml) -> nombre canonico de BRANDS en main.rs/index.html.
// null = no promocionar (no esta en BRANDS, o es un duplicado de otra fila).
const CANONICAL = {
  'ASC CARBURANTES': null,
  'CONFORT AUTO': null,
  'FAMILY ENERGY': null,
  'PETROMIRALLES': null,
  'PETROCAT DIRECTE': null, // duplicado de PETROCAT, mismo dominio
  'FARRUCO S.A.': 'FARRUCO',
};

// Marcas cuyo logo NO sale de logos-raw/ -- un fichero puesto a mano en public/logos/ que este
// script debe respetar y no pisar en la proxima pasada. MOEVE: Brandfetch solo tiene un wordmark
// ancho o un icono JPEG de baja calidad (ver logos-raw/moeve/); el usuario trajo el logo oficial
// completo (moeveglobal.com) y de ahi se recorto a mano solo la "m" (ver
// logos-raw/moeve/m-icon.svg) -- vectorial y ya cuadrada, mejor que cualquier opcion automatica.
const MANUAL_LOGOS = {
  MOEVE: 'moeve.svg',
};

function slug(name) {
  return name.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function parseMarcas(yaml) {
  const re = /- marca: (.+)\n\s+gasolineras: (\d+)\n\s+web: (.+)\n/g;
  const out = [];
  let m;
  while ((m = re.exec(yaml + '\n'))) {
    let marca = m[1].trim();
    if (/^["']/.test(marca)) marca = JSON.parse(marca.replace(/^'/, '"').replace(/'$/, '"'));
    out.push(marca);
  }
  return out;
}

function pickBest(brandJson) {
  const logos = brandJson.logos ?? [];
  let best = null;
  for (const logo of logos) {
    for (const fmt of logo.formats ?? []) {
      const score = scoreFormat(logo.type, logo.theme, fmt);
      if (!best || score > best.score) {
        best = { score, type: logo.type, theme: logo.theme, format: fmt.format, width: fmt.width, height: fmt.height };
      }
    }
  }
  return best;
}

async function main() {
  const yaml = await fs.readFile(YAML_PATH, 'utf8');
  const marcas = parseMarcas(yaml);
  await fs.mkdir(OUT_DIR, { recursive: true });

  const manifest = {};
  const skipped = [];
  const missing = [];

  for (const marca of marcas) {
    const canonical = Object.prototype.hasOwnProperty.call(CANONICAL, marca) ? CANONICAL[marca] : marca;
    if (canonical === null) { skipped.push(marca); continue; }

    if (MANUAL_LOGOS[canonical]) {
      manifest[canonical] = MANUAL_LOGOS[canonical];
      console.log(`OK   ${marca.padEnd(20)} -> ${canonical.padEnd(14)} ${MANUAL_LOGOS[canonical].padEnd(20)} (manual, no tocar)`);
      continue;
    }

    const rawDir = path.join(RAW_DIR, slug(marca));
    let brandJson;
    try {
      brandJson = JSON.parse(await fs.readFile(path.join(rawDir, 'brand.json'), 'utf8'));
    } catch {
      missing.push(marca);
      continue;
    }

    const best = pickBest(brandJson);
    const squareness = best ? Math.min(best.width, best.height) / Math.max(best.width, best.height) : 0;
    if (!best || squareness < MIN_SQUARENESS) {
      missing.push(`${marca} (${best ? `solo wordmark ${best.width}x${best.height}` : 'sin logos'})`);
      continue;
    }

    const srcFile = path.join(rawDir, `${best.type}-${best.theme}.${best.format}`);
    const destName = `${slug(canonical)}.${best.format}`;
    await fs.copyFile(srcFile, path.join(OUT_DIR, destName));

    if (manifest[canonical] && manifest[canonical] !== destName) {
      console.log(`AVISO ${canonical}: ya tenia ${manifest[canonical]}, sobrescrito con ${destName} (de "${marca}")`);
    }
    manifest[canonical] = destName;
    console.log(`OK   ${marca.padEnd(20)} -> ${canonical.padEnd(14)} ${destName.padEnd(20)} (${best.type}/${best.format} ${best.width}x${best.height})`);
  }

  // Elimina del directorio los ficheros de imagen que ya no aparecen en el manifest nuevo
  // (p.ej. los .webp viejos de Logo Link que ahora quedan sustituidos por un .svg/.png mejor).
  // _fuel-generic.svg no es de ninguna marca (ver GENERIC_FUEL_ICON_SRC en index.html), así que
  // nunca sale en el manifest -- sin esta excepción, esta limpieza lo borraría cada vez.
  const keepFiles = new Set(Object.values(manifest));
  const existing = await fs.readdir(OUT_DIR);
  for (const f of existing) {
    if (f === 'manifest.json' || f === '_fuel-generic.svg') continue;
    if (!keepFiles.has(f)) {
      await fs.unlink(path.join(OUT_DIR, f));
      console.log(`BORRADO ${f} (ya no esta en el manifest)`);
    }
  }

  await fs.writeFile(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  console.log(`\n${Object.keys(manifest).length} marcas en manifest.json.`);
  if (skipped.length) console.log('Omitidas (no estan en BRANDS o son duplicado):', skipped.join(', '));
  if (missing.length) console.log('Sin asset en logos-raw:', missing.join(', '));
}

main();
