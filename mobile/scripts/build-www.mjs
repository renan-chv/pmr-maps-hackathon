// Builds mobile/www, the web bundle shipped inside the iOS and Android apps, from ../static.
// Third-party files (MapLibre, the Atkinson Hyperlegible font) are vendored so the app shell opens offline.
// Map tiles and live data still come from the network; API calls go to the hosted backend (see static/native.js).
import { cp, mkdir, readFile, rm, writeFile, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STATIC = join(ROOT, "..", "static");
const WWW = join(ROOT, "www");
const VENDOR = join(ROOT, "vendor"); // download cache, committed so a build works without network
const MAPLIBRE = "https://unpkg.com/maplibre-gl@4.7.1/dist";
const FONTS = "https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible+Next:wght@400;500;700;800&display=swap";
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

const exists = (p) => access(p).then(() => true, () => false);
async function fetchTo(url, file, opts = {}) {
  if (await exists(file)) return readFile(file);
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  await mkdir(dirname(file), { recursive: true }); await writeFile(file, buf);
  return buf;
}

await mkdir(VENDOR, { recursive: true });
await fetchTo(`${MAPLIBRE}/maplibre-gl.js`, join(VENDOR, "maplibre-gl.js"));
await fetchTo(`${MAPLIBRE}/maplibre-gl.css`, join(VENDOR, "maplibre-gl.css"));
let css = (await fetchTo(FONTS, join(VENDOR, "fonts-src.css"))).toString();
const urls = [...new Set(css.match(/https:\/\/fonts\.gstatic\.com\/[^)]+/g) || [])];
for (const [i, u] of urls.entries()) {
  const name = `atkinson-${i}.woff2`;
  await fetchTo(u, join(VENDOR, "fonts", name));
  css = css.split(u).join(`fonts/${name}`);
}
await writeFile(join(VENDOR, "fonts.css"), css);

await rm(WWW, { recursive: true, force: true });
await mkdir(join(WWW, "static"), { recursive: true });
await cp(STATIC, join(WWW, "static"), { recursive: true, filter: (src) => !src.endsWith("sw.js") });
await cp(VENDOR, join(WWW, "static", "vendor"), { recursive: true, filter: (src) => !src.endsWith("fonts-src.css") });

let html = await readFile(join(STATIC, "index.html"), "utf8");
const swap = (from, to) => { if (!html.includes(from)) throw new Error(`index.html changed, missing: ${from}`); html = html.split(from).join(to); };
swap(`${MAPLIBRE}/maplibre-gl.js`, "/static/vendor/maplibre-gl.js");
swap(`${MAPLIBRE}/maplibre-gl.css`, "/static/vendor/maplibre-gl.css");
swap(FONTS, "/static/vendor/fonts.css");
html = html.replace(/\s*<link rel="preconnect" href="https:\/\/(unpkg\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)"[^>]*>/g, "");
html = html.replace(/\s*<link rel="manifest"[^>]*>/, "");
await writeFile(join(WWW, "index.html"), html);

// Dev only: ROULIB_API=http://localhost:8099 npm run build points the bundled app at a local backend.
// Release builds keep the hosted backend written in static/native.js.
if (process.env.ROULIB_API) {
  const f = join(WWW, "static", "native.js");
  const js = (await readFile(f, "utf8")).replace(/window\.ROULIB_API = "[^"]+"/, `window.ROULIB_API = ${JSON.stringify(process.env.ROULIB_API)}`);
  await writeFile(f, js);
  console.log(`API -> ${process.env.ROULIB_API} (dev build, do not ship)`);
}
console.log(`www built: ${urls.length} font files vendored`);
