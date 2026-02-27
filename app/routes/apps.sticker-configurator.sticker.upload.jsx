// app/routes/apps.sticker-configurator.sticker.upload.jsx
import { json } from "@remix-run/node";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { authenticate } from "../shopify.server";
import { STICKER_CATALOG, STICKER_CATALOG_VERSION } from "../catalog/stickerCatalog.server";
import {
  stagedUploadsCreateOne,
  uploadBufferToStagedTarget,
  fileCreateOne,
  waitForShopifyFileUrl,
} from "../lib/shopifyFiles.server";

export const handle = { isAppProxy: true };

// ── Legacy-Exports (werden von anderen Routen re-exportiert) ──────────────
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

// ── Konstanten ────────────────────────────────────────────────────────────
const UPLOAD_DIR = path.resolve(
  process.cwd(),
  "public",
  "uploads",
  "sticker-configurator",
  "originals"
);
const UPLOAD_TO_SHOPIFY = process.env.NODE_ENV === "production";
const MAX_FILE_MB = 20;

// CORS-Header für alle Antworten (nötig falls Frontend direkt auf App-Server zugreift)
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "no-store, max-age=0",
};

// ── Hilfsfunktionen ───────────────────────────────────────────────────────
function safeFilename(originalName) {
  const base = String(originalName || "upload").replace(/[^a-zA-Z0-9._-]/g, "_");
  const stamp = Date.now();
  const rnd = crypto.randomBytes(3).toString("hex");
  return `${stamp}-${rnd}-${base}`;
}

function isImageMime(m) {
  return String(m || "").toLowerCase().startsWith("image/");
}

/**
 * Öffentliche URL für lokal gespeicherte Dateien.
 *
 * Datei liegt unter:  public/uploads/sticker-configurator/originals/<filename>
 * Remix-Route:        apps.sticker-configurator.uploads.$.jsx
 *                     → serviert /apps/sticker-configurator/uploads/<splat>
 *                     → liest aus public/uploads/<splat>
 * Splat:              sticker-configurator/originals/<filename>
 *
 * Im App-Proxy-Kontext hat Shopify den 'shop'-Parameter angehängt:
 *   → Browser-URL: https://<shop>/apps/sticker-configurator/uploads/sticker-configurator/originals/<filename>
 *   → Shopify proxied zu: /proxy/sticker-configurator/uploads/sticker-configurator/originals/<filename>
 *   → proxy.sticker-configurator.uploads.$.jsx serviert die Datei
 */
function buildLocalUrl(requestUrl, filename) {
  try {
    const u = new URL(requestUrl);
    const shop = u.searchParams.get("shop");
    const appPath = `/apps/sticker-configurator/uploads/sticker-configurator/originals/${filename}`;
    if (shop) {
      // App-Proxy: Browser ist auf der Shopify-Store-Domain (same-origin für den Browser)
      return `https://${shop}${appPath}`;
    }
    // Embedded Admin / Direktaufruf: über App-Server-Domain und Remix-Route
    return `${u.origin}${appPath}`;
  } catch {
    return `/apps/sticker-configurator/uploads/sticker-configurator/originals/${filename}`;
  }
}

// Admin-Client nach dem Body-Lesen holen (App Proxy braucht nur Query-Params, nicht den Body)
async function getAdminClient(request) {
  try {
    const u = new URL(request.url);
    const isProxy = u.searchParams.has("hmac") || u.searchParams.has("signature");
    if (isProxy) {
      const { admin } = await authenticate.public.appProxy(request);
      return admin ?? null;
    }
    const { admin } = await authenticate.admin(request);
    return admin ?? null;
  } catch {
    return null;
  }
}

// ── Loader (GET) ──────────────────────────────────────────────────────────
export async function loader() {
  return json(
    {
      ok: true,
      route: "/apps/sticker-configurator/sticker/upload",
      catalogVersion: STICKER_CATALOG_VERSION,
      catalog: STICKER_CATALOG,
    },
    { headers: CORS }
  );
}

