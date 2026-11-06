import { nativeImage, NativeImage } from 'electron';
import { drawDisc, drawText } from './iconstyle';

const SIZE = 64;

/**
 * Overlay a red unread badge in the bottom-right corner. Sized to stay legible
 * at tray size (22–32 px) without hiding the icon: one digit, or "9+".
 */
export function badgeIcon(base: NativeImage, count: number): NativeImage {
  const img = base.resize({ width: SIZE, height: SIZE, quality: 'best' });
  const data = Buffer.from(img.toBitmap()); // BGRA, premultiplied
  if (data.length !== SIZE * SIZE * 4) return base;
  const bm = { data, width: SIZE, height: SIZE };
  const text = count > 9 ? '9+' : String(count);
  const r = text.length > 1 ? 17 : 15;
  const c = SIZE - r - 2;
  drawDisc(bm, c, c, r, [229, 57, 53], 2.5);
  drawText(bm, text, c + (text.length > 1 ? 0.5 : 0), c, text.length > 1 ? 3 : 4, 2);
  return nativeImage.createFromBitmap(data, { width: SIZE, height: SIZE });
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
