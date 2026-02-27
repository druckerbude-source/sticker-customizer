// handle re-exportieren damit shopify-app-remix die Route als App-Proxy erkennt (kein CSRF-Check)
export { action, loader, handle } from "./apps.sticker-configurator.sticker.export";