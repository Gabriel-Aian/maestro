import { BrowserWindow, app, dialog, ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTask } from 'node-cron';
import {
  ScheduleSchema,
  buildInstallArgs,
  expandSearches,
  flowsIndex,
  formatError,
  installWindowsTask,
  loadFlow,
  loadSearchFile,
  profiles,
  schedules,
  uninstallWindowsTask,
  windowsTaskStatus,
  type FlowIndexRow,
  type Profile,
  type Schedule,
  type ScheduleTarget,
} from '../../src/index.js';
import { getMaestro } from './maestro.js';
import type {
  ActionResult,
  CreateScheduleInput,
  CreateScheduleResult,
  PickScheduleSearchFileResult,
  RunScheduleResult,
  ScheduleTargetView,
  ScheduleView,
  WindowsTaskActionResult,
  WindowsTaskStatusResult,
} from '../shared/ipc.js';

/**
 * Mesma técnica do `nextRunOf` da CLI: `createTask` sozinho não agenda nada,
 * só compila a expressão — `getNextRun()` só devolve algo depois de
 * start()/stop() imediatos. Puramente de apresentação, por isso não vive em
 * `src/scheduler/scheduler.ts` (que só cuida de decidir o que já está no
 * horário, não de prever o futuro).
 */
function nextRunOf(cron: string): Date | null {
  const task = createTask(cron, () => undefined);
  try {
    task.start();
    return task.getNextRun();
  } finally {
    void task.stop();
    void task.destroy();
  }
}

function toTargetView(target: ScheduleTarget, allProfiles: Profile[], flows: FlowIndexRow[]): ScheduleTargetView {
  if (target.kind === 'flow') {
    return {
      kind: 'flow',
      flowId: target.flowId,
      flowName: flows.find((f) => f.id === target.flowId)?.name ?? target.flowId,
      profileId: target.profile,
      profileName: allProfiles.find((p) => p.id === target.profile || p.name === target.profile)?.name ?? target.profile,
      variables: target.variables,
    };
  }
  return {
    kind: 'search',
    searchFile: target.searchFile,
    themeIds: target.themeIds ?? null,
    sampleSize: target.sampleSize ?? null,
    engine: target.engine ?? null,
    delayRangeMs: target.delayRangeMs ?? null,
  };
}

function toScheduleView(s: Schedule, allProfiles: Profile[], flows: FlowIndexRow[]): ScheduleView {
  const next = nextRunOf(s.cron);
  return {
    id: s.id,
    name: s.name,
    cron: s.cron,
    enabled: s.enabled,
    target: toTargetView(s.target, allProfiles, flows),
    nextRunAt: next ? next.toISOString() : null,
    lastRunAt: s.lastRunAt,
    lastStatus: s.lastStatus,
  };
}

const dirname = fileURLToPath(new URL('.', import.meta.url));

/**
 * `buildInstallArgs`/`buildTickCommand` só acertam `cliPath` sozinhos quando
 * chamados PELA PRÓPRIA CLI (`process.argv[1]` sendo `dist/cli.js`) — dentro
 * do processo principal do Electron, `process.argv[1]` é outra coisa (a flag
 * de linha de comando do próprio Electron, ou o caminho do `out/main/index.js`,
 * nunca o `dist/cli.js`). Por isso sempre explícito aqui.
 *
 * Em desenvolvimento, `out/main/schedulesIpc.js` e `dist/cli.js` são irmãos
 * dois níveis abaixo da raiz do projeto. Empacotado (electron-builder —
 * `asar: false` de propósito, ver `electron-builder.yml`), a raiz de
 * verdade é `app.getAppPath()`, e não há garantia de `node` na PATH do
 * usuário final (é um app de GUI, não uma ferramenta de desenvolvedor) —
 * por isso roda o próprio executável do Maestro com
 * `ELECTRON_RUN_AS_NODE=1` no lugar de um `node` externo. Testado ao vivo
 * neste ambiente (ver o comentário de `buildTickCommand` em
 * `src/scheduler/windowsTask.ts`): `ELECTRON_RUN_AS_NODE=1 electron
 * dist/cli.js schedule tick` roda exatamente como `node dist/cli.js
 * schedule tick`, `node:sqlite` incluso.
 */
function tickInvocationOptions(): { cliPath: string; nodePath?: string; env?: Record<string, string> } {
  if (app.isPackaged) {
    return {
      cliPath: join(app.getAppPath(), 'dist/cli.js'),
      nodePath: process.execPath,
      env: { ELECTRON_RUN_AS_NODE: '1' },
    };
  }
  return { cliPath: join(dirname, '../../dist/cli.js') };
}

