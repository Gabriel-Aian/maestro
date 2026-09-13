# CLAUDE.md

Contexto para o Claude Code trabalhar neste repositório. Leia antes de alterar qualquer coisa.

## O que é

**Maestro** — núcleo de automação web para Windows. Faz duas coisas:

1. **Grava e reproduz fluxos de navegação** em sites que o usuário configura (cliques, digitação, scroll, troca de abas).
2. **Executa pesquisas em lote** a partir de um arquivo JSON organizado por temas, distribuídas entre contas e navegadores.

Usuário único, local-first: nenhum dado sai da máquina, sem backend, sem telemetria.

O `README.md` documenta o uso. O levantamento de requisitos completo (RF-001 a RF-080, RNF-001 a RNF-029, RN-001 a RN-015) foi produzido antes do código e os identificadores aparecem em comentários ao longo dos arquivos — quando encontrar `(RN-005)` ou `(RF-042)`, é referência a esse documento. **Peça-o ao usuário se precisar do texto completo; ele não está versionado aqui.**

## Estado atual

Fases 1 a 4, 6 e 7 do plano estão implementadas. 93 testes passando, typecheck limpo.

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
| Casca Electron — fundação + todas as telas (fila, histórico, perfis/navegadores, fluxos, pesquisas, agendamentos, configurações) | |
| | Instalador Windows (electron-builder) |

**Nunca foi executado contra navegador real neste ambiente de desenvolvimento** — não havia Chromium disponível. A lógica pura está testada; o comportamento com Brave/Chrome/Edge foi validado manualmente pelo usuário no Windows dele. **O mesmo vale para `schtasks.exe`**: `schedule install-task`/`uninstall-task`/`task-status` nunca rodaram contra um Agendador de Tarefas real (este ambiente é Linux) — a sintaxe foi escrita com cuidado, mas confirme com `schedule install-task --dry-run` antes de instalar de verdade, e depois com `schedule task-status`.

**A casca Electron, ao contrário do navegador e do `schtasks`, FOI testada de ponta a ponta neste ambiente** — via `Xvfb` (display virtual headless), tanto `electron-vite build` + `electron out/main/index.js --no-sandbox` quanto `electron-vite dev --noSandbox`. Em ambos os casos o renderer chamou o preload, que chamou o processo principal, que chamou o núcleo de verdade (`profiles.list()`, `detectBrowsers()`, etc.) e voltou com dado real. As telas (fila, histórico, perfis, o widget de login, fluxos, pesquisas, agendamentos, configurações) também foram verificadas visualmente assim: `webContents.capturePage()` tirando print de janelas invisíveis sob Xvfb, contra um banco semeado com perfis/fluxos/jobs/execuções/agendamentos falsos (incluindo um arquivo de fluxo de verdade em `flows/`, não só a entrada no índice) — inclusive viu a fila real processar jobs semeados, o fluxo de login real falhar corretamente ao tentar abrir um navegador que não existe aqui, `maestro:flows:run` abortar de verdade por RN-015 (variável obrigatória sem valor) antes de tentar abrir navegador algum, (na tela de Pesquisas) um job de busca falhar de verdade por navegador não detectado com a mensagem de erro real chegando até a tabela de resultado, (na tela de Agendamentos) um agendamento criado, disparado com "Rodar agora", falhando pelo mesmo motivo (navegador não detectado) e a "última execução" atualizando sozinha para "falhou" assim que o job terminou, e (na tela de Configurações) um valor salvo persistindo de verdade entre um relançamento completo do processo Electron, e uma violação de limite do schema (`AppConfigSchema`) aparecendo como mensagem legível em vez do array de issues cru do Zod. `--no-sandbox`/`--noSandbox` é só para rodar sem privilégio de container aqui; não leve isso para o app real no Windows. **Transparência real de janela (`transparent: true` do widget) não foi confirmada visualmente** — Xvfb não tem compositor, e capturar só o conteúdo da própria janela não revela se o fundo do SO aparece por trás como deveria no Windows real; o que foi confirmado é que a janela abre do tamanho certo, sem moldura, e o conteúdo (cartão escuro semi-transparente, botões) renderiza como projetado. **Diálogos nativos bloqueantes (`dialog.showOpenDialog`, `window.confirm`) não dão para verificar por screenshot sob Xvfb** — sob este ambiente eles ficam pendurados esperando uma resposta que nunca chega (confirmado tentando; o processo precisou ser morto após o timeout). Esse é um limite conhecido do método, não um bug: esses caminhos (selecionar arquivo de pesquisas num agendamento, confirmar instalação/remoção da tarefa do Windows, confirmar remoção de agendamento/perfil) são verificados por revisão de código e por reutilizarem o mesmo padrão já testado interativamente em telas anteriores (`SearchesScreen`, `ProfilesScreen`, `QueueScreen`), não por screenshot direto.

