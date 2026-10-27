import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vaultConfigSchema, type VaultConfig } from '@anvil/shared';
import { writeFileAtomic } from './atomic.ts';

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const vaultDir = join(repoRoot, 'vault');
export const webDistDir = join(repoRoot, 'packages', 'web', 'dist');

const configFile = join(vaultDir, 'config.json');
const exampleConfigFile = join(repoRoot, 'vault.example', 'config.json');

/** 最近一次读配置失败留下的警告（人话，含留底文件名）；读成功即清 —— /api/status 带给设置页 */
let configWarning: string | null = null;

export function configWarningOf(): string | null {
  return configWarning;
}

export function dbFile(): string {
  return join(vaultDir, 'anvil.db');
}

function writeConfig(cfg: VaultConfig): void {
  mkdirSync(vaultDir, { recursive: true });
  writeFileAtomic(configFile, `${JSON.stringify(cfg, null, 2)}\n`);
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

/** 读不懂时原文件另存 `config.json.bad-<时间戳>`：默认值一旦被下一次保存整包写回，手改坏的原件至少还能找回来 */
function stashBadConfig(raw: string, reason: string): void {
  // /api/status 每次都调 loadConfig：坏文件只在本进程第一次读坏时留底一次，别每秒落一个备份
  if (configWarning !== null) {
    console.error(`[anvil] 配置仍读不了（${reason}）：沿用首次留底，本次继续按默认配置运行`);
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const badFile = `${configFile}.bad-${stamp}`;
  try {
    writeFileAtomic(badFile, raw);
    configWarning = `vault/config.json 没读懂（${reason}）：原文件已另存 ${basename(badFile)}，本次按默认配置运行`;
  } catch {
    configWarning = `vault/config.json 没读懂（${reason}）：本次按默认配置运行（原文件另存失败）`;
  }
  console.error(`[anvil] ${configWarning}`);
}

export function loadConfig(): VaultConfig {
  if (!existsSync(configFile)) {
    const seed = existsSync(exampleConfigFile) ? exampleConfigFile : null;
    const cfg = parseConfig(seed ? readFileSync(seed, 'utf8') : '{}');
    writeConfig(cfg);
    configWarning = null;
    return cfg;
  }
  const raw = readFileSync(configFile, 'utf8');
  try {
    const cfg = vaultConfigSchema.parse(JSON.parse(raw));
    configWarning = null;
    return cfg;
  } catch (err) {
    stashBadConfig(raw, (err as Error).message);
    return vaultConfigSchema.parse({});
  }
}

/**
 * 坏配置期间的写入拒绝：`loadConfig()` 读不懂会退回默认值，此时任何「带哪个改哪个」的保存
 * 都会把没带的键一起写成默认值 —— 宁可拒掉，让用户先修 `vault/config.json`。
 */
export class ConfigWriteBlocked extends Error {
  constructor() {
    super('vault/config.json 现在读不懂：先按留底的 config.json.bad-* 修好它再保存，否则其它设置会被写成默认值');
    this.name = 'ConfigWriteBlocked';
  }
}

/** 读一次配置并确认这次读是干净的；坏配置期间只读不写 */
function loadForWrite(): VaultConfig {
  const cfg = loadConfig();
  if (configWarning !== null) throw new ConfigWriteBlocked();
  return cfg;
}

/** 分源保存：带哪个改哪个，没带的保持原样（docs/contracts/09 §4） */
export function saveHandles(patch: { cfHandle?: string; atHandle?: string }): VaultConfig {
  const cfg = { ...loadForWrite(), ...patch };
  writeConfig(cfg);
  return cfg;
}

/** 认领 / 换人写的就是这一个键；'' = 未认领（docs/contracts/14 §3） */
export function saveXcpcPlayerKey(key: string): VaultConfig {
  const cfg = { ...loadForWrite(), xcpcPlayerKey: key };
  writeConfig(cfg);
  return cfg;
}

/** 工坊受管根：只改这一个键，不碰 handle / port / 认领态（docs/contracts/23 §9.3） */
export function saveWorkspaceRoot(root: string): VaultConfig {
  const cfg = { ...loadForWrite(), workspaceRoot: root };
  writeConfig(cfg);
  return cfg;
}

export function portOf(cfg: VaultConfig): number {
  const fromEnv = Number(process.env.ANVIL_PORT);
  return Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : cfg.port;
}
