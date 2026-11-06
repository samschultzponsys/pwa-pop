/*
 * Pixel-level icon helpers that work on raw BGRA (premultiplied) bitmaps, the
 * format nativeImage.toBitmap() returns on Linux. No canvas or fonts needed,
 * so they run in the main process and in plain-Node unit tests.
 */

/** 3x5 pixel font: digits, A–Z and "+". */
export const FONT: Record<string, string[]> = {
  '0': ['111', '101', '101', '101', '111'], '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'], '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'], '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'], '7': ['111', '001', '001', '001', '001'],
  '8': ['111', '101', '111', '101', '111'], '9': ['111', '101', '111', '001', '111'],
  '+': ['000', '010', '111', '010', '000'],
  A: ['010', '101', '111', '101', '101'], B: ['110', '101', '110', '101', '110'],
  C: ['011', '100', '100', '100', '011'], D: ['110', '101', '101', '101', '110'],
  E: ['111', '100', '110', '100', '111'], F: ['111', '100', '110', '100', '100'],
  G: ['011', '100', '101', '101', '011'], H: ['101', '101', '111', '101', '101'],
  I: ['111', '010', '010', '010', '111'], J: ['001', '001', '001', '101', '010'],
  K: ['101', '101', '110', '101', '101'], L: ['100', '100', '100', '100', '111'],
  M: ['101', '111', '111', '101', '101'], N: ['111', '101', '101', '101', '101'],
  O: ['010', '101', '101', '101', '010'], P: ['110', '101', '110', '100', '100'],
  Q: ['010', '101', '101', '111', '011'], R: ['110', '101', '110', '101', '101'],
  S: ['011', '100', '010', '001', '110'], T: ['111', '010', '010', '010', '010'],
  U: ['101', '101', '101', '101', '111'], V: ['101', '101', '101', '101', '010'],
  W: ['101', '101', '111', '111', '101'], X: ['101', '101', '010', '101', '101'],
  Y: ['101', '101', '010', '010', '010'], Z: ['111', '001', '010', '100', '111'],
};

/** Named colours for duplicate apps: target hue (degrees) + chip colour. */
export const ICON_COLORS: Record<string, { hue: number; rgb: [number, number, number] }> = {
  blue: { hue: 215, rgb: [37, 99, 235] },
  green: { hue: 140, rgb: [22, 163, 74] },
  purple: { hue: 275, rgb: [147, 51, 234] },
  orange: { hue: 28, rgb: [234, 88, 12] },
  teal: { hue: 178, rgb: [13, 148, 136] },
  pink: { hue: 328, rgb: [219, 39, 119] },
  red: { hue: 2, rgb: [220, 38, 38] },
  yellow: { hue: 48, rgb: [202, 138, 4] },
};
export const COLOR_ORDER = ['blue', 'green', 'purple', 'orange', 'teal', 'pink', 'red', 'yellow'];

export interface Bitmap { data: Buffer; width: number; height: number }

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h = ((h % 360) + 360) % 360 / 360;
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}

/** The icon's main hue, or null when it is (nearly) grey. */
export function dominantHue(bm: Bitmap): number | null {
  const bins = new Array(36).fill(0);
  let total = 0;
  for (let i = 0; i < bm.width * bm.height; i++) {
    const a = bm.data[i * 4 + 3];
    if (a < 32) continue;
    const k = 255 / a;
    const [h, s, l] = rgbToHsl(bm.data[i * 4 + 2] * k, bm.data[i * 4 + 1] * k, bm.data[i * 4] * k);
    const w = s * (1 - Math.abs(2 * l - 1)) * (a / 255);
    bins[Math.floor(h / 10) % 36] += w;
    total += w;
  }
  if (total < bm.width * bm.height * 0.02) return null;
  const best = bins.indexOf(Math.max(...bins));
  return best * 10 + 5;
}

