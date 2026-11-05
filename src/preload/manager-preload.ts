import { contextBridge, ipcRenderer } from 'electron';

const call = (ch: string) => (...args: unknown[]) => ipcRenderer.invoke(ch, ...args);

contextBridge.exposeInMainWorld('webtray', {
  list: call('apps:list'),
  inspect: call('apps:inspect'),
  save: call('apps:save'),
  remove: call('apps:remove'),
  launch: call('apps:launch'),
  install: call('apps:install'),
  uninstall: call('apps:uninstall'),
  pickIcon: call('app:pickIcon'),
  hidLast: call('app:hidLast'),
  openConfig: call('app:openConfig'),
  installManager: call('app:installManager'),
  info: call('app:info'),
  openExternal: call('app:openExternal'),
});
