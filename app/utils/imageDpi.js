export function calculateDpi(image) {
  // Manche JPGs/PNGs enthalten DPI in EXIF
  // Falls nicht → Default 300
  try {
    if (image && image.height && image.width) {
      return 300; 
    }
  } catch (e) {
    return 300;
  }
}
