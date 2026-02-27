// app/routes/apps.sticker-configurator.sticker.export.jsx
import { json } from "@remix-run/node";
import fs from "fs/promises";
import path from "path";
import { authenticate } from "../shopify.server";
import { uploadBufferAsShopifyFile } from "../lib/shopifyFiles.server";

// Pflicht für App-Proxy POST-Requests: verhindert CSRF-Ablehnung durch shopify-app-remix
export const handle = { isAppProxy: true };

// ==============================
// Performance-Schalter
// ==============================
const DEFAULT_UPLOAD_PNG_TO_SHOPIFY = false;
const DEFAULT_UPLOAD_SVG_TO_SHOPIFY = process.env.NODE_ENV === "production";

// Schutz: sehr große Base64 Uploads abweisen (optional)
const MAX_DATAURL_MB = 35;

const EXPORT_DIR = path.join(process.cwd(), "public", "exports", "sticker-configurator");

// Debug-Logging nur wenn benötigt
const DEBUG = process.env.NODE_ENV !== "production" && process.env.DEBUG_EXPORT === "1";

// ==============================
// Auth (Admin Session Token ODER App-Proxy HMAC)
// ==============================
function isAppProxyRequest(request) {
  const u = new URL(request.url);
  return u.searchParams.has("shop") && (u.searchParams.has("signature") || u.searchParams.has("hmac"));
}

async function getAdminClientOrThrow(request) {
  const auth = String(request.headers.get("authorization") || "");

  if (/^bearer\s+/i.test(auth)) {
    const { admin } = await authenticate.admin(request);
    return admin;
  }

  if (isAppProxyRequest(request)) {
    const { admin } = await authenticate.public.appProxy(request);
    return admin;
  }

  const { admin } = await authenticate.admin(request);
  return admin;
}

function normalizeShape(rawShape) {
  const s = String(rawShape || "").toLowerCase();
  if (s === "circle" || s === "round" || s === "rund") return "round";
  if (s === "oval" || s === "oval_portrait") return "oval";
  if (s === "square") return "square";
  if (s === "rect" || s === "rectangle" || s === "rect_landscape") return "rect";
  if (s === "square_rounded" || s === "rect_rounded" || s === "rect_landscape_rounded" || s === "rounded") {
    return "rounded";
  }
  if (s === "freeform") return "freeform";
  return "rect";
}

function clampInt(n, min, max) {
  const x = Math.round(Number(n));
  if (!Number.isFinite(x)) return min;
  return Math.min(max, Math.max(min, x));
}

function approxBase64BytesLen(base64Str) {
  return Math.floor((base64Str.length * 3) / 4);
}

let _exportDirReady = false;
async function ensureDirOnce(dir) {
  if (_exportDirReady) return;
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch {}
  _exportDirReady = true;
}

// ==============================
// PNG Größe aus IHDR lesen (ohne externe Libs)
// ==============================
function readPngSize(pngBuffer) {
  try {
    if (!pngBuffer || pngBuffer.length < 24) return null;
    if (pngBuffer[0] !== 0x89 || pngBuffer[1] !== 0x50 || pngBuffer[2] !== 0x4e || pngBuffer[3] !== 0x47) {
      return null;
    }
    const w = pngBuffer.readUInt32BE(16);
    const h = pngBuffer.readUInt32BE(20);
    if (!w || !h) return null;
    return { w, h };
  } catch {
    return null;
  }
}

// ------------------------------
// Background / transparency helpers
// ------------------------------
function normalizeBgInput(bgMode, bgColor, exportTransparent) {
  const forcedTransparent = !!exportTransparent;
  const mode = String(forcedTransparent ? "transparent" : (bgMode || "color")).toLowerCase();
  const raw = String(bgColor ?? "").trim();
  const low = raw.toLowerCase();
  const isTrans = !raw || low === "transparent" || low === "none";
  const hasFill = mode !== "transparent" && !isTrans;
  return { mode, raw, hasFill };
}

// ==============================
// ✅ Cutline helpers (PathD Sanitizer + Builder)
// ==============================
function sanitizeSvgPathD(d) {
  const s = String(d || "").trim();
  if (!s) return "";
  // Whitelist: SVG path commands + numbers + separators
  // (verhindert, dass jemand z.B. "><script" reinschiebt)
  const ok = /^[0-9a-zA-Z\s,.\-+eE]*$/.test(s);
  if (!ok) return "";
  // Muss zumindest ein Move enthalten, sonst sinnlos
  if (!/[mM]/.test(s)) return "";
  return s;
}

