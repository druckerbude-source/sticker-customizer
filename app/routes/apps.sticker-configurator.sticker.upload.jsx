// app/routes/apps.sticker-configurator.sticker.upload.jsx
import { json } from "@remix-run/node";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { authenticate } from "../shopify.server";
import { STICKER_CATALOG, STICKER_CATALOG_VERSION } from "../catalog/stickerCatalog.server";
import { uploadBufferAsShopifyFile } from "../lib/shopifyFiles.server";

export const handle = { isAppProxy: true };

// ✅ Legacy exports (werden von anderen Routen re-exportiert)
export const MIN_M2 = 0.1;
export const PRICE_PER_M2 = 250;
export function calcPrice(widthCm, heightCm, quantity = 1) {
  const w = Number(widthCm) || 0;
  const h = Number(heightCm) || 0;
  const area = (w / 100) * (h / 100);
  const billedArea = Math.max(area, MIN_M2);
  const billedQuantity = Math.ceil(billedArea / MIN_M2);
  const effectiveQty = quantity || billedQuantity;
  const price = billedArea * PRICE_PER_M2;
  return { area: billedArea, quantity: effectiveQty, price };
}

const UPLOAD_DIR = path.resolve(
  process.cwd(),
  "public",
  "uploads",
  "sticker-configurator",
  "originals"
);

// Shopify CDN Upload in Produktion aktivieren (Render.com hat ephemeres Filesystem)
const UPLOAD_TO_SHOPIFY = process.env.NODE_ENV === "production";

const MAX_FILE_MB = 20;

function safeFilename(originalName) {
  const base = String(originalName || "upload").replace(/[^a-zA-Z0-9._-]/g, "_");
  const stamp = Date.now();
  const rnd = crypto.randomBytes(3).toString("hex");
  return `${stamp}-${rnd}-${base}`;
}

function isImageMime(m) {
  return String(m || "").toLowerCase().startsWith("image/");
}

// Admin-Client holen: App Proxy (HMAC) ODER Embedded Admin
async function getAdminClient(request) {
  try {
    const u = new URL(request.url);
    const hasHmac = u.searchParams.has("hmac") || u.searchParams.has("signature");
    if (hasHmac) {
      const { admin } = await authenticate.public.appProxy(request);
      return admin;
    }
    const { admin } = await authenticate.admin(request);
    return admin;
  } catch {
    return null;
  }
}

export async function loader() {
  return json(
    {
      ok: true,
      route: "/apps/sticker-configurator/sticker/upload",
      catalogVersion: STICKER_CATALOG_VERSION,
      catalog: STICKER_CATALOG,
    },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}

export async function action({ request }) {
  if (request.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, { status: 405 });
  }

  // Auth – darf fehlschlagen (Fallback zu lokaler Speicherung)
  const admin = await getAdminClient(request);

  try {
    const formData = await request.formData();
    const file = formData.get("file");

    if (!file || typeof file.arrayBuffer !== "function") {
      return json({ ok: false, error: "invalid file" }, { status: 400 });
    }

    const mime = String(file.type || "").toLowerCase();
    if (!isImageMime(mime)) {
      return json({ ok: false, error: "not an image" }, { status: 400 });
    }

    // Buffer ist zuverlässiger als Node-Streams (kein Readable.fromWeb-Problem)
    const buffer = Buffer.from(await file.arrayBuffer());

    if (buffer.length > MAX_FILE_MB * 1024 * 1024) {
      return json({ ok: false, error: `File too large (max ${MAX_FILE_MB}MB)` }, { status: 413 });
    }

    const ext = (String(file.name || "").split(".").pop() || "png").toLowerCase();
    const finalExt = ["png", "jpg", "jpeg", "webp", "gif", "avif"].includes(ext) ? ext : "png";
    const originalBaseName = String(file.name || "image").replace(/\.[^.]+$/, "");
    const filename = safeFilename(`${originalBaseName}.${finalExt}`);

    // ── Shopify CDN Upload (Produktion, wenn Admin-Client verfügbar) ──────────
    if (admin && UPLOAD_TO_SHOPIFY) {
      try {
        const up = await uploadBufferAsShopifyFile(admin, {
          buffer,
          filename,
          mimeType: mime,
          resource: "IMAGE",
          contentType: "IMAGE",
          alt: "Sticker upload",
        });
        return json(
          { ok: true, url: up.url, filename, source: "shopify" },
          { headers: { "Cache-Control": "no-store, max-age=0" } }
        );
      } catch (shopifyErr) {
        console.error("[UPLOAD SHOPIFY WARN]", shopifyErr?.message || shopifyErr);
        // Falle durch zu lokalem Fallback
      }
    }

    // ── Lokaler Fallback (Entwicklung / wenn Shopify nicht verfügbar) ─────────
    await fs.mkdir(UPLOAD_DIR, { recursive: true });
    const absPath = path.join(UPLOAD_DIR, filename);
    await fs.writeFile(absPath, buffer);

    // Korrekte öffentliche URL: entspricht dem tatsächlichen Serve-Pfad in Remix/Vite
    // public/uploads/sticker-configurator/originals/file → /uploads/sticker-configurator/originals/file
    // Über Shopify App Proxy: /apps/sticker-configurator/uploads/sticker-configurator/originals/file
    const origin = new URL(request.url).origin;
    const publicPath = `/uploads/sticker-configurator/originals/${filename}`;
    const url = `${origin}${publicPath}`;

    return json(
      {
        ok: true,
        url,
        filename,
        source: "local",
        // Legacy-Felder für ältere Frontend-Versionen
        originalUrl: publicPath,
        previewUrl: publicPath,
        absoluteOriginalUrl: url,
        absolutePreviewUrl: url,
      },
      { headers: { "Cache-Control": "no-store, max-age=0" } }
    );
  } catch (e) {
    console.error("[UPLOAD ERROR]", e);
    return json({ ok: false, error: "upload_failed" }, { status: 500 });
  }
}
