import * as fs from 'fs';
import * as path from 'path';
import { ensureDir, STATE_DIR } from './paths';

export interface AppState {
  bounds?: { x?: number; y?: number; width: number; height: number };
  maximized?: boolean;
  muted?: boolean;
  zoom?: number;
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
