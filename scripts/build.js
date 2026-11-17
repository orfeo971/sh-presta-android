// Prépare le dossier build/ embarqué dans l'APK (et servi en développement par npm run serve) :
// code regroupé par esbuild (plugins Capacitor, @orfeo/updater) et fichiers statiques.
import { build } from "esbuild";
import { cp, rm, mkdir } from "node:fs/promises";

const out = "build";
await rm(out, { recursive: true, force: true });
await mkdir(`${out}/js`, { recursive: true });
await build({
  entryPoints: ["www/js/app.js"],
  outdir: `${out}/js`,
  bundle: true,
  splitting: true,
  format: "esm",
  target: "chrome100",
  minify: true,
  sourcemap: true,
  chunkNames: "chunks/[name]-[hash]",
  logLevel: "warning"
});
await cp("www/css", `${out}/css`, { recursive: true });
await cp("node_modules/@orfeo/updater/src/ui.css", `${out}/css/updater.css`);
await cp("www/index.html", `${out}/index.html`);
console.log("build/ prêt (SH Presta)");
