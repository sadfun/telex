import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourceDirectory = resolve(projectRoot, "src/miniapp");
const outputDirectory = resolve(projectRoot, "dist/miniapp/public");
const telegramUiStylesPath = resolve(
  projectRoot,
  "node_modules/@telegram-apps/telegram-ui/dist/styles.css",
);
const stylesMarker = "/* TELEGRAM_UI_STYLES */";

await mkdir(outputDirectory, { recursive: true });
const [htmlTemplate, telegramUiStyles] = await Promise.all([
  readFile(resolve(sourceDirectory, "index.html"), "utf8"),
  readFile(telegramUiStylesPath, "utf8"),
]);
if (!htmlTemplate.includes(stylesMarker)) {
  throw new Error(`Mini App HTML is missing ${stylesMarker}`);
}

await Promise.all([
  writeFile(
    resolve(outputDirectory, "index.html"),
    htmlTemplate.replace(stylesMarker, telegramUiStyles),
    "utf8",
  ),
  build({
    entryPoints: [resolve(sourceDirectory, "client.ts")],
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