/** Rotate every colour so the dominant hue becomes `targetHue`. */
export function recolor(bm: Bitmap, targetHue: number): void {
  const dom = dominantHue(bm);
  if (dom === null) return;
  const delta = targetHue - dom;
  for (let i = 0; i < bm.width * bm.height; i++) {
    const a = bm.data[i * 4 + 3];
    if (a === 0) continue;
    const k = 255 / a;
    const [h, s, l] = rgbToHsl(bm.data[i * 4 + 2] * k, bm.data[i * 4 + 1] * k, bm.data[i * 4] * k);
    if (s < 0.08) continue; // keep whites, greys and blacks
    const [r, g, b] = hslToRgb(h + delta, s, l);
    const m = a / 255;
    bm.data[i * 4] = Math.round(b * m);
    bm.data[i * 4 + 1] = Math.round(g * m);
    bm.data[i * 4 + 2] = Math.round(r * m);
  }
}

function blend(bm: Bitmap, x: number, y: number, r: number, g: number, b: number, a: number) {
  if (x < 0 || y < 0 || x >= bm.width || y >= bm.height || a <= 0) return;
  const i = (y * bm.width + x) * 4;
  const ia = 1 - a;
  bm.data[i] = Math.round(b * a + bm.data[i] * ia);
  bm.data[i + 1] = Math.round(g * a + bm.data[i + 1] * ia);
  bm.data[i + 2] = Math.round(r * a + bm.data[i + 2] * ia);
  bm.data[i + 3] = Math.round(255 * a + bm.data[i + 3] * ia);
}

/** Filled anti-aliased circle with a white outline. */
export function drawDisc(bm: Bitmap, cx: number, cy: number, radius: number, rgb: [number, number, number], ring = Math.max(1.5, radius * 0.12)) {
  const x0 = Math.floor(cx - radius - ring - 1), x1 = Math.ceil(cx + radius + ring + 1);
  const y0 = Math.floor(cy - radius - ring - 1), y1 = Math.ceil(cy + radius + ring + 1);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const outer = Math.max(0, Math.min(1, radius + ring - d));
      if (outer > 0) blend(bm, x, y, 255, 255, 255, outer);
      const inner = Math.max(0, Math.min(1, radius - d));
      if (inner > 0) blend(bm, x, y, rgb[0], rgb[1], rgb[2], inner);
    }
  }
}

/** White text centred on (cx, cy) using the pixel font. */
export function drawText(bm: Bitmap, text: string, cx: number, cy: number, scale: number, spacing = scale) {
  const chars = [...text.toUpperCase()].filter((c) => FONT[c]);
  if (!chars.length) return;
  const w = chars.length * 3 * scale + (chars.length - 1) * spacing;
  let ox = Math.round(cx - w / 2);
  const oy = Math.round(cy - (5 * scale) / 2);
  for (const ch of chars) {
    FONT[ch].forEach((row, ry) => {
      for (let rx = 0; rx < 3; rx++) {
        if (row[rx] !== '1') continue;
        for (let py = 0; py < scale; py++) for (let px = 0; px < scale; px++) {
          blend(bm, ox + rx * scale + px, oy + ry * scale + py, 255, 255, 255, 1);
        }
      }
    });
    ox += 3 * scale + spacing;
  }
}

/** Coloured chip with a 1–2 character label in the top-left corner. */
export function drawChip(bm: Bitmap, label: string, rgb: [number, number, number]) {
  const size = Math.min(bm.width, bm.height);
  const r = size * 0.22;
  const cx = r + size * 0.04, cy = r + size * 0.04;
  drawDisc(bm, cx, cy, r, rgb);
  const text = label.slice(0, 2);
  const scale = Math.max(1, Math.floor((text.length > 1 ? r * 1.25 : r * 1.3) / 5));
  drawText(bm, text, cx, cy, scale, Math.max(1, Math.round(scale * 0.6)));
}

/** True when a noticeable part of the icon is see-through. */
export function hasTransparency(bm: Bitmap): boolean {
  let clear = 0;
  for (let i = 0; i < bm.width * bm.height; i++) if (bm.data[i * 4 + 3] < 200) clear++;
  return clear > bm.width * bm.height * 0.03;
}
