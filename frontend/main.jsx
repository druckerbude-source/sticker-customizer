// frontend/main.jsx
import React from "react";
import { createRoot } from "react-dom/client";
import StickerCanvasClient from "./StickerCanvasClient";

function normalizeArgs(arg) {
  // Legacy: (el, productId)
  if (typeof arg === "number" || typeof arg === "string") {
    return { productId: Number(arg) || 0 };
  }
  // New: (el, { productId, initialVariantId, pricingVariantId, apiBase, shapeHandles })
  if (arg && typeof arg === "object") {
    return {
      productId: Number(arg.productId) || 0,
      initialVariantId: Number(arg.initialVariantId) || 0,
      pricingVariantId: Number(arg.pricingVariantId) || 0,
      apiBase: typeof arg.apiBase === "string" && arg.apiBase ? arg.apiBase : undefined,
      shapeHandles: arg.shapeHandles && typeof arg.shapeHandles === "object" ? arg.shapeHandles : undefined,
    };
  }
  return { productId: 0 };
}

function stableKey(props) {
  // Only include fields that should trigger a rerender.
  // (Do NOT include unstable objects unless stringified.)
  return JSON.stringify({
    productId: props.productId || 0,
    initialVariantId: props.initialVariantId || 0,
    pricingVariantId: props.pricingVariantId || 0,
    apiBase: props.apiBase || "",
    shapeHandles: props.shapeHandles || null,
  });
}

window.renderStickerConfigurator = (el, arg) => {
  if (!el) return;

  const props = normalizeArgs(arg);

  // Reuse a single React root per element.
  const existingRoot = el.__stickerRoot;
  const nextKey = stableKey(props);

  if (existingRoot) {
    // If called repeatedly with identical props, do nothing.
    if (el.__stickerPropsKey === nextKey) return;

    el.__stickerPropsKey = nextKey;
    existingRoot.render(<StickerCanvasClient {...props} />);
    return;
  }

  const root = createRoot(el);
  el.__stickerRoot = root;
  el.__stickerPropsKey = nextKey;
  root.render(<StickerCanvasClient {...props} />);
};
