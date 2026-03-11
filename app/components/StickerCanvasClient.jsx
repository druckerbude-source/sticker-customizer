import { useEffect, useMemo, useRef, useState } from "react";

/**
 * StickerCanvasClient.jsx
 * - Self-contained (no relative imports)
 *
 * ✅ Fix (dieser Patch):
 * - Verhindert verzerrte Darstellung durch CSS-Kombination aus width + maxHeight + aspectRatio
 * - Preview-Fläche wird in px berechnet (fit-to-viewport) und setzt width+height explizit
 * - Quadrat bleibt Quadrat, Rechteck bleibt Rechteck, Freiform nutzt Billing-Box AR stabil
 *
 * ✅ Neu (dieser Patch):
 * - 3 zusätzliche Formen als "gedrehte" Varianten ohne doppelten Katalog:
 *   - rect_landscape  (Rechteck Quer) -> nutzt rect, Maße/Label gedreht
 *   - rect_landscape_rounded (Rechteck Quer Abgerundet) -> nutzt rect_rounded, Maße/Label gedreht
 *   - oval_portrait (Oval stehend) -> nutzt oval, Maße/Label gedreht
 *
 * ✅ Neu (Transparenz-Preview Patch):
 * - Editor-Hintergrund bleibt unberührt
 * - Transparenz-Schachbrett wird NUR innerhalb der Sticker-Fläche gezeigt
 *   - feste Formen: direkt im Shape-Container (OK, Container == Stickerfläche)
 *   - Freiform: Schachbrett wird per CSS-Mask auf die tatsächliche Freiform-Kontur begrenzt
 *
 * ✅ Neu (DEIN WUNSCH):
 * - Freiform: freie Größenwahl (cm) statt fixer Größen-Auswahl im Dropdown
 * - Abrechnung/Variante wird automatisch auf die kleinste passende Kataloggröße aufgerundet (ceil)
 * - sizeKey/variantId bleiben für Warenkorb & Backend erhalten (auto gesetzt)
 *
 * ✅ Neu (Mindestkante):
 * - Freiform: kleinste Kante mindestens 40 mm (4 cm) – wird automatisch proportional hochskaliert
 * - Dieses Maß kann nicht unterschritten werden (wirksame Maße effWcm/effHcm sind immer >= 4 cm Mindestkante)
 *
 * ✅ Neu (Proportionen fix):
 * - Freiform: Billing-Box Proportionen werden an die ORIGINAL-Sticker-Proportion (aus der Mask-BoundingBox) gebunden
 * - Wenn der User Breite ODER Höhe ändert, wird die andere Dimension automatisch passend nachgezogen (kein Verzerren)
 * - Fallback: falls Maske noch nicht verfügbar, wird imgAspect genutzt
 *
 * ✅ Neu (Freiräume schließen / füllen):
 * - Freiform: kleine Lücken/Schlitze zwischen Konturen werden vor Floodfill geschlossen (Mask-Closing)
 * - Dadurch entstehen keine unerwünschten "Freiräume" in der Freiform-Fläche (Screenshot 1 -> 2)
 */

//
// ==============================
// Konfiguration
// ==============================
const PRINT_LENGTH_CM = 130;

// ✅ Mindestkante: 40 mm
const MIN_EDGE_MM = 40;
const MIN_EDGE_CM = MIN_EDGE_MM / 10;

// Freeform Preview-Engine
const PX_PER_CM = 100;
const EXPORT_DPI = 300;
const WARN_DPI = 240;
const MIN_DPI = 180;

const SQRT2 = Math.SQRT2;
const FREEFORM_MASTER_LONG_SIDE = 1200;
const FREEFORM_PREVIEW_MAX_SIDE = 1100;

// ✅ schließt kleine "Freiräume" / Schlitze zwischen Konturen (Mask Closing)
// höher = mehr wird zugeschmiert; 2–4 ist meist gut
const FREEFORM_SEAL_GAPS_PX = 3;

// Rounded Export
const ROUNDED_PAD_PX = 28;
const ROUNDED_RADIUS_MM = (ROUNDED_PAD_PX / PX_PER_CM) * 10; // 28px -> 2.8mm

// ✅ Preview-Box Begrenzung
const PREVIEW_MAX_PX = 520;
const PREVIEW_MAX_VW_FACTOR = 0.70;
const PREVIEW_MAX_VH_FACTOR = 0.60;

// UI Colorways (Fallback, falls loader nur "sizes" liefert)
const FALLBACK_COLORWAYS = [
  { colorKey: "white", label: "Weiß" },
  { colorKey: "transparent", label: "Transparent" },
  { colorKey: "colored", label: "Farbig" },
];

// ==============================
// Helpers
// ==============================
function clampNum(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.min(max, Math.max(min, x));
}

function fmtCm(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "";
  const v = Math.round(x * 10) / 10;
  return v % 1 === 0 ? String(v.toFixed(0)) : String(v.toFixed(1));
}

function diagonalFromRect(w, h) {
  const ww = Math.max(0, Number(w) || 0);
  const hh = Math.max(0, Number(h) || 0);
  return Math.sqrt(ww * ww + hh * hh);
}

function cmToInch(cm) {
  return (Number(cm) || 0) / 2.54;
}

function cmToPxAtDpi(cm, dpi) {
  return Math.max(1, Math.round(cmToInch(cm) * (Number(dpi) || EXPORT_DPI)));
}

function mmToPxAtDpi(mm, dpi) {
  const m = clampNum(mm, 0, 50);
  const d = Number(dpi) || EXPORT_DPI;
  return Math.max(1, Math.round((m / 25.4) * d));
}

function calcEffectiveDpi({ imgPxW, imgPxH, targetCmW, targetCmH }) {
  const wIn = Math.max(1e-9, cmToInch(targetCmW));
  const hIn = Math.max(1e-9, cmToInch(targetCmH));
  const dpiX = (Number(imgPxW) || 0) / wIn;
  const dpiY = (Number(imgPxH) || 0) / hIn;
  return Math.min(dpiX, dpiY);
}

function getMajorForPieces(shape, wCm, hCm) {
  if (shape === "round") return Math.max(1e-9, Number(wCm) || 0); // Durchmesser
  return Math.max(1e-9, Math.max(Number(wCm) || 0, Number(hCm) || 0));
}

function calcPiecesFixed(shape, wCm, hCm) {
  const major = getMajorForPieces(shape, wCm, hCm);
  const pieces = Math.floor(PRINT_LENGTH_CM / major);
  return Math.max(1, pieces);
}

function toEuroFromCents(cents) {
  const c = Number(cents);
  if (!Number.isFinite(c)) return 0;
  return Math.round((c / 100) * 100) / 100;
}

function parseNumberDE(str) {
  const s = String(str || "").replace(",", ".").trim();
  const x = Number(s);
  return Number.isFinite(x) ? x : NaN;
}

// tolerant: "4x6", "4 x 6 cm", "4×6", "Ø 4", "D4", "Durchmesser 4"
function parseDimsFromVariantText(text) {
  const t = String(text || "").toLowerCase();

  if (t.includes("ø") || t.includes("durchmesser") || /^d\s*\d/.test(t.trim())) {
    const nums = t.match(/\d+(?:[\.,]\d+)?/g) || [];
    const d = parseNumberDE(nums[0]);
    if (Number.isFinite(d)) return { kind: "round", dCm: d };
  }

  const m = t.match(/(\d+(?:[\.,]\d+)?)\s*[x×]\s*(\d+(?:[\.,]\d+)?)/);
  if (m) {
    const a = parseNumberDE(m[1]);
    const b = parseNumberDE(m[2]);
    if (Number.isFinite(a) && Number.isFinite(b)) {
      const w = Math.min(a, b);
      const h = Math.max(a, b);
      return { kind: "rect", wCm: w, hCm: h };
    }
  }

  const nums = t.match(/\d+(?:[\.,]\d+)?/g) || [];
  if (nums.length === 1) {
    const n = parseNumberDE(nums[0]);
    if (Number.isFinite(n)) return { kind: "single", nCm: n };
  }

  return null;
}

function approxEq(a, b, eps = 0.051) {
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return Math.abs(x - y) <= eps;
}

function findBestVariantIdForSize({ shape, wCm, hCm }, variants) {
  const w = Math.min(Number(wCm) || 0, Number(hCm) || 0);
  const h = Math.max(Number(wCm) || 0, Number(hCm) || 0);
  const d = Number(wCm) || 0;

  if (!Array.isArray(variants) || variants.length === 0) return null;

  for (const v of variants) {
    const p = parseDimsFromVariantText(v?.title || v?.name || "");
    if (!p) continue;

    if (shape === "round") {
      if (p.kind === "round" && approxEq(p.dCm, d)) return v.id;
      if (p.kind === "single" && approxEq(p.nCm, d)) return v.id;
    } else {
      if (p.kind === "rect" && approxEq(p.wCm, w) && approxEq(p.hCm, h)) return v.id;
      if (p.kind === "single") {
        const major = Math.max(w, h);
        if (approxEq(p.nCm, major)) return v.id;
      }
    }
  }
  return null;
}

// ✅ Variant-Matching: Farbe + Größe (für Shopify-Varianten mit Optionen, z. B. "White / 4x4 cm")
const COLOR_SYNONYMS = {
  white: ["white", "weiß", "weiss"],
  transparent: ["transparent", "klar"],
  // ⚠️ bewusst NICHT: "color"/"colour" (zu generisch, matched sonst fast alles)
  colored: ["farbig", "colored", "vollfarbe", "4c"],
};

function normText(x) {
  return String(x || "").toLowerCase().trim();
}

function variantMatchesColor(v, colorKey) {
  const key = String(colorKey || "").toLowerCase() || "white";
  const words = COLOR_SYNONYMS[key] || [key];

  const opts = Array.isArray(v?.options) ? v.options : [];
  const hay = [v?.option1, v?.option2, v?.option3, ...opts, v?.title]
    .map(normText)
    .filter(Boolean)
    .join(" / ");

  return words.some((w) => hay.includes(String(w).toLowerCase()));
}

function extractDimsFromVariant(v) {
  const opts = Array.isArray(v?.options) ? v.options : [];
  const candidates = [v?.option1, v?.option2, v?.option3, ...opts, v?.title];
  for (const c of candidates) {
    const p = parseDimsFromVariantText(c);
    if (p) return p;
  }
  return null;
}

function variantMatchesDims(shape, wCm, hCm, parsed) {
  const w = Number(wCm) || 0;
  const h = Number(hCm) || 0;
  if (!(w > 0) || !(h > 0) || !parsed) return false;

  const s = String(shape || "").toLowerCase();

  // Rund/oval: oft als "Ø 4 cm" oder "4 x 4 cm" geführt
  if (s === "round") {
    const d = Math.max(w, h);
    if (parsed.kind === "single" && approxEq(parsed.nCm, d)) return true;
    if (parsed.kind === "rect" && approxEq(parsed.wCm, d) && approxEq(parsed.hCm, d)) return true;
    return false;
  }

  // Andere: rechteckig/quadratisch (Rotation tolerieren)
  if (parsed.kind === "rect") {
    if (approxEq(parsed.wCm, w) && approxEq(parsed.hCm, h)) return true;
    if (approxEq(parsed.wCm, h) && approxEq(parsed.hCm, w)) return true;
    return false;
  }

  if (parsed.kind === "single") {
    const major = Math.max(w, h);
    return approxEq(parsed.nCm, major);
  }

  return false;
}

function findVariantIdForColorAndSize({ shape, wCm, hCm, colorKey }, variants) {
  const list = Array.isArray(variants) ? variants : [];
  if (!list.length) return null;

  const ck = String(colorKey || "white");

  for (const v of list) {
    if (!variantMatchesColor(v, ck)) continue;
    const parsed = extractDimsFromVariant(v);
    if (!variantMatchesDims(shape, wCm, hCm, parsed)) continue;
    const id = Number(v?.id) || 0;
    if (id) return id;
  }

  return null;
}

// ✅ Mindestkante: kleinste Seite >= minCm (proportional hochskalieren)
function enforceMinEdgeCm(wCm, hCm, minCm = MIN_EDGE_CM) {
  let w = Number(wCm) || 0;
  let h = Number(hCm) || 0;

  if (!(w > 0) || !(h > 0)) {
    return { wCm: minCm, hCm: minCm, scaled: true, k: 1 };
  }

  const minSide = Math.min(w, h);
  if (minSide >= minCm) return { wCm: w, hCm: h, scaled: false, k: 1 };

  const k = minCm / minSide;
  return { wCm: w * k, hCm: h * k, scaled: true, k };
}

