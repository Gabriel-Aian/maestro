import { contextBridge, ipcRenderer } from 'electron';
import {
  PROFILES_EVENT_CHANNEL,
  QUEUE_EVENT_CHANNEL,
  type ActionResult,
  type AddProfileResult,
  type BrowserView,
  type FlowDetailView,
  type FlowListItem,
  type FlowRunDetail,
  type HistoryFilter,
  type HistoryRunView,
  type LoadSearchFileResult,
  type LoginCheckResult,
  type ProfileView,
  type ProfilesEvent,
  type QueueEvent,
  type QueueJobView,
  type RunFlowResult,
  type RunSearchResult,
  type StatusView,
} from '../shared/ipc.js';

/** Assina um canal de evento e devolve a função de cancelamento — chamar ao desmontar. */
function subscribe<T>(channel: string, callback: (event: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

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
  onQueueEvent: (callback: (event: QueueEvent) => void): (() => void) => subscribe(QUEUE_EVENT_CHANNEL, callback),

  listHistory: (filter: HistoryFilter = {}): Promise<HistoryRunView[]> => ipcRenderer.invoke('maestro:history:list', filter),

  listBrowsers: (): Promise<BrowserView[]> => ipcRenderer.invoke('maestro:browsers:list'),
  addBrowserPath: (id: string, path: string): Promise<ActionResult> => ipcRenderer.invoke('maestro:browsers:addPath', { id, path }),

  listProfiles: (): Promise<ProfileView[]> => ipcRenderer.invoke('maestro:profiles:list'),
  addProfile: (name: string, browserId: string): Promise<AddProfileResult> =>
    ipcRenderer.invoke('maestro:profiles:add', { name, browserId }),
  removeProfile: (id: string): Promise<void> => ipcRenderer.invoke('maestro:profiles:remove', id),
  onProfilesEvent: (callback: (event: ProfilesEvent) => void): (() => void) => subscribe(PROFILES_EVENT_CHANNEL, callback),

  startLogin: (profileId: string, url: string): Promise<ActionResult> => ipcRenderer.invoke('maestro:login:start', { profileId, url }),
  checkLogin: (profileId: string): Promise<LoginCheckResult> => ipcRenderer.invoke('maestro:login:check', profileId),
  completeLogin: (profileId: string): Promise<ActionResult> => ipcRenderer.invoke('maestro:login:complete', profileId),

  listFlows: (): Promise<FlowListItem[]> => ipcRenderer.invoke('maestro:flows:list'),
  getFlow: (id: string): Promise<FlowDetailView> => ipcRenderer.invoke('maestro:flows:get', id),
  runFlow: (flowId: string, profileId: string, variables: Record<string, string>, headed: boolean): Promise<RunFlowResult> =>
    ipcRenderer.invoke('maestro:flows:run', { flowId, profileId, variables, headed }),
  getRun: (runId: string): Promise<FlowRunDetail | null> => ipcRenderer.invoke('maestro:runs:get', runId),

  getLastSearchFile: (): Promise<LoadSearchFileResult | null> => ipcRenderer.invoke('maestro:search:getLast'),
  pickSearchFile: (): Promise<LoadSearchFileResult | null> => ipcRenderer.invoke('maestro:search:pickFile'),
  reloadSearchFile: (filePath: string): Promise<LoadSearchFileResult> => ipcRenderer.invoke('maestro:search:reload', filePath),
  openSearchFileFolder: (filePath: string): Promise<void> => ipcRenderer.invoke('maestro:search:openFolder', filePath),
  runSearch: (filePath: string, themeIds: string[]): Promise<RunSearchResult> =>
    ipcRenderer.invoke('maestro:search:run', { filePath, themeIds }),
};

contextBridge.exposeInMainWorld('maestro', api);

export type MaestroBridge = typeof api;
