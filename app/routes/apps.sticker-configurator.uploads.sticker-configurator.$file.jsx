import { createReadStream } from "fs";
import fs from "fs/promises";
import path from "path";

function contentTypeFor(name = "") {
  const n = name.toLowerCase();
  if (n.endsWith(".png")) return "image/png";
  if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
  if (n.endsWith(".webp")) return "image/webp";
  if (n.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

export async function loader({ params }) {
  const file = String(params.file || "");

  // minimaler Path-Traversal-Schutz
  if (!file || file.includes("..") || file.includes("/") || file.includes("\\")) {
    return new Response("Bad filename", { status: 400 });
  }

  const abs = path.join(process.cwd(), "public", "uploads", "sticker-configurator", file);

  try {
    await fs.access(abs);
  } catch {
    return new Response("Not found", { status: 404 });
  }

  return new Response(createReadStream(abs), {
    status: 200,
    headers: {
      "Content-Type": contentTypeFor(file),
      "Cache-Control": "public, max-age=31536000, immutable",
      "Cross-Origin-Resource-Policy": "cross-origin",
    },
  });
}
