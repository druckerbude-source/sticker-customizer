// app/routes/apps.sticker-configurator.uploads.$folder.$filename.jsx
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export const handle = { isAppProxy: true };

function contentTypeFromExt(name) {
  const ext = String(name).split(".").pop()?.toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  return "application/octet-stream";
}

function isSafeFilename(filename) {
  // Keine Pfad-Traversal, keine Slashes, nur übliche Zeichen
  if (!filename) return false;
  if (filename.includes("..")) return false;
  if (filename.includes("/") || filename.includes("\\")) return false;
  return /^[a-zA-Z0-9._-]+$/.test(filename);
}

export async function loader({ request, params }) {
  const url = new URL(request.url);

  // ✅ App-Proxy-Validierung NUR wenn hmac/signature vorhanden ist.
  // Damit funktionieren Links aus dem Warenkorb (ohne hmac) trotzdem.
  const hasHmac = url.searchParams.has("hmac") || url.searchParams.has("signature");
  if (hasHmac) {
    try {
      await authenticate.public.appProxy(request);
    } catch (e) {
      console.error("[UPLOADS AUTH ERROR]", e);
      return json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
  }

  const folder = String(params.folder || "");
  const filename = String(params.filename || "");

  // ✅ Nur diese beiden Ordner erlauben
  if (!["originals", "previews"].includes(folder)) {
    return json({ ok: false, error: "invalid folder" }, { status: 400 });
  }

  if (!isSafeFilename(filename)) {
    return json({ ok: false, error: "invalid filename" }, { status: 400 });
  }

  const fs = (await import("fs/promises")).default;
  const path = (await import("path")).default;

  const abs = path.resolve(
    process.cwd(),
    "public",
    "uploads",
    "sticker-configurator",
    folder,
    filename
  );

  let buf;
  try {
    buf = await fs.readFile(abs);
  } catch (e) {
    return new Response("Not found", { status: 404 });
  }

  return new Response(buf, {
    status: 200,
    headers: {
      "Content-Type": contentTypeFromExt(filename),
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
