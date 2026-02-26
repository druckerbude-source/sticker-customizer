import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * StickerCanvasClient.jsx
 * - Self-contained (no relative imports)
 *
 * ✅ Patch (Austauschdatei):
 * - UI-Cutline bleibt wie gehabt (nur Vorschau)
 * - NEU: Cutline wird für den SVG-Export als echter Vektorpfad erzeugt und an /sticker/export gesendet:
 *   - payload: cutlineEnabled, cutlinePathD, cutlineStrokePx
 *   - Freeform: Cutline aus Maske via Dilation + Kontur + Simplify
 *   - Feste Formen: Cutline als Geometrie-Path (Rect/Rounded/Circle/Ellipse)
 *
 * WICHTIG:
 * - Dein Server hat aktuell KEIN svgInline. Daher MUSS /sticker/export erweitert werden (siehe Patch unten),
 *   damit er cutlinePathD ins SVG übernimmt.
 */

// ==============================
// Konfiguration
// ==============================
const PRINT_LENGTH_CM = 130;

// Mindestkante: 40 mm
const MIN_EDGE_MM = 40;
const MIN_EDGE_CM = MIN_EDGE_MM / 10;

// Freiform Größen-Presets (lange Kante in cm)
const FREEFORM_LONGSIDE_PRESETS_CM = [4, 5, 6, 7, 8, 9, 10, 12, 15, 20];

// Freeform Preview-Engine
const PX_PER_CM = 100;
const EXPORT_DPI = 300;
const MIN_DPI = 180;

const SQRT2 = Math.SQRT2;
const FREEFORM_MASTER_LONG_SIDE = 1200;
const FREEFORM_PREVIEW_MAX_SIDE = 1100;

// schließt kleine "Freiräume" / Schlitze zwischen Konturen (Mask Closing)
const FREEFORM_SEAL_GAPS_PX = 3;

// Rounded Export
const ROUNDED_PAD_PX = 28;
const ROUNDED_RADIUS_MM = (ROUNDED_PAD_PX / PX_PER_CM) * 10;

// ✅ Cutline Stroke im Export (in px bei Export-DPI)
const EXPORT_CUTLINE_STROKE_PX = 2;

// UI Colorways (Fallback)
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
  if (shape === "round") return Math.max(1e-9, Number(wCm) || 0);
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

// ✅ Variant-Matching: Farbe + Größe
const COLOR_SYNONYMS = {
  white: ["white", "weiß", "weiss"],
  transparent: ["transparent", "klar"],
  colored: ["farbig", "colored", "vollfarbe", "4c"],
};

function normText(x) {
  return String(x || "").toLowerCase().trim();
}

function variantMatchesColor(v, colorKey) {
  const key = String(colorKey || "").toLowerCase() || "white";

  const opts = [v?.option1, v?.option2, v?.option3, ...(Array.isArray(v?.options) ? v.options : [])]
    .map(normText)
    .filter(Boolean);

  if (key === "colored" && opts.some((o) => o === "color" || o === "colour")) return true;

  const words = COLOR_SYNONYMS[key] || [key];
  const hay = [...opts, normText(v?.title)].filter(Boolean).join(" / ");
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

  if (s === "round") {
    const d = Math.max(w, h);
    if (parsed.kind === "single" && approxEq(parsed.nCm, d)) return true;
    if (parsed.kind === "rect" && approxEq(parsed.wCm, d) && approxEq(parsed.hCm, d)) return true;
    return false;
  }

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

// Mindestkante
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

  if (edited === "h") {
    h = clampNum(h, minEdgeCm, maxEdgeCm);
    w = h * safeAr;
  } else {
    w = clampNum(w, minEdgeCm, maxEdgeCm);
    h = w / safeAr;
  }

  const maxSide = Math.max(w, h);
  if (maxSide > maxEdgeCm) {
    const k = maxEdgeCm / Math.max(1e-9, maxSide);
    w *= k;
    h *= k;
  }

  const r = enforceMinEdgeCm(w, h, minEdgeCm);
  w = r.wCm;
  h = r.hCm;

  w = clampNum(w, minEdgeCm, maxEdgeCm);
  h = clampNum(h, minEdgeCm, maxEdgeCm);

  return { wCm: w, hCm: h, ar: safeAr };
}

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
    const fitB = w <= sh && h <= sw;
    if (fitA || fitB) {
      fits.push({ ...s, _area: sw * sh, _max: Math.max(sw, sh) });
    }
  }

  if (fits.length) {
    fits.sort((a, b) => a._area - b._area || a._max - b._max);
    return fits[0];
  }

  const sorted = [...sizes]
    .map((s) => {
      const sw = Number(s?.wCm ?? s?.widthCm);
      const sh = Number(s?.hCm ?? s?.heightCm);
      return { ...s, _area: (Number.isFinite(sw) ? sw : 0) * (Number.isFinite(sh) ? sh : 0) };
    })
    .sort((a, b) => b._area - a._area);
  return sorted[0] || null;
}

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

  if (ds.handleSquareRounded) out.square_rounded = ds.handleSquareRounded;
  if (ds.handleRectRounded) out.rect_rounded = ds.handleRectRounded;

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

function guessShopDomain() {
  try {
    if (typeof window === "undefined") return "";

    if (window.__SHOP_DOMAIN__) return String(window.__SHOP_DOMAIN__);

    const el = getStickerRootEl();
    const ds = el?.dataset || {};
    if (ds.shopDomain) return String(ds.shopDomain);

    const sp = new URLSearchParams(String(window.location?.search || ""));
    const qShop = sp.get("shop");
    if (qShop) return String(qShop);

    const wShop = window?.Shopify?.shop;
    if (wShop) return String(wShop);
  } catch {}

  return "";
}

function normalizeShopDomain(shop) {
  const s = String(shop || "").trim();
  if (!s) return "";
  const noProto = s.replace(/^https?:\/\//i, "").replace(/\/$/, "");
  const host = noProto.split("/")[0];
  if (!host.includes(".")) return "";
  return host;
}

function resolveApiBase() {
  if (typeof window !== "undefined" && window.__STICKER_API_BASE__) {
    return String(window.__STICKER_API_BASE__ || "").replace(/\/$/, "");
  }

  if (typeof document !== "undefined") {
    const el =
      document.getElementById("sticker-configurator-root") ||
      document.querySelector(".sticker-embed-root") ||
      document.querySelector("[data-api-base]") ||
      null;

    const base = el?.dataset?.apiBase;
    if (base) return String(base).replace(/\/$/, "");
  }

  try {
    const p = String(window?.location?.pathname || "");
    const m = p.match(/\/apps\/([^\/]+)(?:\/|$)/i);
    if (m && m[1]) return `/apps/${m[1]}`;
    const m2 = p.match(/\/proxy\/([^\/]+)(?:\/|$)/i);
    if (m2 && m2[1]) return `/proxy/${m2[1]}`;
  } catch {}

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

function normalizeUrl(u) {
  const s = String(u || "").trim();
  if (!s) return "";
  if (s.startsWith("//")) {
    const proto =
      typeof window !== "undefined" && window.location && window.location.protocol
        ? window.location.protocol
        : "https:";
    return `${proto}${s}`;
  }
  return s;
}

// ==============================
// Rotated Shapes (UI-only)
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

function flipSizeLabel(label) {
  const t = String(label || "");
  const m = t.match(/(\d+(?:[.,]\d+)?)\s*[x×]\s*(\d+(?:[.,]\d+)?)(.*)$/i);
  if (!m) return t;
  const a = m[1];
  const b = m[2];
  const rest = m[3] || "";
  return `${b} x ${a}${rest}`;
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

// ==============================
// Catalog Normalizer
// ==============================
function normalizeSizeRow(row) {
  const sizeKey = String(row?.sizeKey || row?.key || "").trim();
  const label = String(row?.label || sizeKey || "").trim();
  const widthCm = Number(row?.widthCm ?? row?.wCm);
  const heightCm = Number(row?.heightCm ?? row?.hCm);
  const variantId = String(row?.variantId || "").trim();
  const piecesPerSet = Number(row?.piecesPerSet ?? row?.pieces ?? row?.pcs);

  return {
    sizeKey,
    label,
    widthCm: Number.isFinite(widthCm) ? widthCm : NaN,
    heightCm: Number.isFinite(heightCm) ? heightCm : NaN,
    variantId,
    piecesPerSet: Number.isFinite(piecesPerSet) ? Math.max(1, Math.round(piecesPerSet)) : null,
  };
}

function normalizeCatalog(raw) {
  if (!raw || typeof raw !== "object") return null;

  const out = {};
  for (const [shapeKeyRaw, defRaw] of Object.entries(raw)) {
    const shapeKey = String(shapeKeyRaw || "").toLowerCase();
    if (!shapeKey) continue;

    if (Array.isArray(defRaw)) {
      const sizes = defRaw.map(normalizeSizeRow).filter((s) => s.sizeKey);
      out[shapeKey] = {
        shapeKey,
        label: shapeKey,
        defaultColorKey: "white",
        colors: {
          white: { colorKey: "white", label: "Weiß", sizes },
        },
        sizes,
      };
      continue;
    }

    const def = defRaw && typeof defRaw === "object" ? defRaw : {};
    const label = String(def.label || shapeKey);
    const productHandle = def.productHandle ? String(def.productHandle) : "";
    const sizeOptionKey = def.sizeOptionKey ? String(def.sizeOptionKey) : "";
    const colorOptionKey = def.colorOptionKey ? String(def.colorOptionKey) : "color";
    const defaultColorKey = String(def.defaultColorKey || "white");

    const baseSizes = Array.isArray(def.sizes) ? def.sizes.map(normalizeSizeRow).filter((s) => s.sizeKey) : [];

    let colors = {};
    if (def.colors && typeof def.colors === "object") {
      for (const [ckRaw, cdefRaw] of Object.entries(def.colors)) {
        const ck = String(ckRaw || cdefRaw?.colorKey || "").trim();
        if (!ck) continue;
        const cdef = cdefRaw && typeof cdefRaw === "object" ? cdefRaw : {};
        const sizes = Array.isArray(cdef.sizes) ? cdef.sizes.map(normalizeSizeRow).filter((s) => s.sizeKey) : [];
        colors[ck] = {
          colorKey: String(cdef.colorKey || ck),
          label: String(cdef.label || ck),
          sizes,
        };
      }
    }

    if (!Object.keys(colors).length && baseSizes.length) {
      colors = { white: { colorKey: "white", label: "Weiß", sizes: baseSizes } };
    }

    if (Object.keys(colors).length && baseSizes.length) {
      for (const ck of Object.keys(colors)) {
        const c = colors[ck];
        if (!Array.isArray(c.sizes) || !c.sizes.length) {
          c.sizes = baseSizes.map((s) => ({ ...s, variantId: "" }));
        }
      }
    }

    out[shapeKey] = {
      ...def,
      shapeKey,
      label,
      productHandle,
      sizeOptionKey,
      colorOptionKey,
      defaultColorKey,
      colors,
      sizes: baseSizes.length ? baseSizes : colors?.white?.sizes || [],
    };
  }

  return out;
}

// ==============================
// Freeform Mask/Preview Engine
// ==============================
function invertMask(mask) {
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = mask[i] ? 0 : 1;
  return out;
}

function dilateMaskExact(mask, w, h, radiusPx) {
  const r = Math.max(0, Math.round(radiusPx || 0));
  if (r <= 0) return mask;

  const offsets = [];
  const rr = r * r;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy <= rr) offsets.push([dx, dy]);
    }
  }

  const out = new Uint8Array(w * h);

  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (!mask[row + x]) continue;
      for (let i = 0; i < offsets.length; i++) {
        const nx = x + offsets[i][0];
        const ny = y + offsets[i][1];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        out[ny * w + nx] = 1;
      }
    }
  }

  return out;
}

function erodeMaskExact(mask, w, h, radiusPx) {
  const inv = invertMask(mask);
  const dil = dilateMaskExact(inv, w, h, radiusPx);
  return invertMask(dil);
}

function closeMaskExact(mask, w, h, radiusPx) {
  const r = Math.max(0, Math.round(radiusPx || 0));
  if (r <= 0) return mask;
  const dil = dilateMaskExact(mask, w, h, r);
  const ero = erodeMaskExact(dil, w, h, r);
  return ero;
}