function buildCutlinePathTag({ d, strokePx, color = "#ff00ff" }) {
  const dd = sanitizeSvgPathD(d);
  if (!dd) return "";
  const sw = Math.max(0.5, Number(strokePx) || 1);
  return `<path d="${dd}" fill="none" stroke="${color}" stroke-width="${sw}" />`;
}

function wrapCutContour(inner) {
  if (!inner) return "";
  // id="CutContour" ist der Standard-Layer-Name für Plotter (Silhouette, Graphtec, Roland, Cricut).
  return `<g id="CutContour">\n  ${inner}\n</g>`;
}

export async function action({ request }) {
  if (request.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, { status: 405 });
  }

  // Auth
  let admin;
  try {
    admin = await getAdminClientOrThrow(request);
  } catch (e) {
    console.error("[EXPORT AUTH ERROR]", e);
    return json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json().catch(() => ({}));

    const {
      renderedDataUrl,
      imageUrl,
      shape: rawShape = "rect",

      widthPx,
      heightPx,

      rectWidthPx,
      rectHeightPx,
      freeformCutMaskDataUrl,
      freeformBorderPx,
      bgMode = "color",
      bgColor = "#ffffff",
      exportTransparent = false,
      fitMode,

      // ✅ NEW: Cutline from Client (Vector)
      cutlineEnabled = false,
      cutlinePathD = "",
      cutlineStrokePx = null,

      // Perf Flags (Client kann hier steuern)
      uploadPngToShopify = DEFAULT_UPLOAD_PNG_TO_SHOPIFY,
      uploadSvgToShopify = DEFAULT_UPLOAD_SVG_TO_SHOPIFY,
    } = body || {};

    const shapeKey = normalizeShape(rawShape);

    if (DEBUG) {
      console.log("[EXPORT] req", {
        shape: rawShape,
        shapeKey,
        widthPx,
        heightPx,
        bgMode,
        bgColor,
        exportTransparent: !!exportTransparent,
        hasRenderedDataUrl: !!renderedDataUrl,
        uploadPngToShopify: !!uploadPngToShopify,
        uploadSvgToShopify: !!uploadSvgToShopify,
        cutlineEnabled: !!cutlineEnabled,
        hasCutlinePathD: !!String(cutlinePathD || "").trim(),
        cutlineStrokePx,
      });
    }

    const bg = normalizeBgInput(bgMode, bgColor, exportTransparent);
    const fill = bg.raw || "#ffffff";
    const hasBgFill = !!bg.hasFill;

    const { origin } = new URL(request.url);
    const rawBase = process.env.SHOPIFY_APP_URL || origin;
    const appBase = rawBase.replace(/\/$/, "");

    const getPreserve = (s) => {
      if (s === "freeform") return "xMidYMid meet";
      if (fitMode === "contain") return "xMidYMid meet";
      if (fitMode === "cover") return "xMidYMid slice";
      return "xMidYMid slice";
    };

    // =========================================================
    // MODE 1: Canvas-Export (renderedDataUrl) -> PNG + SVG Wrapper
    // =========================================================
    if (renderedDataUrl && typeof renderedDataUrl === "string") {
      const match = renderedDataUrl.match(/^data:image\/png;base64,(.+)$/);
      if (!match) {
        return json({ ok: false, error: "renderedDataUrl muss data:image/png;base64,... sein." }, { status: 400 });
      }

      const base64 = match[1] || "";
      const approxBytes = approxBase64BytesLen(base64);
      if (approxBytes > MAX_DATAURL_MB * 1024 * 1024) {
        return json({ ok: false, error: `renderedDataUrl zu groß (>${MAX_DATAURL_MB}MB).` }, { status: 413 });
      }

      const pngBuffer = Buffer.from(base64, "base64");

      // echte PNG Pixelmaße verwenden (verhindert Verzerrung)
      const size = readPngSize(pngBuffer);
      const fallbackW = clampInt(widthPx ?? 1, 1, 20000);
      const fallbackH = clampInt(heightPx ?? 1, 1, 20000);
      const exportW = clampInt(size?.w ?? fallbackW, 1, 20000);
      const exportH = clampInt(size?.h ?? fallbackH, 1, 20000);

      await ensureDirOnce(EXPORT_DIR);

      const ts = Date.now();
      const pngName = `${ts}-sticker.png`;
      const svgName = `${ts}-sticker.svg`;

      const localPngUrl = `${appBase}/exports/sticker-configurator/${pngName}`;
      const localSvgUrl = `${appBase}/exports/sticker-configurator/${svgName}`;

      // 1) PNG Upload (optional Shopify, default AUS für Speed)
      let pngUrl = localPngUrl;
      let pngFileId = null;

      if (uploadPngToShopify) {
        try {
          const up = await uploadBufferAsShopifyFile(admin, {
            buffer: pngBuffer,
            filename: pngName,
            mimeType: "image/png",
            resource: "IMAGE",
            contentType: "IMAGE",
            alt: "Sticker export PNG",
          });
          pngUrl = up.url;
          pngFileId = up.fileId;
        } catch (e) {
          console.error("[EXPORT PNG SHOPIFY WARN]", e);
        }
      }

      // Wenn nicht zu Shopify (oder Upload scheitert): lokal speichern (Dev-Fallback)
      if (!pngFileId) {
        await fs.writeFile(path.join(EXPORT_DIR, pngName), pngBuffer);
        pngUrl = localPngUrl;
      }

      // 2) Cutline / Clip
      let cutPath = "";
      const strokeW = Number.isFinite(Number(cutlineStrokePx)) ? Number(cutlineStrokePx) : 1;

      // ✅ Vektorpfad vom Client (z.B. Freeform-Tracing) hat Priorität
      const wantsCutline = !!cutlineEnabled;
      const cutlineD = sanitizeSvgPathD(cutlinePathD);

      if (wantsCutline && cutlineD) {
        // Vektorpfad direkt verwenden (Freeform oder Client-generierte Form)
        cutPath = wrapCutContour(buildCutlinePathTag({ d: cutlineD, strokePx: strokeW, color: "#ff00ff" }));
      } else if (wantsCutline && shapeKey !== "freeform") {
        // Für geometrische Formen: native SVG-Elemente – präziser als approximierte Pfade.
        // rectWidthPx/rectHeightPx = tatsächliche Sticker-Maße (ohne Canvas-Padding bei round/oval).
        const rw = clampInt(rectWidthPx ?? exportW, 1, 20000);
        const rh = clampInt(rectHeightPx ?? exportH, 1, 20000);
        const cx = exportW / 2;
        const cy = exportH / 2;
        let shapeEl = "";

        if (shapeKey === "round") {
          const r = Math.min(rw, rh) / 2;
          shapeEl = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#ff00ff" stroke-width="${strokeW}" />`;
        } else if (shapeKey === "oval") {
          shapeEl = `<ellipse cx="${cx}" cy="${cy}" rx="${rw / 2}" ry="${rh / 2}" fill="none" stroke="#ff00ff" stroke-width="${strokeW}" />`;
        } else if (shapeKey === "rounded") {
          // Eckenradius ≈ Differenz zwischen Canvas und Sticker-Maß (= Padding)
          const padX = Math.max(0, Math.round((exportW - rw) / 2));
          const padY = Math.max(0, Math.round((exportH - rh) / 2));
          const radius = Math.max(4, Math.min(padX, padY, Math.min(exportW, exportH) / 2));
          shapeEl = `<rect x="0" y="0" width="${exportW}" height="${exportH}" rx="${radius}" ry="${radius}" fill="none" stroke="#ff00ff" stroke-width="${strokeW}" />`;
        } else {
          shapeEl = `<rect x="0" y="0" width="${exportW}" height="${exportH}" fill="none" stroke="#ff00ff" stroke-width="${strokeW}" />`;
        }

        cutPath = wrapCutContour(shapeEl);
      }

      const preserve = getPreserve(shapeKey);

      let defsExtra = "";
      let bgRect = "";
      let imageTag = "";

      // Freeform-Mask-Filter ist weiterhin als Fallback drin,
      // aber wenn cutlinePathD vorhanden ist, brauchen wir den Filter NICHT mehr für die Cutline.
      const freeformMask = typeof freeformCutMaskDataUrl === "string" ? freeformCutMaskDataUrl.trim() : "";
      const freeformMaskOk = shapeKey === "freeform" && /^data:image\/png;base64,/.test(freeformMask);

      if (freeformMaskOk && !(wantsCutline && cutlineD)) {
        const maskId = "ffmask_" + ts.toString(36);
        const cutFilterId = "ffcut_" + ts.toString(36);
        const cutRadius = Math.max(1, Math.round(strokeW / 2));

        defsExtra = `
<defs>
  <mask id="${maskId}" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" style="mask-type:alpha">
    <image href="${freeformMask}" x="0" y="0" width="${exportW}" height="${exportH}" preserveAspectRatio="none" />
  </mask>

  <filter id="${cutFilterId}" x="-20%" y="-20%" width="140%" height="140%" color-interpolation-filters="sRGB">
    <feMorphology in="SourceAlpha" operator="dilate" radius="${cutRadius}" result="d" />
    <feComposite in="d" in2="SourceAlpha" operator="out" result="edge" />
    <feFlood flood-color="#ff00ff" flood-opacity="1" result="c" />
    <feComposite in="c" in2="edge" operator="in" result="colEdge" />
  </filter>
</defs>`;

        bgRect = hasBgFill ? `<rect x="0" y="0" width="${exportW}" height="${exportH}" fill="${fill}" mask="url(#${maskId})" />` : "";
        imageTag = `<image href="${renderedDataUrl}" x="0" y="0" width="${exportW}" height="${exportH}" preserveAspectRatio="none" />`;

        // Cutline via Filter (Fallback)
        cutPath = `<image href="${freeformMask}" x="0" y="0" width="${exportW}" height="${exportH}" preserveAspectRatio="none" filter="url(#${cutFilterId})" />`;
      } else {
        bgRect = hasBgFill && shapeKey !== "freeform" ? `<rect x="0" y="0" width="${exportW}" height="${exportH}" fill="${fill}" />` : "";
        // Bei Canvas-Mode ist renderedDataUrl "die Wahrheit" (keine CDN-Abhängigkeit)
        imageTag = `<image href="${renderedDataUrl}" x="0" y="0" width="${exportW}" height="${exportH}" preserveAspectRatio="none" />`;

        // Falls man lieber den Shopify-PNG-Link im SVG will:
        // imageTag = `<image href="${pngUrl}" x="0" y="0" width="${exportW}" height="${exportH}" preserveAspectRatio="${preserve}" />`;
      }

      const svgContent = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${exportW}" height="${exportH}" viewBox="0 0 ${exportW} ${exportH}" xmlns="http://www.w3.org/2000/svg">
  ${defsExtra}
  ${bgRect}
  ${imageTag}
  ${cutPath}
</svg>`;

      // 4) SVG Upload
      let svgUrl = localSvgUrl;
      let svgFileId = null;

      if (uploadSvgToShopify) {
        try {
          const up = await uploadBufferAsShopifyFile(admin, {
            buffer: Buffer.from(svgContent, "utf8"),
            filename: svgName,
            mimeType: "image/svg+xml",
            resource: "FILE",
            contentType: "FILE",
            alt: "Sticker export SVG",
          });
          svgUrl = up.url;
          svgFileId = up.fileId;
        } catch (e) {
          console.error("[EXPORT SVG SHOPIFY WARN]", e);
        }
      }

      if (!svgFileId) {
        await fs.writeFile(path.join(EXPORT_DIR, svgName), svgContent, "utf8");
        svgUrl = localSvgUrl;
      }

      return json({
        ok: true,
        svgUrl,
        pngUrl,
        svgFileId,
        pngFileId,
        exportWidthPx: exportW,
        exportHeightPx: exportH,
        perf: {
          uploadPngToShopify: !!uploadPngToShopify,
          uploadSvgToShopify: !!uploadSvgToShopify,
        },
      });
    }

    // =========================================================
    // MODE 2: Vektor-Fallback (wenn renderedDataUrl fehlt)
    // =========================================================
    if (!imageUrl) {
      return json(
        { ok: false, error: "imageUrl ist erforderlich, wenn kein renderedDataUrl gesendet wird." },
        { status: 400 }
      );
    }

    if (!widthPx || !heightPx) {
      return json({ ok: false, error: "widthPx und heightPx sind erforderlich." }, { status: 400 });
    }

    const w = clampInt(widthPx, 1, 20000);
    const h = clampInt(heightPx, 1, 20000);

    const clipId = "clip_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);

    let clipShape = "";
    let cutPath = "";

    const wantsCutline = !!cutlineEnabled;
    const cutlineD = sanitizeSvgPathD(cutlinePathD);
    const strokeW = Number.isFinite(Number(cutlineStrokePx)) ? Number(cutlineStrokePx) : 1;

    // Tatsächliche Sticker-Maße (in MODE 2 meist = w/h, da kein Canvas-Padding)
    const rw = clampInt(rectWidthPx ?? w, 1, 20000);
    const rh = clampInt(rectHeightPx ?? h, 1, 20000);
    const cx = w / 2;
    const cy = h / 2;

    // ✅ Vektorpfad vom Client nutzen (Freeform-Tracing oder Client-generiert)
    if (wantsCutline && cutlineD && shapeKey !== "freeform") {
      clipShape = `<path d="${cutlineD}" />`;
      cutPath = wrapCutContour(buildCutlinePathTag({ d: cutlineD, strokePx: strokeW, color: "#ff00ff" }));
    } else {
      if (shapeKey === "round") {
        const r = Math.min(rw, rh) / 2;
        clipShape = `<circle cx="${cx}" cy="${cy}" r="${r}" />`;
        cutPath = wantsCutline ? wrapCutContour(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#ff00ff" stroke-width="${strokeW}" />`) : "";
      } else if (shapeKey === "oval") {
        clipShape = `<ellipse cx="${cx}" cy="${cy}" rx="${rw / 2}" ry="${rh / 2}" />`;
        cutPath = wantsCutline ? wrapCutContour(`<ellipse cx="${cx}" cy="${cy}" rx="${rw / 2}" ry="${rh / 2}" fill="none" stroke="#ff00ff" stroke-width="${strokeW}" />`) : "";
      } else if (shapeKey === "rounded") {
        const padX = Math.max(0, Math.round((w - rw) / 2));
        const padY = Math.max(0, Math.round((h - rh) / 2));
        const radius = Math.max(4, Math.min(padX, padY, Math.min(w, h) / 2));
        clipShape = `<rect x="0" y="0" width="${w}" height="${h}" rx="${radius}" ry="${radius}" />`;
        cutPath = wantsCutline ? wrapCutContour(`<rect x="0" y="0" width="${w}" height="${h}" rx="${radius}" ry="${radius}" fill="none" stroke="#ff00ff" stroke-width="${strokeW}" />`) : "";
      } else if (shapeKey === "freeform") {
        clipShape = `<rect x="0" y="0" width="${w}" height="${h}" />`;
        cutPath = wantsCutline && cutlineD ? wrapCutContour(buildCutlinePathTag({ d: cutlineD, strokePx: strokeW })) : "";
      } else {
        clipShape = `<rect x="0" y="0" width="${w}" height="${h}" />`;
        cutPath = wantsCutline ? wrapCutContour(`<rect x="0" y="0" width="${w}" height="${h}" fill="none" stroke="#ff00ff" stroke-width="${strokeW}" />`) : "";
      }
    }

    const bgRect = hasBgFill && shapeKey !== "freeform" ? `<rect x="0" y="0" width="${w}" height="${h}" fill="${fill}" />` : "";

    const preserve = getPreserve(shapeKey);
    const imageTag = `<image href="${imageUrl}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="${preserve}" />`;

    const useClip = shapeKey !== "freeform";
    const defsBlock = useClip ? `<defs><clipPath id="${clipId}">${clipShape}</clipPath></defs>` : "";
    const contentGroup = useClip ? `<g clip-path="url(#${clipId})">${imageTag}</g>` : `${imageTag}`;

    const svgContent = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
  ${defsBlock}
  ${bgRect}
  ${contentGroup}
  ${cutPath}
