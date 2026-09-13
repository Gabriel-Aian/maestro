import { defineConfig } from 'vitest/config';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Raiz de dados descartável: os testes nunca tocam o %APPDATA% real do usuário.
const testHome = mkdtempSync(join(tmpdir(), 'maestro-test-'));

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    env: { MAESTRO_HOME: testHome, MAESTRO_LOG_LEVEL: 'silent' },
    /**
     * Todo arquivo de teste aponta para o MESMO `testHome` (mesmo arquivo
     * SQLite) — de propósito, para exercitar o banco real em vez de mocká-lo.
     * O preço é que dois arquivos com `beforeEach` limpando a mesma tabela
     * (ex.: `test/queue.test.ts` e `test/scheduler.test.ts` ambos fazem
     * `DELETE FROM jobs`/`schedules`) não podem rodar em paralelo sem correr o
     * risco de um apagar dado que o outro está no meio de usar — visto ao vivo
     * ao adicionar um teste com espera assíncrona real (`waitForIdle()`) em
     * `test/orchestrator.test.ts`, que falhava de forma intermitente. Rodar os
     * arquivos em série custa pouco (suíte pequena, testes majoritariamente
     * síncronos) e elimina a classe inteira de corrida — bem mais simples do
     * que dar um banco isolado a cada worker.
     */
    fileParallelism: false,
  },
});
