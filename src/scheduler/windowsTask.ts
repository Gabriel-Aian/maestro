import { execFile } from 'node:child_process';
import { platform } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * Nome fixo: existe UMA tarefa do Windows, não uma por agendamento. Ela só
 * chama `schedule tick`, que lê os agendamentos do banco a cada execução —
 * criar/editar/remover agendamentos nunca precisa tocar o Agendador de
 * Tarefas de novo, só a primeira instalação (e uma reinstalação se o
 * intervalo de checagem mudar).
 */
export const TICK_TASK_NAME = 'MaestroScheduleTick';

/**
 * Não testado contra um Agendador de Tarefas real: este ambiente de
 * desenvolvimento é Linux (RNF a parte, o alvo do produto é Windows — R-01,
 * igual à ressalva já existente sobre o navegador). A sintaxe do `schtasks`
 * abaixo é estável e documentada há muitas versões do Windows, mas vale
 * confirmar com `--dry-run` antes de instalar de verdade.
 */
function assertWindows(action: string): void {
  if (platform() !== 'win32') {
    throw new Error(`${action} só é possível no Windows (R-01) — plataforma atual: ${platform()}.`);
  }
}

export interface InstallTaskOptions {
  intervalMinutes: number;
  /** Para testes/inspeção: caminho do node.exe a usar em vez de process.execPath. */
  nodePath?: string;
  /** Para testes/inspeção: caminho do cli.js a usar em vez de process.argv[1]. */
  cliPath?: string;
}

/**
 * Monta a linha de comando que a tarefa do Windows vai executar a cada tick.
 *
 * O default de `nodePath` NÃO pode ser `process.execPath`: essa função é
 * chamada tanto pela CLI (`node dist/cli.js schedule install-task`, onde
 * `process.execPath` de fato aponta para o `node`) quanto pela casca Electron
 * (`electron/main/schedulesIpc.ts`), onde `process.execPath` aponta para o
 * próprio executável do Electron — um binário completamente diferente, que
 * não sabe interpretar um caminho de script como primeiro argumento. O nome
 * puro `"node"` funciona nos dois casos, porque o `schtasks` resolve
 * executáveis sem caminho pela PATH do Windows, exatamente como digitar
 * `node ...` num terminal — e `node` na PATH já é pré-requisito do projeto
 * inteiro (`npm install`, `npm run build`). Mesmo raciocínio não se aplica a
 * `cliPath`: `process.argv[1]` só é confiável quando quem chama é a própria
 * CLI — a Electron passa sempre um `cliPath` explícito.
 */
export function buildTickCommand(opts: { nodePath?: string; cliPath?: string } = {}): string {
  const node = opts.nodePath ?? 'node';
  const cli = opts.cliPath ?? resolve(process.argv[1] ?? 'dist/cli.js');
  return `"${node}" "${cli}" schedule tick`;
}

/**
 * Monta os argumentos do `schtasks /create` sem executar nada — separado de
 * `installWindowsTask` para poder ser inspecionado com `--dry-run` (e
 * testado) neste ambiente de desenvolvimento, que não é Windows.
 */
export function buildInstallArgs(opts: InstallTaskOptions): string[] {
  return [
    '/create',
    '/f', // sobrescreve se já existir — reinstalar é a forma de mudar o intervalo
    '/tn',
    TICK_TASK_NAME,
    '/tr',
    buildTickCommand(opts),
    '/sc',
    'minute',
    '/mo',
    String(opts.intervalMinutes),
    '/rl',
    'limited', // privilégio padrão do usuário, não admin
  ];
}

/**
 * Registra (ou substitui, via /f) a tarefa única que dispara `schedule tick`
 * periodicamente. Modo "só quando o usuário estiver conectado" — sem `/rp`
 * de senha: uma sessão bloqueada continua conectada (só a tela é que trava),
 * então a tarefa roda normalmente; é exatamente o headless (RN-007) que faz
 * isso funcionar sem precisar de área de trabalho visível. Deslogar de
 * verdade a conta impediria o disparo — é o preço de não guardar credencial
 * alguma do Windows, coerente com a postura do projeto sobre senhas (RNF-001
 * é sobre senha de site, mas o mesmo cuidado vale aqui).
 */
export async function installWindowsTask(opts: InstallTaskOptions): Promise<{ command: string; args: string[] }> {
  assertWindows('Registrar a tarefa no Agendador do Windows');
  const args = buildInstallArgs(opts);
  await exec('schtasks', args, { windowsHide: true });
  return { command: 'schtasks', args };
}

export async function uninstallWindowsTask(): Promise<void> {
  assertWindows('Remover a tarefa do Agendador do Windows');
  await exec('schtasks', ['/delete', '/tn', TICK_TASK_NAME, '/f'], { windowsHide: true });
}

export async function windowsTaskStatus(): Promise<{ installed: boolean; raw?: string }> {
  assertWindows('Consultar a tarefa no Agendador do Windows');
  try {
    const { stdout } = await exec('schtasks', ['/query', '/tn', TICK_TASK_NAME, '/fo', 'LIST'], { windowsHide: true });
    return { installed: true, raw: stdout };
  } catch {
    return { installed: false };
  }
}
