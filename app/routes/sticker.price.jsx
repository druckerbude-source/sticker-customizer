// app/routes/sticker.price.jsx
import { json } from "@remix-run/node";
import { calcPrice } from "./apps.sticker-configurator.sticker.upload.jsx";

// POST /sticker/price
export async function action({ request }) {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  const body = await request.json().catch(() => ({}));
  const widthCm = body?.widthCm ?? body?.width;
  const heightCm = body?.heightCm ?? body?.height;

  const { area, price } = calcPrice(widthCm, heightCm, 1);
  return json({ area, quantity: 1, price });
}

// Optional GET for quick checks in browser
export async function loader() {
  return json({ ok: true, route: "/sticker/price" });
}
