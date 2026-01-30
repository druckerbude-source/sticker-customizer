// app/routes/app.stickerbuilder.price.jsx
import { json } from "@remix-run/node";

const MIN_M2 = 0.1;
const PRICE_PER_M2 = 250;

function calcPrice(widthCm, heightCm, quantity = 1) {
  const w = Number(widthCm) || 0;
  const h = Number(heightCm) || 0;

  const area = (w / 100) * (h / 100); // m²
  const billedArea = Math.max(area, MIN_M2);
  const billedQuantity = Math.ceil(billedArea / MIN_M2);
  const effectiveQty = quantity || billedQuantity;
  const price = billedArea * PRICE_PER_M2;

  return {
    area: billedArea,
    quantity: effectiveQty,
    price,
  };
}

export async function loader() {
  return json({ error: "Method not allowed" }, { status: 405 });
}

export async function action({ request }) {
  try {
    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, { status: 405 });
    }

    const contentType = request.headers.get("content-type") || "";

    let widthCmRaw;
    let heightCmRaw;
    let quantityRaw;

    if (contentType.includes("application/json")) {
      const body = await request.json();
      widthCmRaw = body.widthCm ?? body.width;
      heightCmRaw = body.heightCm ?? body.height;
      quantityRaw = body.quantity ?? body.qty;
    } else {
      const formData = await request.formData();
      widthCmRaw = formData.get("widthCm");
      heightCmRaw = formData.get("heightCm");
      quantityRaw = formData.get("quantity");
    }

    const widthCm = widthCmRaw ? Number(widthCmRaw) : 10;
    const heightCm = heightCmRaw ? Number(heightCmRaw) : 10;
    const quantity = quantityRaw ? Number(quantityRaw) : 1;

    const priceData = calcPrice(widthCm, heightCm, quantity);

    return json({
      ok: true,
      widthCm,
      heightCm,
      ...priceData, // area, quantity, price
    });
  } catch (err) {
    console.error("[ADMIN PRICE ERROR]", err);
    return json(
      {
        ok: false,
        error:
          err instanceof Error ? err.message : "Unknown error in admin price",
      },
      { status: 200 }
    );
  }
}
