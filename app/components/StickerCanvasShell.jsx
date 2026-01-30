// app/components/StickerCanvasShell.jsx
import { useEffect, useState } from "react";

export default function StickerCanvasShell(props) {
  const [Client, setClient] = useState(null);

  useEffect(() => {
    let mounted = true;

    // react-konva / StickerCanvasClient nur im Browser laden
    import("./StickerCanvasClient")
      .then((mod) => {
        if (mounted) {
          setClient(() => mod.default);
        }
      })
      .catch((err) => {
        console.error("StickerCanvasClient konnte nicht geladen werden:", err);
      });

    return () => {
      mounted = false;
    };
  }, []);

  if (!Client) {
    // einfache Fallback-Ansicht während des Ladens
    return (
      <div
        style={{
          padding: 16,
          height: "100%",
          boxSizing: "border-box",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#555",
        }}
      >
        Editor wird geladen …
      </div>
    );
  }

  return <Client {...props} />;
}