function buildInsideMaskFromAlpha(imgData, w, h, alphaThreshold = 8, sealGapsPx = 0) {
  const a = imgData.data;

  let opaque = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const alpha = a[i * 4 + 3];
    opaque[i] = alpha > alphaThreshold ? 1 : 0;
  }

  const r = Math.max(0, Math.round(sealGapsPx || 0));
  if (r > 0) {
    opaque = closeMaskExact(opaque, w, h, r);
  }

  const outside = new Uint8Array(w * h);
  const qx = new Int32Array(w * h);
  const qy = new Int32Array(w * h);
  let qs = 0;
  let qe = 0;

  const push = (x, y) => {
    qx[qe] = x;
    qy[qe] = y;
    qe++;
  };

  const trySeed = (x, y) => {
    const idx = y * w + x;
    if (!opaque[idx] && !outside[idx]) {
      outside[idx] = 1;
      push(x, y);
    }
  };

  for (let x = 0; x < w; x++) {
    trySeed(x, 0);
    trySeed(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    trySeed(0, y);
    trySeed(w - 1, y);
  }

  while (qs < qe) {
    const x = qx[qs];
    const y = qy[qs];
    qs++;

    const nb = [
      [x + 1, y],
      [x - 1, y],
      [x, y + 1],
      [x, y - 1],
    ];

    for (const [nx, ny] of nb) {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const nidx = ny * w + nx;
      if (!opaque[nidx] && !outside[nidx]) {
        outside[nidx] = 1;
        push(nx, ny);
      }
    }
  }

  const inside = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) inside[i] = outside[i] ? 0 : 1;
  return inside;
}

function maskToAlphaCanvas(mask, w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) return c;

  const img = ctx.createImageData(w, h);
  const d = img.data;
  for (let i = 0; i < w * h; i++) {
    const a = mask[i] ? 255 : 0;
    d[i * 4 + 0] = 0;
    d[i * 4 + 1] = 0;
    d[i * 4 + 2] = 0;
    d[i * 4 + 3] = a;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function scheduleIdle(fn, timeoutMs = 500) {
  if (typeof window !== "undefined" && "requestIdleCallback" in window) {
    const id = window.requestIdleCallback(fn, { timeout: timeoutMs });
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(fn, 120);
  return () => window.clearTimeout(id);
}

function canvasToObjectUrl(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) return reject(new Error("toBlob() liefert null"));
        const url = URL.createObjectURL(blob);
        resolve(url);
      },
      "image/png",
      0.92
    );
  });
}

function buildFreeformMasterMask({
  imgEl,
  imgAspect,
  getMasterRectFromAspect,
  maxMaskDim = 520,
  alphaThreshold = 8,
  padPx = 120,
}) {
  const inner = getMasterRectFromAspect(imgAspect || 1);
  const innerW = inner.w;
  const innerH = inner.h;

  const masterW = innerW + padPx * 2;
  const masterH = innerH + padPx * 2;

  const src = document.createElement("canvas");
  src.width = masterW;
  src.height = masterH;
  const sctx = src.getContext("2d");
  if (!sctx) throw new Error("Canvas Kontext nicht verfügbar.");

  const iw = imgEl.naturalWidth || imgEl.width || 1;
  const ih = imgEl.naturalHeight || imgEl.height || 1;

  const scale = Math.min(innerW / iw, innerH / ih);
  const dw = iw * scale;
  const dh = ih * scale;

  const dx = padPx + (innerW - dw) / 2;
  const dy = padPx + (innerH - dh) / 2;

  sctx.clearRect(0, 0, masterW, masterH);
  sctx.imageSmoothingEnabled = true;
  sctx.drawImage(imgEl, dx, dy, dw, dh);

  const s = Math.min(1, maxMaskDim / Math.max(masterW, masterH));
  const mw = Math.max(1, Math.round(masterW * s));
  const mh = Math.max(1, Math.round(masterH * s));

  const mcan = document.createElement("canvas");
  mcan.width = mw;
  mcan.height = mh;
  const mctx = mcan.getContext("2d");
  if (!mctx) throw new Error("Mask Canvas Kontext nicht verfügbar.");

  mctx.clearRect(0, 0, mw, mh);
  mctx.imageSmoothingEnabled = true;
  mctx.imageSmoothingQuality = "high";
  mctx.drawImage(src, 0, 0, mw, mh);

  const mdata = mctx.getImageData(0, 0, mw, mh);
  const insideMask = buildInsideMaskFromAlpha(mdata, mw, mh, alphaThreshold, FREEFORM_SEAL_GAPS_PX);

  return {
    src,
    masterW,
    masterH,
    mw,
    mh,
    insideMask,
    padPx,
    innerW,
    innerH,
    _cache: new Map(),
  };
}

function maskBBox(mask, w, h) {
  let minX = w,
    minY = h,
    maxX = -1,
    maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (!mask[row + x]) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return { minX: 0, minY: 0, maxX: w - 1, maxY: h - 1 };
  return { minX, minY, maxX, maxY };
}

function maskAspectFromBBox(mask, w, h) {
  const bb = maskBBox(mask, w, h);
  const bw = Math.max(1, bb.maxX - bb.minX + 1);
  const bh = Math.max(1, bb.maxY - bb.minY + 1);
  const ar = bw / bh;
  if (!Number.isFinite(ar) || ar <= 1e-6) return 1;
  return Math.min(10, Math.max(0.1, ar));
}

function renderFreeformFromMasterMask({ master, outWpx, outHpx, bgColor, borderPx }) {
  const outW = Math.max(1, Math.round(outWpx));
  const outH = Math.max(1, Math.round(outHpx));

  const pxPerMask = outW / Math.max(1, master.mw);
  const borderInMaskPx = Math.max(1, Math.round((borderPx || 0) / Math.max(1e-9, pxPerMask)));

  const key = borderInMaskPx;
  let cached = master?._cache?.get?.(key);

  if (!cached) {
    const backingMask = dilateMaskExact(master.insideMask, master.mw, master.mh, borderInMaskPx);
    const backingC = maskToAlphaCanvas(backingMask, master.mw, master.mh);
    cached = { backingMask, backingC };
    master._cache.set(key, cached);
    if (master._cache.size > 12) {
      const firstKey = master._cache.keys().next().value;
      master._cache.delete(firstKey);
    }
  }

  const backingMask = cached.backingMask;
  const backingC = cached.backingC;

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
  if (!ctx) throw new Error("Canvas Kontext nicht verfügbar.");

  const offX = -minX * sx;
  const offY = -minY * sy;

  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.globalCompositeOperation = "source-over";
  ctx.drawImage(backingC, 0, 0, master.mw, master.mh, offX, offY, outW, outH);

  if (bgColor && String(bgColor).toLowerCase() !== "transparent") {
    ctx.globalCompositeOperation = "source-in";
    ctx.fillStyle = bgColor || "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  ctx.restore();

  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.globalCompositeOperation = "source-over";
  ctx.drawImage(master.src, 0, 0, master.masterW, master.masterH, offX, offY, outW, outH);
  ctx.restore();

  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.globalCompositeOperation = "destination-in";
  ctx.drawImage(backingC, 0, 0, master.mw, master.mh, offX, offY, outW, outH);
  ctx.restore();

  return canvas;
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
// ✅ Export-Cutline: Kontur -> SVG PathD
// ==============================

// Ramer–Douglas–Peucker Simplification
function rdp(points, epsilon) {
  if (!points || points.length < 3) return points || [];
  const eps = Math.max(0, Number(epsilon) || 0);

  const distPointLine = (p, a, b) => {
    const x = p[0],
      y = p[1];
    const x1 = a[0],
      y1 = a[1];
    const x2 = b[0],
      y2 = b[1];
    const dx = x2 - x1,
      dy = y2 - y1;
    if (dx === 0 && dy === 0) return Math.hypot(x - x1, y - y1);
    const t = ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy);
    const tt = Math.max(0, Math.min(1, t));
    const px = x1 + tt * dx,
      py = y1 + tt * dy;
    return Math.hypot(x - px, y - py);
  };

  const simplify = (pts) => {
    let dmax = 0;
    let idx = 0;
    const end = pts.length - 1;
    for (let i = 1; i < end; i++) {
      const d = distPointLine(pts[i], pts[0], pts[end]);
      if (d > dmax) {
        dmax = d;
        idx = i;
      }
    }
    if (dmax > eps) {
      const left = simplify(pts.slice(0, idx + 1));
      const right = simplify(pts.slice(idx));
      return left.slice(0, -1).concat(right);
    }
    return [pts[0], pts[end]];
  };

  return simplify(points);
}

// pragmatische Kontur (funktioniert stabil für Sticker-Cutlines)
// mask: Uint8Array (0/1), w/h
function marchingSquaresContour(mask, w, h) {
  const inside = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return 0;
    return mask[y * w + x] ? 1 : 0;
  };

  let sx = -1,
    sy = -1;
  for (let y = 0; y < h && sy < 0; y++) {
    for (let x = 0; x < w; x++) {
      if (inside(x, y) && !inside(x - 1, y)) {
        sx = x;
        sy = y;
        break;
      }
    }
  }
  if (sx < 0) return [];

  let x = sx,
    y = sy;
  let dir = 0;
  const pts = [];
  pts.push([x, y]);

  const step = () => {
    const a = inside(x - 1, y - 1);
    const b = inside(x, y - 1);
    const c = inside(x - 1, y);
    const d = inside(x, y);

    const idx = (a << 3) | (b << 2) | (c << 1) | d;

    switch (idx) {
      case 1:
      case 5:
      case 9:
      case 13:
        dir = 0;
        break; // up
      case 2:
      case 3:
      case 6:
      case 7:
        dir = 3;
        break; // left
      case 8:
      case 10:
      case 11:
      case 14:
        dir = 2;
        break; // down
      default:
        dir = 1; // right
    }

    if (dir === 0) y -= 1;
    else if (dir === 1) x += 1;
    else if (dir === 2) y += 1;
    else x -= 1;

    pts.push([x, y]);
  };

  const maxSteps = w * h + (w + h) * 50;
  for (let i = 0; i < maxSteps; i++) {
    step();
    if (x === sx && y === sy && i > 10) break;
  }

  return pts;
}

function pointsToPathD(points, scaleX, scaleY, offsetX = 0, offsetY = 0) {
  if (!points || points.length < 2) return "";
  const p0 = points[0];
  let d = `M ${((p0[0] * scaleX) + offsetX).toFixed(2)} ${((p0[1] * scaleY) + offsetY).toFixed(2)}`;
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    d += ` L ${((p[0] * scaleX) + offsetX).toFixed(2)} ${((p[1] * scaleY) + offsetY).toFixed(2)}`;
  }
  d += " Z";
  return d;
}

function buildFreeformCutlinePathFromMaster(master, outW, outH, borderPxOut) {
  if (!master?.insideMask || !master.mw || !master.mh) return "";

  const pxPerMask = outW / Math.max(1, master.mw);
  const borderInMask = Math.max(1, Math.round((borderPxOut || 0) / Math.max(1e-9, pxPerMask)));

  const backingMask = dilateMaskExact(master.insideMask, master.mw, master.mh, borderInMask);

  const rawPts = marchingSquaresContour(backingMask, master.mw, master.mh);
  if (!rawPts.length) return "";

  const smooth = rdp(rawPts, 1.2);

  const sx = outW / Math.max(1, master.mw);
  const sy = outH / Math.max(1, master.mh);

  return pointsToPathD(smooth, sx, sy, 0, 0);
}

