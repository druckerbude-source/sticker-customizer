import fs from "fs/promises";
import path from "path";

export async function loader({ params }) {
  const file = String(params.file || "");
  if (!file || file.includes("..") || file.includes("/") || file.includes("\\")) {
    return new Response("Not found", { status: 404 });
  }

  const abs = path.join(
    process.cwd(),
    "public",
    "uploads",
    "sticker-configurator",
    "previews",
    file
  );

  try {
    const buf = await fs.readFile(abs);
    return new Response(buf, {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=600",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
