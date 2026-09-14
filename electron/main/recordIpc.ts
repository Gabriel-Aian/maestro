import { BrowserWindow, ipcMain } from 'electron';
import type { BrowserContext } from 'playwright-core';
import { RecordingSession, formatError, launchProfile, materializeTimingSteps, profiles, saveFlow } from '../../src/index.js';
import { getMaestro } from './maestro.js';
import {
  RECORD_EVENT_CHANNEL,
  type RecordFlowCancelResult,
  type RecordFlowStartInput,
  type RecordFlowStartResult,
  type RecordFlowStatusView,
  type RecordFlowStopResult,
} from '../shared/ipc.js';

/**
 * Só uma gravação ativa por vez no processo principal — mesmo espírito de
 * RN-001 (o próprio `launchProfile` já rejeita abrir o mesmo perfil duas
 * vezes; isso aqui é só para não perder silenciosamente uma sessão de
 * gravação em andamento se o usuário clicar "Gravar" de novo).
 */
interface ActiveRecording {
  session: RecordingSession;
  context: BrowserContext;
  name: string;
  startUrl: string;
  profileName: string;
  convertTimings: boolean;
  startedAt: string;
}

let active: ActiveRecording | null = null;

function toStatusView(): RecordFlowStatusView {
  if (!active) return { recording: false, name: null, startUrl: null, profileName: null, startedAt: null, eventCount: 0 };
  return {
    recording: true,
    name: active.name,
    startUrl: active.startUrl,
    profileName: active.profileName,
    startedAt: active.startedAt,
    eventCount: active.session.eventCount,
  };
}

function broadcastStatus(): void {
  const status = toStatusView();
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(RECORD_EVENT_CHANNEL, status);
  }
}

/**
 * Fecha uma gravação em andamento sem salvar nada — chamado em `before-quit`
 * (`electron/main/index.ts`), mesmo cuidado que `shutdownMaestro()` já tem
 * com a fila: sem isso, fechar a janela com uma gravação ativa abandonaria o
 * processo do navegador aberto e o `SingletonLock` do perfil, bloqueando-o
 * até alguém apagar o arquivo manualmente.
 */
export async function closeActiveRecording(): Promise<void> {
  if (!active) return;
  await active.context.close().catch(() => undefined);
  active = null;
}

export function registerRecordIpcHandlers(): void {
  ipcMain.handle('maestro:record:status', (): RecordFlowStatusView => toStatusView());

  ipcMain.handle('maestro:record:start', async (_event, input: RecordFlowStartInput): Promise<RecordFlowStartResult> => {
    if (active) return { ok: false, reason: 'Já existe uma gravação em andamento. Encerre-a antes de iniciar outra.' };

    const name = input.name.trim();
    if (!name) return { ok: false, reason: 'Dê um nome ao fluxo.' };

    const profile = profiles.find(input.profileId);
    if (!profile) return { ok: false, reason: 'Perfil não encontrado.' };

    let context: BrowserContext;
    try {
      context = await launchProfile({
        profile,
        executablePath: getMaestro().resolveExecutable(profile.browserId),
        headless: false, // gravação depende de interação real, igual à CLI (`maestro record`)
        viewport: getMaestro().config.defaultViewport,
        allowUnauthenticated: true,
      });
    } catch (err) {
      return { ok: false, reason: formatError(err) };
    }

    try {
      const session = await RecordingSession.start({
        context,
        name,
        startUrl: input.startUrl,
        // Sem isso a tela ficaria sem nenhum sinal de vida até o usuário
        // clicar em "Parar" — reage a cada evento em vez de fazer polling,
        // mesmo padrão de `QUEUE_EVENT_CHANNEL`.
        onEvent: () => broadcastStatus(),
      });
      active = {
        session,
        context,
        name,
        startUrl: input.startUrl,
        profileName: profile.name,
        convertTimings: input.convertTimings,
        startedAt: new Date().toISOString(),
      };
    } catch (err) {
      await context.close();
      return { ok: false, reason: formatError(err) };
    }

    broadcastStatus();
    return { ok: true };
  });

  ipcMain.handle('maestro:record:stop', async (): Promise<RecordFlowStopResult> => {
    if (!active) return { ok: false, reason: 'Nenhuma gravação em andamento.' };
    const { session, context, convertTimings } = active;

    try {
      const flow = await session.stop();
      const steps = convertTimings ? materializeTimingSteps(flow.steps) : flow.steps;
      const saved = saveFlow({ ...flow, steps });
      const redactedCount = saved.steps.filter((s) => s.type === 'type' && s.redacted).length;
      return { ok: true, flowId: saved.id, flowName: saved.name, stepCount: saved.steps.length, needsReview: saved.needsReview, redactedCount };
    } catch (err) {
      return { ok: false, reason: formatError(err) };
    } finally {
      await context.close();
      active = null;
      broadcastStatus();
    }
  });

  ipcMain.handle('maestro:record:cancel', async (): Promise<RecordFlowCancelResult> => {
    if (!active) return { ok: false, reason: 'Nenhuma gravação em andamento.' };
    await active.context.close();
    active = null;
    broadcastStatus();
    return { ok: true };
  });
}
