import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";

const MIN_M2 = 0.1;
const PRICE_PER_M2 = 250;

// Preislogik:
// - Fläche wird in 0.1 m²-Schritten abgerechnet (MIN_M2)
// - quantity = abgerechnete Schritte (Multiplier)
// - area = abgerechnete Fläche (Steps * MIN_M2)
function calcPrice(widthCm, heightCm) {
  const w = Number(widthCm) || 0;
  const h = Number(heightCm) || 0;

  const rawArea = Math.max(0, (w / 100) * (h / 100)); // m² (echte Fläche)
  const billedSteps = Math.max(1, Math.ceil(rawArea / MIN_M2)); // 0.1m² Schritte
  const billedArea = billedSteps * MIN_M2; // abgerechnete Fläche (gerundet)
  const price = billedArea * PRICE_PER_M2;

  return {
    rawArea,
    area: billedArea,
    quantity: billedSteps,
    price,
  };
}

function isAppProxyRequest(request) {
  const u = new URL(request.url);
  return u.searchParams.has("shop") && (u.searchParams.has("hmac") || u.searchParams.has("signature"));
}

async function softAuth(request) {
  if (isAppProxyRequest(request)) {
    await authenticate.public.appProxy(request);
    return;
  }
  const auth = request.headers.get("authorization") || "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    await authenticate.admin(request);
  }
}

export async function loader() {
  return json({ error: "Method not allowed" }, { status: 405 });
}

export async function action({ request }) {
  try {
    await softAuth(request);
  } catch (e) {
    console.error("[PRICE AUTH ERROR]", e);
    // fail-open: Preisberechnung ist unkritisch – nicht das UI killen
  }

  try {
    if (request.method !== "POST") {
      return json({ ok: false, error: "Method not allowed" }, { status: 405 });
    }

    const contentType = request.headers.get("content-type") || "";

    let widthCmRaw;
    let heightCmRaw;

    if (contentType.includes("application/json")) {
      const body = await request.json();
      widthCmRaw = body.widthCm ?? body.width ?? body.w;
      heightCmRaw = body.heightCm ?? body.height ?? body.h;
    } else if (
      contentType.includes("multipart/form-data") ||
      contentType.includes("application/x-www-form-urlencoded")
    ) {
      const formData = await request.formData();
      widthCmRaw = formData.get("widthCm");
      heightCmRaw = formData.get("heightCm");
    } else {
      return json(
        { ok: false, error: `Unsupported Content-Type: ${contentType}` },
        { status: 200 }
      );
    }

    if (widthCmRaw == null || heightCmRaw == null) {
      return json(
        {
          ok: false,
          error: "Missing widthCm/heightCm",
          got: { widthCm: widthCmRaw ?? null, heightCm: heightCmRaw ?? null },
        },
        { status: 200 }
      );
    }

    const widthCm = Number(widthCmRaw);
    const heightCm = Number(heightCmRaw);

    if (!Number.isFinite(widthCm) || !Number.isFinite(heightCm) || widthCm <= 0 || heightCm <= 0) {
      return json(
        { ok: false, error: "Invalid widthCm/heightCm", got: { widthCm, heightCm } },
        { status: 200 }
      );
    }

    const priceData = calcPrice(widthCm, heightCm);

    return json({
      ok: true,
      widthCm,
      heightCm,
      ...priceData, // rawArea, area, quantity, price
    });
  } catch (err) {
    console.error("[PRICE ACTION ERROR]", err);
    return json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Unknown error in price action",
      },
      { status: 200 }
    );
  }
}
