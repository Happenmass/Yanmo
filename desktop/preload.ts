import { contextBridge, ipcRenderer } from 'electron';
import type { AppState, DesktopAPI } from './shared';

let snapshot: AppState;
const api: DesktopAPI = {
  state: async () => { snapshot = await ipcRenderer.invoke('yanmo:state'); return snapshot; },
  invoke: (action, args) => ipcRenderer.invoke('yanmo:action', action, args),
  subscribe(listener) {
    const handler = (_event: Electron.IpcRendererEvent, state: AppState) => { snapshot = state; listener(state); };
    const meter = (_event: Electron.IpcRendererEvent, value: { level: number; seconds: number }) => { if (snapshot) { snapshot = { ...snapshot, ...value }; listener(snapshot); } };
    ipcRenderer.on('yanmo:state', handler);
    ipcRenderer.on('yanmo:meter', meter);
    return () => { ipcRenderer.removeListener('yanmo:state', handler); ipcRenderer.removeListener('yanmo:meter', meter); };
  },
};
contextBridge.exposeInMainWorld('yanmo', api);