// ── Action (POST) ─────────────────────────────────────────────────────────
export async function action({ request }) {
  // OPTIONS-Preflight für CORS
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  if (request.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, { status: 405, headers: CORS });
  }

  // ── SCHRITT 1: Body lesen – IMMER ZUERST ─────────────────────────────────
  // Wichtig: request.formData() muss VOR jedem authenticate.*-Aufruf erfolgen,
  // da manche Versionen von shopify-app-remix den Request-Body intern konsumieren.
  let buffer, mime, filename;

  try {
    const formData = await request.formData();
    const file = formData.get("file");

    if (!file || typeof file.arrayBuffer !== "function") {
      console.error("[UPLOAD] Kein gültiges 'file'-Feld in FormData");
      return json({ ok: false, error: "invalid_file" }, { status: 400, headers: CORS });
    }

    mime = String(file.type || "").toLowerCase();
    if (!isImageMime(mime)) {
      return json({ ok: false, error: "not_an_image" }, { status: 400, headers: CORS });
    }

    buffer = Buffer.from(await file.arrayBuffer());

    if (buffer.length === 0) {
      console.error("[UPLOAD] Datei ist leer (0 Bytes)");
      return json({ ok: false, error: "empty_file" }, { status: 400, headers: CORS });
    }

    if (buffer.length > MAX_FILE_MB * 1024 * 1024) {
      return json(
        { ok: false, error: `file_too_large_max_${MAX_FILE_MB}mb` },
        { status: 413, headers: CORS }
      );
    }

    const rawName = String(file.name || "image");
    const ext = (rawName.split(".").pop() || "png").toLowerCase();
    const finalExt = ["png", "jpg", "jpeg", "webp", "gif", "avif"].includes(ext) ? ext : "png";
    const baseName = rawName.replace(/\.[^.]+$/, "");
    filename = safeFilename(`${baseName}.${finalExt}`);

    console.log(`[UPLOAD] Datei empfangen: ${filename} (${buffer.length} Bytes, ${mime})`);
  } catch (e) {
    console.error("[UPLOAD] FormData-Parse-Fehler:", e?.message || e);
    return json({ ok: false, error: "form_parse_error" }, { status: 400, headers: CORS });
  }

  // ── SCHRITT 2: Auth (nach Body-Lesen) ────────────────────────────────────
  const admin = await getAdminClient(request);
  console.log(`[UPLOAD] Admin-Client: ${admin ? "verfügbar" : "nicht verfügbar"}, Shopify-Upload: ${UPLOAD_TO_SHOPIFY}`);

  // ── SCHRITT 3: Shopify CDN Upload (Produktion + Admin verfügbar) ──────────
  if (admin && UPLOAD_TO_SHOPIFY) {
    try {
      console.log("[UPLOAD] Starte Shopify CDN Upload...");

      const staged = await stagedUploadsCreateOne(admin, {
        filename,
        mimeType: mime,
        httpMethod: "POST",
        resource: "IMAGE",
      });
      console.log("[UPLOAD] Staged target erstellt:", staged.resourceUrl);

      await uploadBufferToStagedTarget(staged, buffer, { filename, mimeType: mime });
      console.log("[UPLOAD] Buffer zu S3/GCS hochgeladen");

      const created = await fileCreateOne(admin, {
        contentType: "IMAGE",
        originalSource: staged.resourceUrl,
        filename,
        alt: "Sticker upload",
      });
      console.log("[UPLOAD] fileCreate abgeschlossen. fileId:", created.id);

      const ready = await waitForShopifyFileUrl(admin, created.id, {
        maxAttempts: 8,
        delayMs: 1500,
      });

      if (ready.url) {
        console.log("[UPLOAD] Shopify CDN URL erhalten:", ready.url);
        return json(
          { ok: true, url: ready.url, filename, fileId: created.id, source: "shopify" },
          { headers: CORS }
        );
      }

      console.warn("[UPLOAD] Shopify CDN noch nicht READY (Timeout). Falle zu lokal.");
    } catch (shopifyErr) {
      console.error("[UPLOAD SHOPIFY WARN]", shopifyErr?.message || shopifyErr);
      // Falle durch zu lokalem Fallback
    }
  }

  // ── SCHRITT 4: Lokaler Fallback ───────────────────────────────────────────
  // Datei auf Disk speichern und über Remix-Route ausliefern
  // (remix-serve serviert public/ NICHT direkt → über Route apps.sticker-configurator.uploads.$)
  try {
    await fs.mkdir(UPLOAD_DIR, { recursive: true });
    await fs.writeFile(path.join(UPLOAD_DIR, filename), buffer);

    const url = buildLocalUrl(request.url, filename);
    console.log("[UPLOAD] Lokaler Fallback erfolgreich. URL:", url);

    return json(
      { ok: true, url, filename, source: "local" },
      { headers: CORS }
    );
  } catch (writeErr) {
    console.error("[UPLOAD] Lokaler Write fehlgeschlagen:", writeErr?.message || writeErr);
    return json({ ok: false, error: "upload_failed" }, { status: 500, headers: CORS });
  }
}