// ✅ Freiform: Proportionen fixieren (eine Dimension kommt vom User, die andere folgt)
function enforceAspectWithMinEdge({
  wCm,
  hCm,
  aspectWdivH,
  edited = "w",
  minEdgeCm = MIN_EDGE_CM,
  maxEdgeCm = 300,
}) {
  const ar = Number(aspectWdivH);
  const safeAr = Number.isFinite(ar) && ar > 1e-6 ? ar : 1;

  let w = Number(wCm);
  let h = Number(hCm);

  if (!Number.isFinite(w)) w = minEdgeCm;
  if (!Number.isFinite(h)) h = minEdgeCm;

  // Nachziehen nach editierter Dimension
  if (edited === "h") {
    h = clampNum(h, minEdgeCm, maxEdgeCm);
    w = h * safeAr;
  } else {
    w = clampNum(w, minEdgeCm, maxEdgeCm);
    h = w / safeAr;
  }

  // Clamp max (wenn eine Seite > max, proportional zurück)
  const maxSide = Math.max(w, h);
  if (maxSide > maxEdgeCm) {
    const k = maxEdgeCm / Math.max(1e-9, maxSide);
    w *= k;
    h *= k;
  }

  // Mindestkante erzwingen (proportional hoch)
  const r = enforceMinEdgeCm(w, h, minEdgeCm);
  w = r.wCm;
  h = r.hCm;

  // final clamp
  w = clampNum(w, minEdgeCm, maxEdgeCm);
  h = clampNum(h, minEdgeCm, maxEdgeCm);

  return { wCm: w, hCm: h, ar: safeAr };
}

// ✅ Freiform: freie Eingabe -> kleinste passende Abrechnungsgröße aus Katalog wählen (ceil)
function pickBillingSizeForFreeform(userWcm, userHcm, sizes) {
  const w = Math.max(0, Number(userWcm) || 0);
  const h = Math.max(0, Number(userHcm) || 0);
  if (!Array.isArray(sizes) || !sizes.length || w <= 0 || h <= 0) return null;

  const fits = [];
  for (const s of sizes) {
    const sw = Number(s?.wCm ?? s?.widthCm);
    const sh = Number(s?.hCm ?? s?.heightCm);
    if (!Number.isFinite(sw) || !Number.isFinite(sh) || sw <= 0 || sh <= 0) continue;

    const fitA = w <= sw && h <= sh;
    const fitB = w <= sh && h <= sw; // Rotation erlauben (Abrechnung)
    if (fitA || fitB) {
      fits.push({ ...s, _area: sw * sh, _max: Math.max(sw, sh) });
    }
  }

  if (fits.length) {
    fits.sort((a, b) => a._area - b._area || a._max - b._max);
    return fits[0];
  }

  // wenn nichts passt: größte nehmen (damit zumindest eine VariantId existiert)
  const sorted = [...sizes]
    .map((s) => {
      const sw = Number(s?.wCm ?? s?.widthCm);
      const sh = Number(s?.hCm ?? s?.heightCm);
      return { ...s, _area: (Number.isFinite(sw) ? sw : 0) * (Number.isFinite(sh) ? sh : 0) };
    })
    .sort((a, b) => b._area - a._area);
  return sorted[0] || null;
}

// ✅ Freiform: Bild-Aspekt in Billing-Box "contain" fitten
function fitAspectIntoBox(boxW, boxH, aspectWdivH) {
  const bw = Math.max(1e-9, Number(boxW) || 1);
  const bh = Math.max(1e-9, Number(boxH) || 1);
  const ar = Number(aspectWdivH) > 0 ? Number(aspectWdivH) : 1;

  let w = bw;
  let h = bw / ar;
  if (h > bh) {
    h = bh;
    w = bh * ar;
  }
  return { w, h };
}

// ==============================
// API Base (App Proxy kompatibel)
// ==============================
function getStickerRootEl() {
  if (typeof document === "undefined") return null;
  return (
    document.getElementById("sticker-configurator-root") ||
    document.querySelector(".sticker-embed-root") ||
    document.querySelector("[data-shape-handles]") ||
    null
  );
}

function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function getShapeHandleMap() {
  if (typeof window !== "undefined" && window.__SC_SHAPE_HANDLES__) {
    return window.__SC_SHAPE_HANDLES__;
  }

  const el = getStickerRootEl();
  const ds = el?.dataset || {};
  const jsonMap = ds.shapeHandles ? safeJsonParse(ds.shapeHandles) : null;
  if (jsonMap && typeof jsonMap === "object") return jsonMap;

  const out = {};
  if (ds.handleSquare) out.square = ds.handleSquare;
  if (ds.handleRect) out.rect = ds.handleRect;
  if (ds.handleRound) out.round = ds.handleRound;
  if (ds.handleOval) out.oval = ds.handleOval;
  if (ds.handleFreeform) out.freeform = ds.handleFreeform;

  // ✅ neu: getrennte Handles für abgerundet
  if (ds.handleSquareRounded) out.square_rounded = ds.handleSquareRounded;
  if (ds.handleRectRounded) out.rect_rounded = ds.handleRectRounded;

  // ✅ optional: eigene Handles für gedrehte Formen
  if (ds.handleRectLandscape) out.rect_landscape = ds.handleRectLandscape;
  if (ds.handleRectLandscapeRounded) out.rect_landscape_rounded = ds.handleRectLandscapeRounded;
  if (ds.handleOvalPortrait) out.oval_portrait = ds.handleOvalPortrait;

  if (ds.handleRounded) out.rounded = ds.handleRounded;

  return Object.keys(out).length ? out : null;
}

function guessCurrentProductHandle() {
  const h1 = window?.ShopifyAnalytics?.meta?.product?.handle;
  if (h1) return String(h1);

  const m = String(window.location?.pathname || "").match(/\/products\/([^\/]+)/);
  if (m?.[1]) return String(m[1]);

  return "";
}

// ✅ Embedded-App Support:
// In Shopify Admin iframe the origin is NOT the storefront domain.
// For price/variant lookups we try to discover the shop domain from common sources.
function guessShopDomain() {
  try {
    if (typeof window === "undefined") return "";

    // 1) Explicit global
    if (window.__SHOP_DOMAIN__) return String(window.__SHOP_DOMAIN__);

    // 2) Root dataset
    const el = getStickerRootEl();
    const ds = el?.dataset || {};
    if (ds.shopDomain) return String(ds.shopDomain);

    // 3) URL query (?shop=...)
    const sp = new URLSearchParams(String(window.location?.search || ""));
    const qShop = sp.get("shop");
    if (qShop) return String(qShop);

    // 4) App Bridge sometimes exposes shop
    const wShop = window?.Shopify?.shop;
    if (wShop) return String(wShop);
  } catch {}

  return "";
}

function normalizeShopDomain(shop) {
  const s = String(shop || "").trim();
  if (!s) return "";
  // strip protocol
  const noProto = s.replace(/^https?:\/\//i, "").replace(/\/$/, "");
  // keep only hostname-ish
  const host = noProto.split("/")[0];
  // very soft validation
  if (!host.includes(".")) return "";
  return host;
}

function resolveApiBase() {
  // 1) explicit override (global)
  if (typeof window !== "undefined" && window.__STICKER_API_BASE__) {
    return String(window.__STICKER_API_BASE__ || "").replace(/\/$/, "");
  }

  // 2) server-injected (root element)
  if (typeof document !== "undefined") {
    const el = document.getElementById("sticker-configurator-root");
    const base = el?.dataset?.apiBase;
    if (base) return String(base).replace(/\/$/, "");
  }

  // 3) auto-detect from current URL (works for Admin embedded apps: /apps/<handle>/...)
  try {
    const p = String(window?.location?.pathname || "");
    const m = p.match(/\/apps\/([^\/]+)(?:\/|$)/i);
    if (m && m[1]) return `/apps/${m[1]}`;
    const m2 = p.match(/\/proxy\/([^\/]+)(?:\/|$)/i);
    if (m2 && m2[1]) return `/proxy/${m2[1]}`;
  } catch {}

  // 4) fallback
  return "/apps/sticker-configurator";
}

function api(path) {
  const base = resolveApiBase();
  const p = String(path || "");
  if (/^https?:\/\//i.test(p)) return p;
  if (!p.startsWith("/")) return base ? `${base}/${p}` : `/${p}`;
  return base ? `${base}${p}` : p;
}

function isProbablyRemoteUrl(u) {
  const s = String(u || "").trim();
  return /^https?:\/\//i.test(s) || s.startsWith("//") || s.startsWith("/");
}

function isBlobUrl(u) {
  return String(u || "").startsWith("blob:");
}

// ==============================
// Rotated Shapes (UI-only derived from base shapes)
// ==============================
const ROTATED_SHAPE_META = {
  rect_landscape: { base: "rect", rotateDims: true },
  rect_landscape_rounded: { base: "rect_rounded", rotateDims: true },
  oval_portrait: { base: "oval", rotateDims: true },
};

function getShapeMeta(shape) {
  const s = String(shape || "").toLowerCase();
  return ROTATED_SHAPE_META[s] || { base: s, rotateDims: false };
}

// swaps "4 x 6 cm" -> "6 x 4 cm"
function flipSizeLabel(label) {
  const t = String(label || "");
  const m = t.match(/(\d+(?:[.,]\d+)?)\s*[x×]\s*(\d+(?:[.,]\d+)?)(.*)$/i);
  if (!m) return t;
  const a = m[1];
  const b = m[2];
  const rest = m[3] || "";
  return `${b} x ${a}${rest}`;
}

function isFixedVariantShape(s) {
  return [
    "square",
    "round",
    "rect",
    "oval",
    "square_rounded",
    "rect_rounded",
    "rect_landscape",
    "rect_landscape_rounded",
    "oval_portrait",
  ].includes(String(s || "").toLowerCase());
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.crossOrigin = "anonymous";
    im.decoding = "async";
    im.onload = async () => {
      try {
        if (im.decode) await im.decode();
      } catch {}
      resolve(im);
    };
    im.onerror = () => reject(new Error("Konnte Bild nicht laden."));
    im.src = src;
  });
}

async function ensureImageLoaded(src) {
  if (!src) throw new Error("Kein Bild gewählt.");
  return await loadImage(src);
}

async function readFileAsDataURL(file) {
  return await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error("Datei konnte nicht gelesen werden."));
    fr.readAsDataURL(file);
  });
}

