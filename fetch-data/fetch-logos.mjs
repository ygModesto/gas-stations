// Descarga el icono (símbolo, fondo transparente) de cada marca en marcas.yaml usando la Logo
// Link API de Brandfetch, y lo guarda en public/logos/<marca-en-minusculas>.webp.
//
// El client ID es gratuito (brandfetch.com/developers) pero personal: no va hardcodeado aquí a
// propósito, se pasa por variable de entorno para no dejarlo escrito en el repo.
//
// Uso:
//   BRANDFETCH_CLIENT_ID=xxxxx node fetch-data/fetch-logos.mjs
//
// La API bloquea peticiones que no parezcan de navegador (protección "automated_traffic"): de ahí
// las cabeceras de abajo, calcadas de una petición real de Chrome.
import fs from 'node:fs/promises';
import path from 'node:path';

const CLIENT_ID = process.env.BRANDFETCH_CLIENT_ID;
if (!CLIENT_ID) {
  console.error('Falta BRANDFETCH_CLIENT_ID. Uso: BRANDFETCH_CLIENT_ID=xxxxx node fetch-data/fetch-logos.mjs');
  process.exit(1);
}

const HERE = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const YAML_PATH = path.join(HERE, 'marcas.yaml');
const OUT_DIR = path.join(HERE, '..', 'public', 'logos');

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
  'Referer': 'https://yago-modesto.github.io/'
};

// Parseo minimo del YAML: solo necesitamos los tres campos de cada entrada, con formato fijo
// (ver marcas.yaml). Evita añadir una dependencia de npm para un fichero tan simple.
function parseMarcas(yaml) {
  const re = /- marca: (.+)\n\s+gasolineras: (\d+)\n\s+web: (.+)\n/g;
  const out = [];
  let m;
  while ((m = re.exec(yaml + '\n'))) {
    let marca = m[1].trim();
    if (/^["']/.test(marca)) marca = JSON.parse(marca.replace(/^'/, '"').replace(/'$/, '"'));
    out.push({ marca, web: m[3].trim() });
  }
  return out;
}

// "https://familyenergy.es/" / "agla.es/" / "q8.dk # alternativa: ..." -> dominio limpio, o null
function normalizeDomain(web) {
  let s = web.split('#')[0].trim(); // quita comentarios inline
  if (s === 'null' || s === '') return null;
  s = s.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return s || null;
}

function slug(marca) {
  return marca.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // quita acentos
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Cuando Brandfetch no tiene el activo pedido para una marca, NO da 404: responde 200 con una
// imagen "no encontrado" genérica (o casi en blanco) y, siempre, con este Last-Modified centinela
// exacto -- comprobado contra ~10 marcas conocidas, tanto encontradas como no. Es la única señal
// fiable que hemos visto (el content-length de la genérica coincide entre marcas distintas, pero
// nada lo garantiza para siempre; el Last-Modified sí es coherente en todas las pruebas).
const FALLBACK_LAST_MODIFIED = 'Mon, 01 Jan 2024 00:00:00 GMT';

// 'symbol' es el icono suelto con fondo transparente -- el que de verdad encaja en el hueco
// circular del bocadillo -- pero muchas marcas solo tienen 'icon' (a veces el logotipo con texto,
// sobre fondo blanco, sin transparencia). Se prueba primero el bueno y solo si falla el peor,
// dejando constancia de cuál tocó en el nombre de fichero para poder revisarlos luego a mano.
const VARIANTS = ['symbol', 'icon'];

async function fetchLogo(domain) {
  for (const variant of VARIANTS) {
    const url = `https://cdn.brandfetch.io/${domain}/${variant}/w/128/h/128?c=${CLIENT_ID}`;
    const res = await fetch(url, { headers: BROWSER_HEADERS, redirect: 'manual' });
    if (res.status !== 200) continue;
    if (res.headers.get('last-modified') === FALLBACK_LAST_MODIFIED) continue; // sin activo real
    const type = res.headers.get('content-type') || '';
    const ext = type.includes('svg') ? 'svg' : type.includes('png') ? 'png' : 'webp';
    const buf = Buffer.from(await res.arrayBuffer());
    return { buf, ext, variant };
  }
  throw new Error('sin logo en Brandfetch (ni symbol ni icon)');
}

async function main() {
  const yaml = await fs.readFile(YAML_PATH, 'utf8');
  const marcas = parseMarcas(yaml);
  await fs.mkdir(OUT_DIR, { recursive: true });

  const manifest = {};
  const ok = [];
  const fail = [];
  for (const { marca, web } of marcas) {
    const domain = normalizeDomain(web);
    if (!domain) { continue; } // sin web conocida, se salta sin más
    try {
      const { buf, ext, variant } = await fetchLogo(domain);
      const file = `${slug(marca)}.${ext}`;
      await fs.writeFile(path.join(OUT_DIR, file), buf);
      manifest[marca] = file;
      ok.push([marca, domain, file, buf.length, variant]);
      const tag = variant === 'icon' ? ' [icon: revisar, puede llevar texto/fondo]' : '';
      console.log(`OK   ${marca.padEnd(20)} ${domain.padEnd(24)} -> ${file} (${buf.length} B, ${variant})${tag}`);
    } catch (err) {
      fail.push([marca, domain, err.message]);
      console.log(`FAIL ${marca.padEnd(20)} ${domain.padEnd(24)} -> ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 150)); // no ametrallar la API
  }

  // manifest.json: qué marca (tal cual sale en marcas.yaml) tiene logo y en qué fichero. index.html
  // lo cruza contra BRANDS (fetch-data/src/main.rs) para saber qué imágenes precargar; las marcas
  // de aquí que no están en BRANDS (ASC CARBURANTES, CONFORT AUTO...) se ignoran en el cliente.
  await fs.writeFile(
    path.join(OUT_DIR, 'manifest.json'),
    JSON.stringify(manifest, null, 2)
  );

  console.log(`\n${ok.length} logos descargados, ${fail.length} fallidos.`);
  if (fail.length) {
    console.log('Fallidos:', fail.map(([m]) => m).join(', '));
  }
}

main();
