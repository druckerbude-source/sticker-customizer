// app/routes/api.sticker.price.jsx
import { json } from "@remix-run/node";

const MIN_M2 = 0.1;
const PRICE_PER_M2 = 250;

// Debug-Loader, damit GET im Browser nicht crasht
export async function loader() {
  return json({ ok: true, route: "/api/sticker/price" });
}

export async function action({ request }) {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  const { widthCm, heightCm } = await request.json();

  const w = Number(widthCm) || 0;
  const h = Number(heightCm) || 0;

  const area = (w / 100) * (h / 100); // m²
  const billedArea = Math.max(area, MIN_M2);
  const quantity = Math.ceil(billedArea / MIN_M2);
  const price = billedArea * PRICE_PER_M2;

  return json({
    area: billedArea,
    quantity,
    price,
  });
}
