# CLAUDE.md

Contexto para o Claude Code trabalhar neste repositório. Leia antes de alterar qualquer coisa.

## O que é

**Maestro** — núcleo de automação web para Windows. Faz duas coisas:

1. **Grava e reproduz fluxos de navegação** em sites que o usuário configura (cliques, digitação, scroll, troca de abas).
2. **Executa pesquisas em lote** a partir de um arquivo JSON organizado por temas, distribuídas entre contas e navegadores.

Usuário único, local-first: nenhum dado sai da máquina, sem backend, sem telemetria.

O `README.md` documenta o uso. O levantamento de requisitos completo (RF-001 a RF-080, RNF-001 a RNF-029, RN-001 a RN-015) foi produzido antes do código e os identificadores aparecem em comentários ao longo dos arquivos — quando encontrar `(RN-005)` ou `(RF-042)`, é referência a esse documento. **Peça-o ao usuário se precisar do texto completo; ele não está versionado aqui.**

## Estado atual

Fases 1 a 4, 6 e 7 do plano estão implementadas. 83 testes passando, typecheck limpo.

| Pronto | Não implementado |
|---|---|
| Detecção de navegadores (Registro do Windows) | Interface Electron |
| Perfis isolados por conta | Editor visual de fluxos |
| Gravador com seletores em cascata | Notificações nativas |
| Compilação/limpeza da gravação | Visualizador comparativo de screenshots |
| Replay com fallback e retries | |
| Detecção de CAPTCHA e parede de login | |
| Fila persistente com serialização por perfil | |
| Delay configurável (passo, fluxo, entre jobs) | |
| Motor de pesquisas com expansão de variáveis | |
| Agendamento (`node-cron` + Agendador de Tarefas do Windows) | |
| CLI cobrindo todas as operações | |
| Casca Electron — fundação + telas de fila, histórico, perfis/navegadores e fluxos | Telas de pesquisas, agendamentos, config |
| | Instalador Windows (electron-builder) |

**Nunca foi executado contra navegador real neste ambiente de desenvolvimento** — não havia Chromium disponível. A lógica pura está testada; o comportamento com Brave/Chrome/Edge foi validado manualmente pelo usuário no Windows dele. **O mesmo vale para `schtasks.exe`**: `schedule install-task`/`uninstall-task`/`task-status` nunca rodaram contra um Agendador de Tarefas real (este ambiente é Linux) — a sintaxe foi escrita com cuidado, mas confirme com `schedule install-task --dry-run` antes de instalar de verdade, e depois com `schedule task-status`.

**A casca Electron, ao contrário do navegador e do `schtasks`, FOI testada de ponta a ponta neste ambiente** — via `Xvfb` (display virtual headless), tanto `electron-vite build` + `electron out/main/index.js --no-sandbox` quanto `electron-vite dev --noSandbox`. Em ambos os casos o renderer chamou o preload, que chamou o processo principal, que chamou o núcleo de verdade (`profiles.list()`, `detectBrowsers()`, etc.) e voltou com dado real. As telas (fila, histórico, perfis, o widget de login, fluxos) também foram verificadas visualmente assim: `webContents.capturePage()` tirando print de janelas invisíveis sob Xvfb, contra um banco semeado com perfis/fluxos/jobs/execuções falsos (incluindo um arquivo de fluxo de verdade em `flows/`, não só a entrada no índice) — inclusive viu a fila real processar jobs semeados, o fluxo de login real falhar corretamente ao tentar abrir um navegador que não existe aqui, e `maestro:flows:run` abortar de verdade por RN-015 (variável obrigatória sem valor) antes de tentar abrir navegador algum. `--no-sandbox`/`--noSandbox` é só para rodar sem privilégio de container aqui; não leve isso para o app real no Windows. **Transparência real de janela (`transparent: true` do widget) não foi confirmada visualmente** — Xvfb não tem compositor, e capturar só o conteúdo da própria janela não revela se o fundo do SO aparece por trás como deveria no Windows real; o que foi confirmado é que a janela abre do tamanho certo, sem moldura, e o conteúdo (cartão escuro semi-transparente, botões) renderiza como projetado.

