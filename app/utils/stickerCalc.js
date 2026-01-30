// app/utils/stickerCalc.js

export const AREA_PER_UNIT = 0.125;   // 0,125 m² pro Einheit
export const WASTE_FACTOR = 0.10;     // 10 % Verschnitt
export const BASE_PRICE_PER_UNIT = 25; // € pro 0,125 m² (anpassen)

export function calculateStickerData({ widthCm, heightCm, shape }) {
  // Bounding-Box-Fläche
  const areaM2 = (widthCm / 100) * (heightCm / 100);

  // Form-Faktor
  let shapeFactor = 1;
  switch (shape) {
    case "circle":
    case "oval":
      shapeFactor = 0.85;
      break;
    case "rounded":
      shapeFactor = 0.9;
      break;
    case "rectangle":
    case "freeform":
    default:
      shapeFactor = 1;
      break;
  }

  const effectiveAreaM2 = areaM2 * shapeFactor;

  // Einheiten à 0,125 m²
  const units = Math.max(1, Math.ceil(effectiveAreaM2 / AREA_PER_UNIT));

  // Nutzbare Fläche mit Verschnitt
  const usableAreaM2 = units * AREA_PER_UNIT * (1 - WASTE_FACTOR);

  // Stückzahl, wie viele Sticker auf die nutzbare Fläche passen
  let quantity = 1;
  if (effectiveAreaM2 > 0) {
    quantity = Math.floor(usableAreaM2 / effectiveAreaM2);
    if (quantity < 1) quantity = 1;
  }

  // Preis
  const discountFactor = units >= 2 ? 0.97 : 1;
  const totalPriceRaw = units * BASE_PRICE_PER_UNIT * discountFactor;

  return {
    areaM2,
    effectiveAreaM2,
    usableAreaM2,
    units,
    quantity,
    totalPrice: Number(totalPriceRaw.toFixed(2)),
  };
}
