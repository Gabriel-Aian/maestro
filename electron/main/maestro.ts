import { Maestro } from '../../src/index.js';

/**
 * A CLI cria um `Maestro` por comando e desliga no fim. Numa GUI isso não faz
 * sentido: a fila precisa continuar processando enquanto a janela estiver
 * aberta, então existe UMA instância para a vida inteira do app, iniciada em
 * `app.whenReady()` e desligada em `before-quit`.
 */
let instance: Maestro | null = null;

export async function initMaestro(): Promise<Maestro> {
  if (instance) return instance;
  instance = new Maestro();
  await instance.init();
  return instance;
}

export function getMaestro(): Maestro {
  if (!instance) throw new Error('Maestro ainda não foi inicializado (chame initMaestro() em app.whenReady()).');
  return instance;
}

export async function shutdownMaestro(): Promise<void> {
  if (!instance) return;
  await instance.shutdown();
  instance = null;
}