## Arquitetura

```
src/
├── types/schema.ts       # Zod — FONTE ÚNICA de tipos e validação
├── config/               # raiz de dados (%APPDATA%\Maestro) e AppConfig
├── browsers/
│   ├── detect.ts         # Registro do Windows + fallback por caminho
│   └── launcher.ts       # contexto persistente, lock de perfil, pool, login sem automação
├── recorder/
│   ├── injected.ts       # roda NA PÁGINA — serializado via toString()
│   └── recorder.ts       # sessão + compileEvents() (função pura)
├── engine/
│   ├── selectors.ts      # resolução em cascata, navegação entre frames
│   ├── blockDetection.ts # CAPTCHA e parede de login
│   ├── artifacts.ts      # screenshots, trace, manifesto
│   └── replay.ts         # motor de execução
├── search/               # engines declarativos, validação/expansão, runner
├── queue/queue.ts        # fila em SQLite, com delay entre jobs do mesmo perfil
├── scheduler/
│   ├── scheduler.ts      # isDue()/runDueSchedules() — avaliação pura, node-cron por baixo
│   └── windowsTask.ts    # registro da tarefa única no Agendador do Windows (schtasks)
├── db/index.ts           # migrações + repositórios
├── store/flowStore.ts    # fluxos em arquivo, com versionamento
├── orchestrator.ts       # composição de tudo
├── cli.ts                # interface de linha de comando
└── index.ts              # API pública sem UI (RNF-020) — é o que a casca Electron consome

electron/                 # casca Electron — NÃO faz parte do pacote "maestro-core"
├── shared/ipc.ts         # contrato IPC (tipos + nomes de canal) — main e renderer importam daqui, nunca um do outro
├── main/
│   ├── maestro.ts        # instância ÚNICA de Maestro para a vida do app (não "por comando" como a CLI)
│   ├── ipc.ts             # fila/histórico: ipcMain.handle(...) + repassa eventos (enqueued/started/finished/failed/killed)
│   ├── profilesIpc.ts     # perfis/navegadores/login: mesmo padrão, chamando openProfilePlain (sem automação)
│   ├── loginWidget.ts     # janela flutuante separada que substitui o "pressione Enter" da CLI no login manual
│   ├── flowsIpc.ts        # fluxos: listar/mostrar passos/rodar via maestro.enqueueFlow — resultado buscado por runId, sem widget
│   └── index.ts           # janela principal + ciclo de vida do app; importa src/index.ts DIRETO (fonte, não dist/)
├── preload/index.ts      # contextBridge — única coisa exposta ao renderer
└── renderer/src/
    ├── App.tsx            # shell: sidebar de navegação + tela ativa
    ├── LoginWidget.tsx    # UI da janela flutuante — roteada por hash (#/login-widget), não por um entry point separado
    ├── screens/           # uma tela por arquivo (QueueScreen, HistoryScreen, ProfilesScreen, FlowsScreen, ...)
    └── styles.css         # design system (cores, tabela, badges, botões, widget) — sem framework de UI
```

## Regras que o código assume — não quebre

**`src/recorder/injected.ts` é serializado com `toString()` e executado no navegador.** Ele não pode importar nada, não pode capturar variável do escopo do Node, e não pode usar APIs que não existam no browser. Todos os helpers precisam estar declarados dentro da função `injectedRecorder`. Se você adicionar um `import` usado dentro dela, quebra em runtime sem erro de compilação.

**`compileEvents()` é pura de propósito.** É a lógica mais sujeita a regressão do gravador. Mantenha-a sem I/O para continuar testável sem navegador.

**Uma execução ativa por perfil, sempre (RN-001).** Um `user-data-dir` do Chromium não abre em duas instâncias. A fila garante isso e há teste cobrindo. Não introduza caminho que burle.

