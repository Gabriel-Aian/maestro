import { contextBridge, ipcRenderer } from 'electron';
import { QUEUE_EVENT_CHANNEL, type HistoryFilter, type HistoryRunView, type QueueEvent, type QueueJobView, type StatusView } from '../shared/ipc.js';

/**
 * Superfície exposta ao renderer. Cresce tela por tela — nada de
 * `nodeIntegration` solto nem `ipcRenderer` cru no renderer, só o que passar
 * por aqui.
 */
const api = {
  getStatus: (): Promise<StatusView> => ipcRenderer.invoke('maestro:getStatus'),

  listQueue: (): Promise<QueueJobView[]> => ipcRenderer.invoke('maestro:queue:list'),
  cancelJob: (jobId: string): Promise<boolean> => ipcRenderer.invoke('maestro:queue:cancel', jobId),
  killAllJobs: (): Promise<void> => ipcRenderer.invoke('maestro:queue:killAll'),

  listHistory: (filter: HistoryFilter = {}): Promise<HistoryRunView[]> => ipcRenderer.invoke('maestro:history:list', filter),

  /** Retorna uma função de cancelamento — chame ao desmontar o componente. */
  onQueueEvent: (callback: (event: QueueEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: QueueEvent) => callback(payload);
    ipcRenderer.on(QUEUE_EVENT_CHANNEL, listener);
    return () => {
      ipcRenderer.removeListener(QUEUE_EVENT_CHANNEL, listener);
    };
  },
};

contextBridge.exposeInMainWorld('maestro', api);

export type MaestroBridge = typeof api;
