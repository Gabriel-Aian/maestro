# Maestro — núcleo de automação web

Núcleo de automação do Maestro: gravação de fluxos de navegação, reprodução resiliente e execução de pesquisas em lote a partir de um arquivo JSON.

É um módulo independente de interface (RNF-020). A casca Electron consome esta biblioteca; a CLI existe para operar tudo enquanto ela não existe, e continua útil depois para agendamento e diagnóstico.

> **Estado:** núcleo funcional, ainda não exercitado contra navegador real. Veja [Limitações conhecidas](#limitações-conhecidas) antes de usar em produção.

---

## Requisitos

- **Node.js 22.5 ou superior** — o projeto usa `node:sqlite`, embutido a partir dessa versão
- **Windows 10 (19041+) ou Windows 11** para uso pleno; macOS e Linux rodam a CLI, mas sem detecção de navegadores nem agendamento
- Pelo menos um navegador Chromium instalado: **Brave, Google Chrome ou Microsoft Edge**

Não é necessário baixar navegadores: o projeto usa `playwright-core` e controla os navegadores já instalados na máquina.

## Instalação

```bash
npm install
npm run build
```

Para desenvolvimento, `npm run dev -- <comando>` roda direto do TypeScript, sem build.

```bash
npm test          # 35 testes
npm run typecheck # verificação de tipos
```

---

## Primeiros passos

### 1. Verificar o ambiente

```bash
node dist/cli.js doctor
```

Mostra navegadores detectados, perfis, estado do banco e jobs pendentes.

### 2. Cadastrar um perfil de conta

Cada conta vira um diretório de dados de navegador isolado. **Use perfis dedicados de automação**, separados do seu navegador do dia a dia — o Chromium trava o diretório de perfil enquanto está aberto, e o worker não consegue usar um perfil que você deixou em uma janela aberta.

```bash
node dist/cli.js profile add conta-1 --browser brave
node dist/cli.js profile login conta-1 --url https://o-site-do-seu-fluxo.com
```

O comando `login` abre o navegador **sem automação**, apontando para o diretório de perfil. Autentique nos sites que quiser, feche a janela por completo e pressione Enter. **Nenhuma senha é armazenada** — o que persiste é a sessão dentro do perfil.

> **Use `login`, não `auth`.** Provedores de identidade como Google e Microsoft recusam autenticação quando detectam navegador sob controle de automação — é proteção contra ferramentas de acesso automatizado a contas. O `profile login` resolve não automatizando o login: o navegador é aberto direto pelo sistema operacional, sem CDP e sem sinalizadores de automação. O comando `auth` continua existindo para sites que não fazem essa checagem.

Repita para quantas contas quiser:

```bash
node dist/cli.js profile add conta-2 --browser brave
node dist/cli.js profile login conta-2
node dist/cli.js profile list
```

### Sessão de site × perfil do navegador conectado

São coisas diferentes e vale não confundir:

| | O que é | Importa para automação? |
|---|---|---|
| **Sessão de site** | Cookies de cada site, guardados no diretório de perfil | Sim — é o que a automação usa |
| **Perfil conectado** | Entrar com conta Google/Microsoft no próprio navegador | Só se precisar de SSO em propriedades do provedor |

Para navegar e clicar em sites, basta a sessão de site. Conectar o perfil do navegador ativa sincronização de favoritos e senhas, o que raramente muda alguma coisa para a automação.

Se algum navegador não for detectado automaticamente:

```bash
node dist/cli.js browser list
node dist/cli.js browser add brave "C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe"
```

### 3. Gravar um fluxo

```bash
node dist/cli.js record "Conferir painel" --url https://exemplo.com --profile conta-1
```

O navegador abre visível. Navegue normalmente: cliques, digitação e scroll são capturados. **Alt+Clique** em um elemento insere uma asserção de texto no lugar do clique. Pressione Enter no terminal para encerrar.

```bash
node dist/cli.js flow list
node dist/cli.js flow show flow-a3f2
```

### 4. Testar antes de agendar

Sempre valide a gravação antes de colocar em produção:

```bash
# passo a passo, confirmando cada ação
node dist/cli.js flow run flow-a3f2 --profile conta-1 --step

# execução completa em janela visível, sem gravar no histórico
node dist/cli.js flow run flow-a3f2 --profile conta-1 --dry-run
```

### 5. Executar

```bash
node dist/cli.js flow run flow-a3f2 --profile conta-1
node dist/cli.js flow run flow-a3f2 --profile conta-1 --headed --var usuario=ana@exemplo.com
```

### 6. Pesquisas em lote

Copie `examples/searches.example.json`, edite e valide:

```bash
node dist/cli.js search validate meu-arquivo.json
node dist/cli.js search run meu-arquivo.json
node dist/cli.js search run meu-arquivo.json --themes tema-tecnologia,tema-mercado
```

As pesquisas são agrupadas por perfil: um job por conta. A fila então serializa dentro de cada conta e paraleliza entre contas — exatamente o comportamento "primeiro conta 1, depois conta 2", com temas de contas diferentes correndo ao mesmo tempo.

### 7. Acompanhar

```bash
node dist/cli.js queue     # estado da fila
node dist/cli.js history   # últimas execuções
node dist/cli.js stats     # métricas de 30 dias
node dist/cli.js cleanup   # aplica a política de retenção
```

---

## Formato do arquivo de pesquisas

```json
{
  "schemaVersion": 1,
  "defaults": {
    "browser": "brave",
    "profile": "conta-1",
    "engine": "google",
    "headless": true,
    "delayBetweenSearchesMs": [5000, 15000],
    "screenshot": "none",
    "maxRetries": 2
  },
  "themes": [
    {
      "id": "tema-tecnologia",
      "name": "Tecnologia",
      "enabled": true,
      "queries": [
        "playwright automação windows",
        {
          "text": "melhor {ferramenta} para {objetivo}",
          "vars": {
            "ferramenta": ["playwright", "puppeteer"],
            "objetivo": ["teste e2e", "scraping"]
          },
          "repeat": 1
        }
      ]
    }
  ]
}
```

A herança é `defaults → tema`: qualquer campo declarado no tema sobrescreve o padrão. Variáveis geram o produto cartesiano de todas as combinações — o exemplo acima produz 4 pesquisas. `repeat` multiplica cada combinação. Temas com `enabled: false` são ignorados na execução, mas permanecem no arquivo.

Mecanismos disponíveis: `google`, `bing`, `duckduckgo`. Adicionar outro é acrescentar uma entrada em `src/search/engines.ts`, sem tocar no motor.

---

## Formato do fluxo gravado

```json
{
  "schemaVersion": 1,
  "id": "flow-a3f2",
  "name": "Conferir painel",
  "startUrl": "https://exemplo.com",
  "viewport": { "width": 1366, "height": 768 },
  "variables": [
    { "name": "usuario", "default": "", "description": "E-mail", "sensitive": false }
  ],
  "steps": [
    {
      "index": 0,
      "type": "click",
      "frame": [],
      "selectors": [
        { "kind": "testId", "value": "menu-pedidos", "attribute": "data-testid", "stability": 100 },
        { "kind": "role", "value": "link", "name": "Pedidos", "stability": 80 },
        { "kind": "css", "value": "nav > a:nth-of-type(2)", "stability": 45 },
        { "kind": "xpath", "value": "/html/body/nav/a[2]", "stability": 10 }
      ],
      "timeoutMs": 15000,
      "onFailure": "abort",
      "maxRetries": 2,
      "screenshot": false
    }
  ],
  "needsReview": false
}
```

**Tipos de passo:** `navigate`, `click`, `doubleClick`, `type`, `select`, `check`, `press`, `scroll`, `waitForElement`, `waitForTimeout`, `assertText`, `assertUrl`, `screenshot`, `switchTab`.

**Variáveis** usam a sintaxe `{{nome}}` em campos de texto. Variáveis marcadas como `sensitive` são mascaradas em logs e artefatos. Uma variável sem valor aborta o fluxo **antes** de abrir o navegador.

---

## Como funciona

### Seletores em cascata

Cada elemento gravado recebe uma lista ordenada de candidatos. Na reprodução, eles são tentados em ordem até que um resolva **exatamente um** elemento visível e habilitado. Resolver zero ou vários não é erro fatal: passa-se ao próximo.

Quando o candidato primário falha e um fallback salva a execução, o passo é marcado como **degradado** e o fluxo inteiro recebe `needsReview`. Isso é o alarme antecipado: o site mudou, o fluxo ainda funciona, mas vai quebrar em breve.

O orçamento de tempo é assimétrico de propósito. O primeiro candidato recebe o timeout cheio, porque é ele que absorve a espera de carregamento; os demais recebem sondagens curtas, já que a página nesse ponto já renderizou. Sem isso, uma falha custaria dois minutos em vez de quinze segundos.

Candidatos com identificadores que aparentam ser gerados — `css-1a2b3c4d`, UUIDs, módulos CSS, `useId` do React — são descartados na gravação. Um seletor assim quebra no próximo deploy.

### Coalescência da gravação

Gravação bruta é ruidosa. O compilador aplica estas regras antes de salvar:

| Situação | Resultado |
|---|---|
| Digitação caractere a caractere | Um passo `type` com o valor final |
| Clique em campo seguido de digitação | O clique é descartado (era só foco) |
| Enter logo após digitar | Vira `pressEnter: true` no mesmo passo |
| Clique em checkbox + evento change | Vira `check`, que é idempotente |
| Rajada de scroll | Colapsa na posição final |
| Clique simples antes de duplo | Removido |
| Navegação até 2,5s após clique | Não vira passo (é consequência do clique) |

### Fila

Duas invariantes independentes governam o despacho:

1. **Um job ativo por perfil, sempre.** Um diretório de perfil não pode ser aberto por duas instâncias do navegador.
2. **Teto global de navegadores simultâneos.** Cada Chromium custa centenas de MB; estourar a RAM derruba tudo junto.

A primeira protege a correção, a segunda protege a máquina. Jobs de pesquisa e de fluxo compartilham a fila e, por consequência, rodam em paralelo sempre que estiverem em perfis distintos.

Jobs que ficaram em `running` após encerramento abrupto voltam para a fila na próxima inicialização.

### Bloqueio

O motor detecta reCAPTCHA, hCaptcha, Turnstile, DataDome, PerimeterX, interstícios `/sorry/` e paredes de login — por URL, por frame e por texto, em português e inglês.

Ao detectar, a execução para com status `blocked`, o perfil é congelado como `session_expired` e nenhum job novo é despachado para ele até reautenticação manual. **Não há nem haverá resolução automática de desafios.** Insistir em cliques diante de um desafio só reforça a detecção contra a conta.

### Evidências

Cada execução gera um diretório em `runs/<runId>/`:

```
runs/run-2026-09-12-a3f2c1/
├── before.png                  # antes do primeiro passo
├── after.png                   # depois do último (mesmo em falha)
├── failure-step-3.png          # momento exato do erro
├── failure-step-3.html         # DOM no momento do erro
├── trace.zip                   # replay visual navegável
└── run.json                    # manifesto com resultado por passo
```

O trace abre com `npx playwright show-trace runs/<runId>/trace.zip` e dá snapshot de DOM por ação. É a diferença entre diagnosticar em minutos ou reproduzir manualmente até entender.

---

## Estrutura do projeto

```
src/
├── types/schema.ts          # schemas Zod — fonte única de tipos e validação
├── config/                  # raiz de dados e configuração da aplicação
├── browsers/
│   ├── detect.ts            # detecção via Registro do Windows
│   └── launcher.ts          # perfis persistentes, lock, pool de reaproveitamento
├── recorder/
│   ├── injected.ts          # script injetado: captura e geração de seletores
│   └── recorder.ts          # sessão + compilação de eventos em fluxo
├── engine/
│   ├── selectors.ts         # resolução em cascata e navegação entre frames
│   ├── blockDetection.ts    # CAPTCHA e parede de login
│   ├── artifacts.ts         # screenshots, trace, manifesto
│   └── replay.ts            # motor de execução
├── search/
│   ├── engines.ts           # definições declarativas de mecanismos
│   ├── searchFile.ts        # validação, herança e expansão
│   └── runner.ts            # execução do lote
├── queue/queue.ts           # fila persistente
├── db/index.ts              # SQLite, migrações e repositórios
├── store/flowStore.ts       # arquivos de fluxo com versionamento
├── orchestrator.ts          # composição: fila + pool + motores + histórico
└── cli.ts                   # interface de linha de comando
```

### Diretório de dados

Windows: `%APPDATA%\Maestro`. Outros SOs: `~/.local/share/maestro`. Sobrescreva com a variável `MAESTRO_HOME`.

```
Maestro/
├── maestro.db          # fila, histórico, perfis, índice de fluxos
├── config.json
├── flows/
│   ├── flow-a3f2.json  # versão corrente
│   └── flow-a3f2/      # versões anteriores
├── profiles/           # user-data-dir isolado por conta
├── runs/               # artefatos por execução
└── logs/               # JSON Lines com rotação diária
```

---

## Uso como biblioteca

```ts
import { Maestro, loadFlow, replayFlow } from 'maestro-core';

const maestro = new Maestro();
await maestro.init();

maestro.queue.on('finished', (job, result) => {
  console.log(result.status, result.artifactsDir);
  if (result.degraded) console.warn('fluxo precisa de revisão');
});

maestro.enqueueFlow('flow-a3f2', 'conta-1', { headless: true });
maestro.enqueueSearches('./searches.json');

await maestro.queue.waitForIdle();
await maestro.shutdown();
```

---

## Limitações conhecidas

**Não foi executado contra navegador real.** O ambiente de desenvolvimento não tinha Chromium disponível. Toda a lógica pura está coberta por testes — geração de seletores sob jsdom, coalescência, expansão do JSON, escalonamento da fila —, mas o primeiro contato com Brave/Chrome/Edge acontecerá na sua máquina. Comece gravando um fluxo simples e conferindo o JSON gerado.

**`node:sqlite` é experimental no Node 22.** A escolha evita o atrito de recompilar módulo nativo para a ABI do Electron a cada atualização, que é a maior dor no empacotamento. A camada está isolada em `src/db/index.ts`; migrar para `better-sqlite3` é alterar só esse arquivo.

**Headless é mais detectável.** Com sessão autenticada, espere colidir com desafios. Falha por bloqueio é resultado tratado, não defeito.

**Execução visível não funciona com a sessão do Windows bloqueada.** Limitação do sistema operacional. Se o agendamento for de madrugada, headless deixa de ser preferência e vira requisito.

**Automatizar mecanismos de busca com contas autenticadas contraria os termos de uso da maioria dos provedores.** A conta pode ser sinalizada, limitada ou suspensa. Os atrasos aleatórios e a parada em bloqueio mitigam o padrão de acesso, mas não eliminam o risco. Para rank tracking ou coleta de preços, verifique se existe API oficial antes.

**Seletores quebram quando o site muda.** A cascata de candidatos reduz a frequência, não elimina a manutenção. Trate `needsReview` como fila de trabalho.

---

## Não implementado nesta fase

Interface Electron, editor visual de fluxos, integração com o Agendador de Tarefas do Windows, notificações nativas e visualizador comparativo de screenshots. Todas as operações correspondentes existem na CLI.

Fora de escopo por decisão de projeto: aplicativo Android, Firefox e Safari, resolução automática de CAPTCHA, proxies e rotação de IP, extração estruturada de dados, multiusuário.