**Essa verificação por Xvfb já encontrou e corrigiu bugs reais, não hipotéticos, em mais de uma frente** — vale a pena continuar usando o mesmo método para as próximas telas em vez de confiar só em typecheck/testes. Na tela de Pesquisas:
1. `Maestro.enqueueSearches` enfileirava jobs de perfis anteriores antes de validar os seguintes — um perfil inválido no meio do lote deixava jobs de perfis válidos já rodando (corrigido em `src/orchestrator.ts`, ver regra abaixo).
2. Uma tela que só assina eventos de fila depois de descobrir o `jobId` (dentro de um `useEffect([jobId])`, ou um estado só populado após o `await` da chamada que criou o job) pode perder para sempre a conclusão de um job que falha na hora — o evento chega antes da assinatura existir (corrigido com `electron/renderer/src/jobEvents.ts`, ver regra abaixo).
3. Os eventos `finished`/`failed` da fila (`electron/main/ipc.ts`) repassavam o objeto `Job` em memória, que nunca é atualizado com o desfecho real — `status`/`runId`/`error` ficavam com o valor de quando o job entrou em execução. A mensagem de erro de verdade só existe no segundo argumento do evento (ver regra abaixo).

Na tela de Agendamentos:
4. `SchedulesScreen` não assinava eventos de fila — "Rodar agora" enfileira e retorna na hora, mas o job termina depois, de forma assíncrona; sem reagir aos eventos (mesmo padrão de `QueueScreen`/`HistoryScreen`), a coluna "última execução" ficava presa em "nunca rodou" para sempre.
5. **Mais fundo, um bug de verdade no núcleo, não só na GUI**: `Maestro.handle()` só grava `schedules.lastRunAt`/`lastStatus` (via `recordOutcome`) quando o job produz um `RunResult` — mas um job pode lançar ANTES disso (perfil travado, navegador não detectado, timeout), e nesse caminho `recordOutcome` nunca roda. Um agendamento cujo alvo falha sistematicamente (ex.: navegador nunca detectado) ficava marcado como "nunca rodou" para sempre, mesmo disparando — e falhando — a cada tick, sem forma nenhuma de o usuário perceber pela CLI OU pela GUI. Corrigido envolvendo o corpo de `handle()` num try/catch que grava a falha no agendamento antes de relançar o erro (ver regra abaixo). Coberto por `test/orchestrator.test.ts`.
6. **Outro bug de núcleo, também não específico da GUI**: `buildTickCommand()` (`src/scheduler/windowsTask.ts`) usava `process.execPath` como default do caminho do `node` — correto quando quem chama é a própria CLI (`node dist/cli.js schedule install-task`), mas dentro do processo principal do Electron `process.execPath` aponta para o executável do Electron, não para o `node`. O botão "Instalar tarefa" da GUI teria registrado uma tarefa do Windows que nunca funcionaria. Corrigido trocando o default para o nome puro `"node"` (resolvido pela PATH do Windows, igual a digitar `node ...` num terminal) — ver regra abaixo. Coberto por `test/scheduler.test.ts`.
7. Achado ao escrever o teste do item 5: os arquivos de teste compartilham o MESMO arquivo SQLite (`vitest.config.ts`) e rodavam em paralelo (workers separados) — dois arquivos com `beforeEach` limpando a mesma tabela (`test/queue.test.ts` e `test/scheduler.test.ts` ambos fazem `DELETE FROM jobs`/`schedules`) podiam se atropelar durante uma espera assíncrona real (`waitForIdle()`), causando falha intermitente. Corrigido com `fileParallelism: false` em `vitest.config.ts` — suíte pequena e majoritariamente síncrona, o custo é desprezível perto de eliminar a classe inteira de corrida.

