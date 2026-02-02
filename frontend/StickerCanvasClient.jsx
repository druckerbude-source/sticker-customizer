import React, { useEffect, useMemo, useRef, useState } from "react";

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

// ✅ Freiform Größen-Presets (lange Kante in cm) – iOS-sicher via Dropdown
const FREEFORM_LONGSIDE_PRESETS_CM = [4, 5, 6, 7, 8, 9, 10, 12, 15, 20];

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

  const opts = [v?.option1, v?.option2, v?.option3, ...(Array.isArray(v?.options) ? v.options : [])]
    .map(normText)
    .filter(Boolean);

  // ✅ "color/colour" nur als exakter Optionswert akzeptieren (nicht als substring im Titel)
  if (key === "colored" && opts.some((o) => o === "color" || o === "colour")) return true;

  const words = COLOR_SYNONYMS[key] || [key];

  // Für die restlichen Wörter: Optionen + Titel zusammen als Suchraum
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

  // 2) server-injected (root element) – unterstützt sowohl Admin-root als auch Theme App Block root
  if (typeof document !== "undefined") {
    const el =
      document.getElementById("sticker-configurator-root") ||
      document.querySelector(".sticker-embed-root") ||
      document.querySelector("[data-api-base]") ||
      null;

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

function normalizeUrl(u) {
  const s = String(u || "").trim();
  if (!s) return "";
  // Shopify Storefront liefert oft protocol-relative URLs wie //cdn.shopify.com/...
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

// ==============================
// ✅ Catalog Normalizer
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

// ✅ Morphology helpers
function invertMask(mask) {
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = mask[i] ? 0 : 1;
  return out;
}

// Erosion über invert(dilate(invert(mask)))
function erodeMaskExact(mask, w, h, radiusPx) {
  const inv = invertMask(mask);
  const dil = dilateMaskExact(inv, w, h, radiusPx);
  return invertMask(dil);
}

// Closing = Dilate dann Erode (schließt schmale Lücken/Schlitze)
function closeMaskExact(mask, w, h, radiusPx) {
  const r = Math.max(0, Math.round(radiusPx || 0));
  if (r <= 0) return mask;
  const dil = dilateMaskExact(mask, w, h, r);
  const ero = erodeMaskExact(dil, w, h, r);
  return ero;
}

// ✅ inside mask (mit optionalem Gaps-Sealing)
function buildInsideMaskFromAlpha(imgData, w, h, alphaThreshold = 8, sealGapsPx = 0) {
  const a = imgData.data;

  // 1) Opaque-Maske aus Alpha
  let opaque = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const alpha = a[i * 4 + 3];
    opaque[i] = alpha > alphaThreshold ? 1 : 0;
  }

  // 2) ✅ kleine Lücken/Schlitze schließen (Mask-Closing)
  const r = Math.max(0, Math.round(sealGapsPx || 0));
  if (r > 0) {
    opaque = closeMaskExact(opaque, w, h, r);
  }

  // 3) Floodfill auf "transparent" (also !opaque) von außen
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

  // 4) inside = alles, was NICHT außen ist
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

  // ✅ hier: Freiräume schließen (Mask-Closing) bevor inside/outside berechnet wird
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

// ✅ Freiform: Original-Proportion aus Mask-BBox ableiten (kein Verzerren)
function maskAspectFromBBox(mask, w, h) {
  const bb = maskBBox(mask, w, h);
  const bw = Math.max(1, bb.maxX - bb.minX + 1);
  const bh = Math.max(1, bb.maxY - bb.minY + 1);
  const ar = bw / bh;
  if (!Number.isFinite(ar) || ar <= 1e-6) return 1;
  // limit extremes (nur Sicherheitsnetz)
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
  // --- Variant Catalog (from loader) ---
  const [catalog, setCatalog] = useState(null);

// Storefront-Bridge: Werte aus dem Embed an globale Resolver durchreichen (ohne UI-Änderung)
useEffect(() => {
  if (typeof window === "undefined") return;

  // apiBase (App-Proxy Basis)
  const b = String(apiBase || "").trim();
  if (b) window.__STICKER_API_BASE__ = b.replace(/\/$/, "");

  // Shape->Handle Map
  if (shapeHandles && typeof shapeHandles === "object") {
    window.__SC_SHAPE_HANDLES__ = shapeHandles;
  }
}, [apiBase, shapeHandles]);


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

  // ✅ Freiform: Größenwahl über Dropdown (lange Kante), Proportion bleibt erhalten
  const [freeformLongSideCm, setFreeformLongSideCm] = useState(4);

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


// ✅ Cache: verhindert doppelten Export bei gleicher Konfiguration (für Add-to-Cart)
const lastExportKeyRef = useRef("");
const lastExportSvgUrlRef = useRef("");

function buildExportKeyForCart() {
  // Key muss alle Parameter enthalten, die das Ergebnis beeinflussen
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

async function ensureSvgExportForCart(remoteUrlForExport) {
  const exportKey = buildExportKeyForCart();

  // ✅ Wenn unverändert, cached URL verwenden
  if (lastExportKeyRef.current === exportKey && lastExportSvgUrlRef.current) {
    return lastExportSvgUrlRef.current;
  }

  const url = api("/sticker/export");

  // Bild laden (wie in deiner exportSvg())
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

  // ✅ Export API call (SVG wird serverseitig gebaut + zu Shopify Files hochgeladen)
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      renderedDataUrl,
      imageUrl: remoteUrlForExport, // wichtig: remote (Shopify erreichbarer) Pfad
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

      // ✅ wichtig: wir wollen in Prod SVG zu Shopify hochladen
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

  // ✅ Cache setzen
  lastExportKeyRef.current = exportKey;
  lastExportSvgUrlRef.current = data.svgUrl;

  return data.svgUrl;
}

  // ✅ Viewport (für stabile Preview-Box in px)
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

  // ✅ helper: "aktive" Maße für Berechnung/Matching/Export/Cart
  // Freiform: Mindestkante (40mm) erzwingen
  const effDims = useMemo(() => {
    if (shape !== "freeform") return { wCm: widthCm, hCm: heightCm, scaled: false, k: 1 };
    return enforceMinEdgeCm(billingWidthCm, billingHeightCm, MIN_EDGE_CM);
  }, [shape, widthCm, heightCm, billingWidthCm, billingHeightCm]);

  const effWcm = effDims.wCm;
  const effHcm = effDims.hCm;


  // ✅ Freiform: aus langer Kante + Aspect (W/H) -> Billing-Dims (cm)
  function freeformDimsFromLongSide(longSideCm, aspectWdivH) {
    const long = clampNum(longSideCm, MIN_EDGE_CM, 20);
    const ar = Number(aspectWdivH);
    const safeAr = Number.isFinite(ar) && ar > 1e-6 ? ar : 1;

    let w = long;
    let h = long;

    if (safeAr >= 1) {
      // breit -> Breite ist die lange Kante
      w = long;
      h = long / safeAr;
    } else {
      // hoch -> Höhe ist die lange Kante
      h = long;
      w = long * safeAr;
    }

    // Mindestkante sicherstellen (proportional hoch)
    const r = enforceMinEdgeCm(w, h, MIN_EDGE_CM);
    w = r.wCm;
    h = r.hCm;

    // max 20cm auf der langen Kante (falls durch Mindestkante/rounding drüber)
    const maxSide = Math.max(w, h);
    if (maxSide > 20) {
      const k = 20 / Math.max(1e-9, maxSide);
      w *= k;
      h *= k;
    }

    return { wCm: Number(w.toFixed(2)), hCm: Number(h.toFixed(2)) };
  }

  // ✅ Freiform: UI/State automatisch korrigieren (damit niemand unter 40mm bleibt)
  useEffect(() => {
    if (shape !== "freeform") return;

    const r = enforceMinEdgeCm(billingWidthCm, billingHeightCm, MIN_EDGE_CM);
    if (!r.scaled) return;

    setBillingWidthCm(clampNum(r.wCm, MIN_EDGE_CM, 300));
    setBillingHeightCm(clampNum(r.hCm, MIN_EDGE_CM, 300));

    // Optional: Design-Dims proportional mitziehen (stabilere Preview/Design)
    const k = Number(r.k) || 1;
    if (k > 1.0001) {
      setWidthCm((prev) => clampNum((Number(prev) || MIN_EDGE_CM) * k, 1, 300));
      setHeightCm((prev) => clampNum((Number(prev) || MIN_EDGE_CM) * k, 1, 300));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape, billingWidthCm, billingHeightCm]);


  // ✅ Freiform: Dropdown -> Billing-Dims proportional zur Cutline (oder Bild-Aspect als Fallback)
  useEffect(() => {
    if (shape !== "freeform") return;

    const ar = freeformCutAspect || imgAspect || 1;
    const dims = freeformDimsFromLongSide(freeformLongSideCm, ar);

    // nur setzen wenn wirklich Änderung (Loops vermeiden)
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

  // ✅ Katalog-Definition kommt immer aus der Basisform (bei rotated shapes)
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

  // Ensure colorKey and initial sizeKey exist for shapes that use dropdown
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

    // Bei Freiform: sizeKey wird später automatisch aus Billing-Input gesetzt.
    if (shape === "freeform") return;

    const exists = list.some((x) => String(x.sizeKey) === String(sizeKey));
    if (!exists) setSizeKey(String(list[0]?.sizeKey || ""));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape, catalog, shapeDef, hasCatalogColors]);

  useEffect(() => {
    if (!catalog || !shapeDef) return;

    // Bei Freiform: sizeKey wird automatisch aus Billing-Input gesetzt.
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

  // ✅ Freiform: freie Maße -> Abrechnungsgröße (sizeKey/variantId) automatisch wählen (ceil)
  useEffect(() => {
    if (shape !== "freeform") return;
    if (!availableSizes.length) return;

    // Wichtig: hier effWcm/effHcm verwenden (Mindestkante bereits erzwungen)
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

  // ✅ Freiform: Design-Maße automatisch in Billing-Box fitten (Proportion = Cutline-Aspect, fallback imgAspect)
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

  // ✅ Feste Formen: Größe aus Dropdown setzt Maße
  useEffect(() => {
    if (!selectedSizeObj) return;

    const w = Number(selectedSizeObj.wCm);
    const h = Number(selectedSizeObj.hCm);
    const vid = String(selectedSizeObj.variantId || "");
    // Wenn der Loader (noch) nur die White-"sizes" liefert, ist variantId hier immer die White-Variante.
    // Darum: variantId aus dem Katalog nur direkt verwenden, wenn Farben im Katalog vorhanden sind
    // oder wir explizit auf "white" stehen.
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


  // ✅ Freiform: Preset-LongSide aus aktuellen effektiven Maßen ableiten (beim Wechsel auf Freiform)
  useEffect(() => {
    if (shape !== "freeform") return;
    const long = Math.max(Number(effWcm) || MIN_EDGE_CM, Number(effHcm) || MIN_EDGE_CM);
    // auf nächste verfügbare Presetgröße runden (ceil)
    const next = FREEFORM_LONGSIDE_PRESETS_CM.find((x) => x >= long) || FREEFORM_LONGSIDE_PRESETS_CM[FREEFORM_LONGSIDE_PRESETS_CM.length - 1];
    if (Number(next) && next !== freeformLongSideCm) setFreeformLongSideCm(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape]);

  // Multi-Product per shape
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
    const key = String(shapeMeta?.base || shape || "square").toLowerCase(); // ✅ base für rotated shapes
    const next = map && map[key] ? String(map[key]) : current;
    if (next && next !== activeHandle) setActiveHandle(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape, shapeMeta]);

  // Cache + Inflight-Guard gegen Request-Sturm (z. B. wenn productVariants im Storefront häufig neu referenziert wird)
const variantInfoCacheRef = useRef(new Map()); // vid -> { price:number, title:string }
const variantInfoInFlightRef = useRef(new Map()); // vid -> Promise
const lastVariantFetchVidRef = useRef(0);

useEffect(() => {
  let cancelled = false;

  const vid = Number(selectedVariantId) || 0;
  if (!vid) return;

  // 0) Cache: wenn wir die Variant-Info schon haben, nicht nochmal fetchen
  const cached = variantInfoCacheRef.current.get(vid);
  if (cached) {
    setSelectedVariantPrice(Number(cached.price) || 0);
    setSelectedVariantTitle(String(cached.title || ""));
    return;
  }

  // 1) Wenn Variantenliste vorhanden ist (z.B. bereits geladen), daraus ziehen und cachen
  const fromList = Array.isArray(productVariants)
    ? productVariants.find((x) => Number(x?.id) === vid)
    : null;

  if (fromList) {
    const price = toEuroFromCents(fromList?.price);
    const title = String(fromList?.title || "");
    variantInfoCacheRef.current.set(vid, { price, title });
    setSelectedVariantPrice(price);
    setSelectedVariantTitle(title);
    return;
  }

  // 2) Inflight-Guard: gleiche Variant-ID nicht parallel / nicht endlos erneut laden
  if (variantInfoInFlightRef.current.get(vid)) {
    return () => {
      cancelled = true;
    };
  }
  lastVariantFetchVidRef.current = vid;

  const controller = new AbortController();

  const p = (async () => {
    // A) ✅ Storefront: same-origin variants/<id>.js
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
    } catch (_) {
      // ignore
    }

    // B) ✅ Same-origin App-Backend (Admin / Fallback)
    try {
      const res = await fetch(
        api(`/sticker/variant?variantId=${encodeURIComponent(String(vid))}`),
        {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
          headers: { Accept: "application/json" },
          signal: controller.signal,
        }
      );

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
    } catch (_) {
      // ignore
    }

    // C) Fallback: direct variant endpoint über erkannte Shop-Domain (ohne Cookies)
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
    } catch (_) {
      // ignore
    }
  })()
    .finally(() => {
      // inflight cleanup
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

          // ✅ Original-Proportion aus Mask-BBox ableiten
          const ar = maskAspectFromBBox(master.insideMask, master.mw, master.mh);
          setFreeformCutAspect(ar);

          // ✅ Billing-Box direkt einmal auf diese Proportion "einrasten" lassen (ohne Sprünge)
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
        // ✅ Für Preview in px: effektive Billing-Dims nutzen (Mindestkante garantiert)
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

    // ✅ WICHTIG (Fix "verzogene" Ansicht nach Export):
    // Solange das Editor-Work-Image ein lokales Blob-URL ist, darf die Preview NICHT
    // automatisch auf eine server-gerenderte Preview umschalten. Beim Export/Add-to-cart
    // wird das Bild remote hochgeladen (uploadedUrl) und die serverPreview-Logik würde
    // danach anspringen und displaySrc ändern.
    // Das kann (je nach Backend-Render/Padding) dazu führen, dass die Freiform-Maske im
    // Editor optisch "verzogen" wirkt, obwohl das Design korrekt ist.
    // => Server-Preview nur verwenden, wenn imageUrl selbst schon remote ist.
    const normalizedImageUrl = normalizeUrl(imageUrl);

    const allowServerPreview =
      isProbablyRemoteUrl(normalizedImageUrl) && !isBlobUrl(normalizedImageUrl);

    if (!allowServerPreview) {
      if (serverPreviewUrl) setServerPreviewUrl("");
      return;
    }

    // Wenn imageUrl remote ist, nehmen wir das direkt (keine "hidden" Umschaltung via uploadedUrl).
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

              // ✅ optional: Backend kann später dieselbe Logik nutzen
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
      // Bei lokalem Work-Image (blob:) niemals auf serverPreviewUrl umschalten,
      // damit sich die Darstellung nach Export/Add-to-cart nicht "verzieht".
      if (isBlobUrl(normalizedDisplayImageUrl))
        return freeformPreviewUrl || normalizedDisplayImageUrl || "";
      return (
        serverPreviewUrl ||
        freeformPreviewUrl ||
        normalizedDisplayImageUrl ||
        ""
      );
    }
    return normalizedDisplayImageUrl;
  }, [
    shape,
    serverPreviewUrl,
    freeformPreviewUrl,
    normalizedDisplayImageUrl,
  ]);

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

    // Reset Cut-Aspect, wird nach Master neu berechnet
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

  // ==============================
  // Export
  // ==============================
  async function exportSvg() {
    setErrorMsg("");

    if (!imageUrl) {
      setErrorMsg("Bitte zuerst ein Bild hochladen.");
      return;
    }

    setExporting(true);

    try {
      const remoteUrl = await ensureRemoteUpload();

      // ✅ Einheitlicher Export: SVG erzeugen (Shopify Files) und öffnen
      const svgUrl = await ensureSvgExportForCart(remoteUrl);

      window.open(svgUrl, "_blank", "noopener,noreferrer");
    } catch (e) {
      setErrorMsg(e?.message || String(e));
    } finally {
      setExporting(false);
    }
  }
  useEffect(() => {
  // 1) Wenn Katalogwert existiert: den verwenden
  const fromCatalog = selectedSizeObj?.piecesPerSet;
  if (Number.isFinite(fromCatalog) && fromCatalog > 0) {
    setRealPieces((prev) => (prev === fromCatalog ? prev : fromCatalog));
    return;
  }

  // 2) Fallback: bisherige Berechnung (falls Katalog noch nicht gepflegt)
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


// ✅ NEU: SVG Export erzeugen und URL merken (Shopify Files URL)
let svgUrl = "";
try {
  svgUrl = await ensureSvgExportForCart(remoteUrl);
} catch (e) {
  // SVG ist für Produktion Pflicht -> abbrechen
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

  // ✅ intern (bleibt)
  _sc_pieces_per_pack: String(pieces),
  _sc_total_pieces_hint: String(pieces),

  _sc_design_w_cm: shape === "freeform" ? fmtCm(widthCm) : "",
  _sc_design_h_cm: shape === "freeform" ? fmtCm(heightCm) : "",

  _sc_bg_mode: String(bgMode || "color"),
  _sc_bg: String(bgColorEff || ""),
  _sc_border_mm: String(freeformBorderMm),

  _sc_image: remoteUrl,

  // ✅ NEU: Link zur Produktions-SVG (Shopify Files)
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
  // ✅ Preview-Box px-Fit
  // ==============================
  const previewDims = useMemo(() => {
    const maxW = Math.max(240, Math.min(PREVIEW_MAX_PX, vp.w * PREVIEW_MAX_VW_FACTOR));
    const maxH = Math.max(240, vp.h * PREVIEW_MAX_VH_FACTOR);

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
  }, [vp.w, vp.h, shape, widthCm, heightCm, billingWidthCm, billingHeightCm, effWcm, effHcm]);

  // ==============================
  // ✅ Transparenz-Schachbrett (nur innerhalb Stickerfläche)
  // ==============================
  const transparentPattern = useMemo(() => {
    const c1 = "rgba(255,255,255,0.09)";
    const c2 = "rgba(0,0,0,0.14)";
    const size = 18;
    return {
      backgroundImage: `
        linear-gradient(45deg, ${c2} 25%, transparent 25%, transparent 75%, ${c2} 75%, ${c2}),
        linear-gradient(45deg, ${c2} 25%, transparent 25%, transparent 75%, ${c2} 75%, ${c2})
      `,
      backgroundSize: `${size}px ${size}px`,
      backgroundPosition: `0 0, ${size / 2}px ${size / 2}px`,
      backgroundColor: c1,
    };
  }, []);

  const showTransparentMark = useMemo(() => bgMode === "transparent", [bgMode]);
  const TRANSPARENT_UI_SHADE = "rgba(255,255,255,0.06)";
  const TRANSPARENT_UI_OUTLINE = "rgba(255,255,255,0.35)";

  // ==============================
  // UI Preview styles
  // ==============================
  const PREVIEW_SURFACE_SCALE = 0.88;

  const previewFrameStyle = useMemo(() => {
    return {
      position: "relative",
      width: `${previewDims.w}px`,
      height: `${previewDims.h}px`,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      overflow: "visible",
    };
  }, [previewDims.w, previewDims.h]);

  const fixedSurfaceDims = useMemo(() => {
    const s = clampNum(PREVIEW_SURFACE_SCALE, 0.6, 0.98);
    return {
      w: Math.max(1, Math.round(previewDims.w * s)),
      h: Math.max(1, Math.round(previewDims.h * s)),
    };
  }, [previewDims.w, previewDims.h]);

  const freeformContainerStyle = useMemo(() => {
    return {
      position: "relative",
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      overflow: "hidden",
      width: `${previewDims.w}px`,
      height: `${previewDims.h}px`,
      maxWidth: "100%",
      maxHeight: "100%",
      background: "transparent",
    };
  }, [previewDims.w, previewDims.h]);

  const fixedShapeSurfaceStyle = useMemo(() => {
    if (shape === "freeform") return null;

    const base = {
      position: "relative",
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      overflow: "hidden",
      width: `${fixedSurfaceDims.w}px`,
      height: `${fixedSurfaceDims.h}px`,
      maxWidth: "100%",
      maxHeight: "100%",
      background: hasBgFill ? bgColorEff : showTransparentMark ? TRANSPARENT_UI_SHADE : "transparent",
      filter: "drop-shadow(0 10px 28px rgba(0,0,0,0.45))",
    };

    if (shape === "round") return { ...base, borderRadius: "50%" };

    if (shape === "oval" || shape === "oval_portrait") {
      return { ...base, borderRadius: "50%", clipPath: "ellipse(50% 50% at 50% 50%)" };
    }

    if (shape === "square_rounded" || shape === "rect_rounded" || shape === "rect_landscape_rounded") {
      return { ...base, borderRadius: "28px" };
    }

    return base;
  }, [shape, fixedSurfaceDims.w, fixedSurfaceDims.h, hasBgFill, bgColorEff, showTransparentMark, TRANSPARENT_UI_SHADE]);

  const fixedShapeOutlineStyle = useMemo(() => {
    if (shape === "freeform") return null;
    const alpha = showTransparentMark ? 0.28 : 0.14;
    return {
      position: "absolute",
      inset: 0,
      pointerEvents: "none",
      border: `1px solid rgba(255,255,255,${alpha})`,
      borderRadius: "inherit",
      boxShadow: `inset 0 0 0 1px rgba(0,0,0,${showTransparentMark ? 0.28 : 0.18})`,
    };
  }, [shape, showTransparentMark]);

  const shapeContainerStyle = freeformContainerStyle;

  const roundImgBoxStyle = useMemo(() => {
    const w = Math.max(1e-9, Number(widthCm) || 1);
    const h = Math.max(1e-9, Number(heightCm) || 1);
    const diag = Math.max(1e-9, diagonalFromRect(w, h));
    const wp = (w / diag) * 100;
    const hp = (h / diag) * 100;
    return { width: `${wp}%`, height: `${hp}%`, maxWidth: "100%", maxHeight: "100%" };
  }, [widthCm, heightCm]);

  const ovalImgBoxStyle = useMemo(() => {
    const s = 1 / SQRT2;
    return { width: `${s * 100}%`, height: `${s * 100}%`, maxWidth: "100%", maxHeight: "100%" };
  }, []);

  const freeformMaskedTransparencyStyle = useMemo(() => {
    if (!showTransparentMark) return null;
    if (shape !== "freeform") return null;
    if (!displaySrc) return null;

    return {
      position: "absolute",
      inset: 0,
      pointerEvents: "none",
      ...transparentPattern,

      WebkitMaskImage: `url(${displaySrc})`,
      WebkitMaskRepeat: "no-repeat",
      WebkitMaskPosition: "center",
      WebkitMaskSize: "contain",

      maskImage: `url(${displaySrc})`,
      maskRepeat: "no-repeat",
      maskPosition: "center",
      maskSize: "contain",

      opacity: 1,
    };
  }, [showTransparentMark, shape, displaySrc, transparentPattern]);

  const freeformImgEnhanceStyle = useMemo(() => {
    if (shape !== "freeform") return null;
    if (!showTransparentMark) return null;
    return {
      filter:
        "drop-shadow(0 0 0.9px rgba(255,255,255,0.70)) drop-shadow(0 8px 22px rgba(0,0,0,0.45))",
    };
  }, [shape, showTransparentMark]);

  const previewBg = useMemo(() => "#0b0f16", []);

  // ==============================
  // Render
  // ==============================
  return (
    <div style={styles.wrapper}>
      <div style={styles.leftPanel}>
        <div style={styles.sectionTitle}>Form & Größe</div>

        <div style={{ display: "grid", gap: 8, marginBottom: 12 }}>
          <label>
            Form
            <select
              value={shape}
              onChange={(e) => {
                setAddedMsg("");
                setShape(e.target.value);
              }}
              style={{ width: "100%", marginTop: 4, ...styles.select }}
            >
              <option value="square">Quadratisch</option>
              <option value="square_rounded">Quadratisch abgerundet</option>

              <option value="rect">Rechteck</option>
              <option value="rect_rounded">Rechteckig abgerundet</option>
              <option value="rect_landscape">Rechteck Quer</option>
              <option value="rect_landscape_rounded">Rechteck Quer Abgerundet</option>

              <option value="round">Rund</option>

              <option value="oval">Oval</option>
              <option value="oval_portrait">Oval stehend</option>

              <option value="freeform">Freiform</option>
            </select>
          </label>

          {/* ✅ Größe: feste Formen = Dropdown, Freiform = Dropdown (iOS-sicher) */}
          {shape === "freeform" ? (
            <>
              
              <label>
                Größe (Proportion bleibt erhalten)
                <select
                  value={String(freeformLongSideCm)}
                  onChange={(e) => {
                    setAddedMsg("");
                    const v = parseNumberDE(e.target.value);
                    if (!Number.isFinite(v)) return;
                    setFreeformLongSideCm(v);
                  }}
                  style={{ width: "100%", marginTop: 4, ...styles.select }}
                >
                  {FREEFORM_LONGSIDE_PRESETS_CM.map((cm) => {
                    const ar = freeformCutAspect || imgAspect || 1;
                    const dims = freeformDimsFromLongSide(cm, ar);
                    const label = `${fmtCm(cm)} cm (≈ ${dims.wCm.toFixed(2)} × ${dims.hCm.toFixed(2)} cm)`;
                    return (
                      <option key={`ff-${cm}`} value={String(cm)}>
                        {label}
                      </option>
                    );
                  })}
                </select>
              </label>

              <div style={{ fontSize: 12, opacity: 0.75, marginTop: 6 }}>
                Effektiv (Abrechnung):{" "}
                <b>
                  {fmtCm(effWcm)} × {fmtCm(effHcm)} cm
                </b>
              </div>



              
            </>
          ) : (
            <label>
              Größe
              <select
                value={sizeKey}
                onChange={(e) => setSizeKey(e.target.value)}
                disabled={!availableSizes.length}
                style={{ width: "100%", marginTop: 4, ...styles.select }}
              >
                {!availableSizes.length ? (
                  <option value="">{catalog ? "Keine Größen verfügbar" : "Lade Größen..."}</option>
                ) : (
                  availableSizes.map((v) => (
                    <option key={`${String(shape)}-${String(colorKey)}-${v.sizeKey}`} value={v.sizeKey}>
                      {v.label}
                    </option>
                  ))
                )}
              </select>
            </label>
          )}
        </div>

        <div style={styles.label}>Hintergrund</div>
        <select
          value={bgMode}
          onChange={(e) => setBgMode(e.target.value)}
          style={{ width: "100%", marginTop: 4, ...styles.select }}
        >
          <option value="color">Farbig</option>
          <option value="white">Weiß</option>
          {/*<option value="transparent">Transparent</option>*/}
        </select>

        {bgMode === "color" ? (
          <>
            <div style={styles.label}>Hintergrundfarbe</div>
            <input type="color" value={bgColor} onChange={(e) => setBgColor(e.target.value)} style={styles.color} />
          </>
        ) : null}

        {shape === "freeform" ? (
          <>
           <div style={styles.label}>Freiform-Rand (mm)</div>
<select
  value={String(freeformBorderMm)}
  onChange={(e) => {
    const v = Number(String(e.target.value).replace(",", "."));
    setFreeformBorderMm(Number.isFinite(v) ? v : 3);
  }}
  style={{ width: "100%", marginTop: 4, ...styles.select }}
>
  {[1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5].map((mm) => (
    <option key={`ffb-${mm}`} value={String(mm)}>
      {mm.toFixed(1)} mm
    </option>
  ))}
</select>

            {/*<div style={{ fontSize: 12, opacity: 0.85, marginTop: 6 }}>{borderDraftMm.toFixed(1)} mm</div>

            <div style={{ fontSize: 12, opacity: 0.75, marginTop: 10 }}>
              Billing-Box (effektiv):{" "}
              <b>
                {fmtCm(effWcm)} × {fmtCm(effHcm)} cm
              </b>
            </div>*/}
          </>
        ) : null}

        <div style={styles.divider} />

        <div style={styles.statLine}>
          <div style={styles.statLabel}>Sticker pro Set:</div>
          <div style={styles.statValue}>{realPieces}</div>
        </div>

        <div style={styles.statLine}>
          <div style={styles.statLabel}>Preis:</div>
          <div style={styles.statValue}>{`${priceTotal.toFixed(2)} €`}</div>
        </div>

        {/*<div style={{ fontSize: 12, opacity: 0.75, marginTop: 6 }}>
          Variante: <b>{selectedVariantTitle || "—"}</b>
        </div>*/}

        <div style={styles.divider} />

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={(e) => uploadFile(e.target.files?.[0])}
        />

        <button type="button" style={styles.secondaryBtn} onClick={() => fileInputRef.current?.click()}>
          {uploading ? "Upload…" : imageUrl ? "Bild ändern" : "Bild hochladen"}
        </button>

        <label
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            fontSize: 12,
            opacity: 0.9,
            marginTop: 10,
          }}
        >
          <input type="checkbox" checked={goToCartAfterAdd} onChange={(e) => setGoToCartAfterAdd(!!e.target.checked)} />
          Nach dem Hinzufügen zum Warenkorb wechseln
        </label>

        {addedMsg ? (
          <div style={{ marginTop: 10, fontSize: 12, opacity: 0.9, color: "rgba(255,255,255,0.85)" }}>{addedMsg}</div>
        ) : null}

        <button type="button" style={styles.primaryBtn} onClick={addToCart} disabled={!imageUrl}>
          In den Warenkorb
        </button>

        <button type="button" style={styles.secondaryBtn} onClick={exportSvg} disabled={!imageUrl || exporting}>
          {exporting ? "Export…" : "SVG & PDF exportieren"}
        </button>

        {errorMsg ? <div style={styles.errorBox}>{errorMsg}</div> : null}
      </div>

      <div style={{ ...styles.rightPanel, background: previewBg }}>
        {!imageUrl ? (
          <div style={styles.emptyHint}>Bitte links ein Bild hochladen.</div>
        ) : (
          <div style={previewFrameStyle}>
            {shape === "freeform" ? (
              <div style={shapeContainerStyle}>
                {freeformReady && freeformMaskedTransparencyStyle ? <div style={freeformMaskedTransparencyStyle} /> : null}

                <img
                  src={displaySrc}
                  alt="Sticker"
                  style={{
                    width: "100%",
                    height: "100%",
                    objectFit: "contain",
                    background: "transparent",
                    opacity: 1,
                    ...(freeformImgEnhanceStyle || null),
                  }}
                  crossOrigin="anonymous"
                />
              </div>
            ) : (
              <div style={fixedShapeSurfaceStyle}>
                {fixedShapeOutlineStyle ? <div style={fixedShapeOutlineStyle} /> : null}

                {shape === "round" ? (
                  <img
                    src={imageUrl}
                    alt="Sticker"
                    style={{ ...roundImgBoxStyle, display: "block", objectFit: "contain", background: "transparent" }}
                    crossOrigin="anonymous"
                  />
                ) : shape === "oval" || shape === "oval_portrait" ? (
                  <img
                    src={imageUrl}
                    alt="Sticker"
                    style={{ ...ovalImgBoxStyle, objectFit: "contain", background: "transparent" }}
                    crossOrigin="anonymous"
                  />
                ) : (
                  <img
                    src={imageUrl}
                    alt="Sticker"
                    style={{
                      width: "100%",
                      height: "100%",
                      objectFit: "contain",
                      background: "transparent",
                      opacity: 1,
                    }}
                    crossOrigin="anonymous"
                  />
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const styles = {
  wrapper: {
    width: "100%",
    maxWidth: 980,
    margin: "0 auto",
    display: "grid",
    gridTemplateColumns: "260px 1fr",
    gap: 0,
    borderRadius: 22,
    overflow: "hidden",
    boxShadow: "0 20px 60px rgba(0,0,0,0.45)",
    background: "#0b0f16",
  },
  leftPanel: {
    padding: 18,
    background: "#0b0f16",
    color: "#fff",
    borderRight: "1px solid rgba(255,255,255,0.08)",
  },
  rightPanel: {
    minHeight: 520,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  sectionTitle: { fontSize: 14, opacity: 0.9, marginBottom: 6 },
  label: { fontSize: 13, opacity: 0.85, marginTop: 14, marginBottom: 6 },
  select: {
    padding: "10px 10px",
    borderRadius: 10,
    border: "1px solid rgba(255,255,255,0.14)",
    background: "#0e1624",
    color: "#fff",
    outline: "none",
  },
  input: {
    padding: "10px 10px",
    borderRadius: 10,
    border: "1px solid rgba(255,255,255,0.14)",
    background: "#0e1624",
    color: "#fff",
    outline: "none",
  },
  color: {
    width: 86,
    height: 36,
    borderRadius: 10,
    border: "1px solid rgba(255,255,255,0.14)",
    background: "transparent",
    padding: 0,
  },
  divider: { height: 1, background: "rgba(255,255,255,0.10)", margin: "14px 0" },
  statLine: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: 10,
    padding: "6px 0",
  },
  statLabel: { fontSize: 13, opacity: 0.9 },
  statValue: { fontSize: 14, fontWeight: 700 },
  primaryBtn: {
    width: "100%",
    marginTop: 12,
    padding: "12px 14px",
    borderRadius: 999,
    border: "none",
    background: "#16a34a",
    color: "#fff",
    fontWeight: 800,
    cursor: "pointer",
  },
  secondaryBtn: {
    width: "100%",
    marginTop: 10,
    padding: "11px 14px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,0.18)",
    background: "rgba(255,255,255,0.06)",
    color: "#fff",
    fontWeight: 700,
    cursor: "pointer",
  },
  errorBox: {
    marginTop: 12,
    padding: 10,
    borderRadius: 12,
    background: "rgba(239, 68, 68, 0.12)",
    border: "1px solid rgba(239, 68, 68, 0.35)",
    color: "#fecaca",
    fontSize: 12,
    whiteSpace: "pre-wrap",
  },
  emptyHint: {
    color: "rgba(255,255,255,0.75)",
    fontSize: 14,
    textAlign: "center",
    maxWidth: 420,
    lineHeight: 1.4,
  },
};
