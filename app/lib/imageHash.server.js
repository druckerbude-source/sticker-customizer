import crypto from "crypto";

export function hashBuffer(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}