Na tela de Configurações:
8. **Bug de núcleo que afeta a GUI inteira, não só Configurações**: a instância de `Maestro` da GUI vive pela vida inteira do app (`electron/main/maestro.ts`), mas `this.config` era só o valor lido na hora da construção — nada nunca escrevia de volta nela. Antes desta frente, o botão "Registrar caminho" da tela de Perfis já sofria disso silenciosamente: `saveConfig(...)` gravava no disco, mas o `browserPaths` em memória usado por `resolveExecutable()` só via a mudança depois de reiniciar o app. Corrigido com `Maestro.updateConfig()` (ver regra abaixo), que a tela de Configurações usa para tudo e que `profilesIpc.ts` agora também usa em vez de `saveConfig()` direto. Coberto por `test/orchestrator.test.ts`.
9. `AppConfigSchema.parse(...)` rejeitando um valor (ex.: um campo acima do limite permitido) chegava na tela como o array de issues do Zod inteiro, serializado em JSON cru (`[ { "code": "too_big", ... } ]`) — `ZodError.message` é isso mesmo, não uma frase pronta. O mesmo bug já existia (e continua existindo em qualquer lugar que não passe por `formatError`) na CLI inteira: `schedule add --cron "invalido"` mostra o mesmo JSON cru hoje. Corrigido com `formatError()` (`src/errors.ts`), agora usado por TODOS os catches de erro tanto na CLI (`fail(...)`) quanto em todo `electron/main/*Ipc.ts`. Coberto por `test/errors.test.ts`.

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
├── errors.ts             # formatError() — nunca deixa um ZodError cru virar mensagem de usuário
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
│   ├── searchIpc.ts       # pesquisas: só aponta para arquivo já existente (getLast/pickFile/reload/openFolder) + roda via maestro.enqueueSearches
│   ├── schedulesIpc.ts    # agendamentos: CRUD + rodar agora + status/instalar/remover a tarefa do Windows (schtasks)
│   ├── settingsIpc.ts     # configurações: get/getDefaults/update — update passa por Maestro.updateConfig(), nunca saveConfig() direto
│   ├── prefs.ts           # preferências só da GUI (ex.: último arquivo de pesquisas), separadas do AppConfig do núcleo
│   └── index.ts           # janela principal + ciclo de vida do app; importa src/index.ts DIRETO (fonte, não dist/)
├── preload/index.ts      # contextBridge — única coisa exposta ao renderer
└── renderer/src/
    ├── App.tsx            # shell: sidebar de navegação + tela ativa
    ├── LoginWidget.tsx    # UI da janela flutuante — roteada por hash (#/login-widget), não por um entry point separado
    ├── jobEvents.ts       # buffer de conclusões de job + hook useJobEvents — ver regra abaixo antes de mexer
    ├── screens/           # uma tela por arquivo (QueueScreen, HistoryScreen, ProfilesScreen, FlowsScreen, SearchesScreen, SchedulesScreen, SettingsScreen, ...)
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

**Os eventos `finished`/`failed` de `JobQueue` (`src/queue/queue.ts`) carregam o objeto `Job` OBSOLETO como primeiro argumento.** `this.finish(jobId, status, runId, error)` só grava o desfecho no SQLite — nunca muta o `Job` em memória que foi passado para `this.emit(...)`. O dado de verdade está no segundo argumento: `RunResult` inteiro em `finished`, a mensagem de erro (`string`) em `failed`. `electron/main/ipc.ts` já trata isso: `toQueueJobView(job, ..., overrides)` aceita `{ status, runId, error }` e os listeners de `finished`/`failed` sempre passam esse override construído a partir do segundo argumento do evento — nunca do `job` sozinho. Qualquer novo listener desses dois eventos (aqui ou em código futuro) precisa do mesmo cuidado; foi um bug real (a coluna de erro da tela de Pesquisas ficava em branco mesmo com o job corretamente marcado como "falhou").

**Buffer de conclusão de job no renderer (`electron/renderer/src/jobEvents.ts`) — não troque por "assinar só depois de saber o jobId".** Um job pode falhar sincronamente (ex.: `resolveExecutable` lançando antes de qualquer I/O) e seu evento de fila pode chegar ANTES da chamada que o criou (`runFlow`/`runSearch`) sequer retornar no renderer. `useJobEvents(...)` assina desde o mount (efeito sem dependências) e guarda toda conclusão num `Map` module-level; `consumeJobCompletion(jobId)` é para ser chamado logo ao descobrir um `jobId` novo, para pegar uma conclusão que já tenha chegado antes. Usado por `FlowsScreen` e `SearchesScreen`; qualquer tela nova que dispare um job pela fila e precise saber quando ele termina deve reusar esse módulo, não reinventar um `useEffect([jobId])` que só assina depois — foi exatamente esse padrão que prendia a tela em "Executando…"/"em execução" para sempre num job que falhasse rápido demais.

