/*
 * Export / import of the app list, for moving a setup to another computer.
 * The file holds every app's settings plus its icon, so it works even when
 * the other computer has a different user name or home folder. Logins are
 * not included: they are encrypted with this computer's keyring.
 */
import * as fs from 'fs';
import * as path from 'path';
import { AppConfig, ID_RE, loadApps, resolveApp, upsertApp } from './config';
import { ensureDir, ICON_DIR, releaseVersion } from './paths';

export const EXPORT_FORMAT = 'pwa-pop-export';

export interface ExportFile {
  format: typeof EXPORT_FORMAT;
  version: 1;
  exported_by: string;
  exported_at: string;
  apps: AppConfig[];
  /** id -> { ext, base64 } */
  icons: Record<string, { ext: string; data: string }>;
}

export function buildExport(ids?: string[]): ExportFile {
  const apps = loadApps().filter((a) => !ids || ids.includes(a.id));
  const icons: ExportFile['icons'] = {};
  const out: AppConfig[] = [];
  for (const a of apps) {
    const copy: AppConfig = { ...a };
    const file = resolveApp(a).iconPath;
    if (file) {
      try {
        icons[a.id] = { ext: path.extname(file).slice(1).toLowerCase() || 'png', data: fs.readFileSync(file).toString('base64') };
        delete copy.icon; // the path is only valid on this computer
      } catch { /* keep whatever icon value there was */ }
    }
    out.push(copy);
  }
  return {
    format: EXPORT_FORMAT, version: 1, exported_by: `PWA Pop ${releaseVersion()}`,
    exported_at: new Date().toISOString(), apps: out, icons,
  };
}

export function parseExport(text: string): ExportFile {
  let data: any;
  try { data = JSON.parse(text); } catch { throw new Error('This is not a PWA Pop export file.'); }
  if (!data || data.format !== EXPORT_FORMAT || !Array.isArray(data.apps)) throw new Error('This is not a PWA Pop export file.');
  for (const a of data.apps) {
    let urlOk = false;
    try { urlOk = /^https?:$/.test(new URL(String(a?.url)).protocol); } catch { /* invalid */ }
    if (!a || typeof a.id !== 'string' || !ID_RE.test(a.id) || typeof a.name !== 'string' || !urlOk) {
      throw new Error('The export file contains an invalid app entry.');
    }
  }
  data.icons = data.icons && typeof data.icons === 'object' ? data.icons : {};
  return data as ExportFile;
}

/** Writes the imported apps. Returns the configs that were written. */
export function applyImport(file: ExportFile, replaceExisting: boolean): { written: AppConfig[]; skipped: string[] } {
  const existing = new Set(loadApps().map((a) => a.id));
  const written: AppConfig[] = [];
  const skipped: string[] = [];
  for (const a of file.apps) {
    if (existing.has(a.id) && !replaceExisting) { skipped.push(a.id); continue; }
    const cfg: AppConfig = { ...a };
    const icon = file.icons[a.id];
    if (icon && /^[a-z0-9]{1,5}$/.test(icon.ext) && typeof icon.data === 'string') {
      ensureDir(ICON_DIR);
      const dest = path.join(ICON_DIR, `${a.id}.${icon.ext}`);
      fs.writeFileSync(dest, Buffer.from(icon.data, 'base64'));
      cfg.icon = dest;
    }
    upsertApp(cfg);
    written.push(cfg);
  }
  return { written, skipped };
}
