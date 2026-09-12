import { mkdir } from "node:fs/promises";
import { build } from "esbuild";
import { buildMaskToolSources } from "./build-mask-tools.mjs";
import { pluginBanner, PLUGIN_VERSION } from "./build-banner.mjs";

const banner = pluginBanner();

await mkdir("dist", { recursive: true });
await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/risu-cognitive-memory.js",
  bundle: true,
  format: "iife",
  target: "es2022",
  banner: { js: banner },
  minify: false,
  sourcemap: true,
});
await mkdir("../../artifacts/test", { recursive: true });
await build({
  entryPoints: ["src/index.ts"],
  outfile: `../../artifacts/test/risu-cognitive-memory-v${PLUGIN_VERSION}.js`,
  bundle: true,
  format: "iife",
  target: "es2022",
  banner: { js: banner },
  minify: true,
  sourcemap: false,
});
await buildMaskToolSources();
