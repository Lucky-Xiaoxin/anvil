import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vaultConfigSchema, type VaultConfig } from '@anvil/shared';

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const vaultDir = join(repoRoot, 'vault');
export const webDistDir = join(repoRoot, 'packages', 'web', 'dist');

const configFile = join(vaultDir, 'config.json');
const exampleConfigFile = join(repoRoot, 'vault.example', 'config.json');

export function dbFile(): string {
  return join(vaultDir, 'anvil.db');
}

function writeConfig(cfg: VaultConfig): void {
  mkdirSync(vaultDir, { recursive: true });
  writeFileSync(configFile, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
}

export function loadConfig(): VaultConfig {
  if (!existsSync(configFile)) {
    const seed = existsSync(exampleConfigFile) ? exampleConfigFile : null;
    const raw = seed ? readFileSync(seed, 'utf8') : '{}';
    const cfg = vaultConfigSchema.parse(JSON.parse(raw));
    writeConfig(cfg);
    return cfg;
  }
  return vaultConfigSchema.parse(JSON.parse(readFileSync(configFile, 'utf8')));
}

export function saveHandle(handle: string): VaultConfig {
  const cfg = { ...loadConfig(), cfHandle: handle };
  writeConfig(cfg);
  return cfg;
}

export function portOf(cfg: VaultConfig): number {
  const fromEnv = Number(process.env.ANVIL_PORT);
  return Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : cfg.port;
}
