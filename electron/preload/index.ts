import { contextBridge, ipcRenderer } from 'electron';

/**
 * Superfície mínima exposta ao renderer. Cresce tela por tela nas próximas
 * frentes — nada de `nodeIntegration` solto nem `ipcRenderer` cru no
 * renderer, só o que passar por aqui.
 */
const api = {
  getStatus: () => ipcRenderer.invoke('maestro:getStatus'),
};

contextBridge.exposeInMainWorld('maestro', api);

export type MaestroBridge = typeof api;
