import fs from "fs/promises";
import path from "path";

const BASE = path.resolve("./public/sticker-previews");

async function ensureDir() {
  await fs.mkdir(BASE, { recursive: true });
}

export function previewKey({ imageHash, borderMm, bgColor, maxPx }) {
  return `${imageHash}_b${borderMm}_c${bgColor.replace("#","")}_m${maxPx}`;
}

export async function previewExists(key) {
  try {
    await fs.access(path.join(BASE, `${key}.png`));
    return true;
  } catch {
    return false;
  }
}

export async function previewUrl(key) {
  return `/sticker-previews/${key}.png`;
}

export async function savePreview(key, buffer) {
  await ensureDir();
  await fs.writeFile(path.join(BASE, `${key}.png`), buffer);
}
