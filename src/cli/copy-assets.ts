import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourceDirectory = resolve(projectRoot, "src/miniapp");
const outputDirectory = resolve(projectRoot, "dist/miniapp/public");
await mkdir(outputDirectory, { recursive: true });

await Promise.all([
  copyFile(resolve(sourceDirectory, "index.html"), resolve(outputDirectory, "index.html")),
  build({
    entryPoints: [resolve(sourceDirectory, "client.tsx")],
    outfile: resolve(outputDirectory, "app.js"),
    bundle: true,
    minify: true,
    format: "esm",
    platform: "browser",
    target: "es2024",
    legalComments: "none",
    sourcemap: false,
    tsconfig: resolve(projectRoot, "tsconfig.json"),
  }),
]);
