import { json } from "@remix-run/node";

export async function loader() {
  return json({
    ok: true,
    route: "/apps/sticker-configurator",
    ts: Date.now(),
  });
}

// ✅ Optional: Preflight/CORS (hilft bei Proxy/Dev, ist inhaltlich harmlos)
export async function options() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
    },
  });
}