**`Maestro.enqueueSearches` resolve TODOS os perfis do lote antes de enfileirar qualquer job — mesmo princípio de RN-015 aplicado a lote.** Pesquisas são agrupadas por perfil e um job é criado por grupo; se a validação (`requireProfile`, que barra `session_expired` por RN-004) acontecesse dentro do mesmo laço que enfileira, um perfil inválido no meio do `Map` deixava os jobs de perfis anteriores já enfileirados e rodando, com o chamador vendo só uma exceção sem saber que algo tinha sido efetivamente disparado. A correção resolve todos os perfis num passo anterior e só então enfileira — tudo ou nada. Não volte a interlear validação com enfileiramento aqui. Coberto por `test/orchestrator.test.ts`.

**Preferências só da GUI (`electron/main/prefs.ts`) são um arquivo à parte (`gui-prefs.json`) do `AppConfig` do núcleo.** Coisas que só fazem sentido para a casca Electron — hoje, o último arquivo de pesquisas selecionado — não pertencem ao `AppConfig` (que a CLI também lê/escreve e não tem esse conceito). Se uma tela futura precisar lembrar de alguma escolha do usuário entre sessões, adicione o campo em `GuiPrefs`, não sobrecarregue o `AppConfig`.

**A tela de Pesquisas nunca edita o conteúdo do arquivo de pesquisas — só aponta para um arquivo já existente no disco.** Decisão explícita do usuário: `searchIpc.ts` expõe `pickFile` (diálogo nativo, só seleciona), `reload` (relê o mesmo caminho) e `openFolder` (`shell.showItemInFolder`, atalho para o usuário editar com o editor dele). `SearchesScreen` recarrega sozinha no evento `focus` da janela, para que "editar por fora e voltar" funcione sem precisar clicar em "Recarregar". Não adicione um editor de JSON embutido aqui — se isso for pedido no futuro, é uma mudança de escopo explícita, não uma evolução natural desta tela.

**`Maestro.handle()` grava a falha no agendamento mesmo quando o job lança antes de produzir um `RunResult`.** `recordOutcome()` (que persiste `schedules.lastRunAt`/`lastStatus`) só roda depois de um `RunResult` existir — mas perfil travado, navegador não detectado ou timeout lançam antes disso. `handle()` envolve o corpo inteiro num try/catch cujo `catch` chama `recordScheduleFailure(job, signal)`, que olha `job.payload.scheduleId` e grava `{status: signal.aborted ? 'cancelled' : 'failed'}` antes de relançar o erro (a fila continua tratando a falha normalmente). Sem isso um agendamento cujo alvo falha sempre no mesmo ponto fica "nunca rodou" para sempre — bug real, encontrado rodando um agendamento pela GUI neste ambiente (sem Chromium). Ao adicionar um novo caminho de falha em `handle()`, não capture o erro sem deixar esse catch externo vê-lo.

**`buildTickCommand()` (`src/scheduler/windowsTask.ts`) nunca usa `process.execPath` como `node` default.** Essa função monta o comando que o Agendador de Tarefas do Windows executa a cada tick, e é chamada tanto pela CLI (`node dist/cli.js schedule install-task`, onde `process.execPath` de fato é o `node`) quanto pela GUI (`electron/main/schedulesIpc.ts`, botão "Instalar tarefa"), onde `process.execPath` é o executável do Electron — um binário diferente, que não interpreta um caminho de script como primeiro argumento. O default é o nome puro `"node"`, resolvido pela PATH do Windows (que já é pré-requisito do projeto inteiro). Pelo mesmo motivo, `electron/main/schedulesIpc.ts` NUNCA usa o default de `cliPath` (que depende de `process.argv[1]`, correto só quando quem chama é a própria CLI) — sempre passa um `cliPath` explícito resolvido a partir da própria localização do arquivo compilado (`out/main/schedulesIpc.js` → dois níveis acima é a raiz do projeto → `dist/cli.js`).

