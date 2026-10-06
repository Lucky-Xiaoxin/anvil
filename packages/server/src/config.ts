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

/** 配置文件是用户会手改的东西：读不懂就退回默认值，别让整个服务起不来 */
export function parseConfig(raw: string): VaultConfig {
  try {
    return vaultConfigSchema.parse(JSON.parse(raw));
  } catch (err) {
    console.error(`[anvil] 配置读不了（${(err as Error).message}）：退回默认值`);
    return vaultConfigSchema.parse({});
  }
}

export function loadConfig(): VaultConfig {
  if (!existsSync(configFile)) {
    const seed = existsSync(exampleConfigFile) ? exampleConfigFile : null;
    const cfg = parseConfig(seed ? readFileSync(seed, 'utf8') : '{}');
    writeConfig(cfg);
    return cfg;
  }
  return parseConfig(readFileSync(configFile, 'utf8'));
}

/** 分源保存：带哪个改哪个，没带的保持原样（docs/09 §4） */
export function saveHandles(patch: { cfHandle?: string; atHandle?: string }): VaultConfig {
  const cfg = { ...loadConfig(), ...patch };
  writeConfig(cfg);
  return cfg;
}

/** 认领 / 换人写的就是这一个键；'' = 未认领（docs/14 §3） */
export function saveXcpcPlayerKey(key: string): VaultConfig {
  const cfg = { ...loadConfig(), xcpcPlayerKey: key };
  writeConfig(cfg);
  return cfg;
}

export function portOf(cfg: VaultConfig): number {
  const fromEnv = Number(process.env.ANVIL_PORT);
  return Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : cfg.port;
}
