import { json } from "@remix-run/node";
// Wenn du ~/ nicht konfiguriert hast, passt "../components/..." bei dir:
import StickerCanvasClient from "../components/StickerCanvasClient";

// Wichtig: Markiert diese Route als App-Proxy-Route für den Shopify-Wrapper
export const handle = {
  isAppProxy: true,
};

export async function loader() {
  // Hier könntest du später noch Validierung / Parameter-Check machen
  return json({});
}

export default function ProxyStickerConfigurator() {
  return <StickerCanvasClient />;
}
