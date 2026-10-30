/**
 * 当前练习草稿（docs/contracts/29 §4.3）：每场单键 `arena:draft:<arenaPath>`。
 *
 * 这里只做纯状态与 localStorage：计时数学仍走 engine.ts，正式档读写走 api.ts。
 * 旧 `arena:session:` / `arena:ghost:` 只在新键不存在时迁移一次；迁移成功才删旧键，
 * 失败保留原件并把错误交给界面 —— 不把「读不出来」当「没有」。
 */
import type { ArenaRecord, ArenaRecordCreateInput, ArenaRecordResult, ArenaRecordUpdateInput } from '@anvil/shared';
import { arenaGhostEquals, parseArenaRecordResult, parseWorkArenaGhost } from '@anvil/shared';
import type { Session } from './engine.ts';
import { startSession, type GhostSub } from './engine.ts';
import { clearGhost, clearSession, loadGhost, loadSession, type GhostData, type Store } from './session.ts';

export const DRAFT_PREFIX = 'arena:draft:';
export const draftKey = (path: string): string => `${DRAFT_PREFIX}${path}`;

export type DraftPhase = 'running' | 'finished' | 'legacy-unconfirmed';

export interface DraftTarget {
  recordId: string;
  revision: string;
  name: string;
}

/** 只比较成绩与结束信息；显示开关、回顾游标不参与 dirty */
export interface DraftBaseline {
  result: ArenaRecordResult;
  subs: GhostSub[];
}

export interface DraftPendingSave {
  recordId: string;
  payload: ArenaRecordCreateInput;
}

export interface ArenaDraft {
  schema: 1;
  draftId: string;
  phase: DraftPhase;
  session: Session | null;
  ghost: GhostData;
  result: ArenaRecordResult | null;
  target: DraftTarget | null;
  savedBaseline: DraftBaseline | null;
  pendingSave: DraftPendingSave | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function sessionOf(v: unknown): Session | null {
  if (!isRecord(v)) return null;
  if (typeof v.started !== 'number' || !Number.isFinite(v.started)) return null;
  const durationMs = typeof v.durationMs === 'number' && Number.isFinite(v.durationMs) ? v.durationMs : 0;
  return {
    started: v.started,
    hold: v.hold === true,
    paused: v.paused === true,
    ended: v.ended === true,
    scrubMs: typeof v.scrubMs === 'number' && Number.isFinite(v.scrubMs) ? v.scrubMs : 0,
    at: typeof v.at === 'number' && Number.isFinite(v.at) ? v.at : 0,
    durationMs: Math.max(0, durationMs),
  };
}

function targetOf(v: unknown): DraftTarget | null {
  if (!isRecord(v)) return null;
  if (typeof v.recordId !== 'string' || typeof v.revision !== 'string' || typeof v.name !== 'string') return null;
  return { recordId: v.recordId, revision: v.revision, name: v.name };
}

function strictGhost(v: unknown): GhostData | null {
  const parsed = parseWorkArenaGhost(v);
  return parsed.ok ? parsed.ghost : null;
}

function baselineOf(v: unknown): DraftBaseline | null {
  if (!isRecord(v)) return null;
  const result = parseArenaRecordResult(v.result);
  if (!result.ok) return null;
  const ghost = Array.isArray(v.subs) ? strictGhost({ show: true, subs: v.subs }) : null;
  if (ghost === null) return null;
  return { result: result.result, subs: ghost.subs };
}

function pendingOf(v: unknown): DraftPendingSave | null {
  if (!isRecord(v)) return null;
  if (typeof v.recordId !== 'string' || !isRecord(v.payload)) return null;
  const payload = v.payload;
  if (typeof payload.arenaPath !== 'string' || typeof payload.name !== 'string') return null;
  const result = parseArenaRecordResult(payload.result);
  const ghost = strictGhost(payload.ghost);
  if (!result.ok || ghost === null) return null;
  return {
    recordId: v.recordId,
    payload: {
      arenaPath: payload.arenaPath,
      ...(typeof payload.contestTitle === 'string' ? { contestTitle: payload.contestTitle } : {}),
      recordId: v.recordId,
      name: payload.name,
      result: result.result,
      ghost,
    },
  };
}

export type DraftLoad =
  | { kind: 'none' }
  | { kind: 'draft'; draft: ArenaDraft }
  | { kind: 'error'; message: string };

export function parseDraft(v: unknown): ArenaDraft | null {
  if (!isRecord(v)) return null;
  if (v.schema !== 1) return null;
  if (typeof v.draftId !== 'string' || v.draftId === '') return null;
  const phase = v.phase;
  if (phase !== 'running' && phase !== 'finished' && phase !== 'legacy-unconfirmed') return null;
  const ghost = strictGhost(v.ghost);
  if (ghost === null) return null;
  const result = v.result === null || v.result === undefined ? null : parseArenaRecordResult(v.result);
  if (result !== null && !result.ok) return null;
  const session = phase === 'legacy-unconfirmed' ? null : sessionOf(v.session);
  // 已结束必须有结束信息；进行中必须有计时锚点。读不懂就整份报错，不静默补
  if (phase === 'finished' && result === null) return null;
  if (phase === 'running' && session === null) return null;
  return {
    schema: 1,
    draftId: v.draftId,
    phase,
    session,
    ghost,
    result: result === null ? null : result.result,
    target: targetOf(v.target),
    savedBaseline: baselineOf(v.savedBaseline),
    pendingSave: pendingOf(v.pendingSave),
  };
}

export function loadDraft(store: Store, path: string): DraftLoad {
  let raw: string | null;
  try {
    raw = store.getItem(draftKey(path));
  } catch {
    return { kind: 'error', message: '浏览器存储不可用，当前练习无法读取 / 自动保留' };
  }
  if (raw === null || raw === '') return { kind: 'none' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'error', message: '当前草稿的格式读不懂；原数据仍在浏览器里，不会自动覆盖' };
  }
  const draft = parseDraft(parsed);
  if (draft === null) {
    return { kind: 'error', message: '当前草稿的格式读不懂；原数据仍在浏览器里，不会自动覆盖' };
  }
  return { kind: 'draft', draft };
}

