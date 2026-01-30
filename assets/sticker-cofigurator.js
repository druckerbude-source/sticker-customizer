import React from "react";
import { createRoot } from "react-dom/client";

// Wichtig: Pfad anpassen, je nachdem wo StickerCanvasClient in deinem Build landet
import StickerCanvasClient from "./StickerCanvasClient";

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function mountOne(wrap) {
  if (!wrap) return;

  // verhindert Doppel-Mount (z.B. bei Theme-Cache / mehrfach geladenen Scripts)
  if (wrap.dataset && wrap.dataset.__stickerMounted === "1") return;
  if (wrap.dataset) wrap.dataset.__stickerMounted = "1";

  // In deinem Theme-App-Block ist das echte React-Mount-Target dieses Element:
  // <div class="sticker-embed-react-root"></div>
  const mountEl = wrap.querySelector?.(".sticker-embed-react-root") || wrap;

  const ds = wrap.dataset || {};
  const {
    productId,
    pricingVariantId,
    defaultShape,
    defaultWidth,
    defaultHeight,
    defaultBg,
    defaultImageUrl,
    apiBase,
  } = ds;

  // ✅ API Base für api() Resolver verfügbar machen (optional)
  if (apiBase && typeof window !== "undefined") {
    window.__STICKER_API_BASE__ = String(apiBase).replace(/\/$/, "");
  }

  const parsedProductId = toNum(productId);
  const parsedPricingVariantId = toNum(pricingVariantId);

  const parsedWidth =
    defaultWidth && !Number.isNaN(Number(defaultWidth)) ? Number(defaultWidth) : undefined;

  const parsedHeight =
    defaultHeight && !Number.isNaN(Number(defaultHeight)) ? Number(defaultHeight) : undefined;

  const root = createRoot(mountEl);
  root.render(
    <StickerCanvasClient
      productId={parsedProductId}
      pricingVariantId={parsedPricingVariantId}
      defaultShape={defaultShape || "freeform"}
      defaultWidthCm={parsedWidth ?? 10}
      defaultHeightCm={parsedHeight ?? 10}
      defaultBgColor={defaultBg || "#ffffff"}
      defaultImageUrl={defaultImageUrl || ""}
    />
  );
}

function mountStickerConfigurator() {
  // ✅ NEU: Theme-App-Block Wrapper (dein tatsächlicher Root im DOM)
  const wraps = document.querySelectorAll(".sticker-embed-root");
  if (wraps && wraps.length) {
    wraps.forEach(mountOne);
    return;
  }

  // ✅ Fallback: Legacy Root-ID (falls du irgendwann wieder ein ID-Root nutzt)
  const legacy = document.getElementById("sticker-configurator-root");
  if (legacy) mountOne(legacy);
}

document.addEventListener("DOMContentLoaded", mountStickerConfigurator);
