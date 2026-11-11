import * as fs from 'fs';
import * as path from 'path';
import { ensureDir, STATE_DIR } from './paths';

export interface AppState {
  bounds?: { x?: number; y?: number; width: number; height: number };
  maximized?: boolean;
  /** Last size of the app's own pop-up windows (e.g. ConnectWise's Time Entry). */
  popupSize?: { width: number; height: number };
  muted?: boolean;
  zoom?: number;
  /** The site's own icon has been adopted (icon_auto). */
  iconAdopted?: boolean;
  /** Last measured memory use (MB) and when, for the manager. */
  memoryMb?: number;
  memoryAt?: number;
  /** Latest memory breakdown (MB): browser core vs. pages, per process. */
  memory?: MemorySample;
  /** [time ms, total MB] about once a minute, last 6 hours. */
  memoryHistory?: [number, number][];
}

export interface MemorySample {
  total: number;
  /** Main, GPU and utility processes: the part a shared core would hold once. */
  core: number;
  /** Renderer processes: the web pages, service workers and frames. */
  pages: number;
  /** "pss" (shared memory split fairly) or "rss" (may count shared memory twice). */
  method: 'pss' | 'rss' | 'mixed';
  processes: { type: string; name: string; mb: number }[];
}

export class StateStore {
  private file: string;
  data: AppState;
  private timer: NodeJS.Timeout | null = null;

  constructor(id: string) {
    ensureDir(STATE_DIR);
    this.file = path.join(STATE_DIR, `${id}.json`);
    try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.data = {}; }
  }

  update(patch: Partial<AppState>, immediate = false) {
    Object.assign(this.data, patch);
    if (this.timer) clearTimeout(this.timer);
    if (immediate) this.flush();
    else this.timer = setTimeout(() => this.flush(), 500);
  }

  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    try {
      fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.data, null, 2));
      fs.renameSync(this.file + '.tmp', this.file);
    } catch (e) {
      console.warn('[webtray] could not save window state', e);
    }
  }
}
