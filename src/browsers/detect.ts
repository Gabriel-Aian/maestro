import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { platform } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { logger } from '../logger.js';

const exec = promisify(execFile);

export interface DetectedBrowser {
  id: string;
  name: string;
  executablePath: string;
  /** 'registry' | 'filesystem' | 'manual' — útil para diagnóstico (RNF-026). */
  source: 'registry' | 'filesystem' | 'manual';
  version?: string;
}

/**
 * Chaves do Registro usadas pelo Windows para localizar navegadores instalados.
 * App Paths cobre instalação por máquina e por usuário sem precisar adivinhar
 * Program Files vs Program Files (x86) vs %LOCALAPPDATA% (RF-001).
 */
const REGISTRY_TARGETS: ReadonlyArray<{ id: string; name: string; exe: string }> = [
  { id: 'brave', name: 'Brave', exe: 'brave.exe' },
  { id: 'chrome', name: 'Google Chrome', exe: 'chrome.exe' },
  { id: 'edge', name: 'Microsoft Edge', exe: 'msedge.exe' },
];

const APP_PATHS_ROOTS = [
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths',
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths',
];

async function queryRegistry(key: string): Promise<string | null> {
  try {
    const { stdout } = await exec('reg', ['query', key, '/ve'], { windowsHide: true });
    // Saída: "    (Padrão)    REG_SZ    C:\Caminho\app.exe"
    const match = stdout.match(/REG_SZ\s+(.+?)\s*$/m);
    const value = match?.[1]?.trim().replace(/^"|"$/g, '');
    return value && existsSync(value) ? value : null;
  } catch {
    return null;
  }
}

function filesystemCandidates(exe: string): string[] {
  const bases = [
    process.env['ProgramFiles'],
    process.env['ProgramFiles(x86)'],
    process.env['LOCALAPPDATA'],
  ].filter((b): b is string => Boolean(b));

  const vendorPaths: Record<string, string[]> = {
    'brave.exe': ['BraveSoftware\\Brave-Browser\\Application'],
    'chrome.exe': ['Google\\Chrome\\Application'],
    'msedge.exe': ['Microsoft\\Edge\\Application'],
  };

  const out: string[] = [];
  for (const base of bases) {
    for (const vendor of vendorPaths[exe] ?? []) {
      out.push(join(base, vendor, exe));
    }
  }
  return out;
}

/**
 * Detecta os navegadores Chromium instalados (RF-001).
 * Fora do Windows retorna lista vazia — a detecção é específica da plataforma alvo.
 */
export async function detectBrowsers(): Promise<DetectedBrowser[]> {
  if (platform() !== 'win32') {
    logger.debug('Detecção de navegadores ignorada: plataforma não é Windows');
    return [];
  }

  const found: DetectedBrowser[] = [];

  for (const target of REGISTRY_TARGETS) {
    let executablePath: string | null = null;
    let source: DetectedBrowser['source'] = 'registry';

    for (const root of APP_PATHS_ROOTS) {
      executablePath = await queryRegistry(`${root}\\${target.exe}`);
      if (executablePath) break;
    }

    if (!executablePath) {
      source = 'filesystem';
      executablePath = filesystemCandidates(target.exe).find((p) => existsSync(p)) ?? null;
    }

    if (executablePath) {
      found.push({ id: target.id, name: target.name, executablePath, source });
    }
  }

  logger.info({ count: found.length, browsers: found.map((b) => b.id) }, 'Navegadores detectados');
  return found;
}

/**
 * Valida um caminho informado manualmente (RF-002, RF-003).
 * Confere existência, que é arquivo e que o executável tem nome de Chromium
 * conhecido — evita que o usuário aponte para o Firefox, que não fala CDP (R-02).
 */
export function validateBrowserPath(executablePath: string): { ok: true } | { ok: false; reason: string } {
  if (!existsSync(executablePath)) {
    return { ok: false, reason: 'Arquivo não encontrado no caminho informado.' };
  }
  if (!statSync(executablePath).isFile()) {
    return { ok: false, reason: 'O caminho aponta para um diretório, não para um executável.' };
  }
  const exe = executablePath.toLowerCase().split(/[\\/]/).pop() ?? '';
  const known = ['brave.exe', 'chrome.exe', 'msedge.exe', 'chromium.exe', 'thorium.exe', 'vivaldi.exe', 'opera.exe'];
  if (platform() === 'win32' && !known.includes(exe)) {
    return {
      ok: false,
      reason: `"${exe}" não é um navegador Chromium reconhecido. Apenas navegadores baseados em Chromium são suportados (restrição R-02).`,
    };
  }
  return { ok: true };
}
