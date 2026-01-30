// extensions/sticker-embed/assets/sticker-embed.js

function initStickerEmbed() {
  document.querySelectorAll(".sticker-embed-root").forEach((root) => {
    if (root.dataset.bound === "1") return;
    root.dataset.bound = "1";

    // Dataset -> Props
    const productId = Number(root.dataset.productId);
    const initialVariantId = Number(root.dataset.initialVariantId || 0);
    const pricingVariantId = Number(root.dataset.pricingVariantId || 0);
    const apiBase = root.dataset.apiBase || "/apps/sticker-configurator";

    let shapeHandles = {};
    try {
      shapeHandles = JSON.parse(root.dataset.shapeHandles || "{}");
    } catch (err) {
      console.warn(
        "[sticker-embed] shapeHandles JSON ungültig:",
        root.dataset.shapeHandles,
        err
      );
      shapeHandles = {};
    }

    const button = root.querySelector(".sticker-embed-button");
    const modal = root.querySelector(".sticker-embed-modal");
    const backdrop = root.querySelector(".sticker-embed-backdrop");
    const closeBtn = root.querySelector(".sticker-embed-close");
    const reactRoot = root.querySelector(".sticker-embed-react-root");

    if (!button || !modal || !reactRoot || !productId) {
      console.warn("[sticker-embed] unvollständiges Markup/Produkt-ID", {
        button,
        modal,
        reactRoot,
        productId,
      });
      return;
    }

    function emit(name, detail) {
      try {
        window.dispatchEvent(new CustomEvent(name, { detail }));
      } catch (_) {}
    }

    /* -------------------------------------------------
     * OPEN (idempotent + reentrancy-safe)
     * ------------------------------------------------- */
    function openModal() {
      // ✅ bereits offen → nichts tun
      if (modal.classList.contains("sticker-embed-modal--open")) return;

      // ✅ Reentrancy-Guard (Theme / Section-Reloads)
      if (modal.dataset.opening === "1") return;
      modal.dataset.opening = "1";

      modal.classList.add("sticker-embed-modal--open");
      modal.setAttribute("aria-hidden", "false");

      // React-Konfigurator exakt einmal mounten
      if (window.renderStickerConfigurator && !reactRoot.dataset.mounted) {
        window.renderStickerConfigurator(reactRoot, {
          productId,
          initialVariantId,
          pricingVariantId,
          apiBase,
          shapeHandles,
        });
        reactRoot.dataset.mounted = "1";
      }

      // Event für Theme-Fullscreen
      emit("sc:sticker-embed-open", { root, modal, backdrop, reactRoot });

      // Guard wieder lösen
      setTimeout(() => {
        try {
          delete modal.dataset.opening;
        } catch (_) {}
      }, 0);
    }

    /* -------------------------------------------------
     * CLOSE (idempotent)
     * ------------------------------------------------- */
    function closeModal() {
      if (!modal.classList.contains("sticker-embed-modal--open")) return;
      if (modal.dataset.closing === "1") return;
      modal.dataset.closing = "1";

      modal.classList.remove("sticker-embed-modal--open");
      modal.setAttribute("aria-hidden", "true");

      emit("sc:sticker-embed-close", { root, modal, backdrop, reactRoot });

      setTimeout(() => {
        try {
          delete modal.dataset.closing;
        } catch (_) {}
      }, 0);
    }

    // Button nur einmal binden
    if (button.dataset.bound !== "1") {
      button.dataset.bound = "1";
      button.addEventListener("click", (e) => {
        e.preventDefault();
        openModal();
      });
    }

    backdrop?.addEventListener("click", closeModal);
    closeBtn?.addEventListener("click", closeModal);
  });
}

// Shopify / Theme Events
document.addEventListener("DOMContentLoaded", initStickerEmbed);
document.addEventListener("shopify:section:load", initStickerEmbed);
