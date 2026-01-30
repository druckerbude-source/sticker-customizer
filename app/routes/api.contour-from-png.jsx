// app/routes/api.contour-from-png.jsx
import sharp from "sharp";
import * as ClipperLib from "clipper-lib";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";

// Druck-Annahme
const DPI = 300;
const MM_PER_INCH = 25.4;
const PX_PER_MM = DPI / MM_PER_INCH; // ~11,81 px/mm
const OFFSET_MM = 2;
const OFFSET_PX = OFFSET_MM * PX_PER_MM;

const DOUGLAS_TOLERANCE_PX = 1.5;

/**
 * Douglas–Peucker-Vereinfachung für ein Polygon
 * points: [ [x,y], [x,y], ... ]
 */
function simplifyDouglasPeucker(points, tolerance) {
  if (!points || points.length <= 2) return points || [];

  const sqTolerance = tolerance * tolerance;

  function getSqDist(p1, p2) {
    const dx = p1[0] - p2[0];
    const dy = p1[1] - p2[1];
    return dx * dx + dy * dy;
  }

  function getSqSegDist(p, p1, p2) {
    let x = p1[0];
    let y = p1[1];

    let dx = p2[0] - x;
    let dy = p2[1] - y;

    if (dx !== 0 || dy !== 0) {
      const t =
        ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);

      if (t > 1) {
        x = p2[0];
        y = p2[1];
      } else if (t > 0) {
        x += dx * t;
        y += dy * t;
      }
    }

    dx = p[0] - x;
    dy = p[1] - y;

    return dx * dx + dy * dy;
  }

  function simplifyDP(points, first, last, simplified) {
    let maxSqDist = sqTolerance;
    let index = -1;

    for (let i = first + 1; i < last; i++) {
      const sqDist = getSqSegDist(points[i], points[first], points[last]);
      if (sqDist > maxSqDist) {
        index = i;
        maxSqDist = sqDist;
      }
    }

    if (index !== -1) {
      if (index - first > 1) simplifyDP(points, first, index, simplified);
      simplified.push(points[index]);
      if (last - index > 1) simplifyDP(points, index, last, simplified);
    }
  }

  const simplified = [points[0]];
  simplifyDP(points, 0, points.length - 1, simplified);
  simplified.push(points[points.length - 1]);
  return simplified;
}

/**
 * Sehr einfache „Kontur“: wir nehmen erstmal das Bounding-Rect des Motives.
 * Das ist NICHT schön, aber: code ist funktionsfähig,
 * Integration mit deinem Canvas funktioniert damit sofort.
 *
 * Später kannst du hier Marching-Squares / image-js etc. einsetzen,
 * ohne den Rest ändern zu müssen.
 */
function extractLargestContourBoundingBox(mask, width, height) {
  let minX = width,
    maxX = -1,
    minY = height,
    maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = mask[y * width + x];
      if (v === 1) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < minX || maxY < minY) {
    return [];
  }

  // einfache Rechteckkontur
  return [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
  ];
}

/**
 * Offset eines Polygons nach außen mit clipper-lib
 * points: [ [x,y], ... ], offsetPx: Abstand in Pixel
 */
function offsetPolygon(points, offsetPx) {
  if (!points || points.length === 0) return [];

  const SCALE = 100;
  const subj = points.map(([x, y]) => ({
    X: Math.round(x * SCALE),
    Y: Math.round(y * SCALE),
  }));

  const co = new ClipperLib.ClipperOffset();
  co.AddPath(
    subj,
    ClipperLib.JoinType.jtRound,
    ClipperLib.EndType.etClosedPolygon
  );

  const solution = [];
  co.Execute(solution, offsetPx * SCALE); // positiv = nach außen

  if (!solution.length) return [];
  const poly = solution[0];

  return poly.map((p) => [p.X / SCALE, p.Y / SCALE]);
}

function polygonToSvgPath(points) {
  if (!points || !points.length) return "";
  const [x0, y0] = points[0];
  let d = `M ${x0} ${y0}`;
  for (let i = 1; i < points.length; i++) {
    const [x, y] = points[i];
    d += ` L ${x} ${y}`;
  }
  d += " Z";
  return d;
}

export const action = async ({ request }) => {
  await authenticate.admin(request);

  const body = await request.json();
  const filePath = body?.filePath;

  if (!filePath) {
    return json(
      { error: "filePath ist erforderlich" },
      { status: 400 }
    );
  }

  // Bild laden
  const image = sharp(filePath);
  const metadata = await image.metadata();
  const width = metadata.width;
  const height = metadata.height;

  if (!width || !height) {
    return json(
      { error: "Bildbreite/-höhe konnte nicht ermittelt werden" },
      { status: 400 }
    );
  }

  // RGBA-Rohdaten holen
  const raw = await image.ensureAlpha().raw().toBuffer(); // length = w*h*4

  // Alpha -> Binärmaske
  const alphaMask = new Uint8Array(width * height);
  const threshold = 128;

  for (let i = 0; i < width * height; i++) {
    const a = raw[i * 4 + 3]; // 4. Kanal = Alpha
    alphaMask[i] = a >= threshold ? 1 : 0;
  }

  // 1) Grobe Kontur (hier: Bounding-Box als einfacher Start)
  let baseContour = extractLargestContourBoundingBox(
    alphaMask,
    width,
    height
  );

  if (!baseContour.length) {
    return json(
      { error: "Keine konturierte Fläche im PNG gefunden" },
      { status: 400 }
    );
  }

  // 2) Vereinfachen (Douglas–Peucker) – für Rechteck bringt das nichts,
  //    aber später beim echten Kontur-Algorithmus schon.
  baseContour = simplifyDouglasPeucker(baseContour, DOUGLAS_TOLERANCE_PX);

  // 3) 2mm-Offset nach außen
  const offsetContour = offsetPolygon(baseContour, OFFSET_PX);

  const svgPathOffset2mm = polygonToSvgPath(offsetContour);

  return json({
    width,
    height,
    dpi: DPI,
    contour: {
      base: baseContour,
      offset2mm: offsetContour,
    },
    svgPathOffset2mm,
  });
};