function dataUrlToBlob(dataUrl) {
  const [meta, b64] = String(dataUrl || "").split(",");
  const mime = /data:(.*?);base64/.exec(meta || "")?.[1] || "application/octet-stream";
  const bin = atob(b64 || "");
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

async function uploadOriginalFile(file) {
  const fd = new FormData();
  fd.append("file", file);

  const res = await fetch(api("/api/upload"), {
    method: "POST",
    body: fd,
    credentials: "same-origin",
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(txt || "Upload fehlgeschlagen.");
  }

  const json = await res.json();
  return String(json?.url || "");
}

function createCheckerBg(size = 12) {
  return {
    backgroundImage: `
      linear-gradient(45deg, rgba(255,255,255,.08) 25%, transparent 25%),
      linear-gradient(-45deg, rgba(255,255,255,.08) 25%, transparent 25%),
      linear-gradient(45deg, transparent 75%, rgba(255,255,255,.08) 75%),
      linear-gradient(-45deg, transparent 75%, rgba(255,255,255,.08) 75%)
    `,
    backgroundSize: `${size}px ${size}px`,
    backgroundPosition: `0 0, 0 ${size / 2}px, ${size / 2}px -${size / 2}px, -${size / 2}px 0px`,
  };
}

function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function getSurfaceAspect(shape, widthCm, heightCm, imgAspect) {
  const ar = Math.max(0.0001, Number(imgAspect) || 1);

  switch (shape) {
    case "square":
    case "round":
    case "square_rounded":
      return 1;

    case "rect":
    case "rect_rounded":
    case "rect_landscape":
    case "rect_landscape_rounded": {
      const w = Math.max(0.0001, Number(widthCm) || 1);
      const h = Math.max(0.0001, Number(heightCm) || 1);
      return w / h;
    }

    case "oval":
    case "oval_portrait": {
      const w = Math.max(0.0001, Number(widthCm) || 1);
      const h = Math.max(0.0001, Number(heightCm) || 1);
      return w / h;
    }

    case "freeform":
      return ar;

    default:
      return ar;
  }
}

function calcContainRect(containerW, containerH, aspect) {
  const cw = Math.max(1, Number(containerW) || 1);
  const ch = Math.max(1, Number(containerH) || 1);
  const ar = Math.max(0.0001, Number(aspect) || 1);

  let w = cw;
  let h = w / ar;

  if (h > ch) {
    h = ch;
    w = h * ar;
  }

  return {
    width: Math.max(1, Math.round(w)),
    height: Math.max(1, Math.round(h)),
  };
}

// ==============================
// Catalog Normalizer
// ==============================
function normalizeCatalog(data) {
  const byShape = data?.byShape || data?.shapes || {};

  const out = {};
  for (const [shapeKey, rawShape] of Object.entries(byShape || {})) {
    const sizesRaw = Array.isArray(rawShape?.sizes) ? rawShape.sizes : [];
    const colorwaysRaw = Array.isArray(rawShape?.colorways) ? rawShape.colorways : FALLBACK_COLORWAYS;

    const sizes = sizesRaw
      .map((s) => {
        const wCm = Number(s?.wCm ?? s?.widthCm ?? 0);
        const hCm = Number(s?.hCm ?? s?.heightCm ?? 0);
        const sizeKey = String(s?.sizeKey || s?.key || "").trim();
        const label = String(s?.label || "").trim();
        const variantId = Number(s?.variantId || s?.variant_id || 0) || null;
        const price = Number(s?.price ?? s?.priceCents ?? 0) || 0;

        return {
          ...s,
          wCm,
          hCm,
          sizeKey,
          label,
          variantId,
          price,
        };
      })
      .filter((s) => s.wCm > 0 && s.hCm > 0);

    const colorways = colorwaysRaw.map((c) => ({
      ...c,
      colorKey: String(c?.colorKey || c?.key || "").toLowerCase() || "white",
      label: String(c?.label || c?.title || c?.name || "").trim() || "Weiß",
    }));

    out[String(shapeKey).toLowerCase()] = {
      ...rawShape,
      sizes,
      colorways,
    };
  }

  return { byShape: out };
}

// ==============================
// Freeform / Mask Utils
// ==============================
function getImageDataFromCanvas(canvas) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas-Kontext nicht verfügbar.");
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

function alphaMaskFromImageData(imageData, alphaThreshold = 8) {
  const { width, height, data } = imageData;
  const mask = new Uint8Array(width * height);

  for (let i = 0; i < width * height; i++) {
    const a = data[i * 4 + 3];
    mask[i] = a >= alphaThreshold ? 1 : 0;
  }

  return { mask, width, height };
}

function maskBBox(mask, width, height) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (mask[row + x]) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < minX || maxY < minY) {
    return {
      minX: 0,
      minY: 0,
      maxX: width - 1,
      maxY: height - 1,
      width,
      height,
    };
  }

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
}

// Morphological dilation / erosion
function dilateMask(mask, width, height, radius) {
  const r = Math.max(0, Math.floor(radius || 0));
  if (r <= 0) return mask.slice();

  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(height - 1, y + r);
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(width - 1, x + r);

      let v = 0;
      outer: for (let yy = y0; yy <= y1; yy++) {
        const row = yy * width;
        for (let xx = x0; xx <= x1; xx++) {
          if (mask[row + xx]) {
            v = 1;
            break outer;
          }
        }
      }
      out[y * width + x] = v;
    }
  }
  return out;
}

function erodeMask(mask, width, height, radius) {
  const r = Math.max(0, Math.floor(radius || 0));
  if (r <= 0) return mask.slice();

  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(height - 1, y + r);
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(width - 1, x + r);

      let v = 1;
      outer: for (let yy = y0; yy <= y1; yy++) {
        const row = yy * width;
        for (let xx = x0; xx <= x1; xx++) {
          if (!mask[row + xx]) {
            v = 0;
            break outer;
          }
        }
      }
      out[y * width + x] = v;
    }
  }
  return out;
}

function closeMask(mask, width, height, radius = 1) {
  if (!(radius > 0)) return mask.slice();
  const d = dilateMask(mask, width, height, radius);
  return erodeMask(d, width, height, radius);
}

// Exakte (kreisförmige) Dilation – für Randmaske/Cutline
function buildDiskOffsets(radius) {
  const r = Math.max(0, Math.floor(radius || 0));
  const pts = [];
  const r2 = r * r;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy <= r2) pts.push([dx, dy]);
    }
  }
  return pts;
}

function dilateMaskExact(mask, width, height, radius) {
  const r = Math.max(0, Math.floor(radius || 0));
  if (r <= 0) return mask.slice();

  const out = new Uint8Array(width * height);
  const pts = buildDiskOffsets(r);

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let v = 0;
      for (let i = 0; i < pts.length; i++) {
        const xx = x + pts[i][0];
        const yy = y + pts[i][1];
        if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
        if (mask[yy * width + xx]) {
          v = 1;
          break;
        }
      }
      out[row + x] = v;
    }
  }
  return out;
}

// Floodfill from transparent image borders -> outside mask
function outsideMaskFromInside(mask, width, height) {
  const outside = new Uint8Array(width * height);
  const qx = new Int32Array(width * height);
  const qy = new Int32Array(width * height);
  let qs = 0;
  let qe = 0;

  function push(x, y) {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const idx = y * width + x;
    if (outside[idx] || mask[idx]) return;
    outside[idx] = 1;
    qx[qe] = x;
    qy[qe] = y;
    qe++;
  }

  for (let x = 0; x < width; x++) {
    push(x, 0);
    push(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    push(0, y);
    push(width - 1, y);
  }

  while (qs < qe) {
    const x = qx[qs];
    const y = qy[qs];
    qs++;

    push(x + 1, y);
    push(x - 1, y);
    push(x, y + 1);
    push(x, y - 1);
  }

  return outside;
}

function insideMaskWithHolesFilled(mask, width, height) {
  const outside = outsideMaskFromInside(mask, width, height);
  const out = new Uint8Array(width * height);
  for (let i = 0; i < out.length; i++) {
    out[i] = outside[i] ? 0 : 1;
  }
  return out;
}

function cropCanvasToBBox(canvas, bbox, pad = 0) {
  const px = Math.max(0, Math.round(pad || 0));
  const x = Math.max(0, bbox.minX - px);
  const y = Math.max(0, bbox.minY - px);
  const w = Math.min(canvas.width - x, bbox.width + px * 2);
  const h = Math.min(canvas.height - y, bbox.height + px * 2);

  const out = document.createElement("canvas");
  out.width = Math.max(1, w);
  out.height = Math.max(1, h);

  const ctx = out.getContext("2d");
  if (!ctx) return out;

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(canvas, x, y, w, h, 0, 0, w, h);
  return out;
}

function maskToAlphaCanvas(mask, width, height) {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  const ctx = c.getContext("2d");
  if (!ctx) return c;

  const img = ctx.createImageData(width, height);
  const d = img.data;

  for (let i = 0; i < mask.length; i++) {
    const a = mask[i] ? 255 : 0;
    d[i * 4 + 0] = 255;
    d[i * 4 + 1] = 255;
    d[i * 4 + 2] = 255;
    d[i * 4 + 3] = a;
  }

  ctx.putImageData(img, 0, 0);
  return c;
}

function canvasToObjectUrl(canvas, type = "image/png", quality) {
  return new Promise((resolve) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) return resolve("");
        resolve(URL.createObjectURL(blob));
      },
      type,
      quality
    );
  });
}

function fitWithinLongSide(w, h, maxLong = FREEFORM_MASTER_LONG_SIDE) {
  const longSide = Math.max(1, w, h);
  const scale = Math.min(1, maxLong / longSide);
  return {
    w: Math.max(1, Math.round(w * scale)),
    h: Math.max(1, Math.round(h * scale)),
    scale,
  };
}

async function buildFreeformMasterFromImageUrl(imageUrl) {
  const img = await ensureImageLoaded(imageUrl);

  const srcW = img.naturalWidth || img.width || 1;
  const srcH = img.naturalHeight || img.height || 1;

  const fitted = fitWithinLongSide(srcW, srcH, FREEFORM_MASTER_LONG_SIDE);

  const srcCanvas = document.createElement("canvas");
  srcCanvas.width = fitted.w;
  srcCanvas.height = fitted.h;

  const sctx = srcCanvas.getContext("2d", { willReadFrequently: true });
  if (!sctx) throw new Error("Canvas-Kontext nicht verfügbar.");
  sctx.imageSmoothingEnabled = true;
  sctx.imageSmoothingQuality = "high";
  sctx.clearRect(0, 0, fitted.w, fitted.h);
  sctx.drawImage(img, 0, 0, fitted.w, fitted.h);

  const imgData = getImageDataFromCanvas(srcCanvas);
  let { mask, width, height } = alphaMaskFromImageData(imgData, 8);

  // ✅ kleine Schlitze/Lücken schließen und Innenlöcher füllen
  if (FREEFORM_SEAL_GAPS_PX > 0) {
    mask = closeMask(mask, width, height, FREEFORM_SEAL_GAPS_PX);
  }
  mask = insideMaskWithHolesFilled(mask, width, height);

  const bb = maskBBox(mask, width, height);

  const croppedCanvas = cropCanvasToBBox(srcCanvas, bb, 0);
  const croppedW = croppedCanvas.width;
  const croppedH = croppedCanvas.height;

  const croppedData = getImageDataFromCanvas(croppedCanvas);
  let croppedMask = alphaMaskFromImageData(croppedData, 8).mask;

  // Sicherheit: gleiche Closing/Filling im Crop wiederholen
  if (FREEFORM_SEAL_GAPS_PX > 0) {
    croppedMask = closeMask(croppedMask, croppedW, croppedH, FREEFORM_SEAL_GAPS_PX);
  }
  croppedMask = insideMaskWithHolesFilled(croppedMask, croppedW, croppedH);

  const bb2 = maskBBox(croppedMask, croppedW, croppedH);

  // optional nochmals enger zuschneiden auf endgültige Maske
  const finalCanvas = cropCanvasToBBox(croppedCanvas, bb2, 0);
  const finalW = finalCanvas.width;
  const finalH = finalCanvas.height;

  const finalData = getImageDataFromCanvas(finalCanvas);
  let finalMask = alphaMaskFromImageData(finalData, 8).mask;
  if (FREEFORM_SEAL_GAPS_PX > 0) {
    finalMask = closeMask(finalMask, finalW, finalH, FREEFORM_SEAL_GAPS_PX);
  }
  finalMask = insideMaskWithHolesFilled(finalMask, finalW, finalH);

  // Preview downscale version (only for UI objectURL)
  const fittedPreview = fitWithinLongSide(finalW, finalH, FREEFORM_PREVIEW_MAX_SIDE);
  const previewCanvas = document.createElement("canvas");
  previewCanvas.width = fittedPreview.w;
  previewCanvas.height = fittedPreview.h;
  const pctx = previewCanvas.getContext("2d");
  if (!pctx) throw new Error("Canvas-Kontext nicht verfügbar.");
  pctx.imageSmoothingEnabled = true;
  pctx.imageSmoothingQuality = "high";
  pctx.clearRect(0, 0, fittedPreview.w, fittedPreview.h);
  pctx.drawImage(finalCanvas, 0, 0, fittedPreview.w, fittedPreview.h);

  const previewUrl = await canvasToObjectUrl(previewCanvas, "image/png");

  return {
    src: finalCanvas,
    srcW: srcW,
    srcH: srcH,
    masterW: finalW,
    masterH: finalH,
    insideMask: finalMask,
    mw: finalW,
    mh: finalH,
    previewUrl,
    aspect: finalW / Math.max(1, finalH),
    _cache: new Map(), // borderPx -> {backingMask, backingC}
  };
}

