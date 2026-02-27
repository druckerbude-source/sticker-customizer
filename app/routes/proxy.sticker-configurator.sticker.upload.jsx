// handle muss explizit re-exportiert werden, damit shopify-app-remix
// die Route als App-Proxy-Route erkennt (kein CSRF-Check, HMAC-Verifikation)
export { loader, action, handle } from "./apps.sticker-configurator.sticker.upload.jsx";
