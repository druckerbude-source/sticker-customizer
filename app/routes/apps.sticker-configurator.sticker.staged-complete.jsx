import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";

/**
 * apps.sticker-configurator.sticker.staged-complete.jsx
 *
 * Option B:
 * - 1) First call finalizes the staged upload via fileCreate and returns:
 *      { ok:true, url }  OR  { ok:true, processing:true, fileId }
 * - 2) Frontend can poll this same endpoint with { fileId } until { url } exists.
 *
 * Also supports storefront (App Proxy) auth when available, falls back to admin auth.
 */

async function getAdminClient(request) {
  // ✅ Storefront/App-Proxy (wenn in deinem shopify.server verfügbar)
  try {
    if (authenticate?.public?.appProxy) {
      const { admin } = await authenticate.public.appProxy(request);
      return admin;
    }
  } catch {
    // ignore → fallback
  }

  // ✅ Embedded Admin / normal admin auth
  const { admin } = await authenticate.admin(request);
  return admin;
}

const FILE_CREATE_MUTATION = `#graphql
  mutation FileCreate($files: [FileCreateInput!]!) {
    fileCreate(files: $files) {
      files {
        id
        fileStatus
        ... on MediaImage {
          image { url }
        }
        ... on GenericFile {
          url
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const FILE_NODE_QUERY = `#graphql
  query FileNode($id: ID!) {
    node(id: $id) {
      ... on MediaImage {
        id
        fileStatus
        image { url }
      }
      ... on GenericFile {
        id
        fileStatus
        url
      }
    }
  }
`;

function pickFileUrl(fileLike) {
  return (
    fileLike?.url ||
    fileLike?.image?.url ||
    fileLike?.preview?.image?.url ||
    ""
  );
}

async function fetchFileUrlById(admin, fileId) {
  const r = await admin.graphql(FILE_NODE_QUERY, { variables: { id: fileId } });
  const j = await r.json();

  const node = j?.data?.node;
  const url = pickFileUrl(node);
  const fileStatus = node?.fileStatus;

  return { url, fileStatus };
}

export async function action({ request }) {
  try {
    const admin = await getAdminClient(request);
    const body = await request.json().catch(() => ({}));

    const fileId = body?.fileId ? String(body.fileId) : "";
    const resourceUrl = body?.resourceUrl ? String(body.resourceUrl) : "";
    const filename = body?.filename ? String(body.filename) : "upload";
    const alt = body?.alt ? String(body.alt) : "Sticker upload";

    // ============================================================
    // ✅ POLL-MODE: { fileId } -> URL sobald verfügbar
    // ============================================================
    if (fileId && !resourceUrl) {
      const { url, fileStatus } = await fetchFileUrlById(admin, fileId).catch(
        () => ({ url: "", fileStatus: "PROCESSING" })
      );

      if (url) {
        return json({ ok: true, url, fileId });
      }

      return json({
        ok: true,
        processing: true,
        fileId,
        fileStatus: fileStatus || "PROCESSING",
      });
    }

    // ============================================================
    // ✅ FINALIZE-MODE: { resourceUrl, filename, alt }
    // ============================================================
    if (!resourceUrl) {
      return json({ ok: false, error: "resourceUrl fehlt." }, { status: 400 });
    }

    const gqlRes = await admin.graphql(FILE_CREATE_MUTATION, {
      variables: {
        files: [
          {
            originalSource: resourceUrl,
            contentType: "IMAGE",
            filename,
            alt,
          },
        ],
      },
    });

    const gqlJson = await gqlRes.json().catch(() => null);

    const userErrors = gqlJson?.data?.fileCreate?.userErrors || [];
    if (userErrors.length) {
      return json(
        { ok: false, error: userErrors[0]?.message || "fileCreate userError" },
        { status: 400 }
      );
    }

    const file = gqlJson?.data?.fileCreate?.files?.[0];
    const createdId = file?.id ? String(file.id) : "";
    const directUrl = pickFileUrl(file);

    // ✅ Wenn sofort verfügbar → zurückgeben
    if (directUrl) {
      return json({ ok: true, url: directUrl, fileId: createdId || null });
    }

    // ✅ Wenn nicht verfügbar → einmal direkt nachschauen (sehr kurz), sonst processing zurückgeben
    if (createdId) {
      const checked = await fetchFileUrlById(admin, createdId).catch(() => null);
      if (checked?.url) {
        return json({ ok: true, url: checked.url, fileId: createdId });
      }
      return json({
        ok: true,
        processing: true,
        fileId: createdId,
        fileStatus: checked?.fileStatus || file?.fileStatus || "PROCESSING",
      });
    }

    return json(
      {
        ok: false,
        error: "fileCreate: keine fileId erhalten (unerwartet).",
      },
      { status: 500 }
    );
  } catch (err) {
    return json(
      { ok: false, error: err?.message || String(err) },
      { status: 500 }
    );
  }
}
