import { contextBridge, ipcRenderer } from 'electron';

const call = (ch: string) => (...args: unknown[]) => ipcRenderer.invoke(ch, ...args);

contextBridge.exposeInMainWorld('webtray', {
  list: call('apps:list'),
  memory: call('apps:memory'),
  inspect: call('apps:inspect'),
  save: call('apps:save'),
  remove: call('apps:remove'),
  launch: call('apps:launch'),
  quit: call('apps:quit'),
  install: call('apps:install'),
  exportApps: call('apps:export'),
  importApps: call('apps:import'),
  uninstall: call('apps:uninstall'),
  pickIcon: call('app:pickIcon'),
  hidLast: call('app:hidLast'),
  styleIcon: call('icon:style'),
  iconColors: call('icon:colors'),
  openConfig: call('app:openConfig'),
  installManager: call('app:installManager'),
  info: call('app:info'),
  openExternal: call('app:openExternal'),
  checkUpdate: call('update:check'),
  installUpdate: call('update:install'),
  updateGuide: call('update:guide'),
  downloadUpdate: call('update:download'),
  copy: call('app:copy'),
  getAutoUpdate: call('update:getAuto'),
  setAutoUpdate: call('update:setAuto'),
  onUpdateProgress: (cb: (p: number) => void) => { ipcRenderer.on('update:progress', (_e, p: number) => cb(p)); },
});