// Render: Freiform-Sticker (Bild + optional weißer Rand / transparenter Hintergrund)
function renderFreeformStickerCanvasFromMaster({
  master,
  outWpx,
  outHpx,
  borderPx,
  bgColor,
  isTransparentBg,
  forExport = false,
}) {
  const outW = Math.max(1, Math.round(outWpx));
  const outH = Math.max(1, Math.round(outHpx));

  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;

  ctx.clearRect(0, 0, outW, outH);

  // Border in mask-px umrechnen (bezogen auf Zielbreite)
  const pxPerMask = outW / Math.max(1, master.mw);
  const borderInMaskPx = Math.max(1, Math.round((borderPx || 0) / Math.max(1e-9, pxPerMask)));

  let cached = master?._cache?.get?.(borderInMaskPx);
  if (!cached) {
    const backingMask = dilateMaskExact(master.insideMask, master.mw, master.mh, borderInMaskPx);
    const backingC = maskToAlphaCanvas(backingMask, master.mw, master.mh);
    cached = { backingMask, backingC };
    master._cache.set(borderInMaskPx, cached);
    if (master._cache.size > 12) {
      const firstKey = master._cache.keys().next().value;
      master._cache.delete(firstKey);
    }
  }

  const { backingMask, backingC } = cached;
  const bb = maskBBox(backingMask, master.mw, master.mh);

  // knapp auf Stickerfläche zuschneiden
  const M = 3;
  const minX = Math.max(0, bb.minX - M);
  const minY = Math.max(0, bb.minY - M);
  const maxX = Math.min(master.mw - 1, bb.maxX + M);
  const maxY = Math.min(master.mh - 1, bb.maxY + M);

  const cropW = maxX - minX + 1;
  const cropH = maxY - minY + 1;

  // contain in Output
  const s = Math.min(outW / cropW, outH / cropH);
  const drawW = Math.max(1, Math.round(cropW * s));
  const drawH = Math.max(1, Math.round(cropH * s));

  const dx = Math.round((outW - drawW) / 2);
  const dy = Math.round((outH - drawH) / 2);

  const offX = dx - Math.round(minX * s);
  const offY = dy - Math.round(minY * s);

  // 1) Weißer Rand / Film
  if (!isTransparentBg) {
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.globalCompositeOperation = "source-over";
    ctx.drawImage(backingC, 0, 0, master.mw, master.mh, offX, offY, Math.round(master.mw * s), Math.round(master.mh * s));

    ctx.globalCompositeOperation = "source-in";
    ctx.fillStyle = bgColor || "#ffffff";
    ctx.fillRect(0, 0, outW, outH);
    ctx.restore();
  } else if (!forExport) {
    // Preview-Hilfe bei transparentem Material
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.globalCompositeOperation = "source-over";
    ctx.drawImage(backingC, 0, 0, master.mw, master.mh, offX, offY, Math.round(master.mw * s), Math.round(master.mh * s));

    ctx.globalCompositeOperation = "source-in";
    ctx.fillStyle = "rgba(255,255,255,0.06)";
    ctx.fillRect(0, 0, outW, outH);
    ctx.restore();

    try {
      const innerMask = dilateMaskExact(master.insideMask, master.mw, master.mh, Math.max(0, borderInMaskPx - 1));
      const ringMask = new Uint8Array(master.mw * master.mh);
      for (let i = 0; i < ringMask.length; i++) ringMask[i] = backingMask[i] && !innerMask[i] ? 1 : 0;
      const ringC = maskToAlphaCanvas(ringMask, master.mw, master.mh);

      ctx.save();
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.globalCompositeOperation = "source-over";
      ctx.drawImage(ringC, 0, 0, master.mw, master.mh, offX, offY, Math.round(master.mw * s), Math.round(master.mh * s));
      ctx.globalCompositeOperation = "source-in";
      ctx.fillStyle = "rgba(255,255,255,0.35)";
      ctx.fillRect(0, 0, outW, outH);
      ctx.restore();
    } catch {}
  }

  // 2) Originalbild
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.globalCompositeOperation = "source-over";
  ctx.drawImage(master.src, 0, 0, master.masterW, master.masterH, offX, offY, Math.round(master.masterW * s), Math.round(master.masterH * s));
  ctx.restore();

  // 3) Auf Stickerkontur maskieren
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.globalCompositeOperation = "destination-in";
  ctx.drawImage(backingC, 0, 0, master.mw, master.mh, offX, offY, Math.round(master.mw * s), Math.round(master.mh * s));
  ctx.restore();

  return canvas;
}

// Export: Maske der Freiform inkl. Rand als DataURL erzeugen (für Cutline im SVG)
// Liefert eine weiße Maske (RGB=weiß) mit Alpha aus der Rand-Maske.
function renderFreeformMaskDataUrlFromMasterMask({ master, outWpx, outHpx, borderPx }) {
  const outW = Math.max(1, Math.round(outWpx));
  const outH = Math.max(1, Math.round(outHpx));

  const pxPerMask = outW / Math.max(1, master.mw);
  const borderInMaskPx = Math.max(1, Math.round((borderPx || 0) / Math.max(1e-9, pxPerMask)));

  let cached = master?._cache?.get?.(borderInMaskPx);
  if (!cached) {
    const backingMask = dilateMaskExact(master.insideMask, master.mw, master.mh, borderInMaskPx);
    const backingC = maskToAlphaCanvas(backingMask, master.mw, master.mh);
    cached = { backingMask, backingC };
    master._cache.set(borderInMaskPx, cached);
    if (master._cache.size > 12) {
      const firstKey = master._cache.keys().next().value;
      master._cache.delete(firstKey);
    }
  }

  const { backingMask, backingC } = cached;
  const bb = maskBBox(backingMask, master.mw, master.mh);

  const M = 3;
  const minX = Math.max(0, bb.minX - M);
  const minY = Math.max(0, bb.minY - M);
  const maxX = Math.min(master.mw - 1, bb.maxX + M);
  const maxY = Math.min(master.mh - 1, bb.maxY + M);

  const sx = outW / Math.max(1, master.mw);
  const sy = outH / Math.max(1, master.mh);

  const cropW = Math.max(1, Math.round((maxX - minX + 1) * sx));
  const cropH = Math.max(1, Math.round((maxY - minY + 1) * sy));

  const canvas = document.createElement("canvas");
  canvas.width = cropW;
  canvas.height = cropH;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";

  const offX = -minX * sx;
  const offY = -minY * sy;

  ctx.clearRect(0, 0, cropW, cropH);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.globalCompositeOperation = "source-over";
  ctx.drawImage(backingC, 0, 0, master.mw, master.mh, offX, offY, outW, outH);

  // In "weiße Maske" umwandeln: RGB=255, Alpha bleibt erhalten
  const img = ctx.getImageData(0, 0, cropW, cropH);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    if (a > 0) {
      d[i] = 255;
      d[i + 1] = 255;
      d[i + 2] = 255;
    } else {
      d[i] = 0;
      d[i + 1] = 0;
      d[i + 2] = 0;
    }
  }
  ctx.putImageData(img, 0, 0);

  return canvas.toDataURL("image/png");
}

function composeStickerIntoBillingBox({ stickerCanvas, boxWpx, boxHpx }) {
  const bw = Math.max(1, Math.round(boxWpx));
  const bh = Math.max(1, Math.round(boxHpx));

  const out = document.createElement("canvas");
  out.width = bw;
  out.height = bh;

  const ctx = out.getContext("2d");
  if (!ctx) return out;

  ctx.clearRect(0, 0, bw, bh);

  const sw = stickerCanvas?.width || 1;
  const sh = stickerCanvas?.height || 1;

  const s = Math.min(bw / sw, bh / sh);
  const dw = Math.max(1, Math.round(sw * s));
  const dh = Math.max(1, Math.round(sh * s));

  const dx = Math.round((bw - dw) / 2);
  const dy = Math.round((bh - dh) / 2);

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(stickerCanvas, dx, dy, dw, dh);

  return out;
}

