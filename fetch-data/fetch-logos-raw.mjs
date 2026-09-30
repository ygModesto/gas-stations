// Descarga el registro de marca COMPLETO de la Brand API de Brandfetch (no la Logo Link API que
// usa fetch-logos.mjs) para cada marca de marcas.yaml, y guarda TODO en crudo -- el JSON entero y
// cada variante de logo en su formato original (normalmente incluye SVG, a diferencia de Logo Link
// que solo da WebP) -- para poder retocar a partir del original en vez de partir del WebP ya
// reescalado a 128x128.
//
// La Brand API es un producto DISTINTO del Logo Link (otra clave, otra cuota): el plan gratuito
// son 100 peticiones DE POR VIDA, no al mes -- de ahí que este script solo llame una vez por marca
// y no reintente variantes como fetch-logos.mjs.
//
// Uso:
//   BRANDFETCH_API_KEY=xxxxx node fetch-data/fetch-logos-raw.mjs
import fs from 'node:fs/promises';
import path from 'node:path';

const API_KEY = process.env.BRANDFETCH_API_KEY;
if (!API_KEY) {
  console.error('Falta BRANDFETCH_API_KEY. Uso: BRANDFETCH_API_KEY=xxxxx node fetch-data/fetch-logos-raw.mjs');
  process.exit(1);
}

const HERE = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const YAML_PATH = path.join(HERE, 'marcas.yaml');
const OUT_DIR = path.join(HERE, 'logos-raw');

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

function normalizeDomain(web) {
  let s = web.split('#')[0].trim();
  if (s === 'null' || s === '') return null;
  s = s.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return s || null;
}

function slug(marca) {
  return marca.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function main() {
  const yaml = await fs.readFile(YAML_PATH, 'utf8');
  const marcas = parseMarcas(yaml);
  await fs.mkdir(OUT_DIR, { recursive: true });

  let quotaLeft = null;
  const ok = [];
  const fail = [];

  for (let i = 0; i < marcas.length; i++) {
    const { marca, web } = marcas[i];
    const domain = normalizeDomain(web);
    if (!domain) continue;

    // Parón de seguridad: la cuota es de 100 peticiones DE POR VIDA, no se recarga. Mejor frenar
    // limpiamente y avisar que quedan marcas sin bajar que gastarla sin darse cuenta.
    if (quotaLeft !== null && quotaLeft < 3) {
      console.log(`\nQuedan ${quotaLeft} peticiones -- freno aquí por seguridad. Faltan: ` +
        marcas.slice(i).map((m) => m.marca).join(', '));
      break;
    }

    try {
      const res = await fetch(`https://api.brandfetch.io/v2/brands/${domain}`, {
        headers: { Authorization: `Bearer ${API_KEY}` }
      });
      quotaLeft = Number(res.headers.get('x-api-key-quota') ?? quotaLeft);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      const dir = path.join(OUT_DIR, slug(marca));
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'brand.json'), JSON.stringify(data, null, 2));

      const files = [];
      for (const logo of data.logos ?? []) {
        for (const fmt of logo.formats ?? []) {
          const fileName = `${logo.type}-${logo.theme}.${fmt.format}`;
          try {
            const imgRes = await fetch(fmt.src);
            if (!imgRes.ok) continue;
            const buf = Buffer.from(await imgRes.arrayBuffer());
            await fs.writeFile(path.join(dir, fileName), buf);
            files.push(fileName);
          } catch { /* esta variante en concreto falla, se sigue con las demás */ }
        }
      }
      ok.push([marca, domain, files]);
      console.log(`OK   ${marca.padEnd(20)} ${domain.padEnd(24)} -> ${files.join(', ') || '(sin variantes descargables)'} [cuota: ${quotaLeft}]`);
    } catch (err) {
      fail.push([marca, domain, err.message]);
      console.log(`FAIL ${marca.padEnd(20)} ${domain.padEnd(24)} -> ${err.message} [cuota: ${quotaLeft}]`);
    }
  }

  console.log(`\n${ok.length} marcas descargadas, ${fail.length} fallidas. Cuota restante: ${quotaLeft}.`);
  if (fail.length) console.log('Fallidas:', fail.map(([m]) => m).join(', '));
  console.log(`\nCarpeta: ${OUT_DIR}`);
}

main();
