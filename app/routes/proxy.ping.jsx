import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export async function loader({ request }) {
  const u = new URL(request.url);
  const hasProxySig = u.searchParams.has("hmac") || u.searchParams.has("signature");

  // Nur validieren, wenn es wirklich ein Shopify-App-Proxy-Request ist
  if (hasProxySig) {
    await authenticate.public.appProxy(request);
  }

  return json({
    ok: true,
    route: "proxy.ping",
    validated: hasProxySig,
  });
}

export const action = loader;
