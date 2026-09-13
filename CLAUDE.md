# CLAUDE.md

Contexto para o Claude Code trabalhar neste repositório. Leia antes de alterar qualquer coisa.

## O que é

**Maestro** — núcleo de automação web para Windows. Faz duas coisas:

1. **Grava e reproduz fluxos de navegação** em sites que o usuário configura (cliques, digitação, scroll, troca de abas).
2. **Executa pesquisas em lote** a partir de um arquivo JSON organizado por temas, distribuídas entre contas e navegadores.

Usuário único, local-first: nenhum dado sai da máquina, sem backend, sem telemetria.

O `README.md` documenta o uso. O levantamento de requisitos completo (RF-001 a RF-080, RNF-001 a RNF-029, RN-001 a RN-015) foi produzido antes do código e os identificadores aparecem em comentários ao longo dos arquivos — quando encontrar `(RN-005)` ou `(RF-042)`, é referência a esse documento. **Peça-o ao usuário se precisar do texto completo; ele não está versionado aqui.**

## Estado atual

Fases 1 a 4 e 6 do plano estão implementadas. 50 testes passando, typecheck limpo.

| Pronto | Não implementado |
|---|---|
| Detecção de navegadores (Registro do Windows) | Interface Electron |
| Perfis isolados por conta | Editor visual de fluxos |
| Gravador com seletores em cascata | Agendador de Tarefas do Windows |
| Compilação/limpeza da gravação | Notificações nativas |
| Replay com fallback e retries | Visualizador comparativo de screenshots |
| Detecção de CAPTCHA e parede de login | |
| Fila persistente com serialização por perfil | |
| Motor de pesquisas com expansão de variáveis | |
| CLI cobrindo todas as operações | |

**Nunca foi executado contra navegador real neste ambiente de desenvolvimento** — não havia Chromium disponível. A lógica pura está testada; o comportamento com Brave/Chrome/Edge foi validado manualmente pelo usuário no Windows dele.

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
├── queue/queue.ts        # fila em SQLite
├── db/index.ts           # migrações + repositórios
├── store/flowStore.ts    # fluxos em arquivo, com versionamento
├── orchestrator.ts       # composição de tudo
└── cli.ts                # interface de linha de comando
```

## Regras que o código assume — não quebre

**`src/recorder/injected.ts` é serializado com `toString()` e executado no navegador.** Ele não pode importar nada, não pode capturar variável do escopo do Node, e não pode usar APIs que não existam no browser. Todos os helpers precisam estar declarados dentro da função `injectedRecorder`. Se você adicionar um `import` usado dentro dela, quebra em runtime sem erro de compilação.

**`compileEvents()` é pura de propósito.** É a lógica mais sujeita a regressão do gravador. Mantenha-a sem I/O para continuar testável sem navegador.

**Uma execução ativa por perfil, sempre (RN-001).** Um `user-data-dir` do Chromium não abre em duas instâncias. A fila garante isso e há teste cobrindo. Não introduza caminho que burle.

**Seletores são tentados em ordem e exigem exatamente um elemento visível e habilitado (RN-005).** Zero ou vários → próximo candidato. Quando um fallback resolve, o passo é marcado como degradado e o fluxo ganha `needsReview` (RN-006) — é o alarme antecipado de que o site mudou.

**A aba ativa é estado mutável da execução** (`ReplaySession` em `replay.ts`). Um clique pode abrir outra aba e todos os passos seguintes devem rodar nela. Nunca volte a capturar `pages()[0]` em variável fixa — foi exatamente esse bug que fazia o fluxo se perder após redirecionamento.

**Nenhuma senha é armazenada, em nenhuma hipótese (RNF-001).** Autenticação é sempre manual, e a sessão persiste no diretório de perfil.

**Não implemente contorno de CAPTCHA nem mascaramento de automação (RNF-006).** Decisão de projeto, não limitação técnica. Ao detectar desafio, a execução para com status `blocked` e o perfil é congelado. Provedores de identidade (Google, Microsoft) recusam login em navegador automatizado por design — a resposta é `profile login`, que abre o navegador **sem** automação para o usuário autenticar como humano.

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
npm test             # vitest, 50 testes
npm run dev -- <cmd> # roda a CLI direto do TS

node dist/cli.js doctor
node dist/cli.js profile add conta-1 --browser brave
node dist/cli.js profile login conta-1 --url https://site.com   # login SEM automação
node dist/cli.js record "Fluxo" --url https://site.com --profile conta-1
node dist/cli.js flow show <id>
node dist/cli.js flow run <id> --profile conta-1 --step
node dist/cli.js search validate examples/searches.example.json
```

No Windows com PowerShell, se `npm` for bloqueado por política de execução, use `npm.cmd`.

## Testes

- `test/injected.test.ts` — geração de seletores sob jsdom. Contém um truque necessário: o gravador exige `isTrusted`, e jsdom zera essa flag no dispatch. A solução é marcar a implementação interna via `Symbol(impl)` em listener no Window, que roda antes dos listeners do document. Está comentado no arquivo.
- `test/compile.test.ts` — coalescência e troca de abas.
- `test/blockDetection.test.ts` — falsos positivos de login, CAPTCHA.
- `test/queue.test.ts` — invariantes de escalonamento com handler falso.
- `test/searchFile.test.ts` — validação, herança, expansão.

`vitest.config.ts` cria um `MAESTRO_HOME` descartável: os testes nunca tocam o `%APPDATA%` real.

## Próximos passos sugeridos, em ordem

1. **Validar o gravador em sites reais.** É o maior risco aberto. Peça ao usuário o `flow show` de fluxos gravados em sites de verdade e calibre as heurísticas de `injected.ts` em cima dos casos concretos — especialmente `looksGenerated()`, que pode estar descartando identificadores válidos ou aceitando gerados.
2. **Editor de fluxos (fase 5, RF-031 a RF-039).** Remover passos, reordenar, parametrizar valores em variáveis, inserir esperas e asserções. Hoje só dá para editar o JSON à mão.
3. **Agendamento (fase 7, RF-057 a RF-063).** `node-cron` já está nas dependências mas não é usado. Falta também registrar tarefa no Agendador do Windows, para rodar com o app fechado. Atenção à RN-007: execução visível não funciona com a sessão do Windows bloqueada.
4. **Casca Electron.** O núcleo já é invocável sem UI (RNF-020), então é consumir a API de `src/index.ts`. Comece pela tela de fila e histórico, que são as de maior uso.
5. **Retenção e métricas na UI (RF-071 a RF-077).** A lógica existe (`Maestro.cleanupArtifacts()`, `runs.stats()`), falta superfície.

## Pontos em aberto com o usuário

- Natureza dos sites alvo dos fluxos — afeta esforço de antidetecção e estratégia de espera.
- Volume esperado (pesquisas/dia, fluxos/dia) — dimensiona pool de workers e retenção.
- Aplicativo Android foi explicitamente adiado: seria RPA on-device sobre apps nativos via Accessibility Service, arquitetura sem nada em comum com esta. Projeto separado.

## Avisos que devem continuar visíveis ao usuário

Automatizar mecanismos de busca com contas autenticadas contraria os termos de uso da maioria dos provedores; a conta pode ser sinalizada ou suspensa. Os atrasos aleatórios e a parada em bloqueio mitigam o padrão de acesso, não eliminam o risco. Para rank tracking ou coleta de preços, API oficial costuma sair mais barata que manter isso de pé.
