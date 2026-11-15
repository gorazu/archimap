// Pure image helpers on plain pixel arrays, so they run in tests without a DOM.

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** RGBA pixels, as in ImageData. */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** One channel, 0-255. */
export interface GrayImage {
  width: number;
  height: number;
  data: Float32Array;
}

export function toGray({ width, height, data }: RgbaImage): GrayImage {
  const out = new Float32Array(width * height);
  for (let i = 0; i < out.length; i++) {
    out[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  }
  return { width, height, data: out };
}

/** Darkest channel per pixel: high only where a pixel is bright in every channel (white text). */
export function minChannel({ width, height, data }: RgbaImage): GrayImage {
  const out = new Float32Array(width * height);
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.min(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
  }
  return { width, height, data: out };
}

export function cropRgba(img: RgbaImage, box: Box): RgbaImage {
  const x0 = Math.max(0, box.x);
  const y0 = Math.max(0, box.y);
  const w = Math.max(0, Math.min(img.width, box.x + box.w) - x0);
  const h = Math.max(0, Math.min(img.height, box.y + box.h) - y0);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const start = ((y0 + y) * img.width + x0) * 4;
    data.set(img.data.subarray(start, start + w * 4), y * w * 4);
  }
  return { width: w, height: h, data };
}

export function resizeBilinear(img: GrayImage, width: number, height: number): GrayImage {
  const out = new Float32Array(width * height);
  const sx = img.width / width;
  const sy = img.height / height;
  for (let y = 0; y < height; y++) {
    const fy = Math.min(img.height - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(img.height - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.min(img.width - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(img.width - 1, x0 + 1);
      const wx = fx - x0;
      const top = img.data[y0 * img.width + x0] * (1 - wx) + img.data[y0 * img.width + x1] * wx;
      const bottom = img.data[y1 * img.width + x0] * (1 - wx) + img.data[y1 * img.width + x1] * wx;
      out[y * width + x] = top * (1 - wy) + bottom * wy;
    }
  }
  return { width, height, data: out };
}

/** Mean of blocks: fast, good for shrinking a lot (no aliasing). */
export function resizeArea(img: GrayImage, width: number, height: number): GrayImage {
  const out = new Float32Array(width * height);
  const counts = new Float32Array(width * height);
  for (let y = 0; y < img.height; y++) {
    const ty = Math.min(height - 1, Math.floor((y * height) / img.height));
    for (let x = 0; x < img.width; x++) {
      const t = ty * width + Math.min(width - 1, Math.floor((x * width) / img.width));
      out[t] += img.data[y * img.width + x];
      counts[t]++;
    }
  }
  for (let i = 0; i < out.length; i++) out[i] /= counts[i] || 1;
  return { width, height, data: out };
}

export function mean(values: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += values[i];
  return values.length ? sum / values.length : 0;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function percentile(values: ArrayLike<number>, p: number): number {
  const sorted = Float32Array.from(values).sort();
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

/** Bicubic weight (a = -0.75, as OpenCV's INTER_CUBIC). */
function cubic(t: number): number {
  const a = -0.75;
  const x = Math.abs(t);
  if (x <= 1) return (a + 2) * x ** 3 - (a + 3) * x ** 2 + 1;
  if (x < 2) return a * x ** 3 - 5 * a * x ** 2 + 8 * a * x - 4 * a;
  return 0;
}

/** Bicubic resize: keeps small text sharper than bilinear when upscaling. */
export function resizeBicubic(img: GrayImage, width: number, height: number): GrayImage {
  // Separable: rows first into an intermediate image, then columns.
  const pass = (src: Float32Array, srcLen: number, dstLen: number, count: number, stride: number, step: number, dstStride: number, dstStep: number, out: Float32Array) => {
    const scale = srcLen / dstLen;
    for (let d = 0; d < dstLen; d++) {
      const f = (d + 0.5) * scale - 0.5;
      const base = Math.floor(f);
      const w = [cubic(f - (base - 1)), cubic(f - base), cubic(f - (base + 1)), cubic(f - (base + 2))];
      for (let c = 0; c < count; c++) {
        let v = 0;
        for (let k = 0; k < 4; k++) {
          const s = Math.min(srcLen - 1, Math.max(0, base - 1 + k));
          v += w[k] * src[c * stride + s * step];
        }
        out[c * dstStride + d * dstStep] = v;
      }
    }
  };
  const mid = new Float32Array(width * img.height);
  pass(img.data, img.width, width, img.height, img.width, 1, width, 1, mid);
  const out = new Float32Array(width * height);
  pass(mid, img.height, height, width, 1, width, 1, width, out);
  for (let i = 0; i < out.length; i++) out[i] = Math.min(255, Math.max(0, out[i]));
  return { width, height, data: out };
}
