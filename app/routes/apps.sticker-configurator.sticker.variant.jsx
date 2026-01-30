// app/routes/apps.sticker-configurator.sticker.variant.jsx
// Returns variant price/title for a given variantId.
// Purpose: price lookup inside Shopify Admin iframe where /products/<handle>.js and /variants/<id>.js can be blocked by CORS.

import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export async function loader({ request }) {
  const url = new URL(request.url);
  const variantIdRaw = url.searchParams.get("variantId") || "";
  const variantId = Number(variantIdRaw) || 0;

  if (!variantId) {
    return json({ ok: false, error: "variantId missing" }, { status: 400 });
  }

  // ✅ Embedded Admin ODER Storefront App Proxy
  let admin = null;
  let isAppProxyRequest = false;

  try {
    const hasShop = url.searchParams.has("shop");
    const hasHmac = url.searchParams.has("hmac") || url.searchParams.has("signature");
    isAppProxyRequest = hasShop && hasHmac;

    if (isAppProxyRequest) {
      // App Proxy request: validate signature
      await authenticate.public.appProxy(request);
      // NOTE: In App Proxy context we typically don't have an admin client here.
      // If you need this endpoint on storefront too, implement a Storefront API lookup.
    } else {
      // Embedded Admin: validate session
      ({ admin } = await authenticate.admin(request));
    }
  } catch (e) {
    console.error("[VARIANT LOOKUP AUTH ERROR]", e);
    return json(
      {
        ok: false,
        error: isAppProxyRequest
          ? "Unauthorized (app proxy validation failed)"
          : "Unauthorized (admin session token validation failed)",
      },
      { status: 401 }
    );
  }

  if (!admin) {
    // App Proxy requests would land here.
    return json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const gid = `gid://shopify/ProductVariant/${variantId}`;

    const query = `#graphql\n      query VariantPrice($id: ID!) {\n        node(id: $id) {\n          ... on ProductVariant {\n            id\n            title\n            price\n          }\n        }\n      }\n    `;

    const resp = await admin.graphql(query, { variables: { id: gid } });
    const data = await resp.json();

    const v = data?.data?.node;
    if (!v) {
      return json({ ok: false, error: "Variant not found" }, { status: 404 });
    }

    // Admin API returns price as string in shop currency.
    return json({
      ok: true,
      variantId,
      title: String(v.title || ""),
      price: String(v.price || ""),
    });
  } catch (e) {
    console.error("[VARIANT LOOKUP ERROR]", e);
    return json({ ok: false, error: e?.message || "unknown error" }, { status: 500 });
  }
}
