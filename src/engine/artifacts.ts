import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext, Page } from 'playwright-core';
import { paths } from '../config/paths.js';
import { logger } from '../logger.js';
import type { RunResult } from '../types/schema.js';

/**
 * Agrupa todos os arquivos gerados por uma execução em um diretório próprio,
 * nomeado pelo id de correlação (RF-067, RNF-025).
 */
export class RunArtifacts {
  readonly dir: string;
  private tracing = false;

  constructor(readonly runId: string) {
    this.dir = paths.runDir(runId);
  }

  init(): void {
    mkdirSync(this.dir, { recursive: true });
  }

  /**
   * Inicia o trace do Playwright (RF-066).
   * O trace grava snapshot de DOM por ação e é a diferença entre diagnosticar
   * uma falha em minutos ou reproduzir manualmente até entender o que quebrou.
   */
  async startTrace(context: BrowserContext, enabled: boolean): Promise<void> {
    if (!enabled) return;
    try {
      await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
      this.tracing = true;
    } catch (err) {
      logger.warn({ err }, 'Não foi possível iniciar o trace; execução segue sem ele');
    }
  }

  async stopTrace(context: BrowserContext): Promise<string | null> {
    if (!this.tracing) return null;
    const path = join(this.dir, 'trace.zip');
    try {
      await context.tracing.stop({ path });
      return path;
    } catch (err) {
      logger.warn({ err }, 'Falha ao gravar o trace');
      return null;
    } finally {
      this.tracing = false;
    }
  }

  /** Screenshot de página inteira (RF-064). */
  async screenshot(page: Page, label: string): Promise<string | null> {
    const path = join(this.dir, `${label}.png`);
    try {
      await page.screenshot({ path, fullPage: true, timeout: 20_000 });
      return path;
    } catch (err) {
      // Página inteira falha em páginas com scroll infinito ou canvas gigante;
      // a viewport ainda é evidência útil, então vale a segunda tentativa.
      logger.warn({ label, err }, 'Screenshot de página inteira falhou; tentando viewport');
      try {
        await page.screenshot({ path, fullPage: false, timeout: 10_000 });
        return path;
      } catch {
        return null;
      }
    }
  }

  /** Evidência de falha: screenshot + HTML da página no momento do erro (RF-065). */
  async captureFailure(page: Page, stepIndex: number): Promise<void> {
    await this.screenshot(page, `failure-step-${stepIndex}`);
    try {
      const html = await page.content();
      writeFileSync(join(this.dir, `failure-step-${stepIndex}.html`), html, 'utf8');
    } catch (err) {
      logger.warn({ stepIndex, err }, 'Não foi possível capturar o HTML da falha');
    }
  }

  writeManifest(result: RunResult): void {
    writeFileSync(join(this.dir, 'run.json'), JSON.stringify(result, null, 2), 'utf8');
  }
}
