/**
 * app/lib/shopifyFiles.server.js
 *
 * Uploads binary buffers to Shopify "Files" using the two-step process:
 *  1) stagedUploadsCreate -> get temporary upload target
 *  2) multipart upload to target.url
 *  3) fileCreate(originalSource = target.resourceUrl)
 *  4) poll fileStatus until READY and return a CDN URL
 */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @typedef {Object} StagedTarget
 * @property {string} url
 * @property {string} resourceUrl
 * @property {Array<{name: string, value: string}>} parameters
 */

/**
 * @param {any} admin - shopify-app-remix admin client (GraphQL)
 * @param {{ filename: string, mimeType: string, httpMethod?: string, resource: string, fileSize?: number|string }} input
 * @returns {Promise<StagedTarget>}
 */
export async function stagedUploadsCreateOne(admin, input) {
  const resp = await admin.graphql(
    `#graphql
    mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets {
          url
          resourceUrl
          parameters {
            name
            value
          }
        }
        userErrors {
          field
          message
        }
      }
    }`,
    {
      variables: {
        input: [
          {
            filename: input.filename,
            mimeType: input.mimeType,
            httpMethod: input.httpMethod || "POST",
            resource: input.resource,
            ...(input.fileSize ? { fileSize: String(input.fileSize) } : {}),
          },
        ],
      },
    }
  );

  const json = await resp.json();
  const errs = json?.data?.stagedUploadsCreate?.userErrors || [];
  if (errs.length) {
    throw new Error(`stagedUploadsCreate error: ${errs.map((e) => e.message).join(" | ")}`);
  }
  const target = json?.data?.stagedUploadsCreate?.stagedTargets?.[0];
  if (!target?.url || !target?.resourceUrl) {
    throw new Error("stagedUploadsCreate: missing staged target");
  }
  return target;
}

/**
 * Uploads a buffer to a staged target using multipart form data.
 * @param {StagedTarget} target
 * @param {Buffer} buffer
 * @param {{ filename: string, mimeType: string }} file
 */
export async function uploadBufferToStagedTarget(target, buffer, file) {
  const form = new FormData();
  for (const p of target.parameters || []) {
    form.append(p.name, p.value);
  }

  const blob = new Blob([buffer], { type: file.mimeType });
  form.append("file", blob, file.filename);

  const res = await fetch(target.url, { method: "POST", body: form });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`upload to staged target failed (${res.status}): ${t}`);
  }
}

/**
 * Creates a Shopify File record from a staged upload resourceUrl.
 * @param {any} admin
 * @param {{ contentType: "IMAGE"|"FILE", originalSource: string, filename: string, alt?: string }} file
 * @returns {Promise<{ id: string, fileStatus: string }>}
 */
export async function fileCreateOne(admin, file) {
  const resp = await admin.graphql(
    `#graphql
    mutation fileCreate($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files {
          id
          fileStatus
        }
        userErrors {
          field
          message
        }
      }
    }`,
    {
      variables: {
        files: [
          {
            alt: file.alt || undefined,
            contentType: file.contentType,
            originalSource: file.originalSource,
            filename: file.filename,
          },
        ],
      },
    }
  );

  const json = await resp.json();
  const errs = json?.data?.fileCreate?.userErrors || [];
  if (errs.length) {
    throw new Error(`fileCreate error: ${errs.map((e) => e.message).join(" | ")}`);
  }

  const created = json?.data?.fileCreate?.files?.[0];
  if (!created?.id) {
    throw new Error("fileCreate: missing file id");
  }
  return { id: created.id, fileStatus: created.fileStatus || "" };
}

/**
 * Polls until fileStatus is READY and returns a CDN URL.
 * Supports both MediaImage (image.url) and GenericFile (url).
 *
 * @param {any} admin
 * @param {string} id
 * @param {{ maxAttempts?: number, delayMs?: number }} [opts]
 * @returns {Promise<{ url: string, fileStatus: string }>}
 */
export async function waitForShopifyFileUrl(admin, id, opts = {}) {
  const maxAttempts = Math.max(1, Number(opts.maxAttempts || 20));
  const delayMs = Math.max(100, Number(opts.delayMs || 700));

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const resp = await admin.graphql(
      `#graphql
      query fileNode($id: ID!) {
        node(id: $id) {
          id
          ... on MediaImage {
            fileStatus
            image {
              url
            }
          }
          ... on GenericFile {
            fileStatus
            url
          }
        }
      }`,
      { variables: { id } }
    );
    const json = await resp.json();
    const node = json?.data?.node;

    const fileStatus = node?.fileStatus || "";
    const url = node?.url || node?.image?.url || "";

    if (fileStatus === "READY" && url) {
      return { url, fileStatus };
    }

    if (attempt < maxAttempts) await sleep(delayMs);
  }

  return { url: "", fileStatus: "TIMEOUT" };
}

/**
 * High-level helper: buffer -> staged upload -> fileCreate -> wait READY -> CDN URL
 *
 * @param {any} admin
 * @param {{ buffer: Buffer, filename: string, mimeType: string, resource: "IMAGE"|"FILE", contentType: "IMAGE"|"FILE", alt?: string }} args
 * @returns {Promise<{ fileId: string, url: string }>}
 */
export async function uploadBufferAsShopifyFile(admin, args) {
  const staged = await stagedUploadsCreateOne(admin, {
    filename: args.filename,
    mimeType: args.mimeType,
    httpMethod: "POST",
    resource: args.resource,
  });

  await uploadBufferToStagedTarget(staged, args.buffer, {
    filename: args.filename,
    mimeType: args.mimeType,
  });

  const created = await fileCreateOne(admin, {
    contentType: args.contentType,
    originalSource: staged.resourceUrl,
    filename: args.filename,
    alt: args.alt,
  });

  const ready = await waitForShopifyFileUrl(admin, created.id);
  if (!ready.url) {
    throw new Error(`Shopify file not READY (status=${ready.fileStatus}).`);
  }

  return { fileId: created.id, url: ready.url };
}