// ==============================
// Component
// ==============================
export default function StickerCanvasClient({
  productId = null,
  initialVariantId = null,
  pricingVariantId = null,
  apiBase = "",
  shapeHandles = null,
  defaultShape = "square",
  defaultWidthCm = 4,
  defaultHeightCm = 4,
  defaultBgColor = "#ffffff",
  defaultImageUrl = "",
}) {
  const [catalog, setCatalog] = useState(null);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const b = String(apiBase || "").trim();
    if (b) window.__STICKER_API_BASE__ = b.replace(/\/$/, "");

    if (shapeHandles && typeof shapeHandles === "object") {
      window.__SC_SHAPE_HANDLES__ = shapeHandles;
    }
  }, [apiBase, shapeHandles]);

  const [shape, setShape] = useState(String(defaultShape || "square").toLowerCase());
  const shapeMeta = useMemo(() => getShapeMeta(shape), [shape]);
  const baseShapeKey = String(shapeMeta?.base || shape || "").toLowerCase();

  const [colorKey, setColorKey] = useState("white");
  const [sizeKey, setSizeKey] = useState("");

  const [widthCm, setWidthCm] = useState(clampNum(defaultWidthCm, 1, 300));
  const [heightCm, setHeightCm] = useState(clampNum(defaultHeightCm, 1, 300));

  const [billingWidthCm, setBillingWidthCm] = useState(clampNum(defaultWidthCm, 1, 300));
  const [billingHeightCm, setBillingHeightCm] = useState(clampNum(defaultHeightCm, 1, 300));

  const [freeformCutAspect, setFreeformCutAspect] = useState(1);
  const lastFreeformEditRef = useRef("w");

  const [freeformLongSideCm, setFreeformLongSideCm] = useState(4);

  const [bgMode, setBgMode] = useState("color");
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

  // ✅ UI-Cutline nur für "white" und "color" (farbig)
  const shouldShowCutline = useMemo(() => bgMode === "white" || bgMode === "color", [bgMode]);

  const [imageUrl, setImageUrl] = useState(defaultImageUrl || "");
  const [uploadedUrl, setUploadedUrl] = useState(() =>
    defaultImageUrl && isProbablyRemoteUrl(defaultImageUrl) ? defaultImageUrl : ""
  );

  const [freeformBorderMm, setFreeformBorderMm] = useState(3);

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

  const fileInputRef = useRef(null);
  const pendingFileRef = useRef(null);
  const remoteUploadPromiseRef = useRef(null);
  const uploadGenIdRef = useRef(0);
  const localPreviewUrlRef = useRef(null);

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

  const imgElRef = useRef(null);
  const imgElUrlRef = useRef("");

  const lastExportKeyRef = useRef("");
  const lastExportSvgUrlRef = useRef("");

  const [vp, setVp] = useState(() => ({
    w: typeof window !== "undefined" ? window.innerWidth : 1200,
    h: typeof window !== "undefined" ? window.innerHeight : 800,
  }));

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onResize = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    onResize();
    window.addEventListener("resize", onResize, { passive: true });
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const isMobile = vp.w <= 900;

  // ✅ Preview an RIGHT PANEL koppeln (ResizeObserver)
  const rightPanelRef = useRef(null);
  const [rightBox, setRightBox] = useState({ w: 900, h: 600 });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const el = rightPanelRef.current;
    if (!el) return;

    const clampWH = (w, h) => ({
      w: Math.max(200, Math.round(w || 0)),
      h: Math.max(200, Math.round(h || 0)),
    });

    const measure = () => {
      const r = el.getBoundingClientRect?.();
      if (!r) return;

      if (r.width > 0 && r.height > 0) {
        const next = clampWH(r.width, r.height);
        setRightBox((prev) => (prev.w === next.w && prev.h === next.h ? prev : next));
      }
    };

    measure();

    let ro = null;
    if ("ResizeObserver" in window) {
      ro = new ResizeObserver((entries) => {
        const r = entries?.[0]?.contentRect;
        if (!r) return;
        const next = clampWH(r.width, r.height);
        setRightBox((prev) => (prev.w === next.w && prev.h === next.h ? prev : next));
      });
      ro.observe(el);
    }

    let raf = 0;
    let rafCount = 0;
    const rafKick = () => {
      rafCount += 1;
      measure();
      if (rafCount < 60) raf = requestAnimationFrame(rafKick);
    };
    raf = requestAnimationFrame(rafKick);

    const onToggle = () => measure();
    document.addEventListener("toggle", onToggle, true);
    window.addEventListener("orientationchange", measure, { passive: true });

    return () => {
      if (ro) ro.disconnect();
      cancelAnimationFrame(raf);
      document.removeEventListener("toggle", onToggle, true);
      window.removeEventListener("orientationchange", measure);
    };
  }, []);

  // ✅ helper: "aktive" Maße
  const effDims = useMemo(() => {
    if (shape !== "freeform") return { wCm: widthCm, hCm: heightCm, scaled: false, k: 1 };
    return enforceMinEdgeCm(billingWidthCm, billingHeightCm, MIN_EDGE_CM);
  }, [shape, widthCm, heightCm, billingWidthCm, billingHeightCm]);

  const effWcm = effDims.wCm;
  const effHcm = effDims.hCm;

  function freeformDimsFromLongSide(longSideCm, aspectWdivH) {
    const long = clampNum(longSideCm, MIN_EDGE_CM, 20);
    const ar = Number(aspectWdivH);
    const safeAr = Number.isFinite(ar) && ar > 1e-6 ? ar : 1;

    let w = long;
    let h = long;

    if (safeAr >= 1) {
      w = long;
      h = long / safeAr;
    } else {
      h = long;
      w = long * safeAr;
    }

    const r = enforceMinEdgeCm(w, h, MIN_EDGE_CM);
    w = r.wCm;
    h = r.hCm;

    const maxSide = Math.max(w, h);
    if (maxSide > 20) {
      const k = 20 / Math.max(1e-9, maxSide);
      w *= k;
      h *= k;
    }

    return { wCm: Number(w.toFixed(2)), hCm: Number(h.toFixed(2)) };
  }

  useEffect(() => {
    if (shape !== "freeform") return;

    const r = enforceMinEdgeCm(billingWidthCm, billingHeightCm, MIN_EDGE_CM);
    if (!r.scaled) return;

    setBillingWidthCm(clampNum(r.wCm, MIN_EDGE_CM, 300));
    setBillingHeightCm(clampNum(r.hCm, MIN_EDGE_CM, 300));

    const k = Number(r.k) || 1;
    if (k > 1.0001) {
      setWidthCm((prev) => clampNum((Number(prev) || MIN_EDGE_CM) * k, 1, 300));
      setHeightCm((prev) => clampNum((Number(prev) || MIN_EDGE_CM) * k, 1, 300));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape, billingWidthCm, billingHeightCm]);

  useEffect(() => {
    if (shape !== "freeform") return;

    const ar = freeformCutAspect || imgAspect || 1;
    const dims = freeformDimsFromLongSide(freeformLongSideCm, ar);

    if (!approxEq(billingWidthCm, dims.wCm, 0.01)) setBillingWidthCm(dims.wCm);
    if (!approxEq(billingHeightCm, dims.hCm, 0.01)) setBillingHeightCm(dims.hCm);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape, freeformLongSideCm, freeformCutAspect, imgAspect]);

  async function fetchVariantCatalog() {
    const baseUrl = api("/sticker/upload");
    const sep = String(baseUrl).includes("?") ? "&" : "?";
    const url = `${baseUrl}${sep}cb=${Date.now()}`;

    const res = await fetch(url, {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });

    if (!res.ok) throw new Error(`Catalog fetch failed: ${res.status}`);
    const data = await res.json().catch(() => null);
    return data?.catalog || null;
  }

  useEffect(() => {
    let alive = true;
    fetchVariantCatalog()
      .then((cat) => {
        if (!alive) return;
        const norm = normalizeCatalog(cat);
        setCatalog(norm || null);
      })
      .catch((e) => console.error("[catalog]", e));
    return () => {
      alive = false;
    };
  }, []);

  const shapeDef = useMemo(() => {
    return catalog?.[baseShapeKey] || null;
  }, [catalog, baseShapeKey]);

  const hasCatalogColors = useMemo(() => {
    return !!(shapeDef && !Array.isArray(shapeDef) && shapeDef?.colors && typeof shapeDef.colors === "object");
  }, [shapeDef]);

  const availableColors = useMemo(() => {
    if (hasCatalogColors) {
      const colorsObj = shapeDef.colors || {};
      const out = Object.values(colorsObj)
        .map((c) => ({
          colorKey: String(c?.colorKey || ""),
          label: String(c?.label || c?.colorKey || ""),
        }))
        .filter((x) => x.colorKey);
      return out.length ? out : FALLBACK_COLORWAYS;
    }
    return FALLBACK_COLORWAYS;
  }, [shapeDef, hasCatalogColors]);

  const availableSizes = useMemo(() => {
    if (!shapeDef) return [];

    const rot = !!shapeMeta?.rotateDims;

    if (hasCatalogColors) {
      const c = shapeDef?.colors?.[colorKey] || null;
      const list = Array.isArray(c?.sizes) ? c.sizes : [];
      return list
        .map((s) => normalizeSizeRow(s))
        .filter((s) => s.sizeKey)
        .map((s) => {
          const w = s.widthCm;
          const h = s.heightCm;
          const wOut = rot ? h : w;
          const hOut = rot ? w : h;

          return {
            sizeKey: s.sizeKey,
            label: rot ? flipSizeLabel(s.label) : s.label,
            wCm: wOut,
            hCm: hOut,
            variantId: s.variantId,
            piecesPerSet: s.piecesPerSet ?? null,
          };
        });
    }

    const list = Array.isArray(shapeDef?.sizes) ? shapeDef.sizes : Array.isArray(shapeDef) ? shapeDef : [];
    return (list || [])
      .map((s) => normalizeSizeRow(s))
      .filter((s) => s.sizeKey)
      .map((s) => {
        const w = s.widthCm;
        const h = s.heightCm;
        const wOut = rot ? h : w;
        const hOut = rot ? w : h;

        return {
          sizeKey: s.sizeKey,
          label: rot ? flipSizeLabel(s.label) : s.label,
          wCm: wOut,
          hCm: hOut,
          variantId: s.variantId,
        };
      });
  }, [shapeDef, hasCatalogColors, colorKey, shapeMeta]);

  const selectedSizeObj = useMemo(() => {
    return availableSizes.find((s) => String(s.sizeKey) === String(sizeKey)) || null;
  }, [availableSizes, sizeKey]);

  useEffect(() => {
    if (!catalog || !shapeDef) return;

    let nextColor = String(colorKey || "white");

    if (hasCatalogColors) {
      const colorsObj = shapeDef.colors || {};
      const defKey = String(shapeDef?.defaultColorKey || "white");
      if (!colorsObj[nextColor]) {
        if (colorsObj[defKey]) nextColor = defKey;
        else nextColor = String(Object.keys(colorsObj)[0] || "white");
      }
    } else {
      if (!nextColor) nextColor = "white";
    }

    if (nextColor !== colorKey) setColorKey(nextColor);

    const list = (() => {
      if (hasCatalogColors) {
        const c = shapeDef?.colors?.[nextColor];
        return Array.isArray(c?.sizes) ? c.sizes.map(normalizeSizeRow).filter((s) => s.sizeKey) : [];
      }
      const base = Array.isArray(shapeDef?.sizes) ? shapeDef.sizes : Array.isArray(shapeDef) ? shapeDef : [];
      return (base || []).map(normalizeSizeRow).filter((s) => s.sizeKey);
    })();

    if (!list.length) {
      if (sizeKey) setSizeKey("");
      return;
    }

    if (shape === "freeform") return;

    const exists = list.some((x) => String(x.sizeKey) === String(sizeKey));
    if (!exists) setSizeKey(String(list[0]?.sizeKey || ""));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape, catalog, shapeDef, hasCatalogColors]);

  useEffect(() => {
    if (!catalog || !shapeDef) return;
    if (shape === "freeform") return;

    const list = hasCatalogColors
      ? (shapeDef?.colors?.[colorKey]?.sizes || []).map(normalizeSizeRow).filter((s) => s.sizeKey)
      : (Array.isArray(shapeDef?.sizes) ? shapeDef.sizes : []).map(normalizeSizeRow).filter((s) => s.sizeKey);

    if (!list.length) {
      if (sizeKey) setSizeKey("");
      return;
    }

    const exists = list.some((x) => String(x.sizeKey) === String(sizeKey));
    if (!exists) setSizeKey(String(list[0]?.sizeKey || ""));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape, colorKey, hasCatalogColors, catalog]);

  useEffect(() => {
    if (shape !== "freeform") return;
    if (!availableSizes.length) return;

    const best = pickBillingSizeForFreeform(effWcm, effHcm, availableSizes);
    if (!best) return;

    const nextKey = String(best.sizeKey || "");
    if (nextKey && nextKey !== String(sizeKey || "")) setSizeKey(nextKey);

    const vid = String(best.variantId || "");
    if (vid) {
      const n = Number(vid) || 0;
      if (n && n !== Number(selectedVariantId)) setSelectedVariantId(n);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape, effWcm, effHcm, availableSizes]);

  useEffect(() => {
    if (shape !== "freeform") return;

    const bw = clampNum(effWcm, MIN_EDGE_CM, 300);
    const bh = clampNum(effHcm, MIN_EDGE_CM, 300);

    const ar = freeformCutAspect || imgAspect || 1;
    const fit = fitAspectIntoBox(bw, bh, ar);

    const wNext = clampNum(fit.w, 1, 300);
    const hNext = clampNum(fit.h, 1, 300);

    if (!approxEq(widthCm, wNext, 0.01)) setWidthCm(wNext);
    if (!approxEq(heightCm, hNext, 0.01)) setHeightCm(hNext);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape, effWcm, effHcm, imgAspect, freeformCutAspect]);

  useEffect(() => {
    if (!selectedSizeObj) return;

    const w = Number(selectedSizeObj.wCm);
    const h = Number(selectedSizeObj.hCm);
    const vid = String(selectedSizeObj.variantId || "");
    const trustCatalogVid = !!hasCatalogColors || String(colorKey || "white") === "white";
    if (vid && trustCatalogVid) {
      const n = Number(vid) || 0;
      if (n && n !== Number(selectedVariantId)) setSelectedVariantId(n);
    }

    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return;

    if (shape === "freeform") {
      return;
    } else {
      setWidthCm(w);
      setHeightCm(h);
      setBillingWidthCm(w);
      setBillingHeightCm(h);
    }
  }, [selectedSizeObj, shape, selectedVariantId, hasCatalogColors, colorKey]);

  useEffect(() => {
    if (shape === "freeform") return;
    setBillingWidthCm(widthCm);
    setBillingHeightCm(heightCm);
  }, [shape, widthCm, heightCm]);

  useEffect(() => {
    if (shape !== "freeform") return;
    const long = Math.max(Number(effWcm) || MIN_EDGE_CM, Number(effHcm) || MIN_EDGE_CM);
    const next =
      FREEFORM_LONGSIDE_PRESETS_CM.find((x) => x >= long) ||
      FREEFORM_LONGSIDE_PRESETS_CM[FREEFORM_LONGSIDE_PRESETS_CM.length - 1];
    if (Number(next) && next !== freeformLongSideCm) setFreeformLongSideCm(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape]);

  const [activeHandle, setActiveHandle] = useState(() => {
    const map = getShapeHandleMap();
    const current = guessCurrentProductHandle();
    const meta = getShapeMeta(defaultShape || "square");
    const key = String(meta?.base || defaultShape || "square").toLowerCase();
    return map && map[key] ? String(map[key]) : current;
  });

  useEffect(() => {
    const map = getShapeHandleMap();
    const current = guessCurrentProductHandle();
    const key = String(shapeMeta?.base || shape || "square").toLowerCase();
    const next = map && map[key] ? String(map[key]) : current;
    if (next && next !== activeHandle) setActiveHandle(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape, shapeMeta]);

  const variantInfoCacheRef = useRef(new Map());
  const variantInfoInFlightRef = useRef(new Map());

  useEffect(() => {
    let cancelled = false;

    const vid = Number(selectedVariantId) || 0;
    if (!vid) return;

    const cached = variantInfoCacheRef.current.get(vid);
    if (cached) {
      setSelectedVariantPrice(Number(cached.price) || 0);
      setSelectedVariantTitle(String(cached.title || ""));
      return;
    }

    const fromList = Array.isArray(productVariants) ? productVariants.find((x) => Number(x?.id) === vid) : null;

    if (fromList) {
      const price = toEuroFromCents(fromList?.price);
      const title = String(fromList?.title || "");
      variantInfoCacheRef.current.set(vid, { price, title });
      setSelectedVariantPrice(price);
      setSelectedVariantTitle(title);
      return;
    }

    if (variantInfoInFlightRef.current.get(vid)) {
      return () => {
        cancelled = true;
      };
    }

    const controller = new AbortController();

    const p = (async () => {
      try {
        const res = await fetch(`/variants/${vid}.js`, {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });

        if (res.ok) {
          const j = await res.json().catch(() => null);
          if (j && !cancelled) {
            const price = toEuroFromCents(j?.price);
            const title = String(j?.public_title || j?.title || "");
            variantInfoCacheRef.current.set(vid, { price, title });
            setSelectedVariantPrice(price);
            setSelectedVariantTitle(title);
            return;
          }
        }
      } catch (_) {}

      try {
        const res = await fetch(api(`/sticker/variant?variantId=${encodeURIComponent(String(vid))}`), {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });

        const j = await res.json().catch(() => null);
        if (res.ok && j && j.ok) {
          const raw = j.price ?? j.priceCents ?? j.cents ?? j.amount ?? "";
          let priceNum = 0;

          if (typeof raw === "number") {
            priceNum = raw > 999 ? toEuroFromCents(raw) : raw;
          } else {
            const str = String(raw).trim();
            if (/^\d+$/.test(str) && str.length >= 3) priceNum = toEuroFromCents(Number(str));
            else priceNum = Number(str.replace(",", "."));
          }

          const price = Number.isFinite(priceNum) ? priceNum : 0;
          const title = String(j.title || j.public_title || j.name || "");

          if (!cancelled) {
            variantInfoCacheRef.current.set(vid, { price, title });
            setSelectedVariantPrice(price);
            setSelectedVariantTitle(title);
          }
          return;
        }
      } catch (_) {}

      try {
        const shopHost = normalizeShopDomain(guessShopDomain());
        if (!shopHost) return;

        const res = await fetch(`https://${shopHost}/variants/${vid}.js`, {
          credentials: "omit",
          signal: controller.signal,
        });

        if (!res.ok) return;

        const j = await res.json().catch(() => null);
        if (!j || cancelled) return;

        const price = toEuroFromCents(j?.price);
        const title = String(j?.public_title || j?.title || "");

        variantInfoCacheRef.current.set(vid, { price, title });
        setSelectedVariantPrice(price);
        setSelectedVariantTitle(title);
      } catch (_) {}
    })().finally(() => {
      variantInfoInFlightRef.current.delete(vid);
    });

    variantInfoInFlightRef.current.set(vid, p);

    return () => {
      cancelled = true;
      try {
        controller.abort();
      } catch (_) {}
    };
  }, [selectedVariantId, productVariants]);

  useEffect(() => {
    setPriceTotal(Number(selectedVariantPrice) || 0);
  }, [selectedVariantPrice]);

  useEffect(() => {
    return () => {
      if (freeformPreviewObjUrlRef.current) {
        URL.revokeObjectURL(freeformPreviewObjUrlRef.current);
        freeformPreviewObjUrlRef.current = null;
      }
      if (localPreviewUrlRef.current) {
        URL.revokeObjectURL(localPreviewUrlRef.current);
        localPreviewUrlRef.current = null;
      }
      if (serverPreviewDebounceRef.current) {
        clearTimeout(serverPreviewDebounceRef.current);
        serverPreviewDebounceRef.current = null;
      }
      if (serverPreviewAbortRef.current) {
        serverPreviewAbortRef.current.abort();
        serverPreviewAbortRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!imageUrl) {
      setImgAspect(1);
      imgElRef.current = null;
      imgElUrlRef.current = "";
      return;
    }

    let cancelled = false;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.decoding = "async";

    img.onload = async () => {
      if (cancelled) return;
      try {
        if (img.decode) await img.decode();
      } catch {}

      imgElRef.current = img;
      imgElUrlRef.current = imageUrl;

      const w = img.naturalWidth || 1;
      const h = img.naturalHeight || 1;
      const ratio = h > 0 ? w / h : 1;

      if (Number.isFinite(ratio) && ratio > 0) {
        setImgAspect(ratio);

        if (shape === "freeform") {
          const bw = clampNum(billingWidthCm, 1, 300);
          const bh = clampNum(billingHeightCm, 1, 300);

          if (bw <= 1.1 && bh <= 1.1) {
            let boxW = MIN_EDGE_CM;
            let boxH = MIN_EDGE_CM;
            if (ratio >= 1) {
              boxW = MIN_EDGE_CM * ratio;
              boxH = MIN_EDGE_CM;
            } else {
              boxW = MIN_EDGE_CM;
              boxH = MIN_EDGE_CM / ratio;
            }
            setBillingWidthCm(clampNum(boxW, 1, 300));
            setBillingHeightCm(clampNum(boxH, 1, 300));
          }
        }
      } else {
        setImgAspect(1);
      }
    };

    img.onerror = () => {
      if (!cancelled) {
        setImgAspect(1);
        imgElRef.current = null;
        imgElUrlRef.current = "";
      }
    };

    img.src = imageUrl;

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageUrl, shape]);

  function getMasterRectFromAspect(aspect) {
    const ar = Number(aspect) > 0 ? Number(aspect) : 1;
    if (ar >= 1) {
      const w = FREEFORM_MASTER_LONG_SIDE;
      const h = Math.max(1, Math.round(w / ar));
      return { w, h };
    } else {
      const h = FREEFORM_MASTER_LONG_SIDE;
      const w = Math.max(1, Math.round(h * ar));
      return { w, h };
    }
  }

  function mmToPx(mm) {
    const m = clampNum(mm, 0, 50);
    return Math.max(1, Math.round((m / 10) * PX_PER_CM));
  }

  useEffect(() => {
    if (!imageUrl) {
      setFreeformMaster(null);
      return;
    }
    if (shape !== "freeform" || serverPreviewUrl) return;

    let cancelled = false;
    (async () => {
      try {
        const shared = imgElUrlRef.current === imageUrl ? imgElRef.current : null;
        const img = shared || (await loadImage(imageUrl));

        const master = buildFreeformMasterMask({
          imgEl: img,
          imgAspect: imgAspect || 1,
          getMasterRectFromAspect,
          maxMaskDim: 520,
          padPx: 120,
        });

        if (!cancelled) {
          setFreeformMaster(master);

          const ar = maskAspectFromBBox(master.insideMask, master.mw, master.mh);
          setFreeformCutAspect(ar);

          const edited = lastFreeformEditRef.current || "w";
          const r = enforceAspectWithMinEdge({
            wCm: billingWidthCm,
            hCm: billingHeightCm,
            aspectWdivH: ar || imgAspect || 1,
            edited,
            minEdgeCm: MIN_EDGE_CM,
            maxEdgeCm: 300,
          });
          if (!approxEq(billingWidthCm, r.wCm, 0.01)) setBillingWidthCm(r.wCm);
          if (!approxEq(billingHeightCm, r.hCm, 0.01)) setBillingHeightCm(r.hCm);
        }
      } catch {
        if (!cancelled) setFreeformMaster(null);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageUrl, shape, imgAspect, serverPreviewUrl]);

  useEffect(() => {
    if (!imageUrl || shape !== "freeform" || !freeformMaster || serverPreviewUrl) {
      if (freeformPreviewObjUrlRef.current) {
        URL.revokeObjectURL(freeformPreviewObjUrlRef.current);
        freeformPreviewObjUrlRef.current = null;
      }
      setFreeformPreviewUrl("");
      setFreeformPreviewAspect(imgAspect || 1);
      return;
    }

    let cancelled = false;

    const cancelSchedule = scheduleIdle(async () => {
      if (cancelled) return;

      try {
        const billingRawW = Math.max(1, Math.round((Number(effWcm) || 0) * PX_PER_CM));
        const billingRawH = Math.max(1, Math.round((Number(effHcm) || 0) * PX_PER_CM));

        const billingMaxSide = Math.max(billingRawW, billingRawH);
        const k = billingMaxSide > FREEFORM_PREVIEW_MAX_SIDE ? FREEFORM_PREVIEW_MAX_SIDE / billingMaxSide : 1;

        const boxW = Math.max(1, Math.round(billingRawW * k));
        const boxH = Math.max(1, Math.round(billingRawH * k));

        const designRawW = Math.max(1, Math.round((Number(widthCm) || 0) * PX_PER_CM * k));
        const designRawH = Math.max(1, Math.round((Number(heightCm) || 0) * PX_PER_CM * k));

        const borderPx = Math.max(1, Math.round(mmToPx(freeformBorderMm) * k));

        const sticker = renderFreeformFromMasterMask({
          master: freeformMaster,
          outWpx: designRawW,
          outHpx: designRawH,
          bgColor: hasBgFill ? bgColorEff : "transparent",
          borderPx,
        });

        const boxed = composeStickerIntoBillingBox({
          stickerCanvas: sticker,
          boxWpx: boxW,
          boxHpx: boxH,
        });

        const ar = boxed.height > 0 ? boxed.width / boxed.height : 1;

        const objUrl = await canvasToObjectUrl(boxed);
        if (cancelled) {
          URL.revokeObjectURL(objUrl);
          return;
        }

        if (freeformPreviewObjUrlRef.current) {
          URL.revokeObjectURL(freeformPreviewObjUrlRef.current);
        }
        freeformPreviewObjUrlRef.current = objUrl;

        setFreeformPreviewUrl(objUrl);
        setFreeformPreviewAspect(ar);
      } catch (e) {
        console.warn("Freeform preview render failed:", e);
      }
    }, 500);

    return () => {
      cancelled = true;
      cancelSchedule();
    };
  }, [
    shape,
    imageUrl,
    bgColorEff,
    hasBgFill,
    freeformBorderMm,
    imgAspect,
    freeformMaster,
    widthCm,
    heightCm,
    billingWidthCm,
    billingHeightCm,
    effWcm,
    effHcm,
    serverPreviewUrl,
  ]);

  useEffect(() => {
    if (!imageUrl || shape !== "freeform") {
      setServerPreviewUrl("");
      lastGoodServerPreviewRef.current = "";
      lastServerPreviewKeyRef.current = "";

      if (serverPreviewDebounceRef.current) {
        clearTimeout(serverPreviewDebounceRef.current);
        serverPreviewDebounceRef.current = null;
      }
      if (serverPreviewAbortRef.current) {
        serverPreviewAbortRef.current.abort();
        serverPreviewAbortRef.current = null;
      }
      return;
    }

    const normalizedImageUrl = normalizeUrl(imageUrl);
    const allowServerPreview = isProbablyRemoteUrl(normalizedImageUrl) && !isBlobUrl(normalizedImageUrl);

    if (!allowServerPreview) {
      if (serverPreviewUrl) setServerPreviewUrl("");
      return;
    }

    const srcUrl = normalizedImageUrl;
    if (!srcUrl) {
      setServerPreviewUrl("");
      return;
    }

    const b = Number(freeformBorderMm || 0).toFixed(2);
    const key = `${srcUrl}|${shape}|${bgMode}|${bgColorEff}|${b}`;
    if (key === lastServerPreviewKeyRef.current) return;

    if (serverPreviewDebounceRef.current) clearTimeout(serverPreviewDebounceRef.current);

    serverPreviewDebounceRef.current = setTimeout(() => {
      lastServerPreviewKeyRef.current = key;

      if (serverPreviewAbortRef.current) serverPreviewAbortRef.current.abort();
      const ctrl = new AbortController();
      serverPreviewAbortRef.current = ctrl;

      const reqId = ++serverPreviewReqIdRef.current;

      (async () => {
        try {
          const res = await fetch(api("/sticker/preview"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: ctrl.signal,
            body: JSON.stringify({
              imageUrl: srcUrl,
              shape,
              bgMode,
              bgColor: bgColorEff,
              freeformBorderMm,
              maxPx: 700,
              sealGapsPx: FREEFORM_SEAL_GAPS_PX,
            }),
          });

          if (!res.ok) {
            const t = await res.text().catch(() => "");
            throw new Error(`Preview API error ${res.status}: ${t?.slice?.(0, 200) || ""}`);
          }

          const data = await res.json().catch(() => null);
          if (reqId !== serverPreviewReqIdRef.current) return;

          if (data?.previewUrl) {
            setServerPreviewUrl((prev) => (prev === data.previewUrl ? prev : data.previewUrl));
            lastGoodServerPreviewRef.current = data.previewUrl;
          }
        } catch (e) {
          if (e?.name === "AbortError") return;
          if (lastGoodServerPreviewRef.current) {
            setServerPreviewUrl(lastGoodServerPreviewRef.current);
            return;
          }
          setServerPreviewUrl("");
          console.warn("Server preview failed, fallback to client:", e);
        }
      })();
    }, 250);
  }, [imageUrl, shape, bgMode, bgColorEff, freeformBorderMm]);

  const normalizedDisplayImageUrl = useMemo(() => normalizeUrl(imageUrl), [imageUrl]);

  const displaySrc = useMemo(() => {
    if (shape === "freeform") {
      if (isBlobUrl(normalizedDisplayImageUrl)) return freeformPreviewUrl || normalizedDisplayImageUrl || "";
      return serverPreviewUrl || freeformPreviewUrl || normalizedDisplayImageUrl || "";
    }
    return normalizedDisplayImageUrl;
  }, [shape, serverPreviewUrl, freeformPreviewUrl, normalizedDisplayImageUrl]);

  const freeformReady = useMemo(() => {
    if (shape !== "freeform") return true;
    if (isBlobUrl(imageUrl)) return !!freeformPreviewUrl;
    return !!(serverPreviewUrl || freeformPreviewUrl);
  }, [shape, serverPreviewUrl, freeformPreviewUrl, imageUrl]);

  // ==============================
  // Upload: lokal sofort, remote erst bei Bedarf
  // ==============================
  async function uploadFile(file) {
    setErrorMsg("");
    setAddedMsg("");
    if (!file) return;

    uploadGenIdRef.current += 1;
    remoteUploadPromiseRef.current = null;

    if (localPreviewUrlRef.current) {
      URL.revokeObjectURL(localPreviewUrlRef.current);
      localPreviewUrlRef.current = null;
    }

    const localUrl = URL.createObjectURL(file);
    localPreviewUrlRef.current = localUrl;

    setImageUrl(localUrl);
    setUploadedUrl("");

    setServerPreviewUrl("");
    lastGoodServerPreviewRef.current = "";
    lastServerPreviewKeyRef.current = "";
    if (serverPreviewDebounceRef.current) {
      clearTimeout(serverPreviewDebounceRef.current);
      serverPreviewDebounceRef.current = null;
    }
    if (serverPreviewAbortRef.current) {
      serverPreviewAbortRef.current.abort();
      serverPreviewAbortRef.current = null;
    }

    setFreeformPreviewUrl("");
    if (freeformPreviewObjUrlRef.current) {
      URL.revokeObjectURL(freeformPreviewObjUrlRef.current);
      freeformPreviewObjUrlRef.current = null;
    }

    imgElRef.current = null;
    imgElUrlRef.current = "";

    setFreeformCutAspect(1);
    pendingFileRef.current = file;
  }

  async function ensureRemoteUpload() {
    if (uploadedUrl && !isBlobUrl(uploadedUrl)) return uploadedUrl;
    if (remoteUploadPromiseRef.current) return await remoteUploadPromiseRef.current;

    const original = pendingFileRef.current;
    if (!original) throw new Error("Kein Bild vorhanden. Bitte zuerst ein Bild wählen.");

    const myGen = uploadGenIdRef.current;
    setUploading(true);

    remoteUploadPromiseRef.current = (async () => {
      const url = api("/sticker/upload");
      const form = new FormData();

      form.append("file", original, original.name);
      form.append("variant", "preview");

      form.append("shape", String(shape));
      form.append("colorKey", String(colorKey || "white"));
      form.append("sizeKey", String(sizeKey || ""));

      form.append("widthCm", String(effWcm || 0));
      form.append("heightCm", String(effHcm || 0));

      form.append("bgMode", String(bgMode || "color"));
      form.append("bgColor", String(bgColorEff || ""));

      form.append("freeformBorderMm", String(freeformBorderMm || 0));

      const res = await fetch(url, { method: "POST", body: form });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(`Upload API error ${res.status}: ${t.slice(0, 200)}`);
      }
      const data = await res.json().catch(() => null);

      const remote = String(data?.url || data?.uploadedUrl || "");
      if (!remote) throw new Error("Upload OK, aber keine url im Response.");

      if (myGen !== uploadGenIdRef.current) return "";
      setUploadedUrl(remote);
      return remote;
    })().finally(() => {
      setUploading(false);
      remoteUploadPromiseRef.current = null;
    });

    const out = await remoteUploadPromiseRef.current;
    if (!out) throw new Error("Upload wurde abgebrochen/übersprungen (Bild wurde gewechselt).");
    return out;
  }

  function openFilePicker() {
    setAddedMsg("");
    try {
      fileInputRef.current?.click();
    } catch (_) {}
  }

  // ==============================
  // Export
  // ==============================
  function buildExportKeyForCart() {
    return [
      String(imageUrl || ""),
      String(shape || ""),
      String(colorKey || ""),
      String(sizeKey || ""),
      String(bgMode || ""),
      String(bgColorEff || ""),
      String(freeformBorderMm || ""),
      String(effWcm || ""),
      String(effHcm || ""),
      String(widthCm || ""),
      String(heightCm || ""),
    ].join("|");
  }

  // ✅ Cutline-Pfad für Export erzeugen (wird an Server geschickt)
  function buildCutlinePathDForExport({ shape, canvasW, canvasH, freeformMaster, img, imgAspect }) {
    const w = Math.max(1, Math.round(canvasW));
    const h = Math.max(1, Math.round(canvasH));

    // nur Weiß/Farbig (nicht transparent)
    const exportShouldCut = bgMode === "white" || bgMode === "color";
    if (!exportShouldCut) return "";

    if (shape === "round") {
      const r = Math.min(w, h) / 2;
      return `M ${r} 0 A ${r} ${r} 0 1 1 ${r} ${h} A ${r} ${r} 0 1 1 ${r} 0 Z`;
    }

    if (shape === "oval" || shape === "oval_portrait") {
      const rx = w / 2;
      const ry = h / 2;
      return `M ${rx} 0 A ${rx} ${ry} 0 1 1 ${rx} ${h} A ${rx} ${ry} 0 1 1 ${rx} 0 Z`;
    }

    if (shape === "square" || shape === "rect" || shape === "rect_landscape") {
      return `M 0 0 L ${w} 0 L ${w} ${h} L 0 ${h} Z`;
    }

    if (shape === "square_rounded" || shape === "rect_rounded" || shape === "rect_landscape_rounded") {
      const rr = Math.max(6, Math.round(Math.min(w, h) * 0.08));
      const r = Math.min(rr, Math.min(w, h) / 2);
      return (
        `M ${r} 0 L ${w - r} 0 ` +
        `A ${r} ${r} 0 0 1 ${w} ${r} ` +
        `L ${w} ${h - r} ` +
        `A ${r} ${r} 0 0 1 ${w - r} ${h} ` +
        `L ${r} ${h} ` +
        `A ${r} ${r} 0 0 1 0 ${h - r} ` +
        `L 0 ${r} ` +
        `A ${r} ${r} 0 0 1 ${r} 0 Z`
      );
    }

    if (shape === "freeform") {
      const borderPxOut = mmToPxAtDpi(freeformBorderMm, EXPORT_DPI);
      const master =
        freeformMaster ||
        buildFreeformMasterMask({
          imgEl: img,
          imgAspect: imgAspect || 1,
          getMasterRectFromAspect,
          maxMaskDim: 520,
          padPx: 120,
        });

      return buildFreeformCutlinePathFromMaster(master, w, h, borderPxOut);
    }

    return "";
  }

  async function ensureSvgExportForCart(remoteUrlForExport) {
    const exportKey = buildExportKeyForCart();
    if (lastExportKeyRef.current === exportKey && lastExportSvgUrlRef.current) {
      return lastExportSvgUrlRef.current;
    }

    const url = api("/sticker/export");

    const shared = imgElUrlRef.current === imageUrl ? imgElRef.current : null;
    const img = shared || (await loadImage(imageUrl));

    const effectiveDpi = calcEffectiveDpi({
      imgPxW: img.naturalWidth || img.width || 0,
      imgPxH: img.naturalHeight || img.height || 0,
      targetCmW: effWcm,
      targetCmH: effHcm,
    });

    if (effectiveDpi < MIN_DPI) {
      throw new Error(
        `Bildauflösung zu gering (${Math.round(effectiveDpi)} DPI). Minimum: ${MIN_DPI} DPI. ` +
          `Bitte ein größeres Bild hochladen oder Sticker kleiner wählen.`
      );
    }

    const baseWidthPx = cmToPxAtDpi(effWcm, EXPORT_DPI);
    const baseHeightPx = cmToPxAtDpi(effHcm, EXPORT_DPI);

    const isRound = shape === "round";
    const isOval = shape === "oval" || shape === "oval_portrait";
    const isSquare = shape === "square";
    const isSquareRounded = shape === "square_rounded";
    const isRectRounded = shape === "rect_rounded" || shape === "rect_landscape_rounded";
    const isRounded = isSquareRounded || isRectRounded;

    const pad = isRounded ? mmToPxAtDpi(ROUNDED_RADIUS_MM, EXPORT_DPI) : 0;
    const needsBgFill = (isRound || isOval || isSquare || isRounded) && hasBgFill;

    const exportSizePx = isRound ? Math.max(1, Math.round(diagonalFromRect(baseWidthPx, baseHeightPx))) : null;
    const exportOvalW = isOval ? Math.max(1, Math.round(baseWidthPx * SQRT2)) : null;
    const exportOvalH = isOval ? Math.max(1, Math.round(baseHeightPx * SQRT2)) : null;

    const canvas = document.createElement("canvas");
    canvas.width = isRound
      ? exportSizePx
      : isOval
      ? exportOvalW
      : isRounded
      ? Math.max(1, baseWidthPx + pad * 2)
      : baseWidthPx;

    canvas.height = isRound
      ? exportSizePx
      : isOval
      ? exportOvalH
      : isRounded
      ? Math.max(1, baseHeightPx + pad * 2)
      : baseHeightPx;

    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas Kontext nicht verfügbar.");

    const computeContainInRect = (rectX, rectY, rectW, rectH) => {
      const iw = img.naturalWidth || img.width || 1;
      const ih = img.naturalHeight || img.height || 1;
      const scale = Math.min(rectW / iw, rectH / ih);
      const dw = iw * scale;
      const dh = ih * scale;
      const dx = rectX + (rectW - dw) / 2;
      const dy = rectY + (rectH - dh) / 2;
      return { dx, dy, dw, dh };
    };

    const drawContainInRect = (targetCtx, rectX, rectY, rectW, rectH) => {
      const { dx, dy, dw, dh } = computeContainInRect(rectX, rectY, rectW, rectH);
      targetCtx.drawImage(img, dx, dy, dw, dh);
    };

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (needsBgFill) {
      ctx.fillStyle = bgColorEff || "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    if (isRound || isOval) {
      const rectX = (canvas.width - baseWidthPx) / 2;
      const rectY = (canvas.height - baseHeightPx) / 2;
      drawContainInRect(ctx, rectX, rectY, baseWidthPx, baseHeightPx);
    } else if (isRounded) {
      drawContainInRect(ctx, pad, pad, baseWidthPx, baseHeightPx);
    } else if (shape === "freeform") {
      const master =
        freeformMaster ||
        buildFreeformMasterMask({
          imgEl: img,
          imgAspect: imgAspect || 1,
          getMasterRectFromAspect,
          maxMaskDim: 520,
          padPx: 120,
        });

      const borderPx = mmToPxAtDpi(freeformBorderMm, EXPORT_DPI);

      const ffCanvas = renderFreeformFromMasterMask({
        master,
        outWpx: cmToPxAtDpi(widthCm, EXPORT_DPI),
        outHpx: cmToPxAtDpi(heightCm, EXPORT_DPI),
        bgColor: hasBgFill ? bgColorEff : "transparent",
        borderPx,
      });

      canvas.width = ffCanvas.width;
      canvas.height = ffCanvas.height;
      const ctxFF = canvas.getContext("2d");
      if (!ctxFF) throw new Error("Canvas Kontext nicht verfügbar.");
      ctxFF.clearRect(0, 0, canvas.width, canvas.height);
      ctxFF.drawImage(ffCanvas, 0, 0);
    } else {
      drawContainInRect(ctx, 0, 0, canvas.width, canvas.height);
    }

    const renderedDataUrl = canvas.toDataURL("image/png");

    // ✅ NEU: Cutline-Pfad für Server
    const exportCutlineEnabled = bgMode === "white" || bgMode === "color";
    const cutlinePathD = exportCutlineEnabled
      ? buildCutlinePathDForExport({
          shape,
          canvasW: canvas.width,
          canvasH: canvas.height,
          freeformMaster,
          img,
          imgAspect,
        })
      : "";

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        renderedDataUrl,
        imageUrl: remoteUrlForExport,
        shape,
        widthPx: canvas.width,
        heightPx: canvas.height,

        bgMode,
        bgColor: bgColorEff,

        rectWidthPx: baseWidthPx,
        rectHeightPx: baseHeightPx,
        dpi: EXPORT_DPI,
        effectiveDpi: Math.round(effectiveDpi),

        colorKey: String(colorKey || "white"),
        sizeKey: String(sizeKey || ""),
        widthCm: Number(effWcm) || 0,
        heightCm: Number(effHcm) || 0,

        // ✅ NEU: Cutline-Info für SVG-Builder am Server
        cutlineEnabled: !!exportCutlineEnabled,
        cutlinePathD: String(cutlinePathD || ""),
        cutlineStrokePx: EXPORT_CUTLINE_STROKE_PX,

        uploadSvgToShopify: true,
        uploadPngToShopify: false,
      }),
    });

    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`Export API error ${res.status}: ${t}`);
    }

    const data = await res.json().catch(() => null);
    if (!data?.svgUrl) throw new Error("Export OK, aber keine svgUrl im Response.");

    lastExportKeyRef.current = exportKey;
    lastExportSvgUrlRef.current = data.svgUrl;

    return data.svgUrl;
  }

  // ==============================
  // Stückzahl: Katalog bevorzugen
  // ==============================
  useEffect(() => {
    const fromCatalog = selectedSizeObj?.piecesPerSet;
    if (Number.isFinite(fromCatalog) && fromCatalog > 0) {
      setRealPieces((prev) => (prev === fromCatalog ? prev : fromCatalog));
      return;
    }
    const pieces = calcPiecesFixed(shape, effWcm, effHcm);
    setRealPieces((prev) => (prev === pieces ? prev : pieces));
  }, [selectedSizeObj, shape, effWcm, effHcm]);

  // ==============================
  // Cart
  // ==============================
  async function addToCart() {
    setErrorMsg("");
    setAddedMsg("");

    const trustCatalogVid = !!hasCatalogColors || String(colorKey || "white") === "white";
    const variantIdFromCatalog = trustCatalogVid ? Number(selectedSizeObj?.variantId) || 0 : 0;
    const variantIdFallback = Number(selectedVariantId) || Number(productId) || 0;
    const variantId = variantIdFromCatalog || variantIdFallback;

    if (!variantId) {
      setErrorMsg("Variant-ID fehlt. Prüfe im Katalog: shape + colorKey + sizeKey müssen eine variantId liefern.");
      return;
    }

    if (!imageUrl) {
      setErrorMsg("Bitte zuerst ein Bild hochladen.");
      return;
    }

    let remoteUrl = "";
    try {
      remoteUrl = await ensureRemoteUpload();
    } catch (e) {
      setErrorMsg(e?.message || String(e));
      return;
    }

    let svgUrl = "";
    try {
      svgUrl = await ensureSvgExportForCart(remoteUrl);
    } catch (e) {
      setErrorMsg(e?.message || String(e));
      return;
    }

    const pieces = Math.max(1, Number(realPieces) || calcPiecesFixed(shape, effWcm, effHcm));
    if (pieces > 9999) {
      setErrorMsg("Stückzahl zu groß für den Warenkorb (Limit 9999).");
      return;
    }

    const wNorm = Math.min(Number(effWcm) || 1, Number(effHcm) || 1);
    const hNorm = Math.max(Number(effWcm) || 1, Number(effHcm) || 1);
    const major = getMajorForPieces(shape, wNorm, hNorm);

    const v =
      Array.isArray(productVariants) && productVariants.length
        ? productVariants.find((x) => Number(x?.id) === Number(variantId))
        : null;

    const variantTitle = String(v?.title || selectedVariantTitle || "");
    const variantPriceEur =
      typeof v?.price !== "undefined" ? toEuroFromCents(v.price) : Number(selectedVariantPrice) || 0;

    const items = [
      {
        id: variantId,
        quantity: 1,
        properties: {
          _sc_line_id: String(Date.now()),
          _sc_shape: String(shape),

          _sc_major_cm: fmtCm(major),
          _sc_print_length_cm: String(PRINT_LENGTH_CM),

          _sc_pieces_per_pack: String(pieces),
          _sc_total_pieces_hint: String(pieces),

          _sc_design_w_cm: shape === "freeform" ? fmtCm(widthCm) : "",
          _sc_design_h_cm: shape === "freeform" ? fmtCm(heightCm) : "",

          _sc_bg_mode: String(bgMode || "color"),
          _sc_bg: String(bgColorEff || ""),
          _sc_border_mm: String(freeformBorderMm),

          _sc_image: remoteUrl,
          _sc_svg: svgUrl,

          _sc_variant_id: String(variantId),
          _sc_variant_title: variantTitle,
          _sc_variant_price_eur: String(variantPriceEur.toFixed(2)),
        },
      },
    ];

    try {
      const res = await fetch("/cart/add.js", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      });

      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(`Warenkorb Fehler ${res.status}: ${t}`);
      }

      if (goToCartAfterAdd) {
        window.location.href = "/cart";
      } else {
        setAddedMsg("Zum Warenkorb hinzugefügt. Du kannst jetzt Form/Farbe/Größe ändern und erneut hinzufügen.");
      }
    } catch (e) {
      setErrorMsg(e?.message || String(e));
    }
  }

  // ==============================
  // ✅ Preview-Dims: an Right Panel koppeln
  // ==============================
  const previewDims = useMemo(() => {
    const pad = isMobile ? 14 : 24;

    const maxW = Math.max(240, (rightBox.w || vp.w) - pad * 2);
    const maxH = Math.max(240, (rightBox.h || vp.h) - pad * 2);

    const clampAr = (ar) => {
      const a = Number(ar);
      if (!Number.isFinite(a) || a <= 0) return 1;
      return Math.min(6, Math.max(1 / 6, a));
    };

    const arBase = (() => {
      if (shape === "round") return 1;

      if (shape === "oval" || shape === "oval_portrait") {
        const w = Math.max(1e-9, Number(widthCm) || 1);
        const h = Math.max(1e-9, Number(heightCm) || 1);
        return clampAr(w / h);
      }

      if (shape === "freeform") {
        const bw = Math.max(1e-9, Number(effWcm) || 1);
        const bh = Math.max(1e-9, Number(effHcm) || 1);
        return clampAr(bw / bh);
      }

      const w = Math.max(1e-9, Number(widthCm) || 1);
      const h = Math.max(1e-9, Number(heightCm) || 1);
      return clampAr(w / h);
    })();

    if (shape === "round") {
      const s = Math.round(Math.min(maxW, maxH));
      return { w: s, h: s, ar: 1 };
    }

    const ar = arBase;

    let wPx, hPx;
    if (ar >= 1) {
      wPx = Math.min(maxW, maxH * ar);
      hPx = wPx / ar;
    } else {
      hPx = Math.min(maxH, maxW / ar);
      wPx = hPx * ar;
    }

    return { w: Math.round(wPx), h: Math.round(hPx), ar };
  }, [rightBox.w, rightBox.h, vp.w, vp.h, isMobile, shape, widthCm, heightCm, effWcm, effHcm]);

  const fixedSurfaceDims = useMemo(() => {
    const s = 0.88;
    return {
      w: Math.max(1, Math.round(previewDims.w * s)),
      h: Math.max(1, Math.round(previewDims.h * s)),
    };
  }, [previewDims.w, previewDims.h]);

  const roundImgBoxStyleVars = useMemo(() => {
    const w = Math.max(1e-9, Number(widthCm) || 1);
    const h = Math.max(1e-9, Number(heightCm) || 1);
    const diag = Math.max(1e-9, diagonalFromRect(w, h));
    const wp = (w / diag) * 100;
    const hp = (h / diag) * 100;
    return { "--scRoundW": `${wp}%`, "--scRoundH": `${hp}%` };
  }, [widthCm, heightCm]);

  // ✅ Transparenz-Checker (wird aktuell nicht genutzt, da Transparent auskommentiert)
  const showTransparentMark = useMemo(() => bgMode === "transparent", [bgMode]);

  // ✅ Freiform Mask-Overlay braucht dynamische URL
  const freeformMaskStyle = useMemo(() => {
    if (!showTransparentMark) return null;
    if (shape !== "freeform") return null;
    if (!displaySrc) return null;

    return {
      WebkitMaskImage: `url(${displaySrc})`,
      WebkitMaskRepeat: "no-repeat",
      WebkitMaskPosition: "center",
      WebkitMaskSize: "contain",
      maskImage: `url(${displaySrc})`,
      maskRepeat: "no-repeat",
      maskPosition: "center",
      maskSize: "contain",
    };
  }, [showTransparentMark, shape, displaySrc]);

  // ==============================
  // Render Helpers
  // ==============================
  // ── Shape-Kacheln (StickerApp.de visuelles Grid) ──────────────
  const SHAPE_TILES_UI = [
    { key: "square",                 label: "Quadrat",     w: 20, h: 20, r: 0      },
    { key: "square_rounded",         label: "Abgerundet",  w: 20, h: 20, r: 6      },
    { key: "rect",                   label: "Rechteck",    w: 28, h: 18, r: 0      },
    { key: "rect_rounded",           label: "Rect. abg.",  w: 28, h: 18, r: 5      },
    { key: "rect_landscape",         label: "Quer",        w: 28, h: 14, r: 0      },
    { key: "rect_landscape_rounded", label: "Quer abg.",   w: 28, h: 14, r: 4      },
    { key: "round",                  label: "Rund",        w: 20, h: 20, r: "50%"  },
    { key: "oval",                   label: "Oval",        w: 26, h: 18, r: "50%"  },
    { key: "oval_portrait",          label: "Oval hoch",   w: 16, h: 24, r: "50%"  },
    { key: "freeform",               label: "Freiform",    w: null, h: null, r: null },
  ];

  function renderConfigurator() {
    return (
      <>
        {/* ── Panel-Titel ──────────────────────────────────────────── */}
        <div className="scPanelTitle">Sticker konfigurieren</div>

        {/* ── Schritt 1: Form ──────────────────────────────────────── */}
        <div className="scStepHeader">
          <span className="scStepNum">1</span>
          Form wählen
        </div>
        <div className="scShapeGrid">
          {SHAPE_TILES_UI.map(({ key, label, w, h, r }) => {
            const active = shape === key;
            return (
              <button
                key={key}
                type="button"
                className={`scShapeTile${active ? " scShapeTile--active" : ""}`}
                onClick={() => { setAddedMsg(""); setShape(key); }}
              >
                {w !== null ? (
                  <div
                    className="scShapeTileIcon"
                    style={{ width: w, height: h, borderRadius: r }}
                  />
                ) : (
                  <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                    <path
                      d="M10 2 L14 7 L19 8 L15 13 L16 18 L10 15 L4 18 L5 13 L1 8 L6 7 Z"
                      fill={active ? "#e10600" : "rgba(255,255,255,0.25)"}
                    />
                  </svg>
                )}
                <span className="scShapeTileLabel">{label}</span>
              </button>
            );
          })}
        </div>

        {/* ── Schritt 2: Größe ─────────────────────────────────────── */}
        <div className="scStepHeader">
          <span className="scStepNum">2</span>
          Größe wählen
        </div>

        {shape === "freeform" ? (
          <select
            className="scSelect"
            value={String(freeformLongSideCm)}
            onChange={(e) => {
              setAddedMsg("");
              const v = parseNumberDE(e.target.value);
              if (!Number.isFinite(v)) return;
              setFreeformLongSideCm(v);
            }}
          >
            {FREEFORM_LONGSIDE_PRESETS_CM.map((cm) => {
              const ar = freeformCutAspect || imgAspect || 1;
              const dims = freeformDimsFromLongSide(cm, ar);
              const label = `${fmtCm(cm)} cm (≈ ${dims.wCm.toFixed(2)} × ${dims.hCm.toFixed(2)} cm)`;
              return (
                <option key={`ff-${cm}`} value={String(cm)}>{label}</option>
              );
            })}
          </select>
        ) : (
          <select
            className="scSelect"
            value={sizeKey}
            onChange={(e) => setSizeKey(e.target.value)}
            disabled={!availableSizes.length}
          >
            {!availableSizes.length ? (
              <option value="">{catalog ? "Keine Größen verfügbar" : "Lade Größen…"}</option>
            ) : (
              availableSizes.map((v) => (
                <option key={`${String(shape)}-${String(colorKey)}-${v.sizeKey}`} value={v.sizeKey}>
                  {v.label}
                </option>
              ))
            )}
          </select>
        )}

        {/* ── Schritt 3: Material ──────────────────────────────────── */}
        <div className="scStepHeader">
          <span className="scStepNum">3</span>
          Material
        </div>
        <div className="scMaterialGrid">
          {[
            {
              key: "white", label: "Weiß",
              icon: <div style={{ width: 22, height: 22, borderRadius: 4, background: "#fff", border: "1px solid rgba(0,0,0,0.15)" }} />,
            },
            {
              key: "color", label: "Farbig",
              icon: <div style={{ width: 22, height: 22, borderRadius: 4, background: "linear-gradient(135deg,#ff4d4d,#ffb800,#00c8ff)" }} />,
            },
          ].map(({ key, label, icon }) => (
            <button
              key={key}
              type="button"
              className={`scMaterialBtn${bgMode === key ? " scMaterialBtn--active" : ""}`}
              onClick={() => setBgMode(key)}
            >
              {icon}
              {label}
            </button>
          ))}
        </div>

        {bgMode === "color" ? (
          <div className="scFieldRow" style={{ marginTop: 8 }}>
            <span style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font)" }}>Hintergrundfarbe</span>
            <input className="scColor" type="color" value={bgColor} onChange={(e) => setBgColor(e.target.value)} />
          </div>
        ) : null}

        {shape === "freeform" ? (
          <>
            <div className="scStepHeader">
              <span className="scStepNum" style={{ fontSize: 8 }}>↳</span>
              Freiform-Rand
            </div>
            <select
              className="scSelect"
              value={String(freeformBorderMm)}
              onChange={(e) => {
                const v = Number(String(e.target.value).replace(",", "."));
                setFreeformBorderMm(Number.isFinite(v) ? v : 3);
              }}
            >
              {[1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5].map((mm) => (
                <option key={`ffb-${mm}`} value={String(mm)}>{mm.toFixed(1)} mm</option>
              ))}
            </select>
          </>
        ) : null}

        {/* ── Schritt 4: Motiv ─────────────────────────────────────── */}
        <div className="scStepHeader">
          <span className="scStepNum">4</span>
          Motiv hochladen
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="scHiddenFile"
          onChange={(e) => uploadFile(e.target.files?.[0])}
        />

        <button
          type="button"
          className={`scBtn ${imageUrl ? "scBtnSecondary" : "scBtnUpload"}`}
          style={{ marginTop: 0 }}
          onClick={openFilePicker}
        >
          {uploading ? "Wird hochgeladen…" : imageUrl ? "Bild ändern" : "Bild auswählen"}
        </button>

        {/* ── Preis & CTA ──────────────────────────────────────────── */}
        <div className="scDivider" />

        <div className="scPriceCard">
          <div className="scPriceLine">
            <span className="scPriceLabel">Sticker pro Set</span>
            <span className="scPriceValue">{realPieces}</span>
          </div>
          <div className="scPriceLine" style={{ marginBottom: 0 }}>
            <span className="scPriceLabel">Gesamtpreis</span>
            <span className="scPriceBig">{priceTotal.toFixed(2)} €</span>
          </div>
          {selectedVariantTitle ? (
            <div className="scVariantHint">{selectedVariantTitle}</div>
          ) : null}
        </div>

        <button type="button" className="scBtn scBtnPrimary" onClick={addToCart} disabled={!imageUrl}>
          In den Warenkorb
        </button>

        {addedMsg ? (
          <div style={{
            marginTop: 8, padding: "8px 12px", borderRadius: 8,
            background: "rgba(34,197,94,0.10)", border: "1px solid rgba(34,197,94,0.25)",
            color: "#86efac", fontSize: 11, fontFamily: "var(--font)", lineHeight: 1.4,
          }}>
            ✓ {addedMsg}
          </div>
        ) : null}

        <label className="scCheck">
          <input
            type="checkbox"
            checked={goToCartAfterAdd}
            onChange={(e) => setGoToCartAfterAdd(!!e.target.checked)}
          />
          <span>Nach dem Hinzufügen zum Warenkorb wechseln</span>
        </label>

        {errorMsg ? <div className="scError">{errorMsg}</div> : null}
      </>
    );
  }

  function renderPreview() {
    if (!imageUrl) {
      return (
        <div className="scEmpty">
          <div className="scEmptyHint">Bitte links ein Bild hochladen.</div>

          <button type="button" className="scBtn scBtnHero" onClick={openFilePicker} disabled={uploading}>
            {uploading ? "Upload…" : "Bild hochladen"}
          </button>

          <div className="scEmptySub">Tipp: PNG mit transparentem Hintergrund funktioniert am besten.</div>
        </div>
      );
    }

    const fixedSurfaceClass = (() => {
      if (shape === "round") return "scSurface scSurface--round";
      if (shape === "oval" || shape === "oval_portrait") return "scSurface scSurface--oval";
      if (shape === "square_rounded" || shape === "rect_rounded" || shape === "rect_landscape_rounded")
        return "scSurface scSurface--rounded";
      return "scSurface";
    })();

    const surfaceStyleVars =
      shape === "freeform"
        ? {}
        : {
            "--scSurfW": `${fixedSurfaceDims.w}px`,
            "--scSurfH": `${fixedSurfaceDims.h}px`,
            "--scSurfBg": hasBgFill ? bgColorEff : showTransparentMark ? "rgba(255,255,255,0.06)" : "transparent",
          };

    const frameVars = {
      "--scFrameW": `${previewDims.w}px`,
      "--scFrameH": `${previewDims.h}px`,
    };

    return (
      <div className="scPreviewFrame" style={frameVars}>
        {shape === "freeform" ? (
          <div className="scFreeformBox">
            {freeformReady && showTransparentMark ? (
              <div className="scTransparentMask" style={freeformMaskStyle || undefined} />
            ) : null}

            <img
              src={displaySrc}
              alt="Sticker"
              className={`scImg scImgContain ${shouldShowCutline ? "scCutline" : ""}`}
              crossOrigin="anonymous"
            />
          </div>
        ) : (
          <div className={fixedSurfaceClass} style={surfaceStyleVars}>
            {shouldShowCutline ? <div className="scCutlineOverlay" /> : null}

            <div className={`scSurfaceOutline ${showTransparentMark ? "scSurfaceOutline--strong" : ""}`} />

            {shape === "round" ? (
              <img
                src={imageUrl}
                alt="Sticker"
                className="scImg scImgContain scImgRoundBox"
                style={roundImgBoxStyleVars}
                crossOrigin="anonymous"
              />
            ) : shape === "oval" || shape === "oval_portrait" ? (
              <img src={imageUrl} alt="Sticker" className="scImg scImgContain scImgOvalBox" crossOrigin="anonymous" />
            ) : (
              <img src={imageUrl} alt="Sticker" className="scImg scImgContain" crossOrigin="anonymous" />
            )}
          </div>
        )}
      </div>
    );
  }

  // ==============================
  // ✅ CSS vars + Layout
  // ==============================
  return (
    <div className={`scWrap ${isMobile ? "is-mobile" : "is-desktop"}`}>
      <style dangerouslySetInnerHTML={{ __html: SC_CSS }} />

      <div className="scLeft">{renderConfigurator()}</div>

      <div ref={rightPanelRef} className="scRight">
        {renderPreview()}
      </div>
    </div>
  );
}

