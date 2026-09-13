import { describe, it, expect } from 'vitest';
import { computeStepDelay, resolveStepDelayRange, randomDelay } from '../src/engine/timing.js';
import { materializeTimingSteps } from '../src/recorder/recorder.js';
import { AppConfigSchema, FlowSchema, type AppConfig, type Flow, type FlowStep } from '../src/types/schema.js';

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return AppConfigSchema.parse(overrides);
}

function flow(steps: FlowStep[], overrides: Partial<Flow> = {}): Flow {
  return FlowSchema.parse({
    schemaVersion: 1,
    id: 'flow-1',
    name: 'Fluxo de teste',
    startUrl: 'https://exemplo.com',
    steps,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  });
}

function clickStep(overrides: Partial<FlowStep> = {}): FlowStep {
  return {
    type: 'click',
    index: 0,
    frame: [],
    timeoutMs: 15_000,
    onFailure: 'abort',
    maxRetries: 2,
    screenshot: false,
    selectors: [{ kind: 'css', value: '#botao', stability: 50 }],
    button: 'left',
    ...overrides,
  } as FlowStep;
}

function waitStep(ms: number, overrides: Partial<FlowStep> = {}): FlowStep {
  return {
    type: 'waitForTimeout',
    index: 0,
    frame: [],
    timeoutMs: 15_000,
    onFailure: 'abort',
    maxRetries: 2,
    screenshot: false,
    ms,
    ...overrides,
  } as FlowStep;
}

describe('randomDelay', () => {
  it('nunca sorteia fora da faixa', () => {
    for (let i = 0; i < 50; i += 1) {
      const value = randomDelay([100, 200]);
      expect(value).toBeGreaterThanOrEqual(100);
      expect(value).toBeLessThanOrEqual(200);
    }
  });

  it('faixa fixa sempre devolve o mesmo valor', () => {
    expect(randomDelay([500, 500])).toBe(500);
  });
});

describe('resolveStepDelayRange — precedência passo > fluxo > global', () => {
  it('usa a configuração global quando fluxo e passo não definem nada', () => {
    const range = resolveStepDelayRange(clickStep(), flow([clickStep()]), config({ defaultStepDelayMs: [1_000, 2_000] }));
    expect(range).toEqual([1_000, 2_000]);
  });

  it('o fluxo sobrepõe a configuração global', () => {
    const f = flow([clickStep()], { stepDelayMs: [3_000, 4_000] });
    const range = resolveStepDelayRange(clickStep(), f, config({ defaultStepDelayMs: [1_000, 2_000] }));
    expect(range).toEqual([3_000, 4_000]);
  });

  it('o passo sobrepõe o fluxo e a configuração global', () => {
    const step = clickStep({ delayMs: [9_000, 9_500] });
    const f = flow([step], { stepDelayMs: [3_000, 4_000] });
    const range = resolveStepDelayRange(step, f, config({ defaultStepDelayMs: [1_000, 2_000] }));
    expect(range).toEqual([9_000, 9_500]);
  });
});

describe('computeStepDelay', () => {
  it('não espera antes do primeiro passo do fluxo', () => {
    const step = clickStep({ index: 0 });
    const f = flow([step], { stepDelayMs: [5_000, 5_000] });
    expect(computeStepDelay(0, step, f, config())).toBe(0);
  });

  it('não espera quando a faixa efetiva é [0, 0] (recurso desligado)', () => {
    const step = clickStep({ index: 1 });
    const f = flow([clickStep(), step]);
    expect(computeStepDelay(1, step, f, config())).toBe(0);
  });

  it('não soma delay ambiente em cima de um waitForTimeout explícito', () => {
    const step = waitStep(2_000, { index: 1 });
    const f = flow([clickStep(), step], { stepDelayMs: [5_000, 5_000] });
    expect(computeStepDelay(1, step, f, config())).toBe(0);
  });

  it('aplica a faixa efetiva quando ligada e não é o primeiro passo nem um wait explícito', () => {
    const step = clickStep({ index: 1 });
    const f = flow([clickStep(), step], { stepDelayMs: [1_000, 1_000] });
    expect(computeStepDelay(1, step, f, config())).toBe(1_000);
  });
});

describe('materializeTimingSteps', () => {
  it('insere um waitForTimeout antes do passo cujo intervalo alcança o limiar', () => {
    const steps = [clickStep({ index: 0 }), clickStep({ index: 1, recordedGapMs: 8_000 })];
    const result = materializeTimingSteps(steps);

    expect(result.map((s) => s.type)).toEqual(['click', 'waitForTimeout', 'click']);
    expect(result[1]).toMatchObject({ type: 'waitForTimeout', ms: 8_000 });
    expect(result.map((s) => s.index)).toEqual([0, 1, 2]);
  });

  it('ignora intervalos abaixo do limiar mínimo', () => {
    const steps = [clickStep({ index: 0 }), clickStep({ index: 1, recordedGapMs: 500 })];
    const result = materializeTimingSteps(steps);

    expect(result.map((s) => s.type)).toEqual(['click', 'click']);
  });

  it('aplica o teto máximo a um intervalo muito longo', () => {
    const steps = [clickStep({ index: 0 }), clickStep({ index: 1, recordedGapMs: 120_000 })];
    const result = materializeTimingSteps(steps);

    expect(result[1]).toMatchObject({ type: 'waitForTimeout', ms: 30_000 });
  });

  it('respeita limiares customizados', () => {
    const steps = [clickStep({ index: 0 }), clickStep({ index: 1, recordedGapMs: 1_500 })];
    const result = materializeTimingSteps(steps, { minMs: 1_000, maxMs: 5_000 });

    expect(result.map((s) => s.type)).toEqual(['click', 'waitForTimeout', 'click']);
    expect(result[1]).toMatchObject({ ms: 1_500 });
  });

  it('não insere nada quando nenhum passo tem intervalo gravado', () => {
    const steps = [clickStep({ index: 0 }), clickStep({ index: 1 })];
    const result = materializeTimingSteps(steps);

    expect(result).toHaveLength(2);
  });

  it('é idempotente: rodar de novo sobre o resultado não duplica o wait', () => {
    const steps = [clickStep({ index: 0 }), clickStep({ index: 1, recordedGapMs: 8_000 })];
    const once = materializeTimingSteps(steps);
    const twice = materializeTimingSteps(once);

    expect(twice.map((s) => s.type)).toEqual(['click', 'waitForTimeout', 'click']);
  });
});
