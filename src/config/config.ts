import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { paths, ensureDataDirs } from '../config/paths.js';
import { AppConfigSchema, type AppConfig } from '../types/schema.js';

let cached: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (cached) return cached;
  ensureDataDirs();

  if (!existsSync(paths.config)) {
    cached = AppConfigSchema.parse({});
    writeFileSync(paths.config, JSON.stringify(cached, null, 2), 'utf8');
    return cached;
  }

  const raw = JSON.parse(readFileSync(paths.config, 'utf8')) as unknown;
  cached = AppConfigSchema.parse(raw);
  return cached;
}

export function saveConfig(config: AppConfig): AppConfig {
  ensureDataDirs();
  const parsed = AppConfigSchema.parse(config);
  writeFileSync(paths.config, JSON.stringify(parsed, null, 2), 'utf8');
  cached = parsed;
  return parsed;
}

export function resetConfigCache(): void {
  cached = null;
}
