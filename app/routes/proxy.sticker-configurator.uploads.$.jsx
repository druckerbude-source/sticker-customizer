import fs from "fs/promises";
import path from "path";

// Shopify App-Proxy Route: liefert /apps/sticker-configurator/uploads/... aus
export const handle = {
  isAppProxy: true,
};

const UPLOADS_ROOT = path.resolve(process.cwd(), "public", "uploads");

function contentTypeFor(filePath = "") {
  const p = String(filePath || "").toLowerCase();
  if (p.endsWith(".png")) return "image/png";
  if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
  if (p.endsWith(".webp")) return "image/webp";
  if (p.endsWith(".svg")) return "image/svg+xml";
  if (p.endsWith(".pdf")) return "application/pdf";
  return "application/octet-stream";
}

function safeResolveUploadPath(splat) {
  const rel = String(splat || "").replace(/^\/+/, "");

  // Path Traversal verhindern
  if (!rel || rel.includes("..") || rel.includes("\u0000")) return null;

  const abs = path.resolve(UPLOADS_ROOT, rel);
  const root = UPLOADS_ROOT.endsWith(path.sep) ? UPLOADS_ROOT : UPLOADS_ROOT + path.sep;

  if (!abs.startsWith(root)) return null;
  return { abs, rel };
}

export async function loader({ request, params }) {
  const method = String(request.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Remix splat: params["*"] ist der Restpfad nach /proxy/sticker-configurator/uploads/
  const splat = params["*"];
  const resolved = safeResolveUploadPath(splat);
  if (!resolved) return new Response("Not found", { status: 404 });

  try {
    const stat = await fs.stat(resolved.abs);
    if (!stat.isFile()) return new Response("Not found", { status: 404 });

    const etag = `"${stat.size}-${Math.floor(stat.mtimeMs)}"`;
    const inm = request.headers.get("if-none-match");
    if (inm && inm === etag) {
      return new Response(null, {
        status: 304,
        headers: {
          ETag: etag,
          "Cache-Control": "public, max-age=3600",
        },
      });
    }

    if (method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: {
          "Content-Type": contentTypeFor(resolved.rel),
          "Content-Length": String(stat.size),
          ETag: etag,
          "Cache-Control": "public, max-age=3600",
        },
      });
    }

    const buf = await fs.readFile(resolved.abs);
    return new Response(buf, {
      status: 200,
      headers: {
        "Content-Type": contentTypeFor(resolved.rel),
        "Content-Length": String(buf.length),
        ETag: etag,
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
