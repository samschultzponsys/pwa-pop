import * as fs from 'fs';
import * as path from 'path';
import { BrowserWindow, nativeImage, NativeImage } from 'electron';
import { assetPath } from './paths';
import { drawChip, hasTransparency, ICON_COLORS, recolor } from './iconstyle';

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
};

export function defaultIcon(): NativeImage {
  return nativeImage.createFromPath(assetPath('assets', 'icons', '256x256.png'));
}

let helper: BrowserWindow | null = null;
let helperReady: Promise<void> | null = null;

/**
 * Decode any image format Chromium understands (SVG, ICO, WebP…) into a PNG by
 * drawing it onto a canvas in an invisible window. nativeImage itself only
 * reads PNG/JPEG on Linux.
 */
export async function rasterize(data: Buffer, mime: string, size = 256): Promise<NativeImage> {
  if (!helper || helper.isDestroyed()) {
    helper = new BrowserWindow({
      show: false, width: 16, height: 16,
      webPreferences: { sandbox: true, contextIsolation: true, javascript: true, partition: 'webroost-icon-helper' },
    });
    helperReady = helper.loadURL('data:text/html,<!doctype html><title>icon</title>');
  }
  await helperReady;
  const url = `data:${mime};base64,${data.toString('base64')}`;
  const png: string = await helper.webContents.executeJavaScript(`new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = c.height = ${size};
      const g = c.getContext('2d'); g.imageSmoothingQuality = 'high';
      const w = img.naturalWidth || ${size}, h = img.naturalHeight || ${size};
      const s = Math.min(${size} / w, ${size} / h);
      g.drawImage(img, (${size} - w * s) / 2, (${size} - h * s) / 2, w * s, h * s);
      res(c.toDataURL('image/png'));
    };
    img.onerror = () => rej(new Error('decode failed'));
    img.src = ${JSON.stringify(url)};
  })`);
  return nativeImage.createFromDataURL(png);
}

export function disposeHelper(): void {
  if (helper && !helper.isDestroyed()) helper.destroy();
  helper = null;
}

export async function imageFromBuffer(data: Buffer, mime = ''): Promise<NativeImage | null> {
  const direct = nativeImage.createFromBuffer(data);
  if (!direct.isEmpty()) return direct;
  try {
    const img = await rasterize(data, mime || sniffMime(data));
    return img.isEmpty() ? null : img;
  } catch {
    return null;
  }
}

export async function loadIconFile(file: string | null): Promise<NativeImage> {
  if (!file) return defaultIcon();
  try {
    const ext = path.extname(file).toLowerCase();
    if (ext === '.png' || ext === '.jpg' || ext === '.jpeg') {
      const img = nativeImage.createFromPath(file);
      if (!img.isEmpty()) return img;
    }
    const img = await imageFromBuffer(fs.readFileSync(file), MIME[ext] ?? '');
    if (img) return img;
  } catch (e) {
    console.warn(`[webroost] could not load icon ${file}:`, e);
  }
  return defaultIcon();
}

function sniffMime(b: Buffer): string {
  const head = b.subarray(0, 256).toString('utf8');
  if (/<svg[\s>]/i.test(head) || head.trimStart().startsWith('<?xml')) return 'image/svg+xml';
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return 'image/x-icon';
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'image/webp';
  if (head.startsWith('GIF8')) return 'image/gif';
  return 'image/png';
}

export interface IconStyle { icon_color?: string; icon_label?: string }

/**
 * Apply a duplicate app's colour and corner label to its icon. Works at
 * 256 px, so tray, window and menu icons are all scaled down from one image.
 */
export function styleIcon(img: NativeImage, style: IconStyle): NativeImage {
  const color = style.icon_color ? ICON_COLORS[style.icon_color] : undefined;
  const label = (style.icon_label || '').trim();
  if (!color && !label) return img;
  const size = 256;
  const base = img.resize({ width: size, height: size, quality: 'best' });
  const data = Buffer.from(base.toBitmap());
  if (data.length !== size * size * 4) return img;
  const bm = { data, width: size, height: size };
  if (color) recolor(bm, color.hue);
  if (label) drawChip(bm, label, color?.rgb ?? [55, 65, 81]);
  return nativeImage.createFromBitmap(data, { width: size, height: size });
}

/** True when a noticeable part of the image is see-through. */
export function imageHasTransparency(img: NativeImage): boolean {
  const s = img.resize({ width: 64, height: 64 });
  return hasTransparency({ data: Buffer.from(s.toBitmap()), width: 64, height: 64 });
}
