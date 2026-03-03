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
     * React mounten – mit Retry falls Bundle noch lädt
     * ------------------------------------------------- */
    function mountReact(attempt) {
      if (reactRoot.dataset.mounted === "1") return;
      if (window.renderStickerConfigurator) {
        window.renderStickerConfigurator(reactRoot, {
          productId,
          initialVariantId,
          pricingVariantId,
          apiBase,
          shapeHandles,
        });
        reactRoot.dataset.mounted = "1";
      } else if (attempt < 30) {
        // sticker-configurator.js noch nicht fertig (max ~4.5s warten)
        setTimeout(function () { mountReact(attempt + 1); }, 150);
      } else {
        console.warn("[sticker-embed] renderStickerConfigurator nicht gefunden – Bundle-Fehler?");
      }
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
      document.body.classList.add("sc-lock");

      // React mounten (mit Retry für langsame Bundle-Loads)
      mountReact(0);

      // Event für Theme-Fullscreen
      emit("sc:sticker-embed-open", { root, modal, backdrop, reactRoot });

      // Guard wieder lösen
      setTimeout(function () {
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
      document.body.classList.remove("sc-lock");

      emit("sc:sticker-embed-close", { root, modal, backdrop, reactRoot });

      setTimeout(function () {
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

    // React fires this event after successful cart add (before optional redirect).
    // Close the modal so the customer sees the updated cart icon / page state.
    window.addEventListener("sc:sticker-added-to-cart", closeModal);
  });
}

// Shopify / Theme Events
// readyState-Check: falls DOMContentLoaded schon gefeuert hat (z.B. dynamisch geladenes Script)
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initStickerEmbed);
} else {
  initStickerEmbed();
}
// Section-Reloads (Shopify Theme Editor)
document.addEventListener("shopify:section:load", initStickerEmbed);
