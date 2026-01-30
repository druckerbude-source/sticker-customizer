// app/routes/apps.sticker-configurator.sticker.staged-target.jsx
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server"; // ggf. Pfad anpassen

const MUTATION = `#graphql
mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
  stagedUploadsCreate(input: $input) {
    stagedTargets {
      url
      resourceUrl
      parameters { name value }
    }
    userErrors { field message }
  }
}
`;

function pickFirst(arr) {
  return Array.isArray(arr) && arr.length ? arr[0] : null;
}

export async function action({ request }) {
  try {
    if (request.method !== "POST") {
      return json({ ok: false, error: "Method not allowed" }, { status: 405 });
    }

    const { admin } = await authenticate.admin(request);

    const body = await request.json().catch(() => ({}));
    const filename = String(body?.filename || "").trim() || "upload.png";
    const mimeType = String(body?.mimeType || "image/png").trim();
    const fileSize = Number(body?.fileSize || 0);

    if (!fileSize || !Number.isFinite(fileSize) || fileSize <= 0) {
      return json({ ok: false, error: "fileSize fehlt/ungültig" }, { status: 400 });
    }

    const MAX_BYTES = 25 * 1024 * 1024; // 25 MB
    if (fileSize > MAX_BYTES) {
      return json(
        { ok: false, error: `Datei zu groß (${Math.round(fileSize / 1024 / 1024)} MB). Max 25 MB.` },
        { status: 413 }
      );
    }

    const variables = {
      input: [
        {
          filename,
          mimeType,
          resource: "IMAGE", // ✅ statt FILE
          fileSize: String(fileSize),
          httpMethod: "POST",
        },
      ],
    };

    const resp = await admin.graphql(MUTATION, { variables });
    const payload = await resp.json();

    // Top-Level errors (z.B. Access denied)
    if (Array.isArray(payload?.errors) && payload.errors.length) {
      const msg =
        payload.errors.map((e) => e?.message).filter(Boolean).join(" | ") || "GraphQL error";

      const status = /access denied/i.test(msg) ? 403 : 500;

      return json(
        {
          ok: false,
          error: msg,
          hint: /access denied/i.test(msg)
            ? "Deiner App fehlt sehr wahrscheinlich der Scope write_files (und ggf. read_files). Scopes ergänzen und App neu installieren."
            : undefined,
        },
        { status }
      );
    }

    const out = payload?.data?.stagedUploadsCreate;
    const userErr = pickFirst(out?.userErrors);
    if (userErr) {
      return json(
        { ok: false, error: userErr.message || "stagedUploadsCreate userError", field: userErr.field || null },
        { status: 400 }
      );
    }

    const target = pickFirst(out?.stagedTargets);
    if (!target?.url || !target?.resourceUrl || !Array.isArray(target?.parameters)) {
      return json({ ok: false, error: "stagedUploadsCreate: keine gültigen stagedTargets erhalten" }, { status: 500 });
    }

    return json({ ok: true, target });
  } catch (e) {
    return json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

export async function loader() {
  return json({ ok: false, error: "Use POST" }, { status: 405 });
}
