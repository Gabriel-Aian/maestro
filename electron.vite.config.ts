import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

const root = fileURLToPath(new URL('.', import.meta.url));

// `src/` já é o núcleo (CLI, engine, orchestrator — ver CLAUDE.md), então a
// casca Electron mora inteira em `electron/`, com suas próprias convenções
// (main/preload/renderer) em vez das pastas padrão do electron-vite
// (src/main, src/preload, src/renderer), que colidiriam com o núcleo.
export default defineConfig({
  main: {
    build: {
      lib: { entry: resolve(root, 'electron/main/index.ts') },
    },
  },
  preload: {
    build: {
      lib: { entry: resolve(root, 'electron/preload/index.ts') },
      // Força CJS: com `contextIsolation` + `sandbox` ligados (o par correto
      // para expor `contextBridge` com segurança), o preload roda num
      // contexto que não aceita `import`/`export` de verdade, mesmo gerando
      // .mjs — testado ao vivo (Xvfb) e confirmado pelo próprio validador do
      // electron-vite, que só garante suporte a "es" fora do sandbox.
      rollupOptions: { output: { format: 'cjs' } },
    },
  },
  renderer: {
    root: resolve(root, 'electron/renderer'),
    plugins: [react()],
    build: {
      rollupOptions: {
        input: resolve(root, 'electron/renderer/index.html'),
      },
    },
  },
});
