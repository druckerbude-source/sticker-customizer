import { json } from "@remix-run/node";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { authenticate } from "../shopify.server";

const PX_PER_CM = 100;
const FREEFORM_MASTER_LONG_SIDE = 1200;
const DEFAULT_MAX_PX = 1200;

const PREVIEW_DIR = path.resolve(process.cwd(), "public", "uploads", "sticker-configurator", "previews");

// damit du direkt testen kannst: /apps/sticker-configurator/sticker/preview
export async function loader() {
  return json({
    ok: true,
    route: "/apps/sticker-configurator/sticker/preview",
    hint: "POST JSON { imageUrl, shape, widthCm, heightCm, bgColor, freeformBorderMm, maxPx }",
  });
}

export async function options() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
    },
  });
}

function clampNum(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.min(max, Math.max(min, x));
}

function mmToPx(mm) {
  const m = clampNum(mm, 0, 50);
  return Math.max(1, Math.round((m / 10) * PX_PER_CM));
}

// ------------------------------
// Background / transparency helpers
// ------------------------------
function normalizeBgInput(bgMode, bgColor) {
  const mode = String(bgMode || "color").toLowerCase();
  const raw = String(bgColor ?? "").trim();
  const low = raw.toLowerCase();
  const isTrans = !raw || low === "transparent" || low === "none";
  const hasFill = mode !== "transparent" && !isTrans;
  return { mode, raw, hasFill };
}

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

// ---------------------------------------------------------------------------
// SSRF Guard + Relative URL Support
// ---------------------------------------------------------------------------

function baseFromRequest(request) {
  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");

  const base = origin || referer;
  if (!base) {
    const u = new URL(request.url);
    return `${u.protocol}//${u.host}`;
  }

  const u = new URL(base);
  return `${u.protocol}//${u.host}`;
}

function resolveImageUrl(imageUrl, baseUrlStr) {
  const raw = String(imageUrl || "").trim();
  if (!raw) throw new Error("imageUrl fehlt.");

  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith("//")) return `https:${raw}`;

  // relative (storefront / app proxy): /cdn/... oder /apps/...
  if (raw.startsWith("/")) return new URL(raw, baseUrlStr).toString();

  throw new Error("Ungültige imageUrl (muss http(s) oder /pfad sein).");
}

function assertSafeHttpUrl(urlStr, { request, baseUrlStr }) {
  let u;
  try {
    u = new URL(urlStr);
  } catch {
    throw new Error("Ungültige imageUrl.");
  }

  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("imageUrl muss http/https sein.");
  }

  const host = (u.hostname || "").toLowerCase();

  // block local
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".local")) {
    throw new Error("Lokale imageUrl ist nicht erlaubt.");
  }

  // Allowlist:
  const appHost = new URL(request.url).hostname.toLowerCase();
  const storeHost = (() => {
    try {
      return new URL(baseUrlStr).hostname.toLowerCase();
    } catch {
      return "";
    }
  })();

  const allowed =
    host === appHost ||
    (storeHost && host === storeHost) ||
    host === "cdn.shopify.com" ||
    host.endsWith(".myshopify.com") ||
    host.endsWith(".shopifycdn.com") ||
    host.endsWith(".shopify.com");

  if (!allowed) {
    throw new Error(`imageUrl Host nicht erlaubt (${host}).`);
  }

  return u;
}

async function fetchImageBuffer(imageUrlRaw, request, { timeoutMs = 8000, maxBytes = 15_000_000 } = {}) {
  const baseUrlStr = baseFromRequest(request);
  const resolved = resolveImageUrl(imageUrlRaw, baseUrlStr);
  const u = assertSafeHttpUrl(resolved, { request, baseUrlStr });

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(u.toString(), {
      method: "GET",
      redirect: "follow",
      signal: ctrl.signal,
      headers: { "User-Agent": "sticker-configurator/preview" },
    });

    if (!res.ok) throw new Error(`Bild nicht erreichbar (${res.status}).`);

    const ct = String(res.headers.get("content-type") || "");
    if (ct && !ct.startsWith("image/")) {
      throw new Error(`Ungültiger Content-Type (${ct}).`);
    }

    const cl = Number(res.headers.get("content-length") || 0);
    if (cl && cl > maxBytes) {
      throw new Error(`Bild zu groß (>${Math.round(maxBytes / 1e6)}MB).`);
    }

    const ab = await res.arrayBuffer();
    if (ab.byteLength > maxBytes) {
      throw new Error(`Bild zu groß (>${Math.round(maxBytes / 1e6)}MB).`);
    }

    return { buf: Buffer.from(ab), resolvedUrl: u.toString() };
  } catch (e) {
    if (e?.name === "AbortError") throw new Error("Timeout beim Laden des Bildes.");
    throw e;
  } finally {
    clearTimeout(t);
  }
}

