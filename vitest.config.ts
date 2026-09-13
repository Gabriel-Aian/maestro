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
  },
});