/** 写入失败（隐私模式 / 配额）必须让界面看得见：返回 false，不抛 */
export function saveDraft(store: Store, path: string, draft: ArenaDraft): boolean {
  try {
    store.setItem(draftKey(path), JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

export function clearDraft(store: Store, path: string): void {
  try {
    store.removeItem(draftKey(path));
  } catch {
    /* 清不掉也只剩一份旧草稿，不阻塞界面 */
  }
}

export function listDraftPaths(store: Store): string[] {
  if (typeof store.key !== 'function' || typeof store.length !== 'number') return [];
  const out: string[] = [];
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i);
    if (k !== null && k.startsWith(DRAFT_PREFIX)) out.push(k.slice(DRAFT_PREFIX.length));
  }
  return out;
}

/**
 * 删除存档后解除同场草稿的编辑目标（docs/contracts/29 §6.2）：
 * 保留 ghost / result，下次保存按「新建一份」走，避免一直对着已不存在的 recordId 更新。
 */
export function detachDraftTarget(store: Store, arenaPath: string, recordId: string): boolean {
  const loaded = loadDraft(store, arenaPath);
  if (loaded.kind !== 'draft' || loaded.draft.target === null || loaded.draft.target.recordId !== recordId) return false;
  return saveDraft(store, arenaPath, { ...loaded.draft, target: null, savedBaseline: null });
}

export function newDraftId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `drf_${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export function newDraft(now: number): ArenaDraft {
  return {
    schema: 1,
    draftId: newDraftId(),
    phase: 'running',
    session: startSession(now),
    ghost: { show: true, subs: [] },
    result: null,
    target: null,
    savedBaseline: null,
    pendingSave: null,
  };
}

/** 补录草稿：不经过计时，时长取当前榜单（契约 §4.2 manual + declared） */
export function newManualDraft(durationMs: number, ghost: GhostData = { show: true, subs: [] }): ArenaDraft {
  return {
    schema: 1,
    draftId: newDraftId(),
    phase: 'finished',
    session: null,
    ghost,
    result: { origin: 'manual', finish: 'declared', durationMs, stoppedAtMs: null },
    target: null,
    savedBaseline: null,
    pendingSave: null,
  };
}

/** 结束：到时写满时长；主动结束保留真实停止位置（契约 §3.2.3） */
export function finishDraft(draft: ArenaDraft, durationMs: number, stoppedAtMs: number, now: number): ArenaDraft {
  const stopped = Math.max(0, Math.min(durationMs, Math.floor(stoppedAtMs)));
  const full = stopped >= durationMs;
  const session: Session = {
    ...(draft.session ?? startSession(now)),
    hold: true,
    paused: false,
    ended: true,
    at: stopped,
    scrubMs: stopped,
    durationMs,
  };
  return {
    ...draft,
    phase: 'finished',
    session,
    result: {
      origin: 'timed',
      finish: full ? 'time-limit' : 'stopped',
      durationMs,
      stoppedAtMs: full ? durationMs : stopped,
    },
  };
}

/** 旧 review / 只有逐发的草稿：确认已结束后按补录转换，不伪造计时完成 */
export function declareFinished(draft: ArenaDraft, durationMs: number): ArenaDraft {
  return {
    ...draft,
    phase: 'finished',
    session: null,
    result: { origin: 'manual', finish: 'declared', durationMs, stoppedAtMs: null },
  };
}

/** 旧 live「恢复为当前练习」：复制成绩与位置，暂停态进入，明确点继续才走钟 */
export function draftFromLegacyLive(ghost: GhostData, viewMs: number, durationMs: number, now: number): ArenaDraft {
  const at = Math.max(0, Math.min(durationMs > 0 ? durationMs : viewMs, Math.floor(viewMs)));
  return {
    schema: 1,
    draftId: newDraftId(),
    phase: 'running',
    session: { started: now - at, hold: true, paused: true, ended: false, scrubMs: at, at, durationMs },
    ghost,
    result: null,
    target: null,
    savedBaseline: null,
    pendingSave: null,
  };
}

/**
 * 编辑历史档：载入成绩与结束信息。旧 review 已由界面确认结束后传入 manual 结果；
 * baseline 记原档的结束状态（unknown），这样确认后尚未保存的升级会显示为有修改。
 */
export function draftFromRecord(
  record: ArenaRecord,
  result: ArenaRecordResult,
  revision: string,
  baselineResult: ArenaRecordResult = record.result,
): ArenaDraft {
  return {
    schema: 1,
    draftId: newDraftId(),
    phase: 'finished',
    session: null,
    ghost: { show: record.ghost.show, subs: record.ghost.subs.map((s) => ({ ...s })) },
    result,
    target: { recordId: record.recordId, revision, name: record.name },
    savedBaseline: { result: baselineResult, subs: record.ghost.subs.map((s) => ({ ...s })) },
    pendingSave: null,
  };
}

const subsKey = (subs: readonly GhostSub[]): string =>
  [...subs].sort((a, b) => a.p - b.p || a.t - b.t).map((s) => `${s.p}:${s.t}:${s.r}`).join(',');

export function resultEquals(a: ArenaRecordResult | null, b: ArenaRecordResult | null): boolean {
  if (a === null || b === null) return a === b;
  return a.origin === b.origin && a.finish === b.finish && a.durationMs === b.durationMs && a.stoppedAtMs === b.stoppedAtMs;
}

/** 有未保存修改：结束信息或逐发与最近一次成功保存不同 */
export function isDirty(draft: ArenaDraft): boolean {
  if (draft.result === null) return false;
  if (draft.savedBaseline === null) return true;
  if (!resultEquals(draft.result, draft.savedBaseline.result)) return true;
  return subsKey(draft.ghost.subs) !== subsKey(draft.savedBaseline.subs);
}

export type ReplaceCase = 'none' | 'running' | 'unsaved' | 'legacy';

/** 替换草稿前的确认（契约 §3.4）：干净或没有草稿直接切；进行中 / 未保存 / 旧数据各有一套动作 */
export function replaceCaseOf(draft: ArenaDraft | null): ReplaceCase {
  if (draft === null) return 'none';
  if (draft.phase === 'running') return 'running';
  if (draft.phase === 'legacy-unconfirmed') return 'legacy';
  return isDirty(draft) ? 'unsaved' : 'none';
}

export function canSaveDraft(draft: ArenaDraft | null): boolean {
  return draft !== null && draft.phase === 'finished' && draft.result !== null;
}

export function finishSwitchLabel(c: ReplaceCase): string {
  return c === 'running' ? '结束并保存后切换' : c === 'legacy' ? '标记旧成绩已结束并保存后切换' : '保存后切换';
}

export function discardSwitchLabel(c: ReplaceCase): string {
  return c === 'running' ? '放弃本次练习后切换' : c === 'legacy' ? '放弃后切换' : '放弃修改后切换';
}

/** 保存成功后：目标切到该档，baseline 只记成绩与结束信息；草稿保留并标记已保存 */
export function applySaveSuccess(draft: ArenaDraft, record: ArenaRecord, revision: string): ArenaDraft {
  return {
    ...draft,
    phase: 'finished',
    result: record.result,
    target: { recordId: record.recordId, revision, name: record.name },
    savedBaseline: { result: record.result, subs: record.ghost.subs.map((s) => ({ ...s })) },
    pendingSave: null,
  };
}

export function buildCreatePayload(
  draft: ArenaDraft,
  opts: { arenaPath: string; contestTitle?: string; recordId: string; name: string },
): ArenaRecordCreateInput | null {
  if (draft.result === null) return null;
  return {
    arenaPath: opts.arenaPath,
    ...(opts.contestTitle === undefined || opts.contestTitle === '' ? {} : { contestTitle: opts.contestTitle }),
    recordId: opts.recordId,
    name: opts.name,
    result: draft.result,
    ghost: { show: draft.ghost.show, subs: draft.ghost.subs.map((s) => ({ ...s })) },
  };
}

export function buildUpdatePayload(
  draft: ArenaDraft,
  opts: { arenaPath: string; recordId: string; expectedRevision: string },
): ArenaRecordUpdateInput | null {
  if (draft.result === null) return null;
  return {
    arenaPath: opts.arenaPath,
    recordId: opts.recordId,
    expectedRevision: opts.expectedRevision,
    result: draft.result,
    ghost: { show: draft.ghost.show, subs: draft.ghost.subs.map((s) => ({ ...s })) },
  };
}

/** 更新响应丢失后的对账：读回的档与本次提交内容一致即视为已保存 */
export function updateReconciled(draft: ArenaDraft, record: ArenaRecord): boolean {
  if (draft.result === null) return false;
  if (record.recordId !== draft.target?.recordId) return false;
  return resultEquals(record.result, draft.result) && arenaGhostEquals(record.ghost, { show: draft.ghost.show, subs: draft.ghost.subs });
}

export type LegacyMigration =
  | { kind: 'none' }
  | { kind: 'migrated'; draft: ArenaDraft }
  | { kind: 'error'; message: string };

/**
 * 新键不存在时只读兼容旧 session / ghost：未结束 session → running；ended → finished（按到时完赛）；
 * 只有逐发 → legacy-unconfirmed。成功写入新键后才删旧键。
 */
export function migrateLegacy(store: Store, path: string, durationMs: number): LegacyMigration {
  try {
    // 新键存在时以新键为准：即使旧键还在，也不能复活已放弃的练习
    if (store.getItem(draftKey(path)) !== null) return { kind: 'none' };
  } catch {
    return { kind: 'error', message: '浏览器存储不可用，旧数据无法迁移' };
  }
  const session = loadSession(store, path);
  const ghost = loadGhost(store, path);
  if (session === null && ghost === null) return { kind: 'none' };

  let draft: ArenaDraft;
  if (session !== null && !session.ended) {
    draft = {
      schema: 1,
      draftId: newDraftId(),
      phase: 'running',
      session: { ...session, durationMs: durationMs > 0 ? durationMs : session.durationMs },
      ghost: ghost ?? { show: true, subs: [] },
      result: null,
      target: null,
      savedBaseline: null,
      pendingSave: null,
    };
  } else if (session !== null && session.ended) {
    // 旧版「结束」总落到整场时长；没有真实早停记录，按到时完赛迁移（2026-10-29 用户确认）
    const span = durationMs > 0 ? durationMs : session.durationMs;
    draft = {
      schema: 1,
      draftId: newDraftId(),
      phase: 'finished',
      session: { ...session, hold: true, ended: true, durationMs: span, at: span, scrubMs: session.scrubMs },
      ghost: ghost ?? { show: true, subs: [] },
      result: { origin: 'timed', finish: 'time-limit', durationMs: span, stoppedAtMs: span },
      target: null,
      savedBaseline: null,
      pendingSave: null,
    };
  } else {
    draft = {
      schema: 1,
      draftId: newDraftId(),
      phase: 'legacy-unconfirmed',
      session: null,
      ghost: ghost ?? { show: true, subs: [] },
      result: null,
      target: null,
      savedBaseline: null,
      pendingSave: null,
    };
  }

  if (!saveDraft(store, path, draft)) {
    return { kind: 'error', message: '旧数据迁移写入失败：原 session / 逐发还在浏览器里，没有删除' };
  }
  if (session !== null) clearSession(store, path);
  if (ghost !== null) clearGhost(store, path);
  return { kind: 'migrated', draft };
}

/** 保存 / 恢复等会替换草稿的动作用：干净草稿直接覆盖，旧键已消费不用再管 */
export function draftSummary(draft: ArenaDraft | null): string {
  if (draft === null) return '没有当前草稿';
  if (draft.phase === 'running') return draft.session?.paused === true ? '当前练习已暂停' : '当前练习进行中';
  if (draft.phase === 'legacy-unconfirmed') return '旧成绩 · 需确认是否已结束';
  return draft.target === null ? '已结束 · 未保存' : isDirty(draft) ? '已结束 · 有未保存修改' : '已结束 · 已保存';
}