**A tela de Agendamentos reage a eventos de fila para "última execução", igual `QueueScreen`/`HistoryScreen`.** "Rodar agora" só enfileira; o job termina depois, de forma assíncrona. `SchedulesScreen` assina `window.maestro.onQueueEvent(...)` e reconsulta a lista inteira a cada evento — não usa o buffer de `jobEvents.ts` (que é para acompanhar UM job específico em UI de resultado, como em `FlowsScreen`/`SearchesScreen`), porque aqui o interesse é só "algo mudou, busque de novo", igual à Fila.

**`vitest.config.ts` roda os arquivos de teste em série (`fileParallelism: false`).** Todo arquivo aponta para o MESMO banco SQLite (`MAESTRO_HOME` único, de propósito — testar contra o banco real, não mockado). Dois arquivos com `beforeEach` limpando a mesma tabela rodando em paralelo (workers/processos separados) podem se atropelar durante uma espera assíncrona real (`queue.waitForIdle()`), causando falha intermitente — visto ao vivo ao adicionar um teste em `test/orchestrator.test.ts`. Não reative paralelismo sem antes isolar o banco por arquivo/worker.

**`Maestro.updateConfig(next)` é o ÚNICO jeito certo de mudar `AppConfig` a partir da GUI — nunca `saveConfig()` direto.** A instância de `Maestro` da GUI vive pela vida inteira do app; `saveConfig()` sozinho só grava no disco, e `this.config` (lido "ao vivo" por `enqueueFlow`/`handle`/`cleanupArtifacts`/etc.) não teria como saber que mudou. `updateConfig()` faz `Object.assign(this.config, parsed)` — muta o objeto em vez de trocar a referência — e recalcula `browserPaths` (`refreshBrowserPaths()`, mesma lógica de `init()`) para caminhos manuais valerem na hora. Único ponto cego: `maxConcurrentBrowsers`/`jobTimeoutMs`/`jobDelayMs` (congelados dentro de `JobQueue` na construção) e `browserIdleTtlMs` (congelado em `BrowserPool`) — `SettingsScreen` avisa que esses quatro só valem depois de reiniciar. `electron/main/profilesIpc.ts`'s `addBrowserPath` foi corrigido para passar por aqui também (antes usava `saveConfig()` direto — mesmo bug de propagação, só que silencioso porque ninguém tinha comparado o comportamento contra uma instância já rodando). Coberto por `test/orchestrator.test.ts`.

**`formatError(err)` (`src/errors.ts`) é a única forma certa de transformar um erro capturado em mensagem para o usuário — nunca `err instanceof Error ? err.message : String(err)` sozinho.** `ZodError.message` é o array de issues inteiro serializado em JSON, não uma frase pronta; qualquer `catch` que apenas repasse `err.message` vaza esse JSON cru para quem está usando o app assim que um `Schema.parse()` falhar. `formatError` detecta `ZodError` e formata como `campo: mensagem` (mesmo estilo de `SearchFileInvalidError`), caindo para o comportamento de sempre em qualquer outro tipo de erro. Todo catch de erro na CLI (`fail(...)`) e em todo `electron/main/*Ipc.ts` passa por aqui agora — ao adicionar um novo `ipcMain.handle` com try/catch, use `formatError(err)`, não repita o padrão antigo.

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
npm test             # vitest, 93 testes
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
- `test/scheduler.test.ts` — `isDue`/idempotência do tick/isolamento de falha; construção do comando `schtasks` sem executá-lo, incluindo o default correto de `nodePath` (`"node"`, nunca `process.execPath`).
- `test/orchestrator.test.ts` — atomicidade por perfil de `enqueueSearches` (nenhum job é enfileirado se qualquer perfil do lote for inválido, mesmo com outros válidos); que um agendamento registra `lastStatus: 'failed'` mesmo quando o job lança antes de produzir um `RunResult`; e que `Maestro.updateConfig()` reflete na instância em memória (campo lido ao vivo + `browserPaths` recalculado), não só no disco.
- `test/errors.test.ts` — `formatError()` nunca deixa o JSON cru de um `ZodError` vazar como mensagem de usuário.

`vitest.config.ts` cria um `MAESTRO_HOME` descartável (os testes nunca tocam o `%APPDATA%` real) e roda os arquivos em série (`fileParallelism: false` — ver "Regras que o código assume").

## Próximos passos sugeridos, em ordem

