// app/routes/app._index.jsx

import fs from "fs";
import path from "path";
import { json, redirect } from "@remix-run/node";
import { Form, useActionData } from "@remix-run/react";
import { Page, Layout, Card, Text } from "@shopify/polaris";
import { useState } from "react";
import { authenticate } from "../shopify.server";


// Mindestbreite/-höhe in cm
const MIN_CM = 4;

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return json({});
};

export const action = async ({ request }) => {
  await authenticate.admin(request);

  const formData = await request.formData();

  // --- Pflichtfelder auslesen ---
  const widthCm = Math.max(MIN_CM, Number(formData.get("width") || 0));
  const heightCm = Math.max(MIN_CM, Number(formData.get("height") || 0));
  const shape = (formData.get("shape") || "rectangle").toString();

  const file = formData.get("file");

  if (!file || typeof file !== "object" || typeof file.arrayBuffer !== "function") {
    throw new Error("Keine gültige Datei hochgeladen.");
  }

  // --- Datei im public/uploads speichern, damit sie per URL erreichbar ist ---
  const buffer = Buffer.from(await file.arrayBuffer());

  const uploadDir = path.join(process.cwd(), "public", "uploads");
  await fs.promises.mkdir(uploadDir, { recursive: true });

  const safeName = `${Date.now()}-${String(file.name).replace(/\s+/g, "_")}`;
  const fullPath = path.join(uploadDir, safeName);

  await fs.promises.writeFile(fullPath, buffer);

  // URL, die der Browser laden kann
  const imageUrl = `/uploads/${safeName}`;

  // Direkt in den Editor weiterleiten
  const search = new URLSearchParams({
    width: String(widthCm),
    height: String(heightCm),
    shape,
    imageUrl,
  });

  return redirect(`/app/stickerbuilder?${search.toString()}`);
};

export default function StickerConfiguratorPage() {
  // aktuell nutzen wir useActionData nicht mehr, aber kann da bleiben
  useActionData();
  const [widthInput, setWidthInput] = useState("4");
  const [heightInput, setHeightInput] = useState("4");
  const [shape, setShape] = useState("rectangle");

  return (
    <Page title="Sticker Konfigurator">
      <Layout>
        <Layout.Section>
          <Card sectioned>
            <Text as="h2" variant="headingMd">
              Bild hochladen & Editor starten
            </Text>

            <Form
              method="post"
              encType="multipart/form-data"
              style={{ marginTop: 16 }}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <label>
                  Datei hochladen:
                  <input
                    type="file"
                    name="file"
                    accept=".jpg,.jpeg,.png,.pdf,.svg"
                    required
                    style={{ marginTop: 4 }}
                  />
                </label>

              {/*}  <label>
                  Breite (cm):
                  <input
                    type="number"
                    name="width"
                    min={MIN_CM}
                    step="0.1"
                    value={widthInput}
                    onChange={(e) => setWidthInput(e.target.value)}
                    required
                    style={{ marginTop: 4, width: "200px" }}
                  />
                </label>

                <label>
                  Höhe (cm):
                  <input
                    type="number"
                    name="height"
                    min={MIN_CM}
                    step="0.1"
                    value={heightInput}
                    onChange={(e) => setHeightInput(e.target.value)}
                    required
                    style={{ marginTop: 4, width: "200px" }}
                  />
                </label>*/}

                <label>
                  Form:
                  <select
                    name="shape"
                    style={{ marginTop: 4, width: "250px" }}
                    value={shape}
                    onChange={(e) => setShape(e.target.value)}
                  >
                    <option value="rectangle">Rechteck / Quadrat</option>
                    <option value="circle">Rund</option>
                    <option value="oval">Oval</option>
                    <option value="rounded">Abgerundete Ecken</option>
                    <option value="freeform">Freiform (Konturschnitt)</option>
                  </select>
                </label>

                <button
                  type="submit"
                  style={{
                    marginTop: 12,
                    padding: "8px 16px",
                    borderRadius: 4,
                    border: "none",
                    cursor: "pointer",
                    backgroundColor: "#5c6ac4",
                    color: "#fff",
                    fontWeight: 500,
                  }}
                >
                  Editor öffnen
                </button>
              </div>
            </Form>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
