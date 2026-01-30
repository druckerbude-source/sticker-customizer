// frontend/copy-to-extension.js
const fs = require("fs");
const path = require("path");

const SRC = path.resolve(__dirname, "dist", "sticker-configurator.js");
const DEST = path.resolve(
  __dirname,
  "..",
  "extensions",
  "sticker-embed",
  "assets",
  "sticker-configurator.js"
);

if (!fs.existsSync(SRC)) {
  console.error("[copy] Build-Datei fehlt:", SRC);
  process.exit(1);
}

fs.mkdirSync(path.dirname(DEST), { recursive: true });
fs.copyFileSync(SRC, DEST);

console.log("[copy] Build → Extension kopiert:", DEST);
