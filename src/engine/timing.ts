import type { AppConfig, DelayRange, Flow, FlowStep } from '../types/schema.js';

/** Sorteio uniforme dentro da faixa configurada — nunca fixo (RN-008). */
export function randomDelay([min, max]: DelayRange): number {
  return Math.floor(min + Math.random() * (max - min + 1));
}

/** Passo mais específico vence: passo > fluxo > configuração global. */
export function resolveStepDelayRange(step: FlowStep, flow: Flow, config: AppConfig): DelayRange {
  return step.delayMs ?? flow.stepDelayMs ?? config.defaultStepDelayMs;
}

/**
 * Tempo de espera (ms) a aplicar antes de executar `step`, ou 0 para não
 * esperar. Zero em três casos: é o primeiro passo do fluxo (a navegação
 * inicial já absorve o tempo de carregamento), a faixa efetiva está desligada
 * ([0, 0]), ou o próprio passo já é um `waitForTimeout` explícito — nesse
 * caso a espera deliberada do fluxo é o suficiente, não faz sentido somar o
 * delay ambiente em cima dela.
 */
export function computeStepDelay(index: number, step: FlowStep, flow: Flow, config: AppConfig): number {
  if (index === 0) return 0;
  if (step.type === 'waitForTimeout') return 0;

  const [min, max] = resolveStepDelayRange(step, flow, config);
  if (min === 0 && max === 0) return 0;

  return randomDelay([min, max]);
}