**Seletores são tentados em ordem e exigem exatamente um elemento visível e habilitado (RN-005).** Zero ou vários → próximo candidato. Quando um fallback resolve, o passo é marcado como degradado e o fluxo ganha `needsReview` (RN-006) — é o alarme antecipado de que o site mudou.

**A aba ativa é estado mutável da execução** (`ReplaySession` em `replay.ts`). Um clique pode abrir outra aba e todos os passos seguintes devem rodar nela. Nunca volte a capturar `pages()[0]` em variável fixa — foi exatamente esse bug que fazia o fluxo se perder após redirecionamento.

**Nenhuma senha é armazenada, em nenhuma hipótese (RNF-001).** Autenticação é sempre manual, e a sessão persiste no diretório de perfil.

**Não implemente contorno de CAPTCHA nem mascaramento de automação (RNF-006).** Decisão de projeto, não limitação técnica. Ao detectar desafio, a execução para com status `blocked` e o perfil é congelado. Provedores de identidade (Google, Microsoft) recusam login em navegador automatizado por design — a resposta é `profile login`, que abre o navegador **sem** automação para o usuário autenticar como humano.

**A GUI usa `openProfilePlain` (sem automação) para login, nunca `launchProfile` (Playwright).** Decisão explícita do usuário: como o navegador do login não é controlado por CDP, o processo principal não tem nenhuma visibilidade sobre o que acontece dentro dele — por isso o widget flutuante (`electron/main/loginWidget.ts` + `#/login-widget`) em vez de detectar a conclusão sozinho. `maestro:login:complete` reexecuta a mesma checagem de `isProfileLocked` da CLI antes de marcar `authenticated`; não confie em estado do lado do renderer para essa decisão.

**Rodar um fluxo pela GUI é direto, sem widget e sem passo a passo — decisão explícita do usuário.** Diferente do login (que precisa de confirmação humana porque o processo não é controlado), rodar um fluxo é observável de ponta a ponta pela fila real: `FlowsScreen` dispara `maestro.enqueueFlow(...)` e escuta os mesmos eventos de fila já usados em `QueueScreen`/`HistoryScreen`, buscando o `RunResult` completo (`maestro:runs:get`) só quando o job específico termina. Não adicione confirmação por passo aqui — se isso for pedido no futuro, é uma tela nova, não uma alteração desta.

**Agendamento nunca roda headed (RN-007).** A sessão do Windows pode estar bloqueada quando o disparo acontece, e automação visível não funciona nesse cenário. `Maestro.enqueueSchedule()` força `headless: true` incondicionalmente — não adicione uma opção para desligar isso.

**Uma única tarefa no Agendador do Windows, não uma por agendamento.** Ela só chama `maestro schedule tick`, que lê os agendamentos do banco a cada execução e usa `node-cron`'s `createTask(...).match(now)` (sem nunca iniciar o timer interno) para decidir o que disparar. Criar/editar/remover agendamentos nunca precisa tocar o Agendador de Tarefas de novo — só a instalação inicial. Não tente traduzir cada cron para um trigger nativo do `schtasks`; é exatamente o problema que esse design evita.

**O preload do Electron tem que compilar para CJS, nunca ESM — mesmo o pacote sendo `"type": "module"`.** Com `contextIsolation: true` + `sandbox: true` (a combinação certa para expor `contextBridge` com segurança — não enfraqueça isso para "resolver" um erro de preload), o preload roda num contexto que não aceita `import`/`export` de verdade. Testado ao vivo neste ambiente via Xvfb: com saída ESM (`.mjs`, o default do electron-vite quando detecta `"type": "module"`) a janela abre mas o preload falha silenciosamente (`SyntaxError: Cannot use import statement outside a module`) e `window.maestro` fica `undefined` — sem crash, sem aviso óbvio, só a UI quebrada. `electron.vite.config.ts` força `rollupOptions.output.format: 'cjs'` no bloco `preload`, e a saída vira `index.cjs` (não `index.js` — precisa da extensão `.cjs` porque o pacote é `"type": "module"`). Se trocar esse arquivo de posição ou nome, ajuste a referência hardcoded em `electron/main/index.ts`.