// ==============================
// CSS (self-contained)
// ==============================
const SC_CSS = `
/* Root */
.scWrap{
  /* ── StickerApp.de Design Tokens ─────────────────────────────── */
  --bg:      #040404;
  --panel:   #0f0f13;
  --card:    rgba(255,255,255,0.04);
  --border:  rgba(255,255,255,0.09);
  --border2: rgba(255,255,255,0.14);
  --text:    rgba(255,255,255,0.92);
  --muted:   rgba(255,255,255,0.55);
  --muted2:  rgba(255,255,255,0.38);
  --accent:  #e10600;
  --input-bg:#1a1a22;
  --shadow:  0 24px 80px rgba(0,0,0,0.65);
  --font:    'Noto Sans','Inter',system-ui,sans-serif;
  /* ─────────────────────────────────────────────────────────────── */

  width: 100%;
  max-width: 1200px;
  margin: 0 auto;
  border-radius: 16px;
  overflow: hidden;
  background: var(--bg);
  box-shadow: var(--shadow);
  font-family: var(--font);

  display: grid;
  grid-template-columns: 300px 1fr;
  min-height: 560px;
}

/* Desktop */
.scWrap.is-desktop .scLeft{
  border-right: 1px solid rgba(255,255,255,0.08);
}

/* Mobile */
@media (max-width: 900px){
  .scWrap{
    grid-template-columns: 1fr;
  }
  .scRight{
    order: -1; /* Preview oben */
    min-height: clamp(260px, 42vh, 520px);
  }
  .scLeft{
    border-top: 1px solid rgba(255,255,255,0.08);
    border-right: none !important;
  }
}

/* Panels */
.scLeft{
  padding: 18px 16px;
  background: var(--panel);
  color: #fff;
  display: grid;
  gap: 0;
  align-content: start;
  overflow-y: auto;
  font-family: var(--font);
}

@media (max-width: 900px){
  .scLeft{
    padding: 14px;
    gap: 0;
  }
}

.scRight{
  background: var(--bg);
  padding: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 560px;
}

@media (max-width: 900px){
  .scRight{
    padding: 14px;
    min-height: 300px;
  }
}

/* ── Panel Titel ─────────────────────────────────────────────── */
.scPanelTitle{
  font-size: 15px;
  font-weight: 900;
  color: #fff;
  letter-spacing: -0.01em;
  margin-bottom: 16px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--border);
  font-family: var(--font);
}

/* ── Step Header (nummerierte Abschnitte) ────────────────────── */
.scStepHeader{
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 16px;
  margin-bottom: 8px;
  font-size: 11px;
  font-weight: 700;
  color: var(--muted);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  font-family: var(--font);
}
.scStepNum{
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--accent);
  color: #fff;
  font-size: 10px;
  font-weight: 900;
  flex-shrink: 0;
}

/* ── Shape Tile Grid ─────────────────────────────────────────── */
.scShapeGrid{
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 5px;
}
.scShapeTile{
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 8px 4px;
  border-radius: 8px;
  border: 1.5px solid rgba(255,255,255,0.08);
  background: rgba(255,255,255,0.03);
  cursor: pointer;
  min-height: 58px;
  transition: border-color 0.12s, background 0.12s;
  font-family: var(--font);
  color: rgba(255,255,255,0.45);
}
.scShapeTile:hover{
  border-color: rgba(255,255,255,0.18);
  background: rgba(255,255,255,0.05);
}
.scShapeTile--active{
  border-color: var(--accent);
  background: rgba(225,6,0,0.10);
  color: var(--accent);
}
.scShapeTileIcon{
  background: rgba(255,255,255,0.25);
  flex-shrink: 0;
  transition: background 0.12s;
}
.scShapeTile--active .scShapeTileIcon{
  background: var(--accent);
}
.scShapeTileLabel{
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.02em;
  line-height: 1.2;
  text-align: center;
}

/* ── Material Swatches ───────────────────────────────────────── */
.scMaterialGrid{
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 5px;
}
.scMaterialBtn{
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  padding: 8px 4px;
  border-radius: 8px;
  border: 1.5px solid rgba(255,255,255,0.08);
  background: rgba(255,255,255,0.03);
  cursor: pointer;
  font-size: 10px;
  font-weight: 500;
  color: rgba(255,255,255,0.55);
  font-family: var(--font);
  transition: border-color 0.12s, background 0.12s;
  line-height: 1.2;
}
.scMaterialBtn--active{
  border-color: var(--accent);
  background: rgba(225,6,0,0.10);
  color: var(--accent);
  font-weight: 700;
}

/* ── Preis-Card ──────────────────────────────────────────────── */
.scPriceCard{
  background: rgba(255,255,255,0.04);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px 14px;
  margin-top: 14px;
}
.scPriceLine{
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 4px;
}
.scPriceLabel{ font-size: 11px; color: var(--muted); font-family: var(--font); }
.scPriceValue{ font-size: 14px; font-weight: 700; color: #fff; font-family: var(--font); }
.scPriceBig{
  font-size: 22px;
  font-weight: 900;
  color: var(--accent);
  font-family: var(--font);
  letter-spacing: -0.02em;
}
.scVariantHint{
  font-size: 10px;
  color: var(--muted2);
  margin-top: 4px;
  font-family: var(--font);
}

/* Fields */
.scBlock{ display:grid; gap: 10px; }
.scField{ display:grid; gap: 6px; }
.scLabel{ font-size: 13px; color: var(--muted); }

@media (max-width: 900px){
  .scLabel{ font-size: 14px; }
}

.scSelect{
  width: 100%;
  padding: 9px 28px 9px 10px;
  border-radius: 8px;
  border: 1.5px solid var(--border);
  background: var(--input-bg);
  color: #fff;
  outline: none;
  font-size: 13px;
  font-family: var(--font);
  appearance: none;
  -webkit-appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='rgba(255,255,255,0.4)' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 10px center;
  cursor: pointer;
}

@media (max-width: 900px){
  .scSelect{
    padding: 12px 28px 12px 10px;
    font-size: 16px; /* iOS zoom fix */
  }
}

.scFieldRow{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap: 12px;
}

.scColor{
  width: 96px;
  height: 40px;
  border-radius: 12px;
  border: 1px solid rgba(255,255,255,0.14);
  background: transparent;
  padding: 0;
}

/* Divider */
.scDivider{
  height: 1px;
  background: var(--border);
  margin: 14px 0;
}

/* Stats (legacy – weiterhin genutzt als Fallback) */
.scStats{ display:grid; gap: 4px; }
.scStatLine{
  display:flex;
  align-items:baseline;
  justify-content:space-between;
  gap: 10px;
  padding: 3px 0;
}
.scStatLabel{ font-size: 11px; color: var(--muted); font-family: var(--font); }
.scStatValue{ font-size: 15px; font-weight: 800; color: #fff; font-family: var(--font); }

/* Buttons */
.scBtn{
  width: 100%;
  border-radius: 10px;
  border: none;
  cursor: pointer;
  font-weight: 700;
  padding: 12px 14px;
  font-size: 13px;
  font-family: var(--font);
  margin-top: 8px;
}

@media (max-width: 900px){
  .scBtn{
    padding: 14px 14px;
    font-size: 16px;
    border-radius: 10px;
  }
}

.scBtnPrimary{
  background: var(--accent);
  color: #fff;
  font-weight: 800;
  box-shadow: 0 4px 18px rgba(225,6,0,0.30);
  letter-spacing: 0.02em;
}
.scBtnPrimary:disabled{
  opacity: .45;
  cursor: not-allowed;
  box-shadow: none;
}

.scBtnSecondary{
  background: rgba(255,255,255,0.05);
  border: 1.5px solid rgba(255,255,255,0.12);
  color: rgba(255,255,255,0.8);
}

.scBtnUpload{
  background: rgba(255,255,255,0.03);
  border: 1.5px dashed rgba(225,6,0,0.45);
  color: var(--accent);
  font-weight: 600;
}

.scBtnHero{
  background: var(--accent);
  color: #fff;
  max-width: 520px;
  box-shadow: 0 4px 20px rgba(225,6,0,0.30);
}

.scCheck{
  display:flex;
  gap: 10px;
  align-items:center;
  font-size: 13px;
  color: var(--muted);
  margin-top: 2px;
}
.scCheck input{ transform: scale(1.05); }

@media (max-width: 900px){
  .scCheck{ font-size: 14px; }
}

/* Messages */
.scInfo{
  margin-top: 6px;
  font-size: 12px;
  color: rgba(255,255,255,0.85);
}

.scError{
  margin-top: 8px;
  padding: 10px;
  border-radius: 14px;
  background: rgba(239, 68, 68, 0.12);
  border: 1px solid rgba(239, 68, 68, 0.35);
  color: #fecaca;
  font-size: 12px;
  white-space: pre-wrap;
}

/* Hidden file */
.scHiddenFile{ display:none; }

/* Empty state */
.scEmpty{
  width: 100%;
  max-width: 520px;
  display: grid;
  gap: 12px;
  justify-items: center;
  align-content: center;
  text-align: center;
  padding: 14px;
}
.scEmptyHint{
  color: rgba(255,255,255,0.78);
  font-size: 14px;
  line-height: 1.4;
}
.scEmptySub{
  color: rgba(255,255,255,0.56);
  font-size: 12px;
  line-height: 1.35;
}

/* Preview Frame (dynamic via CSS vars) */
.scPreviewFrame{
  width: var(--scFrameW, 520px);
  height: var(--scFrameH, 520px);
  display:flex;
  align-items:center;
  justify-content:center;
  position: relative;
}

/* Fixed shapes surface */
.scSurface{
  width: var(--scSurfW, 460px);
  height: var(--scSurfH, 460px);
  display:inline-flex;
  align-items:center;
  justify-content:center;
  overflow:hidden;
  background: var(--scSurfBg, transparent);
  filter: drop-shadow(0 10px 28px rgba(0,0,0,0.45));
  position: relative;
}
.scSurface--round{ border-radius: 50%; }
.scSurface--oval{ border-radius: 50%; clip-path: ellipse(50% 50% at 50% 50%); }
.scSurface--rounded{ border-radius: 28px; }

.scSurfaceOutline{
  position:absolute;
  inset:0;
  pointer-events:none;
  border: 1px solid rgba(255,255,255,0.14);
  border-radius: inherit;
  box-shadow: inset 0 0 0 1px rgba(0,0,0,0.18);
}
.scSurfaceOutline--strong{
  border: 1px solid rgba(255,255,255,0.28);
  box-shadow: inset 0 0 0 1px rgba(0,0,0,0.28);
}

/* Images */
.scImg{ display:block; width:100%; height:100%; background: transparent; }
.scImgContain{ object-fit: contain; }

.scImgRoundBox{
  width: var(--scRoundW, 100%);
  height: var(--scRoundH, 100%);
  max-width: 100%;
  max-height: 100%;
}
.scImgOvalBox{
  width: 70.71%;
  height: 70.71%;
  max-width: 100%;
  max-height: 100%;
}

/* Freeform box */
.scFreeformBox{
  width: var(--scFrameW, 520px);
  height: var(--scFrameH, 520px);
  display:inline-flex;
  align-items:center;
  justify-content:center;
  overflow:hidden;
  position: relative;
  background: transparent;
}

/* Checkerboard pattern (nur relevant, wenn Transparent aktiviert wird) */
.scTransparentMask{
  position:absolute;
  inset:0;
  pointer-events:none;
  background-color: rgba(255,255,255,0.09);
  background-image:
    linear-gradient(45deg, rgba(0,0,0,0.14) 25%, transparent 25%, transparent 75%, rgba(0,0,0,0.14) 75%, rgba(0,0,0,0.14)),
    linear-gradient(45deg, rgba(0,0,0,0.14) 25%, transparent 25%, transparent 75%, rgba(0,0,0,0.14) 75%, rgba(0,0,0,0.14));
  background-size: 18px 18px;
  background-position: 0 0, 9px 9px;
  opacity: 1;
}

/* =========================================================
   ✅ Cutline (UI-only)
   ========================================================= */

.scCutline{
  filter:
    drop-shadow( 1px  0px 0 rgba(0,0,0,0.72))
    drop-shadow(-1px  0px 0 rgba(0,0,0,0.72))
    drop-shadow( 0px  1px 0 rgba(0,0,0,0.72))
    drop-shadow( 0px -1px 0 rgba(0,0,0,0.72))
    drop-shadow( 0px  0px 1px rgba(255,255,255,0.30))
    drop-shadow( 0px 10px 22px rgba(0,0,0,0.38));
}

.scCutlineOverlay{
  position:absolute;
  inset:0;
  pointer-events:none;
  border-radius: inherit;
  box-shadow:
    0 0 0 1px rgba(0,0,0,0.70),
    0 0 0 2px rgba(255,255,255,0.20);
}
`;