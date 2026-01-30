// app/routes/apps.sticker-configurator.sticker.upload.jsx
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";

// ✅ Central catalog source (server-side)
import { STICKER_CATALOG, STICKER_CATALOG_VERSION } from "../catalog/stickerCatalog.server";

// ✅ Mark as App Proxy route (important in some Shopify/Remix setups)
export const handle = { isAppProxy: true };

// ✅ Safe defaults (Legacy calcPrice kann sonst später knallen, falls doch genutzt)
export const MIN_M2 = 0.1;
export const PRICE_PER_M2 = 250;

// ✅ Legacy (nicht mehr benutzt, kann später gelöscht werden)
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

function safeFilename(name) {
  const base = String(name || "upload").replace(/[^a-zA-Z0-9._-]/g, "_");
  const stamp = Date.now();
  return `${stamp}-${base}`;
}

function isImageMime(m) {
  const mime = String(m || "").toLowerCase();
  return mime.startsWith("image/");
}

export async function loader() {
  // ✅ Storefront App Proxy: Katalog immer ausliefern, nie cachen
  return json(
    {
      ok: true,
      route: "/apps/sticker-configurator/sticker/upload",
      catalogVersion: STICKER_CATALOG_VERSION,
      catalog: STICKER_CATALOG,
    },
    {
      headers: {
        "Cache-Control": "no-store, max-age=0",
      },
    }
  );
}

export async function action({ request }) {
  if (request.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, { status: 405 });
  }

  // ✅ Embedded Admin ODER Storefront App Proxy
  let admin = null;
  let isAppProxyRequest = false;

  try {
    const u = new URL(request.url);
    // Shopify App Proxy Requests sind am zuverlässigsten über hmac/signature zu erkennen.
    const hasHmac = u.searchParams.has("hmac") || u.searchParams.has("signature");
    isAppProxyRequest = hasHmac;

    if (isAppProxyRequest) {
      await authenticate.public.appProxy(request);
    } else {
      ({ admin } = await authenticate.admin(request));
    }
  } catch (e) {
    console.error("[UPLOAD AUTH ERROR]", e);
    return json(
      {
        ok: false,
        error: isAppProxyRequest
          ? "Unauthorized (app proxy validation failed)"
          : "Unauthorized (admin session token validation failed)",
      },
      { status: 401 }
    );
  }

  // ✅ Node-only Imports erst hier
  const fs = (await import("fs/promises")).default;
  const path = (await import("path")).default;
  const crypto = (await import("crypto")).default;
  const { Readable } = await import("stream");
  const { pipeline } = await import("stream/promises");

  // Upload-Ziele
  const UPLOAD_DIR = path.resolve(
    process.cwd(),
    "public",
    "uploads",
    "sticker-configurator",
    "originals"
  );

  const PREVIEW_DIR = path.resolve(
    process.cwd(),
    "public",
    "uploads",
    "sticker-configurator",
    "previews"
  );

  try {
    const formData = await request.formData();
    const file = formData.get("file");

    if (!file || typeof file.stream !== "function") {
      return json({ ok: false, error: "invalid file" }, { status: 400 });
    }

    const mime = String(file.type || "").toLowerCase();
    if (!isImageMime(mime)) {
      return json({ ok: false, error: "not an image" }, { status: 400 });
    }

    const filename = safeFilename(file.name || "image.png");
    const ext = (String(file.name || "").split(".").pop() || "png").toLowerCase();
    const finalExt = ["png", "jpg", "jpeg", "webp"].includes(ext) ? ext : "png";

    await fs.mkdir(UPLOAD_DIR, { recursive: true });
    await fs.mkdir(PREVIEW_DIR, { recursive: true });

    const rnd = crypto.randomBytes(3).toString("hex");
    const finalName = `${filename}-${rnd}.${finalExt}`;

    const absOriginal = path.join(UPLOAD_DIR, finalName);
    const absPreview = path.join(PREVIEW_DIR, finalName);

    // Stream in Datei
    const nodeStream = Readable.fromWeb(file.stream());
    await pipeline(nodeStream, (await import("fs")).createWriteStream(absOriginal));

    // Preview = erstmal identisch (ggf. später serverseitig kleiner skalieren)
    await fs.copyFile(absOriginal, absPreview);

    // Relative URLs (öffentlich)
    const publicOriginal = `/apps/sticker-configurator/uploads/originals/${finalName}`;
    const publicPreview  = `/apps/sticker-configurator/uploads/previews/${finalName}`;

    // ✅ Wichtig für Warenkorb/extern: absolute URLs stabilisieren
    const origin = new URL(request.url).origin;
    const absoluteOriginalUrl = `${origin}${publicOriginal}`;
    const absolutePreviewUrl = `${origin}${publicPreview}`;

    return json(
      {
        ok: true,

        // ✅ Deine bisherigen Felder
        originalUrl: publicOriginal,
        previewUrl: publicPreview,
        filename: finalName,

        // ✅ Neu: absolute Varianten (optional, aber sehr praktisch)
        absoluteOriginalUrl,
        absolutePreviewUrl,

        // ✅ Neu: Kompatibilität zu deinem Frontend ("url" erwartet)
        // Für Warenkorb/Produktion ist "original" meist sinnvoller als "preview".
        url: absoluteOriginalUrl,
      },
      {
        headers: {
          "Cache-Control": "no-store, max-age=0",
        },
      }
    );
  } catch (e) {
    console.error("[UPLOAD ERROR]", e);
    return json({ ok: false, error: "upload_failed" }, { status: 500 });
  }
}