// --- Masken ----------------------------------------------------------------

function buildInsideMaskFromAlpha(imgData, w, h, alphaThreshold = 8) {
  const a = imgData.data;

  const isTransparent = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) isTransparent[i] = a[i * 4 + 3] <= alphaThreshold ? 1 : 0;

  const outside = new Uint8Array(w * h);
  const qx = new Int32Array(w * h);
  const qy = new Int32Array(w * h);
  let qs = 0,
    qe = 0;

  const push = (x, y) => {
    qx[qe] = x;
    qy[qe] = y;
    qe++;
  };
  const trySeed = (x, y) => {
    const idx = y * w + x;
    if (isTransparent[idx] && !outside[idx]) {
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
    const x = qx[qs],
      y = qy[qs];
    qs++;

    const nx1 = x + 1,
      nx2 = x - 1,
      ny1 = y + 1,
      ny2 = y - 1;

    if (nx1 < w) {
      const i = y * w + nx1;
      if (isTransparent[i] && !outside[i]) {
        outside[i] = 1;
        push(nx1, y);
      }
    }
    if (nx2 >= 0) {
      const i = y * w + nx2;
      if (isTransparent[i] && !outside[i]) {
        outside[i] = 1;
        push(nx2, y);
      }
    }
    if (ny1 < h) {
      const i = ny1 * w + x;
      if (isTransparent[i] && !outside[i]) {
        outside[i] = 1;
        push(x, ny1);
      }
    }
    if (ny2 >= 0) {
      const i = ny2 * w + x;
      if (isTransparent[i] && !outside[i]) {
        outside[i] = 1;
        push(x, ny2);
      }
    }
  }

  const inside = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) inside[i] = outside[i] ? 0 : 1;
  return inside;
}

