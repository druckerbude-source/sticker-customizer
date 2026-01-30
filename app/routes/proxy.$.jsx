import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export async function loader({ request, params }) {
  const u = new URL(request.url);
  const hasProxySig = u.searchParams.has("hmac") || u.searchParams.has("signature");
  if (hasProxySig) await authenticate.public.appProxy(request);

  return json({ ok: true, hit: "proxy.$", splat: params["*"] || "", validated: hasProxySig });
}
export const action = loader;