1. **Validar o gravador em sites reais.** É o maior risco aberto. Peça ao usuário o `flow show` de fluxos gravados em sites de verdade e calibre as heurísticas de `injected.ts` em cima dos casos concretos — especialmente `looksGenerated()`, que pode estar descartando identificadores válidos ou aceitando gerados.
2. **Validar o agendamento no Windows real.** Segundo maior risco aberto, mesma natureza do item 1: `schedule install-task`/`tick` nunca rodaram contra um Agendador de Tarefas de verdade. Peça ao usuário para instalar com `--dry-run` primeiro, depois de verdade, e conferir com `schedule task-status` e `schedule list` (próxima janela calculada) se bate com o Agendador de Tarefas nativo do Windows.
3. **Editor de fluxos (fase 5, RF-031 a RF-039).** Remover passos, reordenar, parametrizar valores em variáveis, inserir esperas e asserções. Hoje só dá para editar o JSON à mão.
4. **Telas da casca Electron, na ordem combinada com o usuário: ~~fila/histórico~~ ~~perfis/navegadores~~ ~~fluxos~~ ~~pesquisas~~ ~~agendamentos~~ ~~configurações~~ — todas prontas.** Só falta **empacotamento (electron-builder, instalador Windows)**, item 5 abaixo. Padrão usado em todas: `electron/shared/ipc.ts` (contrato) → handler em `electron/main/*Ipc.ts` (busca do núcleo real, sem caminho paralelo) → método no preload → tela em `electron/renderer/src/screens/`.
   - Configurações edita `defaultHeadless`/`defaultTimeoutMs`/`defaultMaxRetries`/`defaultViewport`/`defaultStepDelayMs`/`captureTrace`/`detectLoginWall`/`retention` (aplicam na hora) e `maxConcurrentBrowsers`/`jobTimeoutMs`/`jobDelayMs`/`browserIdleTtlMs` (só depois de reiniciar, a tela avisa) — não edita `browserPaths` diretamente (isso já mora na tela de Perfis) nem inventa configuração nova além do que `AppConfigSchema` já define.
   - **Ponto em aberto sobre Agendamentos, ainda não resolvido**: a tela expõe "Instalar tarefa"/"Ver comando"/"Verificar status"/"Remover tarefa" do Agendador de Tarefas do Windows, com o mesmo `buildInstallArgs`/`installWindowsTask`/`windowsTaskStatus` da CLI. Isso pressupõe `node` na PATH e um `dist/cli.js` no mesmo lugar de hoje (raiz do projeto) — nenhuma dessas duas coisas está garantida uma vez que o app for empacotado com electron-builder (o usuário final não necessariamente tem Node.js instalado, e o layout de instalação ainda não existe). Quando a fase de empacotamento acontecer, revisite `schedulesIpc.ts` (a constante `cliPath` no topo do arquivo) e `buildTickCommand()` — pode ser necessário rodar o próprio Electron empacotado com `ELECTRON_RUN_AS_NODE=1` em vez de depender de um `node` externo.
5. **Empacotamento: electron-builder + instalador Windows.** Nenhuma configuração de build de instalador existe ainda no repositório. Decisões em aberto: layout final de instalação (onde `dist/cli.js` fica em relação ao executável do Electron — afeta o ponto acima), se o `node:sqlite` experimental sobrevive ao empacotamento sem flag extra, ícone/assinatura do instalador, e auto-update (não pedido ainda).
6. **Retenção e métricas na UI (RF-071 a RF-077).** A lógica existe (`Maestro.cleanupArtifacts()`, `runs.stats()`), falta superfície.

## Pontos em aberto com o usuário

- Natureza dos sites alvo dos fluxos — afeta esforço de antidetecção e estratégia de espera.
- Volume esperado (pesquisas/dia, fluxos/dia) — dimensiona pool de workers e retenção.
- Aplicativo Android foi explicitamente adiado: seria RPA on-device sobre apps nativos via Accessibility Service, arquitetura sem nada em comum com esta. Projeto separado.

## Avisos que devem continuar visíveis ao usuário

Automatizar mecanismos de busca com contas autenticadas contraria os termos de uso da maioria dos provedores; a conta pode ser sinalizada ou suspensa. Os atrasos aleatórios e a parada em bloqueio mitigam o padrão de acesso, não eliminam o risco. Para rank tracking ou coleta de preços, API oficial costuma sair mais barata que manter isso de pé.
