// Erzeugt die statische Variante für GitHub Pages in dist/ (Aufruf: node scripts/build-pages.mjs)
import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|avif)$/i;

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(join(root, "static"), dist, { recursive: true });
await cp(join(root, "images"), join(dist, "images"), { recursive: true });
await cp(join(root, "seed.sql"), join(dist, "seed.sql"));
await writeFile(join(dist, "config.js"), "window.APP_CONFIG = { staticMode: true };\n");
await writeFile(join(dist, ".nojekyll"), "");

// Ersatz für GET /api/images: Dateiliste pro Unterordner
const index = {};
for (const kind of ["items", "buildings"]) {
  const files = await readdir(join(root, "images", kind)).catch(() => []);
  index[kind] = files.filter((f) => IMAGE_EXT.test(f)).sort();
}
await writeFile(join(dist, "images", "index.json"), JSON.stringify(index));
console.log(`dist/ erstellt (${index.items.length} Item-, ${index.buildings.length} Gebäudebilder)`);
