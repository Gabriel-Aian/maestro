import { ipcMain } from 'electron';
import { describeCandidate, flowsIndex, loadFlow, runs, type Flow, type FlowStep } from '../../src/index.js';
import { getMaestro } from './maestro.js';
import type {
  FlowDetailView,
  FlowListItem,
  FlowRunDetail,
  FlowStepResultView,
  RunFlowResult,
} from '../shared/ipc.js';

function toFlowListItem(f: ReturnType<typeof flowsIndex.list>[number]): FlowListItem {
  return {
    id: f.id,
    name: f.name,
    startUrl: f.startUrl,
    stepCount: f.stepCount,
    needsReview: f.needsReview,
    lastStatus: f.lastStatus,
    updatedAt: f.updatedAt,
  };
}

/** Mesma ideia do `describeFirst` da CLI: um resumo de uma linha do alvo do passo. */
function describeStep(step: FlowStep): string {
  switch (step.type) {
    case 'navigate':
      return step.url;
    case 'waitForTimeout':
      return `esperar ${step.ms}ms`;
    case 'press':
      return `tecla "${step.key}"`;
    case 'assertUrl':
      return `URL ${step.operator} "${step.expected}"`;
    case 'screenshot':
      return step.label;
    case 'switchTab':
      return step.matchUrl ?? `aba ${step.tabIndex}`;
    case 'closeTab':
      return '';
    case 'scroll':
      return step.target === 'element' && step.selectors?.length ? describeCandidate(step.selectors[0]!) : `posição (${step.x}, ${step.y})`;
    default:
      return step.selectors[0] ? describeCandidate(step.selectors[0]) : '';
  }
}

function toFlowDetail(flow: Flow): FlowDetailView {
  return {
    id: flow.id,
    name: flow.name,
    startUrl: flow.startUrl,
    needsReview: flow.needsReview,
    variables: flow.variables.map((v) => ({ name: v.name, default: v.default, description: v.description, sensitive: v.sensitive })),
    steps: flow.steps.map((step) => ({
      index: step.index,
      type: step.type,
      summary: describeStep(step),
      note: step.note ?? null,
    })),
  };
}

function toRunDetail(row: Record<string, unknown>): FlowRunDetail {
  const steps = JSON.parse(String(row.steps_json ?? '[]')) as Array<Record<string, unknown>>;
  return {
    runId: String(row.id),
    status: String(row.status),
    startedAt: String(row.started_at),
    finishedAt: row.finished_at ? String(row.finished_at) : null,
    durationMs: row.duration_ms !== null && row.duration_ms !== undefined ? Number(row.duration_ms) : null,
    degraded: Number(row.degraded) === 1,
    error: row.error ? String(row.error) : null,
    blockReason: row.block_reason ? String(row.block_reason) : null,
    artifactsDir: row.artifacts_dir ? String(row.artifacts_dir) : null,
    steps: steps.map(
      (s): FlowStepResultView => ({
        index: Number(s.index),
        type: String(s.type),
        status: s.status as FlowStepResultView['status'],
        degraded: Boolean(s.degraded),
        attempts: Number(s.attempts),
        durationMs: Number(s.durationMs),
        error: s.error ? String(s.error) : null,
      }),
    ),
  };
}

export function registerFlowIpcHandlers(): void {
  ipcMain.handle('maestro:flows:list', (): FlowListItem[] => flowsIndex.list().map(toFlowListItem));

  ipcMain.handle('maestro:flows:get', (_event, id: string): FlowDetailView => toFlowDetail(loadFlow(id)));

  ipcMain.handle(
    'maestro:flows:run',
    (_event, input: { flowId: string; profileId: string; variables: Record<string, string>; headed: boolean }): RunFlowResult => {
      try {
        const job = getMaestro().enqueueFlow(input.flowId, input.profileId, {
          headless: !input.headed,
          variables: input.variables,
        });
        return { ok: true, jobId: job.id };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  ipcMain.handle('maestro:runs:get', (_event, runId: string): FlowRunDetail | null => {
    const row = runs.get(runId);
    return row ? toRunDetail(row) : null;
  });
}
