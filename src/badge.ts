import { nativeImage, NativeImage } from 'electron';

// 3x5 pixel font, enough for "0"-"9" and "+".
const FONT: Record<string, string[]> = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '001', '001', '001'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
  '+': ['000', '010', '111', '010', '000'],
};

const SIZE = 64;

/**
 * Overlay a red unread badge with the count on an icon. Works on raw pixels so
 * it needs no canvas or font. Pass count < 0 for a plain dot.
 */
export function badgeIcon(base: NativeImage, count: number): NativeImage {
  const img = base.resize({ width: SIZE, height: SIZE, quality: 'best' });
  const buf = Buffer.from(img.toBitmap()); // BGRA, premultiplied
  if (buf.length !== SIZE * SIZE * 4) return base;

  const blend = (x: number, y: number, r: number, g: number, b: number, a: number) => {
    if (x < 0 || y < 0 || x >= SIZE || y >= SIZE || a <= 0) return;
    const i = (y * SIZE + x) * 4;
    const ia = 1 - a;
    buf[i] = Math.round(b * a + buf[i] * ia);
    buf[i + 1] = Math.round(g * a + buf[i + 1] * ia);
    buf[i + 2] = Math.round(r * a + buf[i + 2] * ia);
    buf[i + 3] = Math.round(255 * a + buf[i + 3] * ia);
  };

  const text = count < 0 ? '' : count > 9 ? (count > 99 ? '99+' : String(count)) : String(count);
  const radius = text.length > 2 ? 22 : 19;
  const cx = SIZE - radius - 1;
  const cy = SIZE - radius - 1;

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const ring = Math.max(0, Math.min(1, radius + 1.5 - d));
      if (ring > 0) blend(x, y, 255, 255, 255, ring);
      const fill = Math.max(0, Math.min(1, radius - d));
      if (fill > 0) blend(x, y, 229, 57, 53, fill);
    }
  }

  if (text) {
    const scale = text.length === 1 ? 4 : 3;
    const spacing = text.length > 2 ? 1 : scale;
    const glyphW = 3 * scale;
    const totalW = text.length * glyphW + (text.length - 1) * spacing;
    let ox = Math.round(cx - totalW / 2);
    const oy = Math.round(cy - (5 * scale) / 2);
    for (const ch of text) {
      const rows = FONT[ch];
      rows.forEach((row, ry) => {
        for (let rx = 0; rx < 3; rx++) {
          if (row[rx] !== '1') continue;
          for (let py = 0; py < scale; py++) {
            for (let px = 0; px < scale; px++) blend(ox + rx * scale + px, oy + ry * scale + py, 255, 255, 255, 1);
          }
        }
      });
      ox += glyphW + spacing;
    }
  }

  return nativeImage.createFromBitmap(buf, { width: SIZE, height: SIZE });
}

/** Extract an unread count from a page title. Returns 0 when there is none. */
export function parseUnread(title: string, pattern?: string): number {
  let re: RegExp;
  try { re = new RegExp(pattern || '\\((\\d+)\\)'); } catch { re = /\((\d+)\)/; }
  const m = re.exec(title);
  if (!m) return 0;
  const n = parseInt(m[1] ?? m[0].replace(/\D/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
}
