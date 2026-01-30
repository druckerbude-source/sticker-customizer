import { json } from "@remix-run/node";
import fs from "fs/promises";
import path from "path";

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".pdf") return "application/pdf";
  return "application/octet-stream";
}

// GET /apps/sticker-configurator/uploads/<...>
export async function loader({ params }) {
  try {
    const splat = params["*"];
    if (!splat) return json({ ok: false, error: "missing path" }, { status: 400 });

    // Pfad-Schutz (kein ../)
    const cleaned = splat.replace(/\\/g, "/");
    if (cleaned.includes("..")) return json({ ok: false, error: "invalid path" }, { status: 400 });

    // => public/<splat>
    const abs = path.join(process.cwd(), "public", "uploads", "sticker-configurator", cleaned);

    const buf = await fs.readFile(abs);
    return new Response(buf, {
      status: 200,
      headers: {
        "Content-Type": contentTypeFor(abs),
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch (e) {
    return json({ ok: false, error: "not found" }, { status: 404 });
  }
}
