// app/routes/api.sticker.upload.jsx
import { json } from "@remix-run/node";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { authenticate } from "../shopify.server"; // ggf. Pfad anpassen: "~/shopify.server"

const UPLOAD_DIR = path.resolve(
  process.cwd(),
  "public",
  "uploads",
  "sticker-configurator",
  "originals"
);

function safeExt(filename = "") {
  const ext = filename.split(".").pop()?.toLowerCase() || "png";
  return ["png", "jpg", "jpeg", "webp"].includes(ext) ? ext : "png";
}

export const action = async ({ request }) => {
  // ✅ Admin-Auth (Bearer Session Token aus embedded App / authenticatedFetch)
  await authenticate.admin(request);

  const form = await request.formData();
  const file = form.get("file") || form.get("image");

  if (!file || typeof file === "string") {
    return json({ error: "No file field (expected file or image)" }, { status: 400 });
  }

  const buf = Buffer.from(await file.arrayBuffer());

  await fs.mkdir(UPLOAD_DIR, { recursive: true });

  const name = `${Date.now()}-${crypto.randomBytes(8).toString("hex")}.${safeExt(file.name)}`;
  const abs = path.join(UPLOAD_DIR, name);

  await fs.writeFile(abs, buf);

  // Same-Origin für embedded Admin (trycloudflare) -> schnell + stabil
  const url = `/uploads/sticker-configurator/originals/${name}`;

  return json({
    ok: true,
    url,
    name,
    bytes: buf.length,
  });
};
