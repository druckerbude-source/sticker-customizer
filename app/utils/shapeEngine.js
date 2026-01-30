export function applyShapeMask(ctx, shape, image) {
  const width = image.width;
  const height = image.height;

  if (shape === "rectangle") {
    ctx.rect(0, 0, width, height);
  }

  if (shape === "rounded") {
    const r = 40;
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.lineTo(width - r, 0);
    ctx.quadraticCurveTo(width, 0, width, r);
    ctx.lineTo(width, height - r);
    ctx.quadraticCurveTo(width, height, width - r, height);
    ctx.lineTo(r, height);
    ctx.quadraticCurveTo(0, height, 0, height - r);
    ctx.lineTo(0, r);
    ctx.quadraticCurveTo(0, 0, r, 0);
  }

  if (shape === "circle") {
    const radius = Math.min(width, height) / 2;
    ctx.arc(width / 2, height / 2, radius, 0, Math.PI * 2);
  }

  if (shape === "oval") {
    ctx.ellipse(
      width / 2,
      height / 2,
      width / 2,
      height / 3,
      0,
      0,
      Math.PI * 2
    );
  }
}
