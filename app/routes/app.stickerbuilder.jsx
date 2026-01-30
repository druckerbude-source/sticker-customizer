// app/routes/app.stickerbuilder.jsx
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import StickerCanvasShell from "../components/StickerCanvasShell";

export async function loader({ request }) {
  await authenticate.admin(request);

  const url = new URL(request.url);
  const p = url.searchParams;

  return json({
    // ✅ wichtig: sorgt dafür, dass StickerCanvasClient.resolveApiBase() immer die richtige Base nimmt
    apiBase: "/apps/sticker-configurator",

    initialWidthCm: Number(p.get("width")) || 4,
    initialHeightCm: Number(p.get("height")) || 4,
    initialShape: p.get("shape") || "rectangle",
    imageUrl: p.get("imageUrl") || "",
    initialBackgroundColor: p.get("bg") || "#ffffff",
    initialBorderWidthMm: Number(p.get("borderWidth")) || 3,
    initialBorderEnabled: false,
  });
}

export default function Page() {
  const config = useLoaderData();

  return (
    <div id="sticker-configurator-root" data-api-base={config?.apiBase || "/apps/sticker-configurator"}>
      <StickerCanvasShell {...config} />
    </div>
  );
}
