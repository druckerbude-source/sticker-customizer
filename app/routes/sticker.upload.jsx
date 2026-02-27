// app/routes/sticker.upload.jsx
// Wrapper route so the storefront can POST to /sticker/upload
// handle re-exportieren damit shopify-app-remix die Route als App-Proxy erkennt
export { loader, action, handle } from "./apps.sticker-configurator.sticker.upload.jsx";