</svg>`;

    await ensureDirOnce(EXPORT_DIR);

    const fileName = `${Date.now()}-sticker.svg`;
    const localSvgUrl = `${appBase}/exports/sticker-configurator/${fileName}`;

    let svgUrl = localSvgUrl;
    let svgFileId = null;

    if (DEFAULT_UPLOAD_SVG_TO_SHOPIFY) {
      try {
        const up = await uploadBufferAsShopifyFile(admin, {
          buffer: Buffer.from(svgContent, "utf8"),
          filename: fileName,
          mimeType: "image/svg+xml",
          resource: "FILE",
          contentType: "FILE",
          alt: "Sticker export SVG",
        });
        svgUrl = up.url;
        svgFileId = up.fileId;
      } catch (e) {
        console.error("[EXPORT SVG SHOPIFY WARN]", e);
      }
    }

    if (!svgFileId) {
      await fs.writeFile(path.join(EXPORT_DIR, fileName), svgContent, "utf8");
      svgUrl = localSvgUrl;
    }

    return json({ ok: true, svgUrl, pngUrl: null, svgFileId, exportWidthPx: w, exportHeightPx: h });
  } catch (err) {
    console.error("[EXPORT ERROR]", err);
    return json({ ok: false, error: err?.message || String(err) }, { status: 500 });
  }
}

export function loader() {
  return json({ ok: false, error: "GET not supported" }, { status: 405 });
}