#!/usr/bin/env node
// `node:sqlite` ainda emite ExperimentalWarning no Node 22. O aviso é
// informativo e polui toda saída da CLI, então fica filtrado — os demais
// avisos continuam visíveis.
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  const isSqliteNotice = warning.name === 'ExperimentalWarning' && warning.message.includes('SQLite');
  if (!isSqliteNotice) process.emitWarning(warning);
});

import { createInterface } from 'node:readline/promises';
import { randomUUID } from 'node:crypto';
import { statSync, existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Command } from 'commander';
import { detectBrowsers, validateBrowserPath } from './browsers/detect.js';
import { launchProfile, isProfileLocked, openProfilePlain } from './browsers/launcher.js';
import { RecordingSession, materializeTimingSteps, DEFAULT_TIMING_MIN_MS, DEFAULT_TIMING_MAX_MS } from './recorder/recorder.js';
import { saveFlow, loadFlow, listFlowVersions, restoreFlowVersion } from './store/flowStore.js';
import { loadSearchFile, validateSearchFile, expandSearches } from './search/searchFile.js';
import { replayFlow } from './engine/replay.js';
import { Maestro } from './orchestrator.js';
import { loadConfig, saveConfig } from './config/config.js';
import { profiles, flowsIndex, runs, schedules, getDb } from './db/index.js';
import { paths, ensureDataDirs } from './config/paths.js';
import { ProfileSchema, ScheduleSchema, type ScheduleTarget } from './types/schema.js';
import { formatError } from './errors.js';
import { runDueSchedules } from './scheduler/scheduler.js';
import { installWindowsTask, uninstallWindowsTask, windowsTaskStatus, buildInstallArgs, TICK_TASK_NAME } from './scheduler/windowsTask.js';
import { createTask } from 'node-cron';

// Lê a versão do package.json em vez de duplicá-la aqui: versão escrita à mão
// em dois lugares diverge na primeira vez que alguém esquece de atualizar uma.
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

// A versão vem do package.json: escrever à mão em dois lugares garante que um
// dos dois fique desatualizado e leve alguém a achar que o build não pegou.
const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

const program = new Command();
program.name('maestro').description('Núcleo de automação web do Maestro').version(version);

async function prompt(message: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(message);
  rl.close();
  return answer;
}

function ok(message: string): void {
  process.stdout.write(`✔ ${message}\n`);
}

function info(message: string): void {
  process.stdout.write(`${message}\n`);
}

function fail(message: string): never {
  process.stderr.write(`✖ ${message}\n`);
  process.exit(1);
}

/* ─────────────────────────  NAVEGADORES  ───────────────────────── */

const browser = program.command('browser').description('Gestão de navegadores');

browser
  .command('list')
  .description('Lista os navegadores Chromium detectados (RF-001)')
  .action(async () => {
    const detected = await detectBrowsers();
    const config = loadConfig();

    if (detected.length === 0 && Object.keys(config.browserPaths).length === 0) {
      info('Nenhum navegador detectado. Use "maestro browser add <id> <caminho>" para cadastrar manualmente.');
      return;
    }
    for (const b of detected) info(`  ${b.id.padEnd(8)} ${b.name.padEnd(16)} ${b.executablePath}  [${b.source}]`);
    for (const [id, path] of Object.entries(config.browserPaths)) info(`  ${id.padEnd(8)} ${'(manual)'.padEnd(16)} ${path}  [manual]`);
  });

browser
  .command('add <id> <executablePath>')
  .description('Cadastra manualmente o caminho de um navegador (RF-002, RF-003)')
  .action((id: string, executablePath: string) => {
    const validation = validateBrowserPath(executablePath);
    if (!validation.ok) fail(validation.reason);

    const config = loadConfig();
    saveConfig({ ...config, browserPaths: { ...config.browserPaths, [id]: executablePath } });
    ok(`Navegador "${id}" cadastrado.`);
  });

/* ─────────────────────────  PERFIS  ───────────────────────── */

const profile = program.command('profile').description('Gestão de perfis de conta');

profile
  .command('list')
  .description('Lista os perfis cadastrados')
  .action(() => {
    const all = profiles.list();
    if (all.length === 0) return info('Nenhum perfil cadastrado.');
    for (const p of all) {
      const lock = isProfileLocked(p.userDataDir) ? ' [EM USO]' : '';
      info(`  ${p.name.padEnd(16)} ${p.browserId.padEnd(8)} ${p.status.padEnd(22)} ${p.lastUsedAt ?? 'nunca usado'}${lock}`);
    }
  });

profile
  .command('add <name>')
  .description('Cria um perfil com diretório de dados isolado (RF-004)')
  .requiredOption('-b, --browser <id>', 'navegador do perfil (brave, chrome, edge)')
  .action((name: string, opts: { browser: string }) => {
    if (profiles.find(name)) fail(`Já existe um perfil chamado "${name}".`);
    ensureDataDirs();

    const id = `prof-${randomUUID().slice(0, 8)}`;
    const created = ProfileSchema.parse({
      id,
      name,
      browserId: opts.browser,
      userDataDir: paths.profileDir(id),
      status: 'never_authenticated',
      lastUsedAt: null,
      createdAt: new Date().toISOString(),
    });

    profiles.insert(created);
    ok(`Perfil "${name}" criado em ${created.userDataDir}`);
    info(`  Próximo passo: maestro profile auth ${name}`);
  });

profile
  .command('auth <name>')
  .description('Abre o navegador visível para login manual (RF-005, RN-003)')
  .option('-u, --url <url>', 'página onde fazer login', 'https://accounts.google.com/')
  .action(async (name: string, opts: { url: string }) => {
    const p = profiles.find(name);
    if (!p) fail(`Perfil "${name}" não encontrado.`);

    const maestro = new Maestro();
    await maestro.init();

    const context = await launchProfile({
      profile: p,
      executablePath: maestro.resolveExecutable(p.browserId),
      headless: false,
      viewport: loadConfig().defaultViewport,
      allowUnauthenticated: true,
    });

    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(opts.url, { waitUntil: 'domcontentloaded' }).catch(() => undefined);

    info(`\nNavegador aberto em ${opts.url}`);
    info('Faça login normalmente, inclusive 2FA. Pode abrir outras abas e autenticar');
    info('em quantos sites quiser: tudo fica guardado neste mesmo perfil.');
    info('Nenhuma senha é armazenada pelo Maestro — o que persiste é a sessão (RNF-001).\n');
    await prompt('Pressione Enter quando o login estiver concluído... ');

    // Confirma que houve navegação real antes de marcar como autenticado:
    // fechar em about:blank quase sempre significa que ninguém logou em nada.
    const finalUrls = context.pages().map((pg) => pg.url());
    const navegou = finalUrls.some((u) => u !== 'about:blank' && !u.startsWith('chrome://'));

    await context.close();

    if (!navegou) {
      fail(
        `Nenhuma navegação detectada — o perfil continua sem sessão e NÃO foi marcado como autenticado.\n` +
          `  Rode de novo e faça o login antes de pressionar Enter:\n` +
          `  maestro profile auth ${name} --url <endereço do site>`,
      );
    }

    profiles.setStatus(p.id, 'authenticated');
    ok(`Perfil "${name}" autenticado.`);
    await maestro.shutdown();
  });

profile
  .command('login <name>')
  .description('Abre o navegador SEM automação para autenticar (contorna o bloqueio de provedores)')
  .option('-u, --url <url>', 'página inicial', 'https://www.google.com/')
  .action(async (name: string, opts: { url: string }) => {
    const p = profiles.find(name);
    if (!p) fail(`Perfil "${name}" não encontrado.`);

    const maestro = new Maestro();
    await maestro.init();

    openProfilePlain({
      executablePath: maestro.resolveExecutable(p.browserId),
      userDataDir: p.userDataDir,
      url: opts.url,
    });

    info('\n── Login manual ──────────────────────────────');
    info('  O navegador abriu SEM automação: nenhum provedor vai recusar o login.');
    info('  Autentique em quantos sites quiser — tudo fica neste mesmo perfil.');
    info('  Ao terminar, FECHE a janela por completo antes de continuar.');
    info('──────────────────────────────────────────────\n');
    await prompt('Pressione Enter depois de fechar o navegador... ');

    if (isProfileLocked(p.userDataDir)) {
      fail('O navegador ainda está aberto. Feche a janela por completo e rode o comando de novo.');
    }

    profiles.setStatus(p.id, 'authenticated');
    ok(`Perfil "${name}" marcado como autenticado.`);
    info(`  Verifique com: maestro flow run <id> -p ${name} --dry-run`);
    await maestro.shutdown();
  });

profile
  .command('rm <name>')
  .description('Remove um perfil e seus dados de sessão (RF-007)')
  .action(async (name: string) => {
    const p = profiles.find(name);
    if (!p) fail(`Perfil "${name}" não encontrado.`);

    const answer = await prompt(`Isso apaga a sessão em ${p.userDataDir}. Confirma? (digite "sim"): `);
    if (answer.trim().toLowerCase() !== 'sim') return info('Cancelado.');

    profiles.remove(p.id);
    ok(`Perfil "${name}" removido. O diretório de dados foi preservado; apague manualmente se quiser.`);
  });

/* ─────────────────────────  GRAVAÇÃO  ───────────────────────── */

program
  .command('record <name>')
  .description('Grava um fluxo de navegação (RF-021 a RF-030)')
  .requiredOption('-u, --url <url>', 'URL inicial')
  .requiredOption('-p, --profile <name>', 'perfil a usar')
  .option('--convert-timings', 'converte os intervalos observados na gravação em passos waitForTimeout reais')
  .option('--min-ms <n>', `limiar mínimo para converter um intervalo (padrão ${DEFAULT_TIMING_MIN_MS}ms)`)
  .option('--max-ms <n>', `teto aplicado ao intervalo convertido (padrão ${DEFAULT_TIMING_MAX_MS}ms)`)
  .action(async (name: string, opts: { url: string; profile: string; convertTimings?: boolean; minMs?: string; maxMs?: string }) => {
    const p = profiles.find(opts.profile);
    if (!p) fail(`Perfil "${opts.profile}" não encontrado.`);

    const maestro = new Maestro();
    await maestro.init();

    const context = await launchProfile({
      profile: p,
      executablePath: maestro.resolveExecutable(p.browserId),
      headless: false, // gravação depende de interação real
      viewport: loadConfig().defaultViewport,
      allowUnauthenticated: true,
    });

    const session = await RecordingSession.start({ context, name, startUrl: opts.url });

    info('\n── Gravando ──────────────────────────────────');
    info('  Navegue normalmente. Cliques, digitação e scroll são capturados.');
    info('  Alt+Clique em um elemento insere uma asserção de texto (RF-029).');
    info('──────────────────────────────────────────────\n');
    await prompt('Pressione Enter para encerrar a gravação... ');

    try {
      const flow = await session.stop();
      const steps = opts.convertTimings
        ? materializeTimingSteps(flow.steps, {
            minMs: opts.minMs !== undefined ? Number(opts.minMs) : undefined,
            maxMs: opts.maxMs !== undefined ? Number(opts.maxMs) : undefined,
          })
        : flow.steps;
      const saved = saveFlow({ ...flow, steps });
      ok(`Fluxo "${saved.name}" salvo como ${saved.id} (${saved.steps.length} passos).`);
      info(`  Arquivo: ${paths.flowFile(saved.id)}`);
      info(`  Teste antes de agendar: maestro flow run ${saved.id} -p ${opts.profile} --headed`);
    } catch (err) {
      fail(formatError(err));
    } finally {
      await context.close();
      await maestro.shutdown();
    }
  });

/* ─────────────────────────  FLUXOS  ───────────────────────── */

const flow = program.command('flow').description('Gestão e execução de fluxos');

flow
  .command('list')
  .description('Lista os fluxos gravados (RF-080)')
  .action(() => {
    const all = flowsIndex.list();
    if (all.length === 0) return info('Nenhum fluxo gravado.');
    for (const f of all) {
      const review = f.needsReview ? ' ⚠ requer revisão' : '';
      info(`  ${f.id.padEnd(14)} ${f.name.padEnd(28)} ${String(f.stepCount).padStart(3)} passos  ${f.lastStatus ?? '—'}${review}`);
    }
  });

flow
  .command('show <id>')
  .description('Exibe os passos de um fluxo (RF-031)')
  .action((id: string) => {
    const f = loadFlow(id);
    info(`\n${f.name}  (${f.id})\n  URL inicial: ${f.startUrl}\n`);
    for (const step of f.steps) {
      const selector = 'selectors' in step && step.selectors?.length ? describeFirst(step.selectors) : '';
      info(`  ${String(step.index).padStart(3)}. ${step.type.padEnd(16)} ${selector}`);
      if (step.note) info(`       ↳ ${step.note}`);
    }
  });

flow
  .command('run <id>')
  .description('Executa um fluxo (RF-057)')
  .requiredOption('-p, --profile <name>', 'perfil a usar')
  .option('--headed', 'executa com janela visível')
  .option('--dry-run', 'modo de teste: não grava no histórico de produção (RF-039)')
  .option('--step', 'modo passo a passo, confirmando cada ação (RF-038)')
  .option('--var <pares...>', 'variáveis no formato nome=valor')
  .action(async (id: string, opts: { profile: string; headed?: boolean; dryRun?: boolean; step?: boolean; var?: string[] }) => {
    const variables = parseVars(opts.var ?? []);

    if (opts.step || opts.dryRun) {
      await runInteractive(id, opts.profile, variables, Boolean(opts.step));
      return;
    }

    const maestro = new Maestro();
    await maestro.init();
    const job = maestro.enqueueFlow(id, opts.profile, { headless: !opts.headed, variables });
    ok(`Job ${job.id} enfileirado.`);

    maestro.queue.on('finished', (_j, result) => {
      info(`\n  Status: ${result.status}  |  ${result.steps.length} passos  |  ${(result.durationMs / 1000).toFixed(1)}s`);
      info(`  Evidências: ${result.artifactsDir}`);
      if (result.degraded) info('  ⚠ Passos degradados detectados — o fluxo foi marcado para revisão (RN-006).');
      if (result.error) info(`  Erro: ${result.error}`);
    });

    await maestro.queue.waitForIdle();
    await maestro.shutdown();
  });

flow
  .command('versions <id>')
  .description('Lista as versões anteriores de um fluxo (RF-037)')
  .action((id: string) => {
    const versions = listFlowVersions(id);
    if (versions.length === 0) return info('Nenhuma versão anterior.');
    for (const v of versions) info(`  ${v}`);
  });

flow
  .command('restore <id> <version>')
  .description('Restaura uma versão anterior do fluxo (RF-037)')
  .action((id: string, version: string) => {
    const restored = restoreFlowVersion(id, version);
    ok(`Fluxo ${id} restaurado para ${version} (${restored.steps.length} passos).`);
  });

flow
  .command('convert-timings <id>')
  .description('Converte os intervalos já gravados em passos waitForTimeout reais')
  .option('--min-ms <n>', `limiar mínimo para converter um intervalo (padrão ${DEFAULT_TIMING_MIN_MS}ms)`)
  .option('--max-ms <n>', `teto aplicado ao intervalo convertido (padrão ${DEFAULT_TIMING_MAX_MS}ms)`)
  .action((id: string, opts: { minMs?: string; maxMs?: string }) => {
    const flow = loadFlow(id);
    const steps = materializeTimingSteps(flow.steps, {
      minMs: opts.minMs !== undefined ? Number(opts.minMs) : undefined,
      maxMs: opts.maxMs !== undefined ? Number(opts.maxMs) : undefined,
    });
    const inserted = steps.length - flow.steps.length;
    if (inserted === 0) {
      return info(
        'Nada para converter: nenhum passo tem intervalo bruto pendente acima do limiar. ' +
          'Isso vale tanto para fluxos já convertidos quanto para fluxos gravados antes deste ' +
          'recurso existir (regrave para capturar o valor preciso).',
      );
    }

    const saved = saveFlow({ ...flow, steps });
    ok(`${inserted} passo(s) waitForTimeout inserido(s) no fluxo "${saved.name}" (${saved.steps.length} passos no total).`);
    info(`  Versão anterior preservada — veja "maestro flow versions ${id}".`);
  });

/* ─────────────────────────  PESQUISAS  ───────────────────────── */

const search = program.command('search').description('Pesquisas em lote');

search
  .command('validate <file>')
  .description('Valida o arquivo JSON de pesquisas (RF-010)')
  .action((file: string) => {
    if (!existsSync(file)) fail(`Arquivo não encontrado: ${file}`);
    try {
      const parsed = loadSearchFile(file);
      const expanded = expandSearches(parsed);
      ok(`Arquivo válido: ${parsed.themes.length} temas, ${expanded.length} pesquisas após expansão.`);
      const byTheme = new Map<string, number>();
      for (const s of expanded) byTheme.set(s.themeName, (byTheme.get(s.themeName) ?? 0) + 1);
      for (const [theme, count] of byTheme) info(`  ${theme.padEnd(24)} ${count}`);
    } catch (err) {
      fail(formatError(err));
    }
  });

search
  .command('run <file>')
  .description('Executa as pesquisas do arquivo (RF-016 a RF-020)')
  .option('-t, --themes <ids>', 'restringe a temas específicos, separados por vírgula')
  .action(async (file: string, opts: { themes?: string }) => {
    const maestro = new Maestro();
    await maestro.init();

    const themeIds = opts.themes?.split(',').map((t) => t.trim());
    const jobs = maestro.enqueueSearches(file, { themeIds });
    ok(`${jobs.length} job(s) enfileirado(s), um por perfil.`);

    maestro.queue.on('finished', (_j, result) => {
      const okCount = result.steps.filter((step) => step.status === 'success').length;
      info(`  ${result.runId}: ${result.status} — ${okCount}/${result.steps.length} pesquisas concluídas`);
    });

    await maestro.queue.waitForIdle();
    await maestro.shutdown();
  });

/* ─────────────────────────  AGENDAMENTO  ───────────────────────── */

const schedule = program.command('schedule').description('Agendamento de fluxos e pesquisas (RF-057 a RF-063)');

/**
 * `getNextRun()` só calcula algo depois que a tarefa é iniciada ao menos uma
 * vez — `createTask` sozinho devolve sempre null. Como a função de callback é
 * no-op, iniciar e parar imediatamente é seguro mesmo se o instante atual
 * bater com o cron (o pior caso é uma chamada vazia a mais).
 */
function nextRunOf(cron: string): Date | null {
  const task = createTask(cron, () => undefined);
  try {
    task.start();
    return task.getNextRun();
  } finally {
    void task.stop();
    void task.destroy();
  }
}

function describeSchedule(s: { id: string; name: string; cron: string; enabled: boolean; lastStatus: string | null }): string {
  const next = nextRunOf(s.cron);
  const status = s.enabled ? 'ativo' : 'desativado';
  const nextStr = next ? next.toISOString().slice(0, 16).replace('T', ' ') : '—';
  return `  ${s.id.padEnd(14)} ${s.name.padEnd(24)} ${s.cron.padEnd(14)} ${status.padEnd(11)} próxima: ${nextStr}  última: ${s.lastStatus ?? '—'}`;
}

schedule
  .command('add <name>')
  .description('Cria um agendamento (RF-057, RF-058)')
  .requiredOption('--cron <expr>', 'expressão cron (5 ou 6 campos)')
  .option('--flow <id>', 'agenda um fluxo (exclusivo com --search)')
  .option('-p, --profile <name>', 'perfil a usar (obrigatório com --flow)')
  .option('--var <pares...>', 'variáveis do fluxo no formato nome=valor')
  .option('--search <file>', 'agenda um arquivo de pesquisas (exclusivo com --flow)')
  .option('--themes <ids>', 'restringe a temas específicos, separados por vírgula (com --search)')
  .action(
    (
      name: string,
      opts: { cron: string; flow?: string; profile?: string; var?: string[]; search?: string; themes?: string },
    ) => {
      if (Boolean(opts.flow) === Boolean(opts.search)) {
        fail('Informe exatamente um de --flow ou --search.');
      }

      let target: ScheduleTarget;
      if (opts.flow) {
        if (!opts.profile) fail('--profile é obrigatório com --flow.');
        if (!profiles.find(opts.profile!)) fail(`Perfil "${opts.profile}" não encontrado.`);
        loadFlow(opts.flow); // valida que o fluxo existe
        target = { kind: 'flow', flowId: opts.flow, profile: opts.profile!, variables: parseVars(opts.var ?? []) };
      } else {
        if (!existsSync(opts.search!)) fail(`Arquivo não encontrado: ${opts.search}`);
        loadSearchFile(opts.search!); // valida o arquivo
        target = { kind: 'search', searchFile: opts.search!, themeIds: opts.themes?.split(',').map((t) => t.trim()) };
      }

      const now = new Date().toISOString();
      let saved;
      try {
        saved = ScheduleSchema.parse({
          id: `sched-${randomUUID().slice(0, 8)}`,
          name,
          cron: opts.cron,
          enabled: true,
          target,
          createdAt: now,
          updatedAt: now,
        });
      } catch (err) {
        fail(formatError(err));
      }

      schedules.insert(saved);
      ok(`Agendamento "${saved.name}" criado como ${saved.id}.`);
      const next = nextRunOf(saved.cron);
      info(`  Próxima janela: ${next ? next.toISOString() : 'não foi possível calcular'}`);
      info(`  Teste antes de confiar no agendamento: maestro schedule run ${saved.id}`);
    },
  );

schedule
  .command('list')
  .description('Lista os agendamentos (RF-059)')
  .action(() => {
    const all = schedules.list();
    if (all.length === 0) return info('Nenhum agendamento cadastrado.');
    for (const s of all) info(describeSchedule(s));
  });

schedule
  .command('show <id>')
  .description('Exibe os detalhes de um agendamento')
  .action((id: string) => {
    const s = schedules.find(id);
    if (!s) fail(`Agendamento "${id}" não encontrado.`);
    info(`\n${s.name}  (${s.id})`);
    info(`  Cron:      ${s.cron}`);
    info(`  Estado:    ${s.enabled ? 'ativo' : 'desativado'}`);
    info(`  Alvo:      ${s.target.kind === 'flow' ? `fluxo ${s.target.flowId} (perfil ${s.target.profile})` : `pesquisas ${s.target.searchFile}${s.target.themeIds ? ` [${s.target.themeIds.join(', ')}]` : ''}`}`);
    info(`  Última:    ${s.lastRunAt ? `${s.lastRunAt} — ${s.lastStatus}` : 'nunca rodou'}`);
    const next = nextRunOf(s.cron);
    info(`  Próxima:   ${next ? next.toISOString() : '—'}\n`);
  });

schedule
  .command('enable <id>')
  .description('Reativa um agendamento desativado')
  .action((id: string) => {
    if (!schedules.find(id)) fail(`Agendamento "${id}" não encontrado.`);
    schedules.setEnabled(id, true);
    ok(`Agendamento ${id} ativado.`);
  });

schedule
  .command('disable <id>')
  .description('Desativa um agendamento sem apagá-lo')
  .action((id: string) => {
    if (!schedules.find(id)) fail(`Agendamento "${id}" não encontrado.`);
    schedules.setEnabled(id, false);
    ok(`Agendamento ${id} desativado.`);
  });

schedule
  .command('rm <id>')
  .description('Remove um agendamento')
  .action((id: string) => {
    if (!schedules.find(id)) fail(`Agendamento "${id}" não encontrado.`);
    schedules.remove(id);
    ok(`Agendamento ${id} removido.`);
  });

schedule
  .command('run <id>')
  .description('Dispara um agendamento agora, ignorando o cron (para testar antes de confiar nele)')
  .action(async (id: string) => {
    const s = schedules.find(id);
    if (!s) fail(`Agendamento "${id}" não encontrado.`);

    const maestro = new Maestro();
    await maestro.init();
    const jobs = maestro.enqueueSchedule(s);
    ok(`${jobs.length} job(s) enfileirado(s) a partir do agendamento "${s.name}".`);

    maestro.queue.on('finished', (_j, result) => {
      info(`  ${result.runId}: ${result.status}`);
    });

    await maestro.queue.waitForIdle();
    await maestro.shutdown();
  });

schedule
  .command('tick')
  .description('Dispara os agendamentos que estiverem no horário agora (chamado pelo Agendador de Tarefas do Windows)')
  .action(async () => {
    const maestro = new Maestro();
    await maestro.init();

    const result = runDueSchedules(maestro, new Date());

    await maestro.queue.waitForIdle();
    await maestro.shutdown();

    info(`  ${result.checked} agendamento(s) avaliado(s), ${result.fired.length} disparado(s), ${result.skipped.length} pulado(s).`);
    for (const f of result.fired) info(`  ✔ ${f.schedule.name} → ${f.jobs.length} job(s)`);
    for (const sk of result.skipped) info(`  ✖ ${sk.schedule.name}: ${sk.reason}`);
  });

schedule
  .command('install-task')
  .description('Registra no Agendador de Tarefas do Windows uma tarefa única que roda "schedule tick" periodicamente (RN-007: sempre headless)')
  .option('--interval-minutes <n>', 'intervalo entre checagens', '5')
  .option('--dry-run', 'mostra o comando schtasks sem executá-lo')
  .action(async (opts: { intervalMinutes: string; dryRun?: boolean }) => {
    const intervalMinutes = Number(opts.intervalMinutes);
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1) fail('--interval-minutes precisa ser um inteiro >= 1.');

    if (opts.dryRun) {
      const args = buildInstallArgs({ intervalMinutes });
      // Só adiciona aspas para exibição em argumentos que ainda não têm as suas
      // próprias (o valor de /tr já vem citado por buildTickCommand).
      const display = args.map((a) => (a.includes(' ') && !a.startsWith('"') ? `"${a}"` : a)).join(' ');
      info('  Comando que seria executado (nada foi alterado):');
      info(`  schtasks ${display}`);
      return;
    }

    try {
      await installWindowsTask({ intervalMinutes });
      ok(`Tarefa "${TICK_TASK_NAME}" registrada, checando a cada ${intervalMinutes} minuto(s).`);
      info('  Não testado contra um Agendador de Tarefas real neste ambiente de desenvolvimento (R-01) —');
      info('  confirme com "maestro schedule task-status" e, se algo não bater, "schedule install-task --dry-run".');
    } catch (err) {
      fail(formatError(err));
    }
  });

schedule
  .command('uninstall-task')
  .description('Remove a tarefa do Agendador de Tarefas do Windows')
  .action(async () => {
    try {
      await uninstallWindowsTask();
      ok('Tarefa removida do Agendador de Tarefas do Windows.');
    } catch (err) {
      fail(formatError(err));
    }
  });

schedule
  .command('task-status')
  .description('Consulta se a tarefa está registrada no Agendador de Tarefas do Windows')
  .action(async () => {
    try {
      const status = await windowsTaskStatus();
      if (!status.installed) return info('Tarefa não registrada. Use "maestro schedule install-task".');
      ok('Tarefa registrada.');
      if (status.raw) info(status.raw);
    } catch (err) {
      fail(formatError(err));
    }
  });

/* ─────────────────────────  FILA E HISTÓRICO  ───────────────────────── */

program
  .command('queue')
  .description('Estado da fila (RF-052)')
  .action(() => {
    const rows = getDb()
      .prepare(`SELECT status, COUNT(*) AS n FROM jobs GROUP BY status`)
      .all() as Array<{ status: string; n: number }>;
    if (rows.length === 0) return info('Fila vazia.');
    for (const row of rows) info(`  ${String(row.status).padEnd(12)} ${row.n}`);
  });

program
  .command('history')
  .description('Histórico de execuções (RF-074)')
  .option('-n, --limit <n>', 'quantidade de registros', '20')
  .option('-s, --status <status>', 'filtra por status')
  .action((opts: { limit: string; status?: string }) => {
    const rows = runs.list({ limit: Number(opts.limit), status: opts.status as never });
    if (rows.length === 0) return info('Nenhuma execução registrada.');
    for (const r of rows) {
      const degraded = Number(r.degraded) === 1 ? ' ⚠' : '';
      info(
        `  ${String(r.started_at).slice(0, 19)}  ${String(r.status).padEnd(9)} ${String(r.kind).padEnd(7)} ` +
          `${String(r.target_name ?? '—').padEnd(24)} ${String(r.duration_ms ?? 0)}ms${degraded}`,
      );
    }
  });

program
  .command('stats')
  .description('Métricas dos últimos 30 dias (RF-076)')
  .action(() => {
    const s = runs.stats(30);
    const rate = s.total > 0 ? ((s.success / s.total) * 100).toFixed(1) : '0.0';
    info(`  Execuções:        ${s.total}`);
    info(`  Taxa de sucesso:  ${rate}%`);
    info(`  Falhas:           ${s.failed}`);
    info(`  Bloqueios:        ${s.blocked}`);
    info(`  Com degradação:   ${s.degraded}`);
    info(`  Duração média:    ${(s.avgMs / 1000).toFixed(1)}s`);
  });

program
  .command('cleanup')
  .description('Remove artefatos expirados (RF-072)')
  .action(async () => {
    const maestro = new Maestro();
    const { removed } = maestro.cleanupArtifacts();
    ok(`${removed} execução(ões) removida(s) conforme a política de retenção.`);
  });

program
  .command('doctor')
  .description('Diagnóstico do ambiente (RNF-026)')
  .action(async () => {
    info(`  Node:             ${process.version}`);
    info(`  Plataforma:       ${process.platform} ${process.arch}`);
    info(`  Diretório dados:  ${paths.root}`);
    info(`  Banco:            ${existsSync(paths.db) ? `${(statSync(paths.db).size / 1024).toFixed(0)} KB` : 'não criado'}`);

    const detected = await detectBrowsers();
    info(`  Navegadores:      ${detected.length > 0 ? detected.map((b) => b.id).join(', ') : 'nenhum detectado'}`);

    const all = profiles.list();
    info(`  Perfis:           ${all.length} (${all.filter((p) => p.status === 'authenticated').length} autenticados)`);

    const pending = getDb().prepare(`SELECT COUNT(*) AS n FROM jobs WHERE status = 'pending'`).get() as { n: number };
    info(`  Jobs pendentes:   ${pending.n}`);

    if (process.platform !== 'win32') {
      info('\n  ⚠ Plataforma alvo é Windows (R-01). Detecção de navegadores e agendamento não funcionam aqui.');
    }
  });

/* ─────────────────────────  HELPERS  ───────────────────────── */

function parseVars(pairs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq < 1) fail(`Variável inválida: "${pair}". Use o formato nome=valor.`);
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

function describeFirst(selectors: Array<{ kind: string; value: string; name?: string }>): string {
  const first = selectors[0];
  if (!first) return '';
  return first.kind === 'role' ? `role=${first.value}${first.name ? `[${first.name}]` : ''}` : `${first.kind}=${first.value}`;
}

/** Execução interativa fora da fila: modo teste e passo a passo (RF-038, RF-039). */
async function runInteractive(flowId: string, profileName: string, variables: Record<string, string>, stepByStep: boolean): Promise<void> {
  const p = profiles.find(profileName);
  if (!p) fail(`Perfil "${profileName}" não encontrado.`);

  const maestro = new Maestro();
  await maestro.init();
  const config = loadConfig();
  const f = loadFlow(flowId);

  const context = await launchProfile({
    profile: p,
    executablePath: maestro.resolveExecutable(p.browserId),
    headless: false,
    viewport: f.viewport,
    allowUnauthenticated: true,
  });

  try {
    const result = await replayFlow({
      flow: f,
      context,
      config,
      variables,
      dryRun: true,
      beforeStep: stepByStep
        ? async (step, index, total) => {
            const selector = 'selectors' in step && step.selectors?.length ? describeFirst(step.selectors) : '';
            const answer = await prompt(`  [${index + 1}/${total}] ${step.type} ${selector} — Enter para executar, "q" para parar: `);
            return answer.trim().toLowerCase() !== 'q';
          }
        : undefined,
      onStepResult: (r) => {
        const mark = r.status === 'success' ? '✔' : r.status === 'skipped' ? '–' : '✖';
        const degraded = r.degraded ? ` (fallback #${r.selectorUsed})` : '';
        info(`    ${mark} passo ${r.index} ${r.type}${degraded}${r.error ? ` — ${r.error.split('\n')[0]}` : ''}`);
      },
    });

    info(`\n  Status: ${result.status}  |  evidências em ${result.artifactsDir}`);
  } finally {
    await context.close();
    await maestro.shutdown();
  }
}

program.parseAsync(process.argv).catch((err: unknown) => {
  fail(formatError(err));
});
