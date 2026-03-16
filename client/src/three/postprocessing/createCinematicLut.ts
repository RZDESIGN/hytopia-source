import {
  ClampToEdgeWrapping,
  Data3DTexture,
  LinearFilter,
  RGBAFormat,
  UnsignedByteType,
  type ColorRepresentation,
  Color,
} from 'three';

const lutColor = new Color();
const shadowTint = new Color(0.87, 0.94, 1.02);
const highlightTint = new Color(1.03, 0.99, 0.95);

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function encodeChannel(value: number): number {
  return Math.round(clamp01(value) * 255);
}

function mixColorChannel(base: number, tint: number, amount: number): number {
  return base + (tint - 1.0) * amount;
}

export function createCinematicLut(size: number = 16, _accent: ColorRepresentation = 0xffffff): Data3DTexture {
  const data = new Uint8Array(size * size * size * 4);
  let offset = 0;

  for (let blue = 0; blue < size; blue++) {
    for (let green = 0; green < size; green++) {
      for (let red = 0; red < size; red++) {
        const r = red / (size - 1);
        const g = green / (size - 1);
        const b = blue / (size - 1);

        lutColor.setRGB(r, g, b);
        const luma = lutColor.r * 0.2126 + lutColor.g * 0.7152 + lutColor.b * 0.0722;
        const shadowAmount = Math.pow(1.0 - luma, 1.35) * 0.18;
        const highlightAmount = Math.pow(luma, 1.15) * 0.14;
        const saturationBoost = 1.0 + (0.08 - shadowAmount * 0.12);
        const average = (lutColor.r + lutColor.g + lutColor.b) / 3.0;

        lutColor.setRGB(
          average + (lutColor.r - average) * saturationBoost,
          average + (lutColor.g - average) * saturationBoost,
          average + (lutColor.b - average) * saturationBoost,
        );

        lutColor.setRGB(
          mixColorChannel(lutColor.r, shadowTint.r, shadowAmount),
          mixColorChannel(lutColor.g, shadowTint.g, shadowAmount),
          mixColorChannel(lutColor.b, shadowTint.b, shadowAmount),
        );

        lutColor.setRGB(
          mixColorChannel(lutColor.r, highlightTint.r, highlightAmount),
          mixColorChannel(lutColor.g, highlightTint.g, highlightAmount),
          mixColorChannel(lutColor.b, highlightTint.b, highlightAmount),
        );

        const contrastPivot = 0.52;
        lutColor.setRGB(
          contrastPivot + (lutColor.r - contrastPivot) * 1.06,
          contrastPivot + (lutColor.g - contrastPivot) * 1.05,
          contrastPivot + (lutColor.b - contrastPivot) * 1.04,
        );

        data[offset++] = encodeChannel(lutColor.r);
        data[offset++] = encodeChannel(lutColor.g);
        data[offset++] = encodeChannel(lutColor.b);
        data[offset++] = 255;
      }
    }
  }

  const texture = new Data3DTexture(data, size, size, size);
  texture.format = RGBAFormat;
  texture.type = UnsignedByteType;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.wrapR = ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;

  return texture;
}
