import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server"; // ggf. Pfad anpassen

export async function action({ request }) {
  // App-Proxy Call (Storefront -> App)
  const { admin } = await authenticate.public.appProxy(request);

  const body = await request.json().catch(() => ({}));
  const productId = Number(body?.productId);
  const pieces = Math.max(1, Number(body?.pieces) || 1);

  // ✅ Variante A: Gesamtpreis statt Unit-Preis
  // Erwartet: body.totalPrice (preferred) oder fallback: body.meta.priceTotal
  const totalPriceRaw =
    body?.totalPrice ?? body?.meta?.priceTotal ?? body?.priceTotal;
  const totalPrice = Number(totalPriceRaw);

  if (!productId || !Number.isFinite(totalPrice) || totalPrice < 0) {
    return json(
      { ok: false, error: "Ungültige Eingaben (productId/totalPrice)." },
      { status: 400 }
    );
  }

  // Shop-Währung holen (damit MoneyInput passt)
  const shopRes = await admin.graphql(`#graphql
    query {
      shop { currencyCode }
    }
  `);
  const shopJson = await shopRes.json();
  const currencyCode = shopJson?.data?.shop?.currencyCode || "EUR";

  const variantGid = `gid://shopify/ProductVariant/${productId}`;

  const mutation = `#graphql
    mutation DraftOrderCreate($input: DraftOrderInput!) {
      draftOrderCreate(input: $input) {
        draftOrder {
          id
          invoiceUrl
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  // ✅ Attributes: alles aus meta + pieces + totalPrice
  const meta = body?.meta || {};
  const customAttributesObj = {
    ...meta,
    pieces,
    priceTotal: Number(totalPrice.toFixed(2)),
  };

  const input = {
    lineItems: [
      {
        variantId: variantGid,
        quantity: 1, // ✅ wichtig: NICHT pieces, sonst wieder Multiplikation
        priceOverride: {
          amount: totalPrice.toFixed(2), // ✅ Gesamtpreis
          currencyCode,
        },
        customAttributes: Object.entries(customAttributesObj).map(([k, v]) => ({
          key: String(k),
          value: typeof v === "string" ? v : JSON.stringify(v),
        })),
      },
    ],
    note: "Sticker-Konfigurator",
  };

  const res = await admin.graphql(mutation, { variables: { input } });
  const data = await res.json();

  const errs = data?.data?.draftOrderCreate?.userErrors || [];
  if (errs.length) {
    return json(
      { ok: false, error: errs[0]?.message || "DraftOrder Fehler", errs },
      { status: 400 }
    );
  }

  const invoiceUrl = data?.data?.draftOrderCreate?.draftOrder?.invoiceUrl;
  return json({ ok: true, invoiceUrl });
}