**`package.json` precisa do campo `"main"` apontando para `out/main/index.js`.** É só o que `electron-vite dev`/`preview` usam para saber o que rodar — não interfere no consumo do pacote como biblioteca (`exports` continua valendo para isso) nem no `bin` da CLI.

**Existe UMA instância de `Maestro` para a vida inteira do processo principal (`electron/main/maestro.ts`), não uma por ação como na CLI.** A fila precisa continuar processando com a janela aberta; `initMaestro()` roda em `app.whenReady()`, `shutdownMaestro()` em `before-quit` (com `event.preventDefault()` até o desligamento terminar, para não abandonar contexto de perfil aberto). Qualquer tela nova pega o `Maestro` via `getMaestro()`, nunca cria o seu próprio.

**As telas não fazem polling — reagem aos eventos da fila.** `electron/main/ipc.ts` liga `maestro.queue.on(...)` a um broadcast (`QUEUE_EVENT_CHANNEL`) para todas as janelas; o renderer assina via `window.maestro.onQueueEvent(...)` e simplesmente reconsulta a lista inteira a cada evento (`QueueScreen`, `HistoryScreen`). É uma escolha deliberada pela simplicidade: reconsultar do SQLite local é barato e evita bugs de estado dessincronizado — não troque por patch incremental de estado sem um motivo concreto.

## Decisões técnicas e seus porquês

**`node:sqlite` em vez de `better-sqlite3`.** O nativo exige recompilar para a ABI do Electron a cada atualização, que é a maior dor no empacotamento. A camada está isolada em `src/db/index.ts` — trocar é alterar só esse arquivo. O módulo ainda é experimental no Node 22; o aviso é filtrado no topo de `cli.ts`.

**`playwright-core`, não `playwright`.** Controla os navegadores já instalados na máquina; não baixa Chromium.

**`chromiumSandbox: true` explícito.** O Playwright desliga o sandbox por padrão, o que exibe faixa de aviso e reduz o isolamento de processos. Como o navegador é o do próprio usuário, manter ligado é o certo.

**Orçamento de timeout assimétrico na resolução de seletores.** O primeiro candidato recebe o timeout cheio (absorve a espera de carregamento); os demais recebem sondagens curtas. Dar 15s a cada um dos oito candidatos transformaria uma falha em dois minutos.

**Detecção de parede de login precisa da URL pretendida.** Sem ela não dá para distinguir "fui redirecionado para o login" de "o fluxo visita o login de propósito". Padrões genéricos (`/login`, `/auth`) só bloqueiam quando há desvio confirmado; provedores de identidade bloqueiam sempre.

## Comandos

```bash
npm install
npm run build        # tsc
npm run typecheck    # tsc --noEmit
npm test             # vitest, 83 testes
npm run dev -- <cmd> # roda a CLI direto do TS

node dist/cli.js doctor
node dist/cli.js profile add conta-1 --browser brave
node dist/cli.js profile login conta-1 --url https://site.com   # login SEM automação
node dist/cli.js record "Fluxo" --url https://site.com --profile conta-1
node dist/cli.js flow show <id>
node dist/cli.js flow run <id> --profile conta-1 --step
node dist/cli.js search validate examples/searches.example.json

node dist/cli.js schedule add "Diário 9h" --cron "30 9 * * *" --flow <id> --profile conta-1
node dist/cli.js schedule run <id>              # dispara agora, ignorando o cron — teste antes de confiar
node dist/cli.js schedule install-task --dry-run  # mostra o comando schtasks sem instalar nada
node dist/cli.js schedule install-task            # Windows: registra a tarefa única que roda "schedule tick"

npm run electron:dev        # electron-vite dev — janela + HMR do renderer
npm run electron:build      # electron-vite build — gera out/{main,preload,renderer}
npm run electron:typecheck  # tsc sobre electron/ (main+preload e renderer, tsconfigs separados)
```

