// app/components/StickerCanvas.jsx
import { useEffect, useState } from "react";

/**
 * SSR-sicherer Wrapper für den Canvas-Editor.
 *
 * Lädt StickerCanvasClient nur im Browser (useEffect + dynamic import),
 * damit es keine Probleme mit react-konva / canvas im Node-SSR gibt.
 *
 * Props:
 * - initialWidthCm   (optional)  => Breite im Editor in cm
 * - initialHeightCm  (optional)  => Höhe im Editor in cm
 * - initialShape     (optional)  => "rectangle" | "circle" | "oval" | "rounded" | "freeform"
 * - imageUrl         (optional)  => Basisbild, falls du eins übergeben willst
 *
 * Alle Props werden 1:1 an StickerCanvasClient durchgereicht.
 */
export default function StickerCanvas(props) {
  const [ClientComponent, setClientComponent] = useState(null);

  useEffect(() => {
    let isMounted = true;

    // nur im Browser laden
    import("./StickerCanvasClient").then((mod) => {
      if (isMounted) {
        setClientComponent(() => mod.default);
      }
    });

    return () => {
      isMounted = false;
    };
  }, []);

   if (!ClientComponent) {
    return (
      <div
        style={{
          padding: 16,
          height: "100%",
          minHeight: 200,
          boxSizing: "border-box",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "rgba(255,255,255,0.5)",
          fontSize: 14,
          fontFamily: "'Noto Sans', sans-serif",
        }}
      >
        Editor wird geladen …
      </div>
    );
  }

  // alle Props (inkl. initialWidthCm / initialHeightCm / initialShape / imageUrl) durchreichen
  return <ClientComponent {...props} />;
}
