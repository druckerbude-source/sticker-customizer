import { createReadStream } from "fs";
import fs from "fs/promises";
import path from "path";

function contentTypeFor(name = "") {
  const n = name.toLowerCase();
  if (n.endsWith(".png")) return "image/png";
  if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
  if (n.endsWith(".webp")) return "image/webp";
  if (n.endsWith(".svg")) return "image/svg+xml";
  if (n.endsWith(".pdf")) return "application/pdf";
  if (n.endsWith(".txt")) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

function safeJoin(baseDir, rel) {
  // rel kommt z.B. als "sticker-configurator/test.txt" oder "sticker-configurator/previews/abc.png"
  const cleaned = String(rel || "")
    .replace(/^\/+/, "")
    .replace(/\\/g, "/");

  // keine Traversals
  if (!cleaned || cleaned.includes("..")) return null;

  const abs = path.resolve(baseDir, cleaned);
  const base = path.resolve(baseDir);
  if (!abs.startsWith(base + path.sep) && abs !== base) return null;

  return abs;
}

export async function loader({ params, request }) {
  // Remix splat-param ist i.d.R. params["*"] bei "$"
  const rel = params["*"] ?? params["$"] ?? "";

  const UPLOADS_DIR = path.resolve(process.cwd(), "public", "uploads");
  const abs = safeJoin(UPLOADS_DIR, rel);
  if (!abs) return new Response("Bad path", { status: 400 });

  try {
    const st = await fs.stat(abs);
    if (!st.isFile()) return new Response("Not found", { status: 404 });

    const headers = new Headers();
    headers.set("Content-Type", contentTypeFor(abs));

    // Previews/Exports können hart gecached werden, Uploads eher kurz
    const isPreviewOrExport =
      rel.startsWith("sticker-configurator/previews/") ||
      rel.startsWith("sticker-configurator/exports/") ||
      rel.startsWith("exports/") ||
      rel.startsWith("previews/");

    headers.set(
      "Cache-Control",
      isPreviewOrExport
        ? "public, max-age=31536000, immutable"
        : "private, max-age=60"
    );

    // Optional: Range etc. lassen wir weg, für PNG/JPG reicht Stream
    return new Response(createReadStream(abs), { status: 200, headers });
  } catch (e) {
    if (e && (e.code === "ENOENT" || e.code === "ENOTDIR")) {
      return new Response("Not found", { status: 404 });
    }
    console.error("[UPLOADS STATIC ERROR]", e);
    return new Response("Server error", { status: 500 });
  }
}
