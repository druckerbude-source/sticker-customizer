import "dotenv/config";
import path from "path";
import fs from "fs";
import express from "express";
import compression from "compression";
import morgan from "morgan";

import { createRequestHandler } from "@remix-run/express";

// ------------------------------
// Helpers
// ------------------------------
function setCorsHeaders(res) {
  // Für Canvas/Export wichtig:
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  // Verhindert Block durch CORP bei cross-origin <img> + canvas:
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  // Optional, aber hilfreich:
  res.setHeader("Timing-Allow-Origin", "*");
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

// ------------------------------
// App
// ------------------------------
const app = express();
app.use(compression());
app.use(morgan("tiny"));

// ✅ Stelle sicher, dass die Ordner existieren
const uploadsDir = path.join(process.cwd(), "public", "uploads", "sticker-configurator");
const exportsDir = path.join(process.cwd(), "public", "exports", "sticker-configurator");
ensureDir(uploadsDir);
ensureDir(exportsDir);

// ✅ CORS + Static für Uploads/Exports
app.options("/uploads/*", (req, res) => {
  setCorsHeaders(res);
  res.sendStatus(204);
});
app.options("/exports/*", (req, res) => {
  setCorsHeaders(res);
  res.sendStatus(204);
});

app.use(
  "/uploads",
  express.static(path.join(process.cwd(), "public", "uploads"), {
    setHeaders(res) {
      setCorsHeaders(res);
      // Caching ok; du kannst das auch weg lassen
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    },
  })
);

app.use(
  "/exports",
  express.static(path.join(process.cwd(), "public", "exports"), {
    setHeaders(res) {
      setCorsHeaders(res);
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    },
  })
);

// ✅ Normale Public Assets (Remix Build)
app.use(
  "/build",
  express.static(path.join(process.cwd(), "public", "build"), {
    immutable: true,
    maxAge: "1y",
  })
);
app.use(express.static(path.join(process.cwd(), "public"), { maxAge: "1h" }));

// Remix Handler
const build =
  process.env.NODE_ENV === "production"
    ? await import("./build/server/index.js")
    : await import("./build/server/index.js"); // falls du dev anders lädst, kann man das anpassen

app.all(
  "*",
  createRequestHandler({
    build,
    mode: process.env.NODE_ENV,
  })
);

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`[server] listening on port ${port}`);
});
