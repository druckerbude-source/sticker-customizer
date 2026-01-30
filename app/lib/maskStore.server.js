import fs from "fs/promises";
import path from "path";

const BASE = path.resolve("./.cache/masks");

async function ensureDir() {
  await fs.mkdir(BASE, { recursive: true });
}

export async function loadMask(imageHash) {
  try {
    const p = path.join(BASE, `${imageHash}.json`);
    const raw = await fs.readFile(p, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function saveMask(imageHash, payload) {
  await ensureDir();
  const p = path.join(BASE, `${imageHash}.json`);
  await fs.writeFile(p, JSON.stringify(payload));
}