// ==============================
// Component
// ==============================
export default function StickerCanvasClient({
  productId = null,
  defaultShape = "square",
  defaultWidthCm = 4,
  defaultHeightCm = 4,
  defaultBgColor = "#ffffff",
  defaultImageUrl = "",
}) {
  // --- Variant Catalog (from loader) ---
  const [catalog, setCatalog] = useState(null);

  const [shape, setShape] = useState(String(defaultShape || "square").toLowerCase());

  // ✅ meta für gedrehte Formen (base + rotate flag)
  const shapeMeta = useMemo(() => getShapeMeta(shape), [shape]);
  const baseShapeKey = String(shapeMeta?.base || shape || "").toLowerCase();

  const [colorKey, setColorKey] = useState("white"); // "white" | "transparent" | "colored"
  const [sizeKey, setSizeKey] = useState(""); // e.g. "4x4", "d4" (oder bei Freiform: Billing-Klasse auto)

  const [widthCm, setWidthCm] = useState(clampNum(defaultWidthCm, 1, 300));
  const [heightCm, setHeightCm] = useState(clampNum(defaultHeightCm, 1, 300));

  // Freiform: user wählt diese Maße frei (cm)
  const [billingWidthCm, setBillingWidthCm] = useState(clampNum(defaultWidthCm, 1, 300));
  const [billingHeightCm, setBillingHeightCm] = useState(clampNum(defaultHeightCm, 1, 300));

  // ✅ Freiform: Original-Sticker-Aspect (aus Maske) – wird genutzt um Billing proportional zu halten
  const [freeformCutAspect, setFreeformCutAspect] = useState(1);
  const lastFreeformEditRef = useRef("w"); // "w" | "h"

  const [bgMode, setBgMode] = useState("color"); // "color" | "white" | "transparent"

  // ✅ bgMode (UI) -> colorKey (Catalog/Variant-Matching)
  // Ohne diese Kopplung bleibt colorKey z.B. auf "white" und es wird immer die White-Variante (und ihr Preis) verwendet.
  useEffect(() => {
    const next = bgMode === "white" ? "white" : bgMode === "transparent" ? "transparent" : "colored";
    if (String(next) !== String(colorKey)) setColorKey(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bgMode]);
  const [bgColor, setBgColor] = useState(defaultBgColor || "#ffffff");

  const bgColorEff = useMemo(() => {
    if (bgMode === "white") return "#ffffff";
    if (bgMode === "transparent") return "transparent";
    return bgColor || "#ffffff";
  }, [bgMode, bgColor]);

  const hasBgFill = bgMode !== "transparent";

  useEffect(() => {
    if (bgMode === "white") setBgColor("#ffffff");
  }, [bgMode]);

  const [imageUrl, setImageUrl] = useState(defaultImageUrl || "");

  const [uploadedUrl, setUploadedUrl] = useState(() =>
    defaultImageUrl && isProbablyRemoteUrl(defaultImageUrl) ? defaultImageUrl : ""
  );

  const [freeformBorderMm, setFreeformBorderMm] = useState(3);
  const [borderDraftMm, setBorderDraftMm] = useState(3);
  useEffect(() => setBorderDraftMm(freeformBorderMm), [freeformBorderMm]);

  // Preis/Varianten
  const [productVariants, setProductVariants] = useState([]);
  const [selectedVariantId, setSelectedVariantId] = useState(() => Number(productId) || 0);
  const [selectedVariantPrice, setSelectedVariantPrice] = useState(0);
  const [selectedVariantTitle, setSelectedVariantTitle] = useState("");

  const [realPieces, setRealPieces] = useState(1);
  const [priceTotal, setPriceTotal] = useState(0);

  const [uploading, setUploading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [addedMsg, setAddedMsg] = useState("");
  const [goToCartAfterAdd, setGoToCartAfterAdd] = useState(true);

  // File refs
  const fileInputRef = useRef(null);
  const pendingFileRef = useRef(null);
  const remoteUploadPromiseRef = useRef(null);
  const uploadGenIdRef = useRef(0);
  const localPreviewUrlRef = useRef(null);

  // Preview refs/state
  const [imgAspect, setImgAspect] = useState(1);
  const [freeformPreviewUrl, setFreeformPreviewUrl] = useState("");
  const [freeformPreviewAspect, setFreeformPreviewAspect] = useState(1);
  const [freeformMaster, setFreeformMaster] = useState(null);
  const freeformPreviewObjUrlRef = useRef(null);

  const [serverPreviewUrl, setServerPreviewUrl] = useState("");
  const serverPreviewAbortRef = useRef(null);
  const serverPreviewDebounceRef = useRef(null);
  const lastServerPreviewKeyRef = useRef("");
  const serverPreviewReqIdRef = useRef(0);
  const lastGoodServerPreviewRef = useRef("");

  // Image cache
  const imgElRef = useRef(null);
  const imgElUrlRef = useRef("");

  // ✅ Viewport (Fallback) + echte Preview-Fläche messen
  const [vp, setVp] = useState(() => ({
    w: typeof window !== "undefined" ? window.innerWidth : 1200,
    h: typeof window !== "undefined" ? window.innerHeight : 800,
  }));
  const rightPanelRef = useRef(null);
  const [previewHostBox, setPreviewHostBox] = useState({ w: 0, h: 0 });

  useEffect(() => {
    function onResize() {
      setVp({
        w: typeof window !== "undefined" ? window.innerWidth : 1200,
        h: typeof window !== "undefined" ? window.innerHeight : 800,
      });
    }
    if (typeof window !== "undefined") {
      window.addEventListener("resize", onResize);
      return () => window.removeEventListener("resize", onResize);
    }
  }, []);

  // ✅ echte nutzbare Fläche des rechten Panels messen
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const el = rightPanelRef.current;
    if (!el) return;

    const ro = new ResizeObserver((entries) => {
      const entry = entries?.[0];
      const rect = entry?.contentRect;
      if (!rect) return;
      setPreviewHostBox({
        w: Math.max(0, Math.floor(rect.width)),
        h: Math.max(0, Math.floor(rect.height)),
      });
    });

    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Load catalog
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const params = new URLSearchParams();
        const shop = normalizeShopDomain(guessShopDomain());
        const handle = guessCurrentProductHandle();
        if (shop) params.set("shop", shop);
        if (handle) params.set("handle", handle);

        const url = api(`/api/catalog${params.toString() ? `?${params.toString()}` : ""}`);
        const res = await fetch(url, { credentials: "same-origin" });
        if (!res.ok) throw new Error(`Catalog ${res.status}`);
        const json = await res.json();
        if (!alive) return;

        const norm = normalizeCatalog(json || {});
        setCatalog(norm);
      } catch (err) {
        console.error("Catalog load failed", err);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Load product variants
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const params = new URLSearchParams();
        const shop = normalizeShopDomain(guessShopDomain());
        const handle = guessCurrentProductHandle();
        if (shop) params.set("shop", shop);
        if (handle) params.set("handle", handle);

        const res = await fetch(api(`/api/product-variants${params.toString() ? `?${params.toString()}` : ""}`), {
          credentials: "same-origin",
        });
        if (!res.ok) throw new Error(`product-variants ${res.status}`);
        const json = await res.json();
        if (!alive) return;
        const variants = Array.isArray(json?.variants) ? json.variants : [];
        setProductVariants(variants);
      } catch (err) {
        console.error("Product variants load failed", err);
        setProductVariants([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Sync image aspect
  useEffect(() => {
    let active = true;

    async function run() {
      if (!imageUrl) {
        setImgAspect(1);
        return;
      }
      try {
        const img = await ensureImageLoaded(imageUrl);
        if (!active) return;
        const w = img.naturalWidth || img.width || 1;
        const h = img.naturalHeight || img.height || 1;
        setImgAspect(w / Math.max(1, h));
      } catch {
        if (!active) return;
        setImgAspect(1);
      }
    }

    run();
    return () => {
      active = false;
    };
  }, [imageUrl]);

  // Cache HTMLImageElement
  useEffect(() => {
    let canceled = false;

    async function run() {
      if (!imageUrl) {
        imgElRef.current = null;
        imgElUrlRef.current = "";
        return;
      }
      if (imgElUrlRef.current === imageUrl && imgElRef.current) return;

      try {
        const img = await ensureImageLoaded(imageUrl);
        if (canceled) return;
        imgElRef.current = img;
        imgElUrlRef.current = imageUrl;
      } catch {
        if (canceled) return;
        imgElRef.current = null;
        imgElUrlRef.current = "";
      }
    }

    run();
    return () => {
      canceled = true;
    };
  }, [imageUrl]);

  // Build freeform master/preview from image
  useEffect(() => {
    let canceled = false;

    async function run() {
      if (baseShapeKey !== "freeform" || !imageUrl) {
        setFreeformMaster(null);
        setFreeformPreviewAspect(1);
        setFreeformCutAspect(1);
        if (freeformPreviewObjUrlRef.current) {
          URL.revokeObjectURL(freeformPreviewObjUrlRef.current);
          freeformPreviewObjUrlRef.current = null;
        }
        setFreeformPreviewUrl("");
        return;
      }

      try {
        const master = await buildFreeformMasterFromImageUrl(imageUrl);
        if (canceled) {
          if (master?.previewUrl) URL.revokeObjectURL(master.previewUrl);
          return;
        }

        setFreeformMaster(master);
        setFreeformPreviewAspect(master.aspect || 1);

        // ✅ exakte Freiform-Aspect aus finaler Mask-BBox
        const bb = maskBBox(master.insideMask, master.mw, master.mh);
        const cutAr = bb.width / Math.max(1, bb.height);
        setFreeformCutAspect(cutAr || master.aspect || imgAspect || 1);

        if (freeformPreviewObjUrlRef.current) {
          URL.revokeObjectURL(freeformPreviewObjUrlRef.current);
          freeformPreviewObjUrlRef.current = null;
        }
        freeformPreviewObjUrlRef.current = master.previewUrl || "";
        setFreeformPreviewUrl(master.previewUrl || "");
      } catch (err) {
        console.error("freeform preview build failed", err);
        if (canceled) return;
        setFreeformMaster(null);
        setFreeformPreviewAspect(imgAspect || 1);
        setFreeformCutAspect(imgAspect || 1);
        if (freeformPreviewObjUrlRef.current) {
          URL.revokeObjectURL(freeformPreviewObjUrlRef.current);
          freeformPreviewObjUrlRef.current = null;
        }
        setFreeformPreviewUrl("");
      }
    }

    run();
    return () => {
      canceled = true;
    };
  }, [baseShapeKey, imageUrl, imgAspect]);

  // Freeform dimensions: keep aspect and minimum edge
  useEffect(() => {
    if (baseShapeKey !== "freeform") return;

    const ar = freeformCutAspect || imgAspect || 1;
    const fixed = enforceAspectWithMinEdge({
      wCm: billingWidthCm,
      hCm: billingHeightCm,
      aspectWdivH: ar,
      edited: lastFreeformEditRef.current || "w",
      minEdgeCm: MIN_EDGE_CM,
      maxEdgeCm: 300,
    });

    if (!approxEq(fixed.wCm, billingWidthCm) || !approxEq(fixed.hCm, billingHeightCm)) {
      setBillingWidthCm(fixed.wCm);
      setBillingHeightCm(fixed.hCm);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseShapeKey, freeformCutAspect]);

  const shapeCatalog = useMemo(() => {
    if (!catalog?.byShape) return null;
    return catalog.byShape[baseShapeKey] || null;
  }, [catalog, baseShapeKey]);

  const colorways = useMemo(() => {
    return Array.isArray(shapeCatalog?.colorways) && shapeCatalog.colorways.length
      ? shapeCatalog.colorways
      : FALLBACK_COLORWAYS;
  }, [shapeCatalog]);

  const sizeOptions = useMemo(() => {
    const raw = Array.isArray(shapeCatalog?.sizes) ? shapeCatalog.sizes : [];
    if (!raw.length) return [];

    // Gedrehte UI-Formen drehen nur die Darstellung/Labels, nicht die Basisdaten
    if (shapeMeta?.rotateDims) {
      return raw.map((s) => ({
        ...s,
        wCm: Number(s?.hCm ?? s?.heightCm ?? s?.wCm ?? 0),
        hCm: Number(s?.wCm ?? s?.widthCm ?? s?.hCm ?? 0),
        label: flipSizeLabel(s?.label || ""),
      }));
    }

    return raw;
  }, [shapeCatalog, shapeMeta]);

  // Init / keep valid color
  useEffect(() => {
    if (!colorways.length) return;
    const found = colorways.find((c) => c.colorKey === colorKey);
    if (!found) setColorKey(colorways[0].colorKey || "white");
  }, [colorways, colorKey]);

  // Auto-select size for fixed shapes
  useEffect(() => {
    if (!sizeOptions.length) {
      setSizeKey("");
      return;
    }

    if (baseShapeKey === "freeform") return;

    const current = sizeOptions.find((s) => String(s.sizeKey) === String(sizeKey));
    if (current) return;

    const match = sizeOptions.find((s) => approxEq(s.wCm, widthCm) && approxEq(s.hCm, heightCm));
    if (match) {
      setSizeKey(match.sizeKey);
      return;
    }

    setSizeKey(sizeOptions[0].sizeKey || "");
  }, [sizeOptions, sizeKey, widthCm, heightCm, baseShapeKey]);

  // Apply selected fixed size to dimensions
  useEffect(() => {
    if (baseShapeKey === "freeform") return;
    const s = sizeOptions.find((x) => String(x.sizeKey) === String(sizeKey));
    if (!s) return;
    if (!approxEq(widthCm, s.wCm)) setWidthCm(s.wCm);
    if (!approxEq(heightCm, s.hCm)) setHeightCm(s.hCm);
  }, [sizeKey, sizeOptions, widthCm, heightCm, baseShapeKey]);

  // Freeform: billing size auto-pick from user input
  const freeformBillingSize = useMemo(() => {
    if (baseShapeKey !== "freeform") return null;

    // user dimensions are billingWidthCm / billingHeightCm and already kept proportional
    return pickBillingSizeForFreeform(billingWidthCm, billingHeightCm, sizeOptions);
  }, [baseShapeKey, billingWidthCm, billingHeightCm, sizeOptions]);

  // Sync freeform sizeKey from picked billing size
  useEffect(() => {
    if (baseShapeKey !== "freeform") return;
    const sk = String(freeformBillingSize?.sizeKey || "");
    if (sk && sk !== String(sizeKey)) setSizeKey(sk);
  }, [baseShapeKey, freeformBillingSize, sizeKey]);

  // Effective displayed dimensions / pricing dimensions
  const effectiveDims = useMemo(() => {
    if (baseShapeKey === "freeform") {
      const eff = enforceAspectWithMinEdge({
        wCm: billingWidthCm,
        hCm: billingHeightCm,
        aspectWdivH: freeformCutAspect || imgAspect || 1,
        edited: lastFreeformEditRef.current || "w",
        minEdgeCm: MIN_EDGE_CM,
        maxEdgeCm: 300,
      });

      return {
        visualWcm: eff.wCm,
        visualHcm: eff.hCm,
        billingWcm: Number(freeformBillingSize?.wCm ?? freeformBillingSize?.widthCm ?? eff.wCm),
        billingHcm: Number(freeformBillingSize?.hCm ?? freeformBillingSize?.heightCm ?? eff.hCm),
      };
    }

    return {
      visualWcm: widthCm,
      visualHcm: heightCm,
      billingWcm: widthCm,
      billingHcm: heightCm,
    };
  }, [baseShapeKey, billingWidthCm, billingHeightCm, widthCm, heightCm, freeformBillingSize, freeformCutAspect, imgAspect]);

  // Selected variant
  useEffect(() => {
    const visualWcm = effectiveDims.visualWcm;
    const visualHcm = effectiveDims.visualHcm;
    const billingWcm = effectiveDims.billingWcm;
    const billingHcm = effectiveDims.billingHcm;

    let nextVariantId = null;

    // 1) Prefer exact size + color
    nextVariantId = findVariantIdForColorAndSize(
      {
        shape: baseShapeKey === "freeform" ? "rect" : baseShapeKey,
        wCm: billingWcm,
        hCm: billingHcm,
        colorKey,
      },
      productVariants
    );

    // 2) Fallback by size only
    if (!nextVariantId) {
      nextVariantId = findBestVariantIdForSize(
        {
          shape: baseShapeKey === "freeform" ? "rect" : baseShapeKey,
          wCm: billingWcm,
          hCm: billingHcm,
        },
        productVariants
      );
    }

    // 3) Fallback from catalog size option
    if (!nextVariantId) {
      const opt =
        baseShapeKey === "freeform"
          ? freeformBillingSize
          : sizeOptions.find((s) => String(s.sizeKey) === String(sizeKey));
      nextVariantId = Number(opt?.variantId || 0) || null;
    }

    if (nextVariantId) setSelectedVariantId(Number(nextVariantId));

    const variant = productVariants.find((v) => Number(v?.id) === Number(nextVariantId));
    const price =
      Number(variant?.price ?? 0) ||
      Number(
        (
          baseShapeKey === "freeform"
            ? freeformBillingSize?.price
            : sizeOptions.find((s) => String(s.sizeKey) === String(sizeKey))?.price
        ) ?? 0
      ) ||
      0;

    setSelectedVariantPrice(toEuroFromCents(price));
    setSelectedVariantTitle(String(variant?.title || ""));

    const pieces = calcPiecesFixed(baseShapeKey === "freeform" ? "rect" : baseShapeKey, visualWcm, visualHcm);
    setRealPieces(pieces);
    setPriceTotal(Math.round(toEuroFromCents(price) * pieces * 100) / 100);
  }, [
    productVariants,
    sizeOptions,
    sizeKey,
    colorKey,
    baseShapeKey,
    effectiveDims,
    freeformBillingSize,
  ]);

  // Debounced server preview for non-freeform exports/previews
  useEffect(() => {
    if (baseShapeKey === "freeform") return;

    if (serverPreviewDebounceRef.current) {
      clearTimeout(serverPreviewDebounceRef.current);
      serverPreviewDebounceRef.current = null;
    }
    if (serverPreviewAbortRef.current) {
      serverPreviewAbortRef.current.abort();
      serverPreviewAbortRef.current = null;
    }

    const key = JSON.stringify({
      shape: baseShapeKey,
      w: effectiveDims.visualWcm,
      h: effectiveDims.visualHcm,
      bgMode,
      bgColor: bgColorEff,
      imageUrl,
    });

    if (!imageUrl) {
      setServerPreviewUrl("");
      lastServerPreviewKeyRef.current = "";
      return;
    }

    if (lastServerPreviewKeyRef.current === key && lastGoodServerPreviewRef.current) {
      setServerPreviewUrl(lastGoodServerPreviewRef.current);
      return;
    }

    serverPreviewDebounceRef.current = setTimeout(async () => {
      const ctrl = new AbortController();
      serverPreviewAbortRef.current = ctrl;
      const reqId = ++serverPreviewReqIdRef.current;

      try {
        const payload = {
          shape: baseShapeKey,
          widthCm: effectiveDims.visualWcm,
          heightCm: effectiveDims.visualHcm,
          imageUrl,
          backgroundMode: bgMode,
          backgroundColor: bgColorEff,
          borderMm: baseShapeKey === "freeform" ? freeformBorderMm : 0,
        };

        const res = await fetch(api("/api/preview"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(payload),
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`preview ${res.status}`);
        const json = await res.json();
        if (reqId !== serverPreviewReqIdRef.current) return;

        const url = String(json?.url || "");
        setServerPreviewUrl(url);
        if (url) {
          lastGoodServerPreviewRef.current = url;
          lastServerPreviewKeyRef.current = key;
        }
      } catch (err) {
        if (ctrl.signal.aborted) return;
        console.error("Server preview failed", err);
      } finally {
        if (serverPreviewAbortRef.current === ctrl) serverPreviewAbortRef.current = null;
      }
    }, 180);

    return () => {
      if (serverPreviewDebounceRef.current) {
        clearTimeout(serverPreviewDebounceRef.current);
        serverPreviewDebounceRef.current = null;
      }
      if (serverPreviewAbortRef.current) {
        serverPreviewAbortRef.current.abort();
        serverPreviewAbortRef.current = null;
      }
    };
  }, [
    baseShapeKey,
    effectiveDims.visualWcm,
    effectiveDims.visualHcm,
    bgMode,
    bgColorEff,
    imageUrl,
    freeformBorderMm,
  ]);

  // Cleanup local object URLs
  useEffect(() => {
    return () => {
      if (localPreviewUrlRef.current) {
        URL.revokeObjectURL(localPreviewUrlRef.current);
        localPreviewUrlRef.current = null;
      }
      if (freeformPreviewObjUrlRef.current) {
        URL.revokeObjectURL(freeformPreviewObjUrlRef.current);
        freeformPreviewObjUrlRef.current = null;
      }
    };
  }, []);

  // Upload handling
  async function handleChooseFile(ev) {
    const file = ev?.target?.files?.[0];
    if (!file) return;

    setErrorMsg("");
    setAddedMsg("");
    pendingFileRef.current = file;

    // local blob preview first
    if (localPreviewUrlRef.current) {
      URL.revokeObjectURL(localPreviewUrlRef.current);
      localPreviewUrlRef.current = null;
    }
    const blobUrl = URL.createObjectURL(file);
    localPreviewUrlRef.current = blobUrl;
    setImageUrl(blobUrl);

    const genId = ++uploadGenIdRef.current;
    setUploading(true);

    const prom = (async () => {
      try {
        const remote = await uploadOriginalFile(file);
        if (!remote) throw new Error("Upload URL leer.");
        if (genId !== uploadGenIdRef.current) return;
        setUploadedUrl(remote);
        setImageUrl(remote);
      } catch (err) {
        console.error(err);
        if (genId !== uploadGenIdRef.current) return;
        setErrorMsg(err?.message || "Upload fehlgeschlagen.");
      } finally {
        if (genId === uploadGenIdRef.current) setUploading(false);
      }
    })();

    remoteUploadPromiseRef.current = prom;
    await prom;
  }

  function triggerFileInput() {
    fileInputRef.current?.click?.();
  }

  function onPickShape(next) {
    setShape(String(next || "square").toLowerCase());
    setAddedMsg("");
    setErrorMsg("");
  }

  function onPickSize(sk) {
    setSizeKey(String(sk || ""));
    setAddedMsg("");
    setErrorMsg("");
  }

  function onBgMode(nextMode) {
    setBgMode(nextMode);
    setAddedMsg("");
    setErrorMsg("");
  }

  function onColorPicked(nextColor) {
    setBgColor(nextColor || "#ffffff");
    setBgMode("color");
    setAddedMsg("");
    setErrorMsg("");
  }

  function onFreeformWidthInput(raw) {
    const n = parseNumberDE(raw);
    if (!Number.isFinite(n)) return;
    lastFreeformEditRef.current = "w";
    const fixed = enforceAspectWithMinEdge({
      wCm: n,
      hCm: billingHeightCm,
      aspectWdivH: freeformCutAspect || imgAspect || 1,
      edited: "w",
      minEdgeCm: MIN_EDGE_CM,
      maxEdgeCm: 300,
    });
    setBillingWidthCm(fixed.wCm);
    setBillingHeightCm(fixed.hCm);
    setAddedMsg("");
    setErrorMsg("");
  }

  function onFreeformHeightInput(raw) {
    const n = parseNumberDE(raw);
    if (!Number.isFinite(n)) return;
    lastFreeformEditRef.current = "h";
    const fixed = enforceAspectWithMinEdge({
      wCm: billingWidthCm,
      hCm: n,
      aspectWdivH: freeformCutAspect || imgAspect || 1,
      edited: "h",
      minEdgeCm: MIN_EDGE_CM,
      maxEdgeCm: 300,
    });
    setBillingWidthCm(fixed.wCm);
    setBillingHeightCm(fixed.hCm);
    setAddedMsg("");
    setErrorMsg("");
  }

  function onFixedWidthInput(raw) {
    const n = parseNumberDE(raw);
    if (!Number.isFinite(n)) return;
    setWidthCm(clampNum(n, 1, 300));
    setAddedMsg("");
    setErrorMsg("");
  }

  function onFixedHeightInput(raw) {
    const n = parseNumberDE(raw);
    if (!Number.isFinite(n)) return;
    setHeightCm(clampNum(n, 1, 300));
    setAddedMsg("");
    setErrorMsg("");
  }

  function applyBorderDraft() {
    const mm = clampNum(borderDraftMm, 1, 20);
    setFreeformBorderMm(mm);
  }

  const visualWidthCm = effectiveDims.visualWcm;
  const visualHeightCm = effectiveDims.visualHcm;
  const billingWidthCmEff = effectiveDims.billingWcm;
  const billingHeightCmEff = effectiveDims.billingHcm;

  const currentImagePx = useMemo(() => {
    const im = imgElRef.current;
    if (!im) return { w: 0, h: 0 };
    return { w: im.naturalWidth || im.width || 0, h: im.naturalHeight || im.height || 0 };
  }, [imageUrl, imgAspect]);

  const effectiveDpi = useMemo(() => {
    if (!currentImagePx.w || !currentImagePx.h) return 0;
    return calcEffectiveDpi({
      imgPxW: currentImagePx.w,
      imgPxH: currentImagePx.h,
      targetCmW: visualWidthCm,
      targetCmH: visualHeightCm,
    });
  }, [currentImagePx, visualWidthCm, visualHeightCm]);

  const dpiState = effectiveDpi >= WARN_DPI ? "good" : effectiveDpi >= MIN_DPI ? "warn" : "bad";

  // ✅ PREVIEW: jetzt primär echte Panelgröße statt Viewport verwenden
  const previewSurfaceScale = baseShapeKey === "freeform" ? 0.88 : 0.84;

  const previewDims = useMemo(() => {
    const surfaceAspect =
      baseShapeKey === "freeform"
        ? freeformPreviewAspect || freeformCutAspect || imgAspect || 1
        : getSurfaceAspect(shape, visualWidthCm, visualHeightCm, imgAspect);

    // nutzbare Fläche des rechten Panels
    const hostW = Math.max(0, Number(previewHostBox?.w) || 0);
    const hostH = Math.max(0, Number(previewHostBox?.h) || 0);

    // Fallback auf viewport-basierte Abschätzung
    const fallbackW = Math.floor(Math.min(PREVIEW_MAX_PX, vp.w * PREVIEW_MAX_VW_FACTOR));
    const fallbackH = Math.floor(Math.min(PREVIEW_MAX_PX, vp.h * PREVIEW_MAX_VH_FACTOR));

    const usableW = hostW > 40 ? Math.floor(hostW * previewSurfaceScale) : fallbackW;
    const usableH = hostH > 40 ? Math.floor(hostH * previewSurfaceScale) : fallbackH;

    return calcContainRect(usableW, usableH, surfaceAspect);
  }, [
    baseShapeKey,
    shape,
    visualWidthCm,
    visualHeightCm,
    imgAspect,
    vp.w,
    vp.h,
    previewHostBox,
    previewSurfaceScale,
    freeformPreviewAspect,
    freeformCutAspect,
  ]);

  const previewShapeStyle = useMemo(() => {
    const base = {
      position: "relative",
      width: `${previewDims.width}px`,
      height: `${previewDims.height}px`,
      maxWidth: "100%",
      maxHeight: "100%",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      overflow: "hidden",
      flex: "0 0 auto",
    };

    switch (baseShapeKey) {
      case "square":
        return { ...base, borderRadius: "0px" };
      case "square_rounded":
        return { ...base, borderRadius: "16px" };
      case "round":
        return { ...base, borderRadius: "9999px" };
      case "rect":
      case "rect_landscape":
        return { ...base, borderRadius: "0px" };
      case "rect_rounded":
      case "rect_landscape_rounded":
        return { ...base, borderRadius: "16px" };
      case "oval":
      case "oval_portrait":
        return { ...base, borderRadius: "9999px / 70%" };
      case "freeform":
        // ✅ kein unnötiges Clipping mehr am äußeren Container
        return {
          ...base,
          overflow: "visible",
          background: "transparent",
        };
      default:
        return base;
    }
  }, [baseShapeKey, previewDims]);

  // For transparent materials show checker ONLY inside sticker shape
  const checkerBg = createCheckerBg(12);

  const previewInnerSurfaceStyle = useMemo(() => {
    if (baseShapeKey !== "freeform") {
      return {
        position: "absolute",
        inset: 0,
        ...(bgMode === "transparent" ? checkerBg : {}),
        backgroundColor: bgMode === "color" || bgMode === "white" ? bgColorEff : undefined,
      };
    }

    // Freeform: checker / fill only inside contour via CSS mask on preview image
    const style = {
      position: "absolute",
      inset: 0,
      pointerEvents: "none",
      WebkitMaskImage: freeformPreviewUrl ? `url("${freeformPreviewUrl}")` : undefined,
      WebkitMaskRepeat: "no-repeat",
      WebkitMaskPosition: "center",
      WebkitMaskSize: "contain",
      maskImage: freeformPreviewUrl ? `url("${freeformPreviewUrl}")` : undefined,
      maskRepeat: "no-repeat",
      maskPosition: "center",
      maskSize: "contain",
    };

    if (bgMode === "transparent") {
      return {
        ...style,
        ...checkerBg,
        backgroundColor: "transparent",
      };
    }

    return {
      ...style,
      backgroundColor: bgColorEff,
    };
  }, [baseShapeKey, bgMode, bgColorEff, freeformPreviewUrl]);

  const previewImageStyle = useMemo(() => {
    if (baseShapeKey === "freeform") {
      return {
        position: "relative",
        width: "100%",
        height: "100%",
        objectFit: "contain",
        display: "block",
        zIndex: 2,
        userSelect: "none",
        WebkitUserDrag: "none",
        pointerEvents: "none",
      };
    }

    return {
      position: "relative",
      width: "100%",
      height: "100%",
      objectFit: "cover",
      display: "block",
      zIndex: 2,
      userSelect: "none",
      WebkitUserDrag: "none",
      pointerEvents: "none",
    };
  }, [baseShapeKey]);

  // Build freeform client preview canvas for exact display
  const freeformClientPreviewUrl = useMemo(() => {
    if (baseShapeKey !== "freeform" || !freeformMaster) return "";
    try {
      const wPx = Math.max(1, Math.round(previewDims.width));
      const hPx = Math.max(1, Math.round(previewDims.height));
      const borderPx = Math.max(1, Math.round((freeformBorderMm / 10) * PX_PER_CM));
      const canvas = renderFreeformStickerCanvasFromMaster({
        master: freeformMaster,
        outWpx: wPx,
        outHpx: hPx,
        borderPx,
        bgColor: bgColorEff === "transparent" ? "#ffffff" : bgColorEff,
        isTransparentBg: bgMode === "transparent",
        forExport: false,
      });
      return canvas.toDataURL("image/png");
    } catch (err) {
      console.error(err);
      return freeformPreviewUrl || "";
    }
  }, [
    baseShapeKey,
    freeformMaster,
    previewDims.width,
    previewDims.height,
    freeformBorderMm,
    bgMode,
    bgColorEff,
    freeformPreviewUrl,
  ]);

  const currentPreviewSrc = useMemo(() => {
    if (!imageUrl) return "";
    if (baseShapeKey === "freeform") {
      return freeformClientPreviewUrl || freeformPreviewUrl || imageUrl;
    }
    return serverPreviewUrl || imageUrl;
  }, [imageUrl, baseShapeKey, freeformClientPreviewUrl, freeformPreviewUrl, serverPreviewUrl]);

  // ---------- EXPORT ----------
  async function buildExportPayload() {
    if (!imageUrl) throw new Error("Bitte zuerst ein Motiv hochladen.");

    const isTransparentBg = bgMode === "transparent";

    if (baseShapeKey === "freeform") {
      if (!freeformMaster) throw new Error("Freiform-Vorschau ist noch nicht bereit.");

      const boxWpx = cmToPxAtDpi(billingWidthCmEff, EXPORT_DPI);
      const boxHpx = cmToPxAtDpi(billingHeightCmEff, EXPORT_DPI);
      const borderPx = mmToPxAtDpi(freeformBorderMm, EXPORT_DPI);

      const stickerCanvas = renderFreeformStickerCanvasFromMaster({
        master: freeformMaster,
        outWpx: boxWpx,
        outHpx: boxHpx,
        borderPx,
        bgColor: isTransparentBg ? "#ffffff" : bgColorEff,
        isTransparentBg,
        forExport: true,
      });

      // Sticker in Billing-Box platzieren
      const composed = composeStickerIntoBillingBox({
        stickerCanvas,
        boxWpx,
        boxHpx,
      });

      const pngDataUrl = composed.toDataURL("image/png");
      const cutMaskDataUrl = renderFreeformMaskDataUrlFromMasterMask({
        master: freeformMaster,
        outWpx: boxWpx,
        outHpx: boxHpx,
        borderPx,
      });

      return {
        shape: "freeform",
        widthCm: billingWidthCmEff,
        heightCm: billingHeightCmEff,
        imageUrl,
        backgroundMode: bgMode,
        backgroundColor: bgColorEff,
        borderMm: freeformBorderMm,
        pngDataUrl,
        cutMaskDataUrl,
        exportDpi: EXPORT_DPI,
      };
    }

    // Fixed shapes: server can handle based on original image URL
    return {
      shape: baseShapeKey,
      widthCm: visualWidthCm,
      heightCm: visualHeightCm,
      imageUrl,
      backgroundMode: bgMode,
      backgroundColor: bgColorEff,
      borderMm: 0,
      exportDpi: EXPORT_DPI,
    };
  }

  async function exportSticker() {
    setErrorMsg("");
    setAddedMsg("");
    setExporting(true);

    try {
      const payload = await buildExportPayload();
      const res = await fetch(api("/sticker/export"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(txt || `Export fehlgeschlagen (${res.status})`);
      }

      const json = await res.json();
      const url = String(json?.url || "");
      if (!url) throw new Error("Keine Export-URL erhalten.");

      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      console.error(err);
      setErrorMsg(err?.message || "Export fehlgeschlagen.");
    } finally {
      setExporting(false);
    }
  }

  async function addToCart() {
    setErrorMsg("");
    setAddedMsg("");

    try {
      if (!imageUrl) throw new Error("Bitte zuerst ein Motiv hochladen.");
      if (!selectedVariantId) throw new Error("Keine passende Variante gefunden.");

      // Ensure upload finished if local preview still pending
      if (remoteUploadPromiseRef.current) {
        await remoteUploadPromiseRef.current.catch(() => {});
      }

      const payload = await buildExportPayload();

      const exportRes = await fetch(api("/sticker/export"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(payload),
      });

      if (!exportRes.ok) {
        const txt = await exportRes.text().catch(() => "");
        throw new Error(txt || `Export fehlgeschlagen (${exportRes.status})`);
      }

      const exportJson = await exportRes.json();

      const lineItemProperties = {
        _sticker_shape: baseShapeKey,
        _sticker_visual_width_cm: String(fmtCm(visualWidthCm)),
        _sticker_visual_height_cm: String(fmtCm(visualHeightCm)),
        _sticker_billing_width_cm: String(fmtCm(billingWidthCmEff)),
        _sticker_billing_height_cm: String(fmtCm(billingHeightCmEff)),
        _sticker_background_mode: bgMode,
        _sticker_background_color: bgColorEff,
        _sticker_freeform_border_mm: baseShapeKey === "freeform" ? String(freeformBorderMm) : "",
        _sticker_preview_url: currentPreviewSrc || "",
        _sticker_source_image_url: uploadedUrl || imageUrl || "",
        _sticker_export_png_url: String(exportJson?.pngUrl || exportJson?.url || ""),
        _sticker_export_svg_url: String(exportJson?.svgUrl || ""),
        _sticker_size_key: String(sizeKey || ""),
      };

      const cartRes = await fetch("/cart/add.js", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          items: [
            {
              id: Number(selectedVariantId),
              quantity: 1,
              properties: lineItemProperties,
            },
          ],
        }),
      });

      if (!cartRes.ok) {
        const txt = await cartRes.text().catch(() => "");
        throw new Error(txt || `Warenkorb fehlgeschlagen (${cartRes.status})`);
      }

      setAddedMsg("Sticker wurde in den Warenkorb gelegt.");

      if (goToCartAfterAdd) {
        window.location.href = "/cart";
      }
    } catch (err) {
      console.error(err);
      setErrorMsg(err?.message || "Konnte nicht in den Warenkorb legen.");
    }
  }

  // ---------- UI DATA ----------
  const shapeButtons = [
    { key: "square", label: "Quadrat" },
    { key: "square_rounded", label: "Abgerundet" },
    { key: "rect", label: "Rechteck" },
    { key: "rect_rounded", label: "Rect. abg." },
    { key: "rect_landscape", label: "Quer" },
    { key: "rect_landscape_rounded", label: "Quer abg." },
    { key: "round", label: "Rund" },
    { key: "oval", label: "Oval" },
    { key: "oval_portrait", label: "Oval hoch" },
    { key: "freeform", label: "Freiform", isAccent: true },
  ];

  const canExport = !!imageUrl && !uploading && !exporting;
  const canAddToCart = !!imageUrl && !!selectedVariantId && !uploading && !exporting;

  const showFreeformFields = baseShapeKey === "freeform";

  const mmLabel = `${fmtCm(visualWidthCm)} × ${fmtCm(visualHeightCm)} cm`;
  const billingLabel =
    baseShapeKey === "freeform"
      ? `Abrechnung: ${fmtCm(billingWidthCmEff)} × ${fmtCm(billingHeightCmEff)} cm`
      : `${fmtCm(billingWidthCmEff)} × ${fmtCm(billingHeightCmEff)} cm`;

  return (
    <div
      style={{
        width: "100%",
        color: "#fff",
        background: "#05070d",
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "320px minmax(0, 1fr)",
          minHeight: "740px",
          background: "#05070d",
        }}
      >
        {/* LEFT SIDEBAR */}
        <aside
          style={{
            borderRight: "1px solid rgba(255,255,255,.08)",
            padding: "26px 18px 22px",
            background:
              "linear-gradient(180deg, rgba(255,255,255,.02), rgba(255,255,255,.01))",
          }}
        >
          <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 20 }}>Sticker konfigurieren</div>

          <div
            style={{
              height: 1,
              background: "rgba(255,255,255,.08)",
              marginBottom: 22,
            }}
          />

          {/* 1 Shape */}
          <div style={{ marginBottom: 18 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                marginBottom: 14,
                fontWeight: 800,
                letterSpacing: ".08em",
                textTransform: "uppercase",
                color: "rgba(255,255,255,.78)",
              }}
            >
              <span
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 999,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: "#ef1d1d",
                  color: "#fff",
                  fontSize: 15,
                  fontWeight: 800,
                }}
              >
                1
              </span>
              Form wählen
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, 1fr)",
                gap: 10,
              }}
            >
              {shapeButtons.map((btn) => {
                const active = shape === btn.key;
                return (
                  <button
                    key={btn.key}
                    type="button"
                    onClick={() => onPickShape(btn.key)}
                    style={{
                      minHeight: 64,
                      borderRadius: 10,
                      border: active
                        ? "1px solid #ef1d1d"
                        : "1px solid rgba(255,255,255,.09)",
                      background: active
                        ? "rgba(239,29,29,.12)"
                        : "rgba(255,255,255,.02)",
                      color: active ? "#ff4b4b" : "rgba(255,255,255,.78)",
                      fontWeight: btn.isAccent ? 800 : 600,
                      fontSize: 13,
                      cursor: "pointer",
                    }}
                  >
                    {btn.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* 2 Size */}
          <div style={{ marginBottom: 18 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                marginBottom: 14,
                fontWeight: 800,
                letterSpacing: ".08em",
                textTransform: "uppercase",
                color: "rgba(255,255,255,.78)",
              }}
            >
              <span
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 999,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: "#ef1d1d",
                  color: "#fff",
                  fontSize: 15,
                  fontWeight: 800,
                }}
              >
                2
              </span>
              Größe wählen
            </div>

            {!showFreeformFields ? (
              <>
                <select
                  value={sizeKey}
                  onChange={(e) => onPickSize(e.target.value)}
                  style={{
                    width: "100%",
                    minHeight: 52,
                    padding: "0 14px",
                    borderRadius: 12,
                    border: "1px solid rgba(255,255,255,.10)",
                    background: "rgba(255,255,255,.03)",
                    color: "#fff",
                    outline: "none",
                  }}
                >
                  {sizeOptions.map((s) => (
                    <option key={s.sizeKey || `${s.wCm}x${s.hCm}`} value={s.sizeKey}>
                      {s.label || `${fmtCm(s.wCm)} × ${fmtCm(s.hCm)} cm`}
                    </option>
                  ))}
                </select>

                <div
                  style={{
                    marginTop: 10,
                    fontSize: 13,
                    color: "rgba(255,255,255,.58)",
                  }}
                >
                  {mmLabel}
                </div>
              </>
            ) : (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 10,
                }}
              >
                <div>
                  <div style={{ fontSize: 12, color: "rgba(255,255,255,.58)", marginBottom: 6 }}>
                    Breite (cm)
                  </div>
                  <input
                    type="number"
                    min={MIN_EDGE_CM}
                    max={300}
                    step="0.1"
                    value={fmtCm(billingWidthCm)}
                    onChange={(e) => onFreeformWidthInput(e.target.value)}
                    style={{
                      width: "100%",
                      minHeight: 48,
                      padding: "0 12px",
                      borderRadius: 12,
                      border: "1px solid rgba(255,255,255,.10)",
                      background: "rgba(255,255,255,.03)",
                      color: "#fff",
                      outline: "none",
                    }}
                  />
                </div>

                <div>
                  <div style={{ fontSize: 12, color: "rgba(255,255,255,.58)", marginBottom: 6 }}>
                    Höhe (cm)
                  </div>
                  <input
                    type="number"
                    min={MIN_EDGE_CM}
                    max={300}
                    step="0.1"
                    value={fmtCm(billingHeightCm)}
                    onChange={(e) => onFreeformHeightInput(e.target.value)}
                    style={{
                      width: "100%",
                      minHeight: 48,
                      padding: "0 12px",
                      borderRadius: 12,
                      border: "1px solid rgba(255,255,255,.10)",
                      background: "rgba(255,255,255,.03)",
                      color: "#fff",
                      outline: "none",
                    }}
                  />
                </div>

                <div
                  style={{
                    gridColumn: "1 / -1",
                    fontSize: 13,
                    color: "rgba(255,255,255,.58)",
                  }}
                >
                  {mmLabel}
                </div>

                <div
                  style={{
                    gridColumn: "1 / -1",
                    fontSize: 13,
                    color: "rgba(255,255,255,.58)",
                  }}
                >
                  {billingLabel}
                </div>

                <div
                  style={{
                    gridColumn: "1 / -1",
                    fontSize: 12,
                    color: "rgba(255,255,255,.45)",
                  }}
                >
                  Mindestkante Freiform: {fmtCm(MIN_EDGE_CM)} cm
                </div>
              </div>
            )}
          </div>

          {/* 3 Material */}
          <div style={{ marginBottom: 18 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                marginBottom: 14,
                fontWeight: 800,
                letterSpacing: ".08em",
                textTransform: "uppercase",
                color: "rgba(255,255,255,.78)",
              }}
            >
              <span
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 999,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: "#ef1d1d",
                  color: "#fff",
                  fontSize: 15,
                  fontWeight: 800,
                }}
              >
                3
              </span>
              Material
            </div>

            <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
              <button
                type="button"
                onClick={() => onBgMode("white")}
                style={{
                  flex: 1,
                  minHeight: 44,
                  borderRadius: 10,
                  border:
                    bgMode === "white"
                      ? "1px solid #ef1d1d"
                      : "1px solid rgba(255,255,255,.10)",
                  background:
                    bgMode === "white" ? "rgba(239,29,29,.12)" : "rgba(255,255,255,.03)",
                  color: bgMode === "white" ? "#ff4b4b" : "#fff",
                  cursor: "pointer",
                }}
              >
                Weiß
              </button>

              <button
                type="button"
                onClick={() => onBgMode("color")}
                style={{
                  flex: 1,
                  minHeight: 44,
                  borderRadius: 10,
                  border:
                    bgMode === "color"
                      ? "1px solid #ef1d1d"
                      : "1px solid rgba(255,255,255,.10)",
                  background:
                    bgMode === "color" ? "rgba(239,29,29,.12)" : "rgba(255,255,255,.03)",
                  color: bgMode === "color" ? "#ff4b4b" : "#fff",
                  cursor: "pointer",
                }}
              >
                Farbig
              </button>

              <button
                type="button"
                onClick={() => onBgMode("transparent")}
                style={{
                  flex: 1,
                  minHeight: 44,
                  borderRadius: 10,
                  border:
                    bgMode === "transparent"
                      ? "1px solid #ef1d1d"
                      : "1px solid rgba(255,255,255,.10)",
                  background:
                    bgMode === "transparent"
                      ? "rgba(239,29,29,.12)"
                      : "rgba(255,255,255,.03)",
                  color: bgMode === "transparent" ? "#ff4b4b" : "#fff",
                  cursor: "pointer",
                }}
              >
                Transparent
              </button>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ fontSize: 13, color: "rgba(255,255,255,.58)" }}>Hintergrundfarbe</div>
              <input
                type="color"
                value={bgColorEff === "transparent" ? "#ffffff" : bgColorEff}
                onChange={(e) => onColorPicked(e.target.value)}
                disabled={bgMode !== "color"}
                style={{
                  width: 104,
                  height: 42,
                  borderRadius: 12,
                  border: "1px solid rgba(255,255,255,.10)",
                  background: "transparent",
                  padding: 2,
                  cursor: bgMode === "color" ? "pointer" : "not-allowed",
                }}
              />
            </div>
          </div>

          {/* 4 Freeform border */}
          {showFreeformFields ? (
            <div style={{ marginBottom: 18 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  marginBottom: 14,
                  fontWeight: 800,
                  letterSpacing: ".08em",
                  textTransform: "uppercase",
                  color: "rgba(255,255,255,.78)",
                }}
              >
                <span
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 999,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: "#ef1d1d",
                    color: "#fff",
                    fontSize: 15,
                    fontWeight: 800,
                  }}
                >
                  4
                </span>
                Freiform-Rand
              </div>

              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <input
                  type="number"
                  min={1}
                  max={20}
                  step="0.1"
                  value={fmtCm(borderDraftMm / 10)}
                  onChange={(e) => setBorderDraftMm((parseNumberDE(e.target.value) || 0) * 10)}
                  style={{
                    flex: 1,
                    minHeight: 48,
                    padding: "0 12px",
                    borderRadius: 12,
                    border: "1px solid rgba(255,255,255,.10)",
                    background: "rgba(255,255,255,.03)",
                    color: "#fff",
                    outline: "none",
                  }}
                />
                <button
                  type="button"
                  onClick={applyBorderDraft}
                  style={{
                    minHeight: 48,
                    padding: "0 16px",
                    borderRadius: 12,
                    border: "1px solid rgba(255,255,255,.10)",
                    background: "rgba(255,255,255,.03)",
                    color: "#fff",
                    cursor: "pointer",
                  }}
                >
                  Übernehmen
                </button>
              </div>

              <div style={{ marginTop: 8, fontSize: 13, color: "rgba(255,255,255,.58)" }}>
                {freeformBorderMm.toFixed(1)} mm
              </div>
            </div>
          ) : null}

          {/* 5 Upload */}
          <div style={{ marginBottom: 18 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                marginBottom: 14,
                fontWeight: 800,
                letterSpacing: ".08em",
                textTransform: "uppercase",
                color: "rgba(255,255,255,.78)",
              }}
            >
              <span
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 999,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: "#ef1d1d",
                  color: "#fff",
                  fontSize: 15,
                  fontWeight: 800,
                }}
              >
                5
              </span>
              Motiv
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/webp,image/jpeg,image/svg+xml"
              onChange={handleChooseFile}
              style={{ display: "none" }}
            />

            <button
              type="button"
              onClick={triggerFileInput}
              style={{
                width: "100%",
                minHeight: 48,
                borderRadius: 12,
                border: "1px solid rgba(255,255,255,.10)",
                background: "rgba(255,255,255,.03)",
                color: "#fff",
                cursor: "pointer",
                fontWeight: 700,
              }}
            >
              {uploading ? "Lädt hoch ..." : imageUrl ? "Motiv ändern" : "Motiv hochladen"}
            </button>

            {imageUrl ? (
              <div
                style={{
                  marginTop: 10,
                  fontSize: 13,
                  color: "rgba(255,255,255,.58)",
                  lineHeight: 1.45,
                }}
              >
                Auflösung: {currentImagePx.w || 0} × {currentImagePx.h || 0} px
                <br />
                Effektive Druckauflösung:{" "}
                <span
                  style={{
                    color:
                      dpiState === "good"
                        ? "#85f59a"
                        : dpiState === "warn"
                        ? "#ffd36e"
                        : "#ff8b8b",
                    fontWeight: 700,
                  }}
                >
                  {effectiveDpi ? `${Math.round(effectiveDpi)} dpi` : "—"}
                </span>
              </div>
            ) : null}
          </div>

          {/* Actions */}
          <div style={{ display: "grid", gap: 10 }}>
            <button
              type="button"
              onClick={exportSticker}
              disabled={!canExport}
              style={{
                minHeight: 50,
                borderRadius: 12,
                border: "1px solid rgba(255,255,255,.10)",
                background: canExport ? "rgba(255,255,255,.06)" : "rgba(255,255,255,.02)",
                color: canExport ? "#fff" : "rgba(255,255,255,.40)",
                cursor: canExport ? "pointer" : "not-allowed",
                fontWeight: 700,
              }}
            >
              {exporting ? "Export läuft ..." : "Exportieren"}
            </button>

            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                fontSize: 13,
                color: "rgba(255,255,255,.66)",
              }}
            >
              <input
                type="checkbox"
                checked={goToCartAfterAdd}
                onChange={(e) => setGoToCartAfterAdd(!!e.target.checked)}
              />
              Nach Hinzufügen direkt zum Warenkorb
            </label>

            <button
              type="button"
              onClick={addToCart}
              disabled={!canAddToCart}
              style={{
                minHeight: 54,
                borderRadius: 12,
                border: "1px solid #ef1d1d",
                background: canAddToCart ? "#ef1d1d" : "rgba(239,29,29,.25)",
                color: "#fff",
                cursor: canAddToCart ? "pointer" : "not-allowed",
                fontWeight: 800,
              }}
            >
              In den Warenkorb
            </button>
          </div>

          {/* Price / variant info */}
          <div
            style={{
              marginTop: 18,
              padding: "14px 14px",
              borderRadius: 14,
              background: "rgba(255,255,255,.03)",
              border: "1px solid rgba(255,255,255,.08)",
              fontSize: 13,
              lineHeight: 1.55,
              color: "rgba(255,255,255,.70)",
            }}
          >
            <div style={{ fontWeight: 800, color: "#fff", marginBottom: 8 }}>Zusammenfassung</div>
            <div>Form: {shapeButtons.find((s) => s.key === shape)?.label || shape}</div>
            <div>Größe: {mmLabel}</div>
            {baseShapeKey === "freeform" ? <div>{billingLabel}</div> : null}
            <div>Stück auf 130 cm Bahn: {realPieces}</div>
            <div>Variante: {selectedVariantTitle || "—"}</div>
            <div>
              Preis gesamt:{" "}
              <span style={{ color: "#fff", fontWeight: 800 }}>
                {Number(priceTotal || 0).toFixed(2)} €
              </span>
            </div>
          </div>

          {errorMsg ? (
            <div
              style={{
                marginTop: 14,
                padding: "12px 14px",
                borderRadius: 12,
                background: "rgba(255,80,80,.12)",
                border: "1px solid rgba(255,80,80,.26)",
                color: "#ffd5d5",
                fontSize: 13,
              }}
            >
              {errorMsg}
            </div>
          ) : null}

          {addedMsg ? (
            <div
              style={{
                marginTop: 14,
                padding: "12px 14px",
                borderRadius: 12,
                background: "rgba(60,200,90,.12)",
                border: "1px solid rgba(60,200,90,.26)",
                color: "#d7ffe1",
                fontSize: 13,
              }}
            >
              {addedMsg}
            </div>
          ) : null}
        </aside>

        {/* RIGHT PREVIEW */}
        <section
          ref={rightPanelRef}
          style={{
            position: "relative",
            minWidth: 0,
            minHeight: 740,
            background: "#000",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            overflow: "hidden",
            padding: 24,
          }}
        >
          {currentPreviewSrc ? (
            <div
              style={{
                ...previewShapeStyle,
              }}
            >
              <div style={previewInnerSurfaceStyle} />

              <img
                src={currentPreviewSrc}
                alt="Sticker Preview"
                draggable={false}
                style={previewImageStyle}
              />
            </div>
          ) : (
            <div
              style={{
                width: Math.max(220, previewDims.width || 320),
                height: Math.max(220, previewDims.height || 320),
                borderRadius: 18,
                border: "1px dashed rgba(255,255,255,.15)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "rgba(255,255,255,.40)",
                fontSize: 15,
                textAlign: "center",
                padding: 20,
              }}
            >
              Bitte Motiv hochladen, um die Vorschau zu sehen.
            </div>
          )}
        </section>
      </div>
    </div>
  );
}