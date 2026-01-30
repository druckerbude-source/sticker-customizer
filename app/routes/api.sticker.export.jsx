import { json } from "@remix-run/node";
import fs from "fs/promises";
import path from "path";

export async function action({ request }) {
  const { imageUrl, shape, widthCm, heightCm, bgColor, freeformPath } =
    await request.json();

  const w = Number(widthCm) || 10;
  const h = Number(heightCm) || 10;

  let maskElement = `<rect x="0" y="0" width="${w}" height="${h}" />`;

  if (shape === "square") {
    const side = Math.min(w, h);
    maskElement = `<rect x="0" y="0" width="${side}" height="${side}" />`;
  } else if (shape === "circle") {
    const r = Math.min(w, h) / 2;
    maskElement = `<circle cx="${w / 2}" cy="${h / 2}" r="${r}" />`;
  } else if (shape === "oval") {
    maskElement = `<ellipse cx="${w / 2}" cy="${h / 2}" rx="${w / 2}" ry="${
      h / 2
    }" />`;
  } else if (shape === "rounded") {
    maskElement = `<rect x="0" y="0" width="${w}" height="${h}" rx="${
      Math.min(w, h) * 0.2
    }" ry="${Math.min(w, h) * 0.2}" />`;
  } else if (shape === "freeform" && freeformPath) {
    maskElement = `<path d="${freeformPath}" />`;
  }

  const svg = `
<svg width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <clipPath id="shapeClip">
      ${maskElement}
    </clipPath>
  </defs>
  <rect width="100%" height="100%" fill="${bgColor}" clip-path="url(#shapeClip)" />
  <image href="${imageUrl}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice" clip-path="url(#shapeClip)" />
</svg>`;

  const exportDir = path.join(process.cwd(), "public", "exports");
  await fs.mkdir(exportDir, { recursive: true });

  const baseName = `sticker-${Date.now()}`;
  const svgPath = path.join(exportDir, `${baseName}.svg`);
  await fs.writeFile(svgPath, svg, "utf8");

  // einfacher PDF-Wrapper (SVG als Inhalt); sauberer Vektor-PDF braucht Lib,
  // das können wir bei Bedarf nachziehen
  const pdfPath = path.join(exportDir, `${baseName}.pdf`);
  await fs.writeFile(pdfPath, svg, "utf8"); // Platzhalter

  return json({
    svgUrl: `/exports/${baseName}.svg`,
    pdfUrl: `/exports/${baseName}.pdf`,
  });
}