No Windows com PowerShell, se `npm` for bloqueado por política de execução, use `npm.cmd`.

## Testes

- `test/injected.test.ts` — geração de seletores sob jsdom. Contém um truque necessário: o gravador exige `isTrusted`, e jsdom zera essa flag no dispatch. A solução é marcar a implementação interna via `Symbol(impl)` em listener no Window, que roda antes dos listeners do document. Está comentado no arquivo.
- `test/compile.test.ts` — coalescência e troca de abas.
- `test/blockDetection.test.ts` — falsos positivos de login, CAPTCHA.
- `test/queue.test.ts` — invariantes de escalonamento com handler falso, incluindo o delay entre jobs do mesmo perfil.
- `test/searchFile.test.ts` — validação, herança, expansão.
- `test/timing.test.ts` — precedência de delay (passo > fluxo > global) e conversão de intervalos gravados em passos reais.
- `test/scheduler.test.ts` — `isDue`/idempotência do tick/isolamento de falha; construção do comando `schtasks` sem executá-lo.

`vitest.config.ts` cria um `MAESTRO_HOME` descartável: os testes nunca tocam o `%APPDATA%` real.

## Próximos passos sugeridos, em ordem

1. **Validar o gravador em sites reais.** É o maior risco aberto. Peça ao usuário o `flow show` de fluxos gravados em sites de verdade e calibre as heurísticas de `injected.ts` em cima dos casos concretos — especialmente `looksGenerated()`, que pode estar descartando identificadores válidos ou aceitando gerados.
2. **Validar o agendamento no Windows real.** Segundo maior risco aberto, mesma natureza do item 1: `schedule install-task`/`tick` nunca rodaram contra um Agendador de Tarefas de verdade. Peça ao usuário para instalar com `--dry-run` primeiro, depois de verdade, e conferir com `schedule task-status` e `schedule list` (próxima janela calculada) se bate com o Agendador de Tarefas nativo do Windows.
3. **Editor de fluxos (fase 5, RF-031 a RF-039).** Remover passos, reordenar, parametrizar valores em variáveis, inserir esperas e asserções. Hoje só dá para editar o JSON à mão.
4. **Telas da casca Electron, na ordem combinada com o usuário: ~~fila/histórico~~ ~~perfis/navegadores~~ ~~fluxos~~ (prontas) → pesquisas → agendamentos → configurações → empacotamento (electron-builder, instalador Windows).** Padrão a repetir para cada uma: `electron/shared/ipc.ts` (contrato) → handler em `electron/main/*Ipc.ts` (busca do núcleo real, sem caminho paralelo) → método no preload → tela em `electron/renderer/src/screens/`. Pesquisas é a próxima: reaproveita `expandSearches`/`loadSearchFile` do núcleo, mas o arquivo de pesquisas hoje só existe como JSON escrito à mão — decidir se a GUI edita esse arquivo diretamente ou só valida/roda um caminho já existente no disco.
5. **Retenção e métricas na UI (RF-071 a RF-077).** A lógica existe (`Maestro.cleanupArtifacts()`, `runs.stats()`), falta superfície.

## Pontos em aberto com o usuário

- Natureza dos sites alvo dos fluxos — afeta esforço de antidetecção e estratégia de espera.
- Volume esperado (pesquisas/dia, fluxos/dia) — dimensiona pool de workers e retenção.
- Aplicativo Android foi explicitamente adiado: seria RPA on-device sobre apps nativos via Accessibility Service, arquitetura sem nada em comum com esta. Projeto separado.

## Avisos que devem continuar visíveis ao usuário

Automatizar mecanismos de busca com contas autenticadas contraria os termos de uso da maioria dos provedores; a conta pode ser sinalizada ou suspensa. Os atrasos aleatórios e a parada em bloqueio mitigam o padrão de acesso, não eliminam o risco. Para rank tracking ou coleta de preços, API oficial costuma sair mais barata que manter isso de pé.