/** Mesma formatação do `schedule install-task --dry-run` da CLI, para mostrar o comando antes de executá-lo de verdade. */
function formatSchtasksCommand(intervalMinutes: number): string {
  const args = buildInstallArgs({ intervalMinutes, ...tickInvocationOptions() });
  const display = args.map((a) => (a.includes(' ') && !a.startsWith('"') ? `"${a}"` : a)).join(' ');
  return `schtasks ${display}`;
}

export function registerScheduleIpcHandlers(): void {
  const listViews = (): ScheduleView[] => {
    const allProfiles = profiles.list();
    const flows = flowsIndex.list();
    return schedules.list().map((s) => toScheduleView(s, allProfiles, flows));
  };

  ipcMain.handle('maestro:schedules:list', (): ScheduleView[] => listViews());

  ipcMain.handle('maestro:schedules:pickSearchFile', async (event): Promise<PickScheduleSearchFileResult | null> => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const dialogOptions: Electron.OpenDialogOptions = {
      title: 'Selecionar arquivo de pesquisas',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    };
    const picked = window ? await dialog.showOpenDialog(window, dialogOptions) : await dialog.showOpenDialog(dialogOptions);
    const filePath = picked.filePaths[0];
    if (picked.canceled || !filePath) return null;

    try {
      const file = loadSearchFile(filePath);
      const expanded = expandSearches(file);
      const counts = new Map<string, number>();
      for (const search of expanded) counts.set(search.themeId, (counts.get(search.themeId) ?? 0) + 1);
      return {
        ok: true,
        filePath,
        themes: file.themes.map((t) => ({ id: t.id, name: t.name, enabled: t.enabled, queryCount: counts.get(t.id) ?? 0 })),
      };
    } catch (err) {
      return { ok: false, reason: formatError(err) };
    }
  });

  ipcMain.handle('maestro:schedules:create', (_event, input: CreateScheduleInput): CreateScheduleResult => {
    try {
      let target: ScheduleTarget;
      if (input.target.kind === 'flow') {
        if (!profiles.find(input.target.profileId)) throw new Error(`Perfil "${input.target.profileId}" não encontrado.`);
        loadFlow(input.target.flowId); // valida que o fluxo existe
        target = { kind: 'flow', flowId: input.target.flowId, profile: input.target.profileId, variables: input.target.variables };
      } else {
        loadSearchFile(input.target.searchFile); // valida o arquivo
        target = {
          kind: 'search',
          searchFile: input.target.searchFile,
          themeIds: input.target.themeIds ?? undefined,
          sampleSize: input.target.sampleSize ?? undefined,
          engine: input.target.engine ?? undefined,
          delayRangeMs: input.target.delayRangeMs ?? undefined,
        };
      }

      const now = new Date().toISOString();
      const saved = ScheduleSchema.parse({
        id: `sched-${randomUUID().slice(0, 8)}`,
        name: input.name,
        cron: input.cron,
        enabled: true,
        target,
        createdAt: now,
        updatedAt: now,
      });

      schedules.insert(saved);
      return { ok: true, schedule: toScheduleView(saved, profiles.list(), flowsIndex.list()) };
    } catch (err) {
      return { ok: false, reason: formatError(err) };
    }
  });

  ipcMain.handle('maestro:schedules:setEnabled', (_event, input: { id: string; enabled: boolean }): ActionResult => {
    if (!schedules.find(input.id)) return { ok: false, reason: 'Agendamento não encontrado.' };
    schedules.setEnabled(input.id, input.enabled);
    return { ok: true };
  });

  ipcMain.handle('maestro:schedules:remove', (_event, id: string): void => {
    schedules.remove(id);
  });

  ipcMain.handle('maestro:schedules:run', (_event, id: string): RunScheduleResult => {
    const s = schedules.find(id);
    if (!s) return { ok: false, reason: 'Agendamento não encontrado.' };
    try {
      const jobs = getMaestro().enqueueSchedule(s);
      return { ok: true, jobIds: jobs.map((j) => j.id) };
    } catch (err) {
      return { ok: false, reason: formatError(err) };
    }
  });

  ipcMain.handle('maestro:schedules:taskStatus', async (): Promise<WindowsTaskStatusResult> => {
    try {
      return { ok: true, ...(await windowsTaskStatus()) };
    } catch (err) {
      return { ok: false, reason: formatError(err) };
    }
  });

  ipcMain.handle('maestro:schedules:installTask', async (_event, intervalMinutes: number): Promise<WindowsTaskActionResult> => {
    try {
      await installWindowsTask({ intervalMinutes, ...tickInvocationOptions() });
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: formatError(err) };
    }
  });

  ipcMain.handle('maestro:schedules:uninstallTask', async (): Promise<WindowsTaskActionResult> => {
    try {
      await uninstallWindowsTask();
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: formatError(err) };
    }
  });

  ipcMain.handle('maestro:schedules:previewInstallCommand', (_event, intervalMinutes: number): string => formatSchtasksCommand(intervalMinutes));
}