// ✅ Performance: extrem schnelle Dilation (O(w*h)) via separable Box-Filter mit Prefix-Sums.
// Für Preview ist das üblicherweise ausreichend (minimal “eckiger” als Kreis-Dilation).
function dilateMaskBox(mask, w, h, radiusPx) {
  const r = Math.max(0, Math.round(radiusPx || 0));
  if (r <= 0) return mask;

  // 1) horizontal
  const tmp = new Uint8Array(w * h);
  const ps = new Int32Array(w + 1);

  for (let y = 0; y < h; y++) {
    const row = y * w;
    ps[0] = 0;
    for (let x = 0; x < w; x++) ps[x + 1] = ps[x] + (mask[row + x] ? 1 : 0);

    for (let x = 0; x < w; x++) {
      const L = Math.max(0, x - r);
      const R = Math.min(w - 1, x + r);
      const sum = ps[R + 1] - ps[L];
      tmp[row + x] = sum > 0 ? 1 : 0;
    }
  }

  // 2) vertical
  const out = new Uint8Array(w * h);
  const psY = new Int32Array(h + 1);

  for (let x = 0; x < w; x++) {
    psY[0] = 0;
    for (let y = 0; y < h; y++) psY[y + 1] = psY[y] + (tmp[y * w + x] ? 1 : 0);

    for (let y = 0; y < h; y++) {
      const T = Math.max(0, y - r);
      const B = Math.min(h - 1, y + r);
      const sum = psY[B + 1] - psY[T];
      out[y * w + x] = sum > 0 ? 1 : 0;
    }
  }

  return out;
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

function maskToAlphaCanvas(mask, w, h) {
  const c = createCanvas(w, h);
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(w, h);
  const d = img.data;
  for (let i = 0; i < w * h; i++) d[i * 4 + 3] = mask[i] ? 255 : 0;
  ctx.putImageData(img, 0, 0);
  return c;
}

// --- Mini LRU ---------------------------------------------------------------

class LruTtl {
  constructor({ max = 12, ttlMs = 5 * 60_000 } = {}) {
    this.max = max;
    this.ttlMs = ttlMs;
    this.map = new Map();
  }
  get(key) {
    const v = this.map.get(key);
    if (!v) return null;
    if (Date.now() - v.t > this.ttlMs) {
      this.map.delete(key);
      return null;
    }
    this.map.delete(key);
    this.map.set(key, v);
    return v.v;
  }
  set(key, value) {
    this.map.set(key, { v: value, t: Date.now() });
    if (this.map.size > this.max) {
      const first = this.map.keys().next().value;
      this.map.delete(first);
    }
  }
}

const masterCache = new LruTtl({ max: 10, ttlMs: 10 * 60_000 });

async function getMasterForImageUrl(resolvedImageUrl, request) {
  const cached = masterCache.get(resolvedImageUrl);
  if (cached) return cached;

  const { buf } = await fetchImageBuffer(resolvedImageUrl, request);
  const img = await loadImage(buf);

  const iw = img.width || 1;
  const ih = img.height || 1;
  const imgAspect = ih > 0 ? iw / ih : 1;

  // leicht reduziert (weniger Pixel = weniger Arbeit)
  const padPx = 140;

  const inner = getMasterRectFromAspect(imgAspect);
  const innerW = inner.w;
  const innerH = inner.h;

  const masterW = innerW + padPx * 2;
  const masterH = innerH + padPx * 2;

  const masterCanvas = createCanvas(masterW, masterH);
  const mctx = masterCanvas.getContext("2d");

  const scale = Math.min(innerW / iw, innerH / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  const dx = padPx + (innerW - dw) / 2;
  const dy = padPx + (innerH - dh) / 2;

  mctx.clearRect(0, 0, masterW, masterH);
  mctx.imageSmoothingEnabled = true;
  mctx.drawImage(img, dx, dy, dw, dh);

  // ✅ etwas kleiner => deutlich schneller, reicht für Preview
  const maxMaskDim = 650;
  const s = Math.min(1, maxMaskDim / Math.max(masterW, masterH));
  const mw = Math.max(1, Math.round(masterW * s));
  const mh = Math.max(1, Math.round(masterH * s));

  const maskCanvas = createCanvas(mw, mh);
  const kctx = maskCanvas.getContext("2d");
  kctx.imageSmoothingEnabled = true;
  kctx.drawImage(masterCanvas, 0, 0, mw, mh);

  const imgData = kctx.getImageData(0, 0, mw, mh);
  const insideMask = buildInsideMaskFromAlpha(imgData, mw, mh, 8);

  const master = { masterCanvas, masterW, masterH, mw, mh, insideMask, backing: new Map() };
  masterCache.set(resolvedImageUrl, master);
  return master;
}

function renderFreeformPreview({ master, outW, outH, bgMode, bgColor, borderPx }) {
  const mw = master.mw;
  const mh = master.mh;

  const bg = normalizeBgInput(bgMode, bgColor);

  const pxPerMask = outW / Math.max(1, mw);
  const borderInMaskPx = Math.max(1, Math.round((borderPx || 0) / Math.max(1e-9, pxPerMask)));

  const key = String(borderInMaskPx);
  let backing = master.backing.get(key);

  if (!backing) {
    // ✅ statt exakter Kreis-Dilation -> superschnelle Box-Dilation
    const backingMask = dilateMaskBox(master.insideMask, mw, mh, borderInMaskPx);
    const bb = maskBBox(backingMask, mw, mh);
    const alphaCanvas = maskToAlphaCanvas(backingMask, mw, mh);
    backing = { bb, alphaCanvas };
    master.backing.set(key, backing);

    if (master.backing.size > 12) {
      const first = master.backing.keys().next().value;
      master.backing.delete(first);
    }
  }

  const bb = backing.bb;

  const M = 3;
  const minX = Math.max(0, bb.minX - M);
  const minY = Math.max(0, bb.minY - M);
  const maxX = Math.min(mw - 1, bb.maxX + M);
  const maxY = Math.min(mh - 1, bb.maxY + M);

  const sx = outW / Math.max(1, mw);
  const sy = outH / Math.max(1, mh);

  const cropW = Math.max(1, Math.round((maxX - minX + 1) * sx));
  const cropH = Math.max(1, Math.round((maxY - minY + 1) * sy));

  const outCanvas = createCanvas(cropW, cropH);
  const octx = outCanvas.getContext("2d");

  const offX = -minX * sx;
  const offY = -minY * sy;

  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = "high";
  octx.clearRect(0, 0, cropW, cropH);

  if (bg.hasFill) {
    // 1) mask -> 2) fill background INSIDE mask -> 3) draw image -> 4) clip to mask
    octx.globalCompositeOperation = "source-over";
    octx.drawImage(backing.alphaCanvas, 0, 0, mw, mh, offX, offY, outW, outH);

    octx.globalCompositeOperation = "source-in";
    octx.fillStyle = bg.raw;
    octx.fillRect(0, 0, cropW, cropH);

    octx.globalCompositeOperation = "source-over";
    octx.drawImage(master.masterCanvas, 0, 0, master.masterW, master.masterH, offX, offY, outW, outH);

    octx.globalCompositeOperation = "destination-in";
    octx.drawImage(backing.alphaCanvas, 0, 0, mw, mh, offX, offY, outW, outH);
  } else {
    // ✅ transparent export/preview: draw image first, then clip => prevents black backing
    octx.globalCompositeOperation = "source-over";
    octx.drawImage(master.masterCanvas, 0, 0, master.masterW, master.masterH, offX, offY, outW, outH);

    octx.globalCompositeOperation = "destination-in";
    octx.drawImage(backing.alphaCanvas, 0, 0, mw, mh, offX, offY, outW, outH);
  }

  return outCanvas;
}

async function ensureDir(p) {
  try {
    await fs.mkdir(p, { recursive: true });
  } catch {}
}
function sha1(str) {
  return crypto.createHash("sha1").update(str).digest("hex");
}

function buildPreviewKey({ imageUrl, shape, widthCm, heightCm, bgMode, bgColor, borderMm, maxPx }) {
  return sha1(JSON.stringify({ v: 7, imageUrl, shape, widthCm, heightCm, bgMode, bgColor, borderMm, maxPx }));
}

function isAppProxyRequest(request) {
  const u = new URL(request.url);
  const hasShop = u.searchParams.has("shop");
  const hasHmac = u.searchParams.has("hmac") || u.searchParams.has("signature");
  return hasShop && hasHmac;
}

async function softAuth(request) {
  if (isAppProxyRequest(request)) {
    await authenticate.public.appProxy(request);
    return;
  }

  const auth = request.headers.get("authorization") || "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    await authenticate.admin(request);
    return;
  }

  // Dev/Local allow (kein Throw)
}

export async function action({ request }) {
  try {
    // Auth: fail-open (Preview darf UI nicht killen)
    try {
      await softAuth(request);
    } catch (e) {
      console.error("[PREVIEW AUTH ERROR]", e);
      return json({ ok: true, previewUrl: "", skipped: true, error: "Unauthorized" }, { status: 200 });
    }

    if (request.method !== "POST") {
      return json({ ok: false, error: "Use POST" }, { status: 405 });
    }

    const body = await request.json().catch(() => ({}));

    const imageUrlRaw = String(body?.imageUrl || "");
    const shape = String(body?.shape || "freeform").toLowerCase();
    if (!imageUrlRaw) {
      return json({ ok: true, previewUrl: "", skipped: true, error: "imageUrl fehlt" }, { status: 200 });
    }

    if (shape !== "freeform") {
      return json({ ok: true, previewUrl: "", skipped: true }, { status: 200 });
    }

    const bgMode = String(body?.bgMode || "color");
    const bgColor = String(body?.bgColor || "#ffffff");
    const borderMm = clampNum(body?.freeformBorderMm ?? body?.borderMm ?? 3, 0, 10);
    const widthCm = clampNum(body?.widthCm ?? body?.baseWcm ?? 4, 1, 300);
    const heightCm = clampNum(body?.heightCm ?? body?.baseHcm ?? 4, 1, 300);
    const maxPx = clampNum(body?.maxPx ?? body?.outMaxSide ?? DEFAULT_MAX_PX, 600, 2000);

    const baseUrlStr = baseFromRequest(request);
    const resolvedImageUrl = resolveImageUrl(imageUrlRaw, baseUrlStr);

    const key = buildPreviewKey({
      imageUrl: resolvedImageUrl,
      shape,
      widthCm,
      heightCm,
      bgMode,
      bgColor,
      borderMm,
      maxPx,
    });

    const filename = `${key}.png`;
    await ensureDir(PREVIEW_DIR);
    const diskPath = path.join(PREVIEW_DIR, filename);

    // Disk cache hit
    try {
      await fs.access(diskPath);
      const previewUrl = `/apps/sticker-configurator/uploads/sticker-configurator/previews/${filename}`;
      return json({ ok: true, previewUrl, widthCm, heightCm }, { headers: { "Cache-Control": "private, max-age=60" } });
    } catch {}

    const master = await getMasterForImageUrl(resolvedImageUrl, request);

    const rawW = Math.max(1, Math.round(widthCm * PX_PER_CM));
    const rawH = Math.max(1, Math.round(heightCm * PX_PER_CM));
    const maxSide = Math.max(rawW, rawH);
    const kk = maxSide > maxPx ? maxPx / maxSide : 1;

    const outW = Math.max(1, Math.round(rawW * kk));
    const outH = Math.max(1, Math.round(rawH * kk));
    const borderPx = Math.max(1, Math.round(mmToPx(borderMm) * kk));

    const outCanvas = renderFreeformPreview({ master, outW, outH, bgMode, bgColor, borderPx });
    const png = outCanvas.toBuffer("image/png");

    const tmp = `${diskPath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, png);
    await fs.rename(tmp, diskPath).catch(async () => {
      await fs.unlink(tmp).catch(() => {});
    });

    const previewUrl = `/apps/sticker-configurator/uploads/sticker-configurator/previews/${filename}`;
    return json({ ok: true, previewUrl, width: outCanvas.width, height: outCanvas.height }, { headers: { "Cache-Control": "private, max-age=60" } });
  } catch (e) {
    console.error("[PREVIEW ACTION ERROR]", e);
    // FAIL-OPEN: Frontend soll dann auf Client-Preview zurückfallen
    return json({ ok: true, previewUrl: "", skipped: true, error: e?.message || String(e) }, { status: 200 });
  }
}
