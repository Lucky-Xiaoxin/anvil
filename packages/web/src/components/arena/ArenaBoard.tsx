/**
 * 回放榜（docs/contracts/16 §5.2 / §5.3 + docs/contracts/29 §3 / §6）：
 * 同一张榜上区分「当前练习 / 查看历史 / 编辑历史 / 查看终榜」，历史只读、当前草稿单键保存。
 *
 * 走钟每秒一次，但**榜只在分钟滚过的那一刻重建**（§4 性能口径）；行组件 memo 化。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ArenaRecord, ArenaLegacyRecordDto } from '@anvil/shared';
import {
  ApiError,
  createArenaRecord,
  getArenaContest,
  getArenaLegacy,
  getArenaRecordItem,
  listArenaRecords,
  updateArenaRecord,
} from '../../api.ts';
import { clockHMS, clockHM, messageOf } from '../../format.ts';
import { Icon } from '../ui.tsx';
import { useTip } from '../../tip.tsx';
import {
  bandRanges,
  buildBoard,
  buildModel,
  elapsedOf,
  inFreezeWindow,
  minutesOf,
  pause as pauseSession,
  problemHeadState,
  startSession,
  subsUntil,
  tick,
  toMs,
  unpause as unpauseSession,
  type Board,
  type BoardRow,
  type Cell,
  type ContestModel,
  type GhostSub,
  type Session,
  type SrkSolution,
  type TeamModel,
} from './engine.ts';
import type { LeafRow } from './catalog.ts';
import { GhostPanel } from './GhostPanel.tsx';
import { Popover, PopShell, resClass, type Anchor } from './pops.tsx';
import {
  applySaveSuccess,
  buildCreatePayload,
  buildUpdatePayload,
  canSaveDraft,
  clearDraft,
  declareFinished,
  draftFromLegacyLive,
  draftFromRecord,
  draftSummary,
  finishDraft,
  isDirty,
  loadDraft,
  migrateLegacy,
  newDraft,
  newManualDraft,
  replaceCaseOf,
  saveDraft,
  updateReconciled,
  type ArenaDraft,
  type ReplaceCase,
} from './draft.ts';
import {
  arenaTitleOf,
  copySaveName,
  firstSaveName,
  newRecordId,
  recordFinishNote,
  recordToGhost,
  resultLabel,
} from './record.ts';
import { draftKey } from './draft.ts';
import type { GhostData, Store } from './session.ts';
import { ConfirmDialog, HistoryDialog, NameDialog, ReplaceDialog, type HistoryState } from './ArenaDialogs.tsx';

export type ArenaEntryMode = 'practice' | 'review' | 'record' | 'restore-legacy';

interface Props {
  row: LeafRow;
  store: Store;
  onBack: () => void;
  mode: ArenaEntryMode;
  /** mode=record 时必填；来自 #/arena?...&record= */
  recordId?: string | null;
  /** 从目录「历史成绩」进来时直接打开选择层 */
  openHistory?: boolean;
  /** 草稿 / 正式档变化后通知目录刷新 */
  onDraftChanged?: () => void;
}

type Load = { kind: 'loading' } | { kind: 'error'; text: string; missing: boolean } | { kind: 'ready'; model: ContestModel };

type Identity = { kind: 'practice' } | { kind: 'review' } | { kind: 'view'; recordId: string } | { kind: 'edit' };

interface ViewState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  recordId: string | null;
  record: ArenaRecord | null;
  revision: string | null;
  error: string | null;
}

interface SwitchAction {
  kind: 'new-practice' | 'manual' | 'edit' | 'restore-legacy';
  record?: ArenaRecord;
  revision?: string;
  legacy?: ArenaLegacyRecordDto;
}

interface NameState {
  mode: 'save' | 'save-as' | 'switch';
  initial: string;
  draft: ArenaDraft;
  action?: SwitchAction;
}

interface ConflictState {
  kind: 'conflict' | 'unknown';
  message: string;
  recordId: string;
}

interface LegacyConfirmState {
  record: ArenaRecord;
  revision: string;
  after: 'edit' | 'reload';
}

type Pop =
  | { anchor: Anchor; kind: 'sub'; ti: number; p: number }
  | { anchor: Anchor; kind: 'team'; ti: number }
  | { anchor: Anchor; kind: 'ghost' };

const pct = (ms: number, dur: number): string => `${(ms / dur) * 100}%`;

/** 幽灵签名：拼进 minuteKey，改了逐发就重建榜 */
const ghostSig = (g: GhostData | null): string =>
  g === null ? 'none' : `${g.show ? 1 : 0}|${g.subs.map((s) => `${s.p}:${s.t}:${s.r}`).join(',')}`;

const isUnknownError = (err: unknown): boolean =>
  err instanceof ApiError && (err.kind === 'timeout' || err.kind === 'offline' || err.kind === 'aborted');

export function ArenaBoard({ row, store, onBack, mode, recordId = null, openHistory = false, onDraftChanged }: Props) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [tryNo, setTryNo] = useState(0);
  const [draft, setDraft] = useState<ArenaDraft | null>(null);
  const draftRef = useRef<ArenaDraft | null>(null);
  const [draftErr, setDraftErr] = useState<string | null>(null);
  const [storageWarn, setStorageWarn] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const staleRef = useRef(false);
  staleRef.current = stale;
  const [reloadNo, setReloadNo] = useState(0);
  const [draftBooted, setDraftBooted] = useState(false);
  const [identity, setIdentity] = useState<Identity>(
    mode === 'record' && recordId !== null ? { kind: 'view', recordId } : mode === 'review' ? { kind: 'review' } : { kind: 'practice' },
  );
  const [view, setView] = useState<ViewState>({ status: 'idle', recordId: null, record: null, revision: null, error: null });
  const [viewGhost, setViewGhost] = useState<GhostData | null>(null);
  const [viewRetry, setViewRetry] = useState(0);
  const viewSeq = useRef(0);
  const [elapsed, setElapsed] = useState(0);
  const [scrubMs, setScrubMs] = useState(0);
  const [frozenView, setFrozenView] = useState(false);
  const [onlyFormal, setOnlyFormal] = useState(false);
  const [pop, setPop] = useState<Pop | null>(null);
  const boardBox = useRef<HTMLDivElement | null>(null);
  const { show, hide } = useTip();

  const [saveBusy, setSaveBusy] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const [historyOpen, setHistoryOpen] = useState(openHistory);
  const [history, setHistory] = useState<HistoryState>({ status: 'loading', dto: null, error: null });
  const historySeq = useRef(0);

  const [nameState, setNameState] = useState<NameState | null>(null);
  const [nameErr, setNameErr] = useState<string | null>(null);
  const [pending, setPending] = useState<{ action: SwitchAction; case: Exclude<ReplaceCase, 'none'> } | null>(null);
  const [replaceErr, setReplaceErr] = useState<string | null>(null);
  const [legacyConfirm, setLegacyConfirm] = useState<LegacyConfirmState | null>(null);
  const [resetConfirm, setResetConfirm] = useState(false);
  /** 切换前被替换的草稿：保存失败时恢复它（进行中不能因保存失败变成已结束） */
  const switchOriginalRef = useRef<ArenaDraft | null>(null);
  const bootRestoreRef = useRef(mode === 'restore-legacy');
  const initialModeRef = useRef(mode);
  const initialDraftBoot = useRef(true);
  /** 编辑 / 恢复旧进度的异步入口也要“最后意图胜出” */
  const editSeq = useRef(0);
  const restoreSeq = useRef(0);

  /* ---------- 取数：进回放才拉那 1.5MB；失败给重试 ---------- */
  useEffect(() => {
    let cancel = false;
    setLoad({ kind: 'loading' });
    void (async () => {
      try {
        const res = await getArenaContest(row.path);
        if (cancel) return;
        const model = buildModel(res.data as Parameters<typeof buildModel>[0]);
        if (model.duration <= 0) {
          setLoad({ kind: 'error', text: '本场快照的时长读不懂，无法回放', missing: false });
          return;
        }
        setLoad({ kind: 'ready', model });
      } catch (err) {
        if (cancel) return;
        const missing = err instanceof ApiError && err.kind === 'not-found';
        setLoad({ kind: 'error', text: messageOf(err), missing });
      }
    })();
    return () => {
      cancel = true;
    };
  }, [row.path, tryNo]);

  const commit = useCallback(
    (next: ArenaDraft | null, persist = true): boolean => {
      if (staleRef.current && persist) {
        setStale(true);
        return false;
      }
      draftRef.current = next;
      setDraft(next);
      if (next === null) {
        if (persist) clearDraft(store, row.path);
        return true;
      }
      if (!persist) return true;
      const ok = saveDraft(store, row.path, next);
      setStorageWarn(ok ? null : '浏览器存储写不进去：当前练习无法自动保留，请勿关闭页面');
      return ok;
    },
    [row.path, store],
  );

  /* ---------- 草稿：新键优先；旧键只在没有新键时迁移一次（需要本场时长） ---------- */
  useEffect(() => {
    if (load.kind !== 'ready') return;
    const duration = load.model.duration;
    setSaveErr(null);
    setSaveNote(null);
    setConflict(null);
    const loaded = loadDraft(store, row.path);
    if (loaded.kind === 'error') {
      setDraftErr(loaded.message);
      commit(null, false);
      setDraftBooted(true);
      return;
    }
    if (loaded.kind === 'draft') {
      let d = loaded.draft;
      if (d.session !== null && d.session.durationMs === 0) d = { ...d, session: { ...d.session, durationMs: duration } };
      setDraftErr(null);
      commit(d);
      setDraftBooted(true);
      return;
    }
    const migrated = migrateLegacy(store, row.path, duration);
    if (migrated.kind === 'error') {
      setDraftErr(migrated.message);
      commit(null, false);
      setDraftBooted(true);
      return;
    }
    if (migrated.kind === 'migrated') {
      setDraftErr(null);
      commit(migrated.draft);
      setDraftBooted(true);
      return;
    }
    setDraftErr(null);
    commit(null, false);
    if (initialModeRef.current === 'practice' && initialDraftBoot.current) {
      const s = { ...startSession(Date.now()), durationMs: duration };
      const d: ArenaDraft = { ...newDraft(Date.now()), session: s };
      commit(d);
      setIdentity({ kind: 'practice' });
    }
    setDraftBooted(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load.kind === 'ready' ? load.model.duration : 0, reloadNo, row.path]);

  useEffect(() => {
    if (draftBooted) initialDraftBoot.current = false;
  }, [draftBooted]);

  /* ---------- 查看指定档：失败留在错误态，不退回本地草稿 ---------- */
  const viewRecordId = identity.kind === 'view' ? identity.recordId : null;
  useEffect(() => {
    if (viewRecordId === null) return;
    const seq = ++viewSeq.current;
    setView({ status: 'loading', recordId: viewRecordId, record: null, revision: null, error: null });
    setViewGhost(null);
    void (async () => {
      try {
        const item = await getArenaRecordItem(row.path, viewRecordId);
        if (seq !== viewSeq.current) return;
        setView({ status: 'ready', recordId: viewRecordId, record: item.record, revision: item.revision, error: null });
        setViewGhost(recordToGhost(item.record.ghost));
      } catch (err) {
        if (seq !== viewSeq.current) return;
        setView({ status: 'error', recordId: viewRecordId, record: null, revision: null, error: messageOf(err) });
      }
    })();
  }, [viewRecordId, row.path, viewRetry]);

  /* 查看历史不暂停当前练习：tab 里的 started 不动，回来仍按真实时钟接上 */
  const practiceRunning = draft?.phase === 'running';
  useEffect(() => {
    if (identity.kind === 'view') setFrozenView(false);
  }, [identity.kind, viewRecordId]);

  const duration = load.kind === 'ready' ? load.model.duration : 0;
  const runningHere = identity.kind === 'practice' && draft?.phase === 'running' && !stale;

  /* ---------- 进入练习 / 已结束后把滑条摆到停止位置 ---------- */
  const identityKey = identity.kind === 'view' ? `view:${identity.recordId}` : identity.kind;
  useEffect(() => {
    if (load.kind !== 'ready') return;
    if (identity.kind === 'practice' && draft !== null) {
      if (draft.phase === 'finished') setScrubMs(draft.result?.stoppedAtMs ?? duration);
      else if (draft.phase === 'legacy-unconfirmed') setScrubMs(duration);
      else setElapsed(elapsedOf(draft.session ?? startSession(Date.now()), duration, Date.now()));
    }
    if (identity.kind === 'edit' && draft !== null) setScrubMs(draft.result?.stoppedAtMs ?? duration);
    if (identity.kind === 'view' && view.status === 'ready') setScrubMs(duration);
    if (identity.kind === 'review') setScrubMs(duration);
    // 只随身份 / 草稿代次 / 查看目标变化：拖轴、改逐发不重置位置
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identityKey, draft?.draftId, draft?.phase, view.status, load.kind === 'ready' ? duration : 0]);

  /* ---------- 走钟：每秒一次；到点落回顾并写结束信息 ---------- */
  useEffect(() => {
    if (!runningHere || load.kind !== 'ready' || draft === null || draft.session === null) return;
    const span = load.model.duration;
    let s = draft.session;
    const run = (): void => {
      const next = tick(s, span, Date.now());
      s = next.session;
      setElapsed(next.elapsed);
      if (next.session !== draft.session) {
        // 用 ref 取最新草稿：计时期间可能刚补录了逐发，不能拿本次 effect 起点的旧快照收尾
        const current = draftRef.current;
        if (current === null || current.draftId !== draft.draftId) return;
        const ended = finishDraft(current, span, span, Date.now());
        commit(ended);
        setScrubMs(span);
        onDraftChanged?.();
      }
    };
    run();
    const id = window.setInterval(run, 1000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runningHere, draft?.draftId, draft?.session?.hold, draft?.session?.started, load.kind === 'ready' ? load.model.duration : 0]);

  /* ---------- 多标签：另一页改了本场草稿 → 旧页面只读，提示重新读取 ---------- */
  useEffect(() => {
    const key = draftKey(row.path);
    const onStorage = (e: StorageEvent): void => {
      if (e.key !== key) return;
      // 同场共用一份草稿：另一个标签只要写成功（同 draftId 也算），这个页面的副本就过期了
      setStale(true);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [row.path]);

  /* ---------- 历史成绩层 ---------- */
  const loadHistory = useCallback(async (): Promise<void> => {
    const seq = ++historySeq.current;
    setHistory((h) => ({ ...h, status: 'loading', error: null }));
    try {
      const dto = await listArenaRecords(row.path);
      if (seq !== historySeq.current) return;
      setHistory({ status: 'ready', dto, error: null });
    } catch (err) {
      if (seq !== historySeq.current) return;
      setHistory({ status: 'error', dto: null, error: messageOf(err) });
    }
  }, [row.path]);

  useEffect(() => {
    if (historyOpen) void loadHistory();
  }, [historyOpen, loadHistory]);

  const openHistoryLayer = useCallback((): void => {
    setHistoryOpen(true);
    setActionErr(null);
  }, []);

  /* ---------- 切换动作 ---------- */
  const applySwitch = useCallback(
    (action: SwitchAction): void => {
      if (load.kind !== 'ready') return;
      setSaveErr(null);
      setSaveNote(null);
      setConflict(null);
      setActionErr(null);
      setFrozenView(false);
      if (action.kind === 'new-practice') {
        const s = { ...startSession(Date.now()), durationMs: load.model.duration };
        commit({ ...newDraft(Date.now()), session: s });
        setIdentity({ kind: 'practice' });
        setElapsed(0);
        setScrubMs(0);
        setNote('新的练习已开始');
        onDraftChanged?.();
        return;
      }
      if (action.kind === 'manual') {
        commit(newManualDraft(load.model.duration));
        setIdentity({ kind: 'practice' });
        setScrubMs(load.model.duration);
        setNote('补录草稿已建立 · 录入逐发后保存');
        onDraftChanged?.();
        return;
      }
      if (action.kind === 'edit' && action.record !== undefined && action.revision !== undefined) {
        const record = action.record;
        const legacy = record.result.origin === 'legacy-review';
        const result = legacy
          ? { origin: 'manual' as const, finish: 'declared' as const, durationMs: load.model.duration, stoppedAtMs: null }
          : record.result;
        commit(draftFromRecord(record, result, action.revision, record.result));
        setIdentity({ kind: 'edit' });
        setScrubMs(record.result.stoppedAtMs ?? load.model.duration);
        setNote(legacy ? '旧回顾已确认结束 · 保存才会升级为正式档' : `正在编辑「${record.name}」`);
        onDraftChanged?.();
        return;
      }
      if (action.kind === 'restore-legacy' && action.legacy !== undefined) {
        const legacy = action.legacy;
        const viewMs = legacy.record.view.viewMs;
        commit(draftFromLegacyLive(recordToGhost(legacy.record.ghost), viewMs, load.model.duration, Date.now()));
        setIdentity({ kind: 'practice' });
        setScrubMs(viewMs);
        setElapsed(viewMs);
        setNote('旧进度已恢复为当前练习（暂停）· 点继续才开始走钟');
        onDraftChanged?.();
      }
    },
    [commit, load, onDraftChanged],
  );

  const requestSwitch = useCallback(
    (action: SwitchAction): void => {
      if (staleRef.current) {
        setStale(true);
        setActionErr('另一个标签页改了本场草稿：先重新读取，再做切换');
        return;
      }
      if (saveBusy) {
        setActionErr('正在保存：先等这次保存结束，再切换');
        return;
      }
      if (draftRef.current?.pendingSave != null) {
        setSaveErr('上次新建请求的结果还没确认：先重试对账，再切换或另存');
        return;
      }
      const c = replaceCaseOf(draftRef.current);
      setReplaceErr(null);
      if (c === 'none') {
        applySwitch(action);
        return;
      }
      setPending({ action, case: c });
    },
    [applySwitch, saveBusy],
  );

  const fetchRecord = useCallback(
    async (recordIdValue: string): Promise<{ record: ArenaRecord; revision: string } | null> => {
      if (identity.kind === 'view' && view.status === 'ready' && view.recordId === recordIdValue && view.record !== null && view.revision !== null) {
        return { record: view.record, revision: view.revision };
      }
      try {
        const item = await getArenaRecordItem(row.path, recordIdValue);
        return { record: item.record, revision: item.revision };
      } catch (err) {
        setActionErr(`读取存档失败：${messageOf(err)}`);
        return null;
      }
    },
    [identity, row.path, view.status, view.recordId, view.record, view.revision],
  );

  const beginEdit = useCallback(
    async (recordIdValue: string): Promise<void> => {
      if (saveBusy) {
        setActionErr('正在保存：先等这次保存结束，再进入编辑');
        return;
      }
      const seq = ++editSeq.current;
      setHistoryOpen(false);
      const got = await fetchRecord(recordIdValue);
      if (seq !== editSeq.current || got === null) return;
      if (got.record.result.origin === 'legacy-review') {
        setLegacyConfirm({ record: got.record, revision: got.revision, after: 'edit' });
        return;
      }
      requestSwitch({ kind: 'edit', record: got.record, revision: got.revision });
    },
    [fetchRecord, requestSwitch, saveBusy],
  );

  const beginRestoreLegacy = useCallback(async (): Promise<void> => {
    if (saveBusy) {
      setActionErr('正在保存：先等这次保存结束，再恢复旧进度');
      return;
    }
    const seq = ++restoreSeq.current;
    setHistoryOpen(false);
    setActionErr(null);
    try {
      const legacy = await getArenaLegacy(row.path);
      if (seq !== restoreSeq.current) return;
      if (legacy.mode !== 'live') {
        setActionErr('旧根记录已经升级为正式存档，不能再按旧进度恢复');
        return;
      }
      requestSwitch({ kind: 'restore-legacy', legacy });
    } catch (err) {
      if (seq === restoreSeq.current) setActionErr(`读取旧进度失败：${messageOf(err)}`);
    }
  }, [requestSwitch, row.path, saveBusy]);

  const beginManual = useCallback((): void => {
    if (saveBusy) return;
    if (draftRef.current !== null) requestSwitch({ kind: 'manual' });
    else applySwitch({ kind: 'manual' });
  }, [applySwitch, requestSwitch, saveBusy]);

  const beginNewPractice = useCallback((): void => {
    requestSwitch({ kind: 'new-practice' });
  }, [requestSwitch]);

  /* mode=restore-legacy 的启动流程：草稿读完、榜单就绪后执行一次 */
  useEffect(() => {
    if (!bootRestoreRef.current || !draftBooted || load.kind !== 'ready') return;
    bootRestoreRef.current = false;
    void beginRestoreLegacy();
  }, [beginRestoreLegacy, draftBooted, load.kind]);

  /* ---------- 保存 ---------- */
  const finishSave = useCallback(
    (base: ArenaDraft, record: ArenaRecord, revision: string, after?: () => void): void => {
      const next = applySaveSuccess(base, record, revision);
      const persisted = commit(next);
      if (!persisted) {
        setSaveErr('已写入服务端，但本地草稿写不进去：刷新页面可重新读回；不要在这个页面继续编辑');
        return;
      }
      setSaveNote(`已保存 · ${record.name}`);
      setSaveErr(null);
      setConflict(null);
      setNameState(null);
      setReplaceErr(null);
      setPending(null);
      switchOriginalRef.current = null;
      onDraftChanged?.();
      after?.();
    },
    [commit, onDraftChanged],
  );

  const doCreate = useCallback(
    async (base: ArenaDraft, name: string, after?: () => void, restoreOnReject?: ArenaDraft): Promise<boolean> => {
      const recordIdValue = newRecordId();
      const payload = buildCreatePayload(base, {
        arenaPath: row.path,
        contestTitle: arenaTitleOf(row),
        recordId: recordIdValue,
        name,
      });
      if (payload === null) {
        setSaveErr('还没有结束信息，不能保存');
        return false;
      }
      const frozen: ArenaDraft = { ...base, pendingSave: { recordId: recordIdValue, payload } };
      if (staleRef.current) {
        setStale(true);
        setSaveErr('另一个标签页改了本场草稿：先重新读取，不能在这里保存');
        return false;
      }
      // pendingSave 必须先落盘再发请求；落盘失败就不发（契约 §5.3）
      if (!saveDraft(store, row.path, frozen)) {
        setSaveErr('浏览器存储写不进去：没有发送保存请求');
        return false;
      }
      draftRef.current = frozen;
      setDraft(frozen);
      setStorageWarn(null);
      setSaveBusy(true);
      try {
        const res = await createArenaRecord(payload);
        finishSave(frozen, res.record, res.revision, after);
        return true;
      } catch (err) {
        if (isUnknownError(err)) {
          setSaveErr('保存结果未知：本次提交已冻结，先点「重试对账」确认结果');
          return false;
        }
        // 明确拒绝：恢复提交前的草稿（进行中的练习不能因为保存失败变成已结束）
        const restored = restoreOnReject ?? base;
        if (!saveDraft(store, row.path, restored)) setStorageWarn('浏览器存储写不进去：草稿只在内存里');
        draftRef.current = restored;
        setDraft(restored);
        setSaveErr(messageOf(err));
        return false;
      } finally {
        setSaveBusy(false);
      }
    },
    [finishSave, row.path, store],
  );

  const doUpdate = useCallback(
    async (base: ArenaDraft, after?: () => void): Promise<boolean> => {
      if (staleRef.current) {
        setStale(true);
        setSaveErr('另一个标签页改了本场草稿：先重新读取，不能在这里保存');
        return false;
      }
      const target = base.target;
      const payload = target === null ? null : buildUpdatePayload(base, {
        arenaPath: row.path,
        recordId: target.recordId,
        expectedRevision: target.revision,
      });
      if (target === null || payload === null) {
        setSaveErr('没有明确的保存目标');
        return false;
      }
      setSaveBusy(true);
      setSaveErr(null);
      try {
        const res = await updateArenaRecord(payload);
        finishSave(base, res.record, res.revision, after);
        return true;
      } catch (err) {
        if (isUnknownError(err)) {
          try {
            const item = await getArenaRecordItem(row.path, target.recordId);
            if (updateReconciled(base, item.record)) {
              finishSave(base, item.record, item.revision, after);
              return true;
            }
          } catch {
            /* 读不回就按冲突处理，保留本地修改 */
          }
          setConflict({ kind: 'unknown', message: '保存结果未知：重新读取后与本次提交不一致', recordId: target.recordId });
          return false;
        }
        if (err instanceof ApiError && err.kind === 'conflict') {
          setConflict({ kind: 'conflict', message: messageOf(err), recordId: target.recordId });
          return false;
        }
        setSaveErr(messageOf(err));
        return false;
      } finally {
        setSaveBusy(false);
      }
    },
    [finishSave, row],
  );

  const saveDraftWithName = useCallback(
    (base: ArenaDraft, name: string, saveAs: boolean, after?: () => void): void => {
      setSaveErr(null);
      setSaveNote(null);
      if (!saveAs && base.target !== null) void doUpdate(base, after);
      else void doCreate(base, name, after, switchOriginalRef.current ?? undefined);
    },
    [doCreate, doUpdate],
  );

  const requestSaveCurrent = useCallback((): void => {
    if (staleRef.current) {
      setStale(true);
      setSaveErr('另一个标签页改了本场草稿：先重新读取，不能在这里保存');
      return;
    }
    const current = draftRef.current;
    if (current === null || !canSaveDraft(current)) return;
    setSaveErr(null);
    if (current.pendingSave !== null) {
      void (async () => {
        setSaveBusy(true);
        try {
          const res = await createArenaRecord(current.pendingSave!.payload);
          finishSave(current, res.record, res.revision);
        } catch (err) {
          if (!isUnknownError(err)) {
            commit({ ...current, pendingSave: null });
            setSaveErr(messageOf(err));
          } else {
            setSaveErr('仍然没有确认到保存结果；稍后再点「重试对账」');
          }
        } finally {
          setSaveBusy(false);
        }
      })();
      return;
    }
    if (current.target !== null) {
      void doUpdate(current);
      return;
    }
    setNameErr(null);
    setNameState({ mode: 'save', initial: firstSaveName(), draft: current });
  }, [commit, doUpdate, finishSave]);

  const requestSaveAs = useCallback((): void => {
    if (staleRef.current) {
      setStale(true);
      setSaveErr('另一个标签页改了本场草稿：先重新读取，不能在这里另存');
      return;
    }
    const current = draftRef.current;
    if (current === null || !canSaveDraft(current)) return;
    if (current.pendingSave !== null) {
      setSaveErr('上次新建请求的结果还没确认：先重试对账，再另存');
      return;
    }
    setNameErr(null);
    setNameState({
      mode: 'save-as',
      initial: copySaveName(current.target?.name ?? '成绩'),
      draft: current,
    });
  }, []);

  const confirmName = useCallback(
    (name: string): void => {
      if (nameState === null) return;
      const state = nameState;
      setNameState(null);
      saveDraftWithName(state.draft, name, state.mode !== 'save', state.action === undefined ? undefined : () => applySwitch(state.action!));
    },
    [applySwitch, nameState, saveDraftWithName],
  );

  /* 替换确认：进行中先结束再保存；保存失败 / 命名取消都不切换 */
  const saveAndSwitch = useCallback((): void => {
    if (pending === null) return;
    const base = draftRef.current;
    if (base === null) {
      applySwitch(pending.action);
      setPending(null);
      return;
    }
    let ready = base;
    if (pending.case === 'running') {
      const span = duration;
      const at = base.session === null ? 0 : elapsedOf(base.session, span, Date.now());
      ready = finishDraft(base, span, at, Date.now());
    } else if (pending.case === 'legacy') {
      ready = declareFinished(base, duration);
    }
    switchOriginalRef.current = base;
    setReplaceErr(null);
    if (!canSaveDraft(ready)) {
      setReplaceErr('还不能保存：缺少结束信息');
      return;
    }
    if (ready.target !== null) {
      void doUpdate(ready, () => applySwitch(pending.action));
      return;
    }
    setNameErr(null);
    setNameState({
      mode: 'switch',
      initial: firstSaveName(),
      draft: ready,
      action: pending.action,
    });
  }, [applySwitch, doUpdate, duration, pending]);

  const discardAndSwitch = useCallback((): void => {
    if (pending === null) return;
    switchOriginalRef.current = null;
    commit(null);
    applySwitch(pending.action);
    setPending(null);
  }, [applySwitch, commit, pending]);

  const confirmLegacyEdit = useCallback((): void => {
    if (legacyConfirm === null) return;
    const { record, revision, after } = legacyConfirm;
    setLegacyConfirm(null);
    const result = { origin: 'manual' as const, finish: 'declared' as const, durationMs: duration, stoppedAtMs: null };
    if (after === 'edit') requestSwitch({ kind: 'edit', record: { ...record, result: legacyConfirm.record.result }, revision });
    else {
      commit(draftFromRecord(record, result, revision, record.result));
      setIdentity({ kind: 'edit' });
      setScrubMs(duration);
      setNote('旧回顾已确认结束 · 保存才会升级为正式档');
    }
  }, [commit, duration, legacyConfirm, requestSwitch]);

  /* 更新冲突：重新读取只认服务端现状，本地修改需先另存 */
  const reloadFromServer = useCallback((): void => {
    const target = conflict;
    if (target === null) return;
    void (async () => {
      try {
        const item = await getArenaRecordItem(row.path, target.recordId);
        if (item.record.result.origin === 'legacy-review') {
          setLegacyConfirm({ record: item.record, revision: item.revision, after: 'edit' });
          setConflict(null);
          return;
        }
        commit(draftFromRecord(item.record, item.record.result, item.revision));
        setIdentity({ kind: 'edit' });
        setScrubMs(item.record.result.stoppedAtMs ?? duration);
        setConflict(null);
        setSaveErr(null);
        setSaveNote('已重新读取服务端存档');
      } catch (err) {
        setSaveErr(`重新读取失败：${messageOf(err)}`);
      }
    })();
  }, [commit, conflict, duration, row.path]);

  /* ---------- 操作 ---------- */
  const togglePause = (): void => {
    if (saveBusy || draft === null || draft.session === null) return;
    const e = elapsedOf(draft.session, duration, Date.now());
    commit({ ...draft, session: draft.session.paused ? unpauseSession(draft.session, e, Date.now()) : pauseSession(draft.session, e) });
  };

  const endPractice = (): void => {
    if (saveBusy || draft === null || draft.session === null) return;
    const e = elapsedOf(draft.session, duration, Date.now());
    const ended = finishDraft(draft, duration, e, Date.now());
    commit(ended);
    setScrubMs(ended.result?.stoppedAtMs ?? duration);
    setNote(null);
    onDraftChanged?.();
  };

  const confirmLegacyDraft = (): void => {
    if (saveBusy || draft === null) return;
    commit(declareFinished(draft, duration));
    setScrubMs(duration);
    onDraftChanged?.();
  };

  const scrub = (minutes: number): void => setScrubMs(minutes * 60_000);
  const jump = (to: '0' | 'freeze' | 'end'): void => {
    if (load.kind !== 'ready') return;
    scrub(to === '0' ? 0 : to === 'end' ? minutesOf(load.model.duration) : minutesOf(load.model.freezeStart) + 1);
  };

  const onGhostChange = useCallback(
    (next: GhostData): void => {
      if (saveBusy || identity.kind === 'review') return;
      setSaveNote(null);
      setSaveErr(null);
      setConflict(null);
      if (identity.kind === 'view') {
        setViewGhost(next);
        return;
      }
      if (draft === null) return;
      commit({ ...draft, ghost: next });
    },
    [commit, draft, identity.kind, saveBusy],
  );

  const onGhostClear = useCallback((): void => {
    if (saveBusy || identity.kind === 'view' || identity.kind === 'review') return;
    if (draft === null) return;
    setSaveNote(null);
    setSaveErr(null);
    commit({ ...draft, ghost: { show: true, subs: [] } });
  }, [commit, draft, identity.kind, saveBusy]);

  /* 幽灵归属只跟身份走：查看终榜不借用当前练习的录入，避免两个身份串数据 */
  const currentGhost: GhostData | null =
    identity.kind === 'view'
      ? viewGhost
      : identity.kind === 'practice' || identity.kind === 'edit'
        ? draft?.ghost ?? null
        : null;

  /* ---------- 弹层 ---------- */
  useEffect(() => {
    if (pop === null) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setPop(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pop]);

  const openCellPop = useCallback((ev: React.MouseEvent, ti: number, p: number): void => {
    const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    setPop({ kind: 'sub', ti, p, anchor: { left: r.left, top: r.top, width: r.width, height: r.height } });
  }, []);
  const openTeamPop = useCallback((ev: React.MouseEvent, ti: number): void => {
    const r = (ev.currentTarget as HTMLElement).closest('.brow')?.getBoundingClientRect();
    if (r === undefined) return;
    setPop({ kind: 'team', ti, anchor: { left: r.left, top: r.top, width: r.width, height: r.height } });
  }, []);
  const openGhostPop = (ev: React.MouseEvent): void => {
    const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    setPop({ kind: 'ghost', anchor: { left: r.left, top: r.top, width: r.width, height: r.height } });
  };

  /* 所有 hook 必须在提前 return 之前：榜的 useMemo 不能跟着“是否 ready”改变调用顺序 */
  const readyModel = load.kind === 'ready' ? load.model : null;
  const span = readyModel?.duration ?? 0;
  const review = !runningHere;
  const viewMs = runningHere ? elapsed : Math.max(0, Math.min(scrubMs, span));
  const inFrz =
    readyModel !== null &&
    (review ? frozenView && inFreezeWindow(viewMs, span, readyModel.freezeStart) : inFreezeWindow(elapsed, span, readyModel.freezeStart));
  const ghostSubs: GhostSub[] | null =
    currentGhost !== null && currentGhost.show && currentGhost.subs.length > 0 ? currentGhost.subs : null;
  const minuteKey = `${minutesOf(viewMs)}|${onlyFormal}|${review ? 'r' : 'l'}|${frozenView ? 'fz' : 'un'}|${Math.min(1, viewMs >= span ? 1 : 0)}|${ghostSig(currentGhost)}`;
  const boardMaybe: Board | null = useMemo(
    () =>
      readyModel === null
        ? null
        : buildBoard(readyModel, review ? viewMs : Math.min(viewMs, span), onlyFormal, review && !frozenView, ghostSubs),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [readyModel, minuteKey],
  );

  if (load.kind === 'error') {
    return (
      <>
        <div className="topbar">
          <button className="btn btn--ghost btn--sm" onClick={onBack}>
            <Icon id="i-chev" className="flip" />
            回到目录
          </button>
          <span aria-hidden="true" className="vsep" />
          <h2 className="rbname">{row.name}</h2>
          <span className="topbar__spacer" />
        </div>
        <div className="content">
          <div className="catwrap">
            <div className="alert alert--err">
              <Icon id="i-plug" />
              <div>
                {load.missing ? (
                  <b>上游没有这份榜单</b>
                ) : (
                  <>
                    <b>榜单拉取失败</b> · {load.text} · 本地没有这一场的缓存
                  </>
                )}
              </div>
              <button className="alert__x" onClick={() => setTryNo((n) => n + 1)}>
                重试
              </button>
            </div>
            <p className="hint">
              {load.missing
                ? '目录里有这一场，但快照仓库里取不到对应文件 —— 不做假数填空，取不到就是空。'
                : '两条源都试过还不通才算取不到，隔一两秒点重试通常就好；缓存过的场次断网也照常回放。'}
            </p>
          </div>
        </div>
      </>
    );
  }

  if (load.kind === 'loading' || draftBooted === false) {
    return (
      <div className="content">
        <div className="catwrap">
          <div className="skel">
            <i />
            正在拉取本场榜单 <code>official/…</code>（约 1.5 MB）…
          </div>
        </div>
      </div>
    );
  }

  const model = load.model;
  const board = boardMaybe;
  if (board === null) return null;
  const frozen = board.cap < viewMs || inFrz;
  const freezeLabel = clockHM(model.freezeStart);
  const teamCount = board.rows.length - (board.ghostTeam ? 1 : 0);
  const ghostRow = board.ghostTeam === null || board.ghostTeam === undefined ? null : board.rows.find((r) => r.ghost === true) ?? null;

  const recordForView = identity.kind === 'view' ? view.record : null;
  const activeResult =
    identity.kind === 'view'
      ? recordForView?.result ?? null
      : identity.kind === 'edit'
        ? draft?.result ?? null
        : identity.kind === 'practice' && draft !== null && draft.phase !== 'running'
          ? draft.result
          : null;
  const finishNote = activeResult === null ? '' : recordFinishNote(activeResult);
  const identityLabel =
    identity.kind === 'view'
      ? `查看：${recordForView?.name ?? '…'}`
      : identity.kind === 'edit'
        ? `编辑：${draft?.target?.name ?? '…'}`
        : identity.kind === 'review'
          ? '查看终榜'
          : '当前练习';
  const identitySub =
    identity.kind === 'practice'
      ? draft === null
        ? '尚未开始'
        : `${draftSummary(draft)}${finishNote === '' ? '' : ` · ${finishNote}`}`
      : identity.kind === 'edit'
        ? `${draft !== null && isDirty(draft) ? '有未保存修改' : '已保存'}${finishNote === '' ? '' : ` · ${finishNote}`}`
        : identity.kind === 'view'
          ? recordForView === null ? '' : `${resultLabel(recordForView.result)}${finishNote === '' ? '' : ` · ${finishNote}`}`
          : '只读';
  const dirtyMark = (identity.kind === 'practice' || identity.kind === 'edit') && draft !== null && isDirty(draft);
  const canSaveHere = (identity.kind === 'practice' || identity.kind === 'edit') && canSaveDraft(draft) && !stale && draftErr === null;
  const showSaveTarget = draft?.target != null && canSaveHere;

  const nameTip = {
    x: 0,
    y: 0,
    date: model.title,
    value: row.name === '' ? row.path : `${row.date} ${row.name}`.trim(),
    zero: false,
    valueClass: 'is-dim',
    sub: [
      `开赛 ${model.startAt}`,
      `封榜 ${freezeLabel}（${model.freezeDeclared ? '本场声明' : '本场未声明 · 按缺省最后 60 分钟'}）`,
      `时长 ${clockHM(span)} · ${model.teams.length} 队（正式 ${model.teams.filter((t) => !t.star).length} · 打星 ${model.teams.filter((t) => t.star).length}）`,
      model.approx ? '本场快照无逐次提交 · 榜按终局判名近似重建' : '',
    ],
  };

  const viewError = identity.kind === 'view' && view.status === 'error';
  const viewLoading = identity.kind === 'view' && view.status === 'loading';

  return (
    <>
      <div className="topbar arena-topbar">
        <button className="btn btn--ghost btn--sm" onClick={onBack}>
          <Icon id="i-chev" className="flip" />
          回到目录
        </button>
        <span aria-hidden="true" className="vsep" />
        <h2
          className="rbname"
          onMouseEnter={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            show({ ...nameTip, x: r.left + Math.min(r.width / 2, 180), y: r.bottom, below: true });
          }}
          onMouseLeave={hide}
        >
          {model.title}
        </h2>
        <span className={`arena-id arena-id--${identity.kind}`} title={`${identityLabel} · ${identitySub}`}>
          <b>{identityLabel}</b>
          <span>{identitySub}</span>
          {dirtyMark ? <i className="arena-id__dirty" title="有未保存修改" /> : null}
        </span>
        {finishNote !== '' ? <span className="pill pill--over">{finishNote}</span> : null}

        {runningHere && draft?.session != null ? (
          <>
            <span className={`clock${draft.session.paused ? ' is-paused' : ''}`}>
              <i className={`dot ${draft.session.paused || elapsed >= span ? 'dot--idle' : 'dot--live'}`} />
              <b>{clockHMS(elapsed)}</b>
            </span>
            <span className="transport">
              <button className="tbtn" disabled={saveBusy} aria-label={draft.session.paused ? '继续' : '暂停'} title={draft.session.paused ? '继续' : '暂停'} onClick={togglePause}>
                <Icon id={draft.session.paused ? 'i-play' : 'i-pause'} />
              </button>
              <button className="tbtn" disabled={saveBusy} aria-label="结束本次练习" title="结束本次练习（提前结束会记录真实停止时间）" onClick={endPractice}>
                <Icon id="i-stop" />
              </button>
            </span>
            {inFrz ? <span className="pill">封榜中 · 剩 {clockHMS(span - elapsed)}</span> : null}
            {draft.session.paused ? <span className="pill">已暂停</span> : null}
          </>
        ) : (
          <>
            {identity.kind === 'review' ? (
              <span className="pill pill--over">终榜回顾</span>
            ) : identity.kind === 'view' ? (
              <span className="pill pill--over">{recordForView === null ? '历史成绩' : resultLabel(recordForView.result)}</span>
            ) : identity.kind === 'edit' ? (
              <span className="pill">{draft?.target?.name ?? '编辑成绩'}</span>
            ) : draft?.phase === 'legacy-unconfirmed' ? (
              <span className="pill">旧成绩 · 未标记结束</span>
            ) : draft?.phase === 'finished' ? (
              <span className="pill pill--over">{draft.result === null ? '已结束' : resultLabel(draft.result)}</span>
            ) : (
              <span className="pill">已结束</span>
            )}
          </>
        )}

        <span className="topbar__spacer" />

        {/* 后台仍在走的当前练习：查看 / 编辑历史时只提示，不暂停 */}
        {practiceRunning && identity.kind !== 'practice' ? (
          <button className="arena-bgclock" title="当前练习仍在计时 · 回到当前练习" onClick={() => setIdentity({ kind: 'practice' })}>
            <i className="dot dot--live" />
            当前练习仍在计时
          </button>
        ) : null}

        {ghostRow === null ? null : (
          <button className="ghrank" onClick={() => { const el = boardBox.current?.querySelector<HTMLElement>('.brow.is-ghost') ?? null; if (el !== null) { el.scrollIntoView({ block: 'center' }); el.classList.remove('is-jump'); void el.offsetWidth; el.classList.add('is-jump'); } }} title={`我的成绩 · ${ghostRow.solved} 题 / ${ghostRow.pen} 罚时 · 点击跳到榜上那一行`}>
            <i className="dot dot--ok" />我 <b>第 {ghostRow.rank} 名</b>
          </button>
        )}

        <button className="btn btn--ghost btn--sm" aria-label="历史成绩" title="历史成绩 · 查看 / 编辑这场保存过的成绩" onClick={openHistoryLayer}>
          <Icon id="i-clock" />
          历史
        </button>

        {identity.kind === 'view' ? (
          <>
            <button className="btn btn--sm" disabled={view.status !== 'ready'} onClick={() => void beginEdit(identity.recordId)}>
              <Icon id="i-pencil" />
              编辑成绩
            </button>
            <button className="btn btn--sm btn--ghost" onClick={() => (draft === null ? beginNewPractice() : setIdentity({ kind: 'practice' }))}>
              {draft === null ? '开始新练习' : '回到当前练习'}
            </button>
          </>
        ) : identity.kind === 'review' ? (
          <button className="btn btn--sm" disabled={!draftBooted} onClick={beginManual} title="不经过模拟计时，建立一份已结束的补录草稿">
            <Icon id="i-plus" />
            录入已结束的成绩
          </button>
        ) : null}

        {(identity.kind === 'practice' || identity.kind === 'edit') && draft !== null && draft.phase !== 'running' ? (
          <button className="btn btn--sm btn--ghost" onClick={beginNewPractice} title="替换当前草稿前会先询问">
            <Icon id="i-play" />
            重新练一次
          </button>
        ) : null}

        {identity.kind === 'practice' && draft?.phase === 'legacy-unconfirmed' ? (
          <button className="btn btn--sm btn--go" onClick={confirmLegacyDraft} title="确认这份旧成绩已经结束；保存时按补录处理">
            确认已结束
          </button>
        ) : null}

        {canSaveHere ? (
          <>
            <button
              className="btn btn--sm"
              disabled={saveBusy || conflict !== null || draft?.pendingSave !== null}
              title={draft?.pendingSave !== null ? '上次保存结果未确认：先重试对账' : draft?.target != null ? `保存到：${draft.target.name}` : '首次保存会新建一档'}
              onClick={requestSaveCurrent}
            >
              <Icon id="i-save" />
              {saveBusy ? '保存中…' : saveNote !== null && draft !== null && !isDirty(draft) ? '已保存' : '保存'}
            </button>
            <button className="btn btn--sm btn--ghost" disabled={saveBusy || conflict !== null} onClick={requestSaveAs} title="另存为新档，原档不变">
              另存
            </button>
            {showSaveTarget ? (
              <span className="arena-target" title={`保存目标：${draft!.target!.name}`}>
                保存到：{draft!.target!.name}
              </span>
            ) : (
              <span className="arena-target is-dim">首次保存将新建一档</span>
            )}
          </>
        ) : null}

        {draft?.pendingSave != null && canSaveHere ? (
          <button className="btn btn--sm btn--go" disabled={saveBusy} onClick={requestSaveCurrent}>
            重试对账
          </button>
        ) : null}

        {identity.kind === 'review' ? null : (
          <button className="btn btn--ghost btn--sm" aria-label="我的成绩" title="我的成绩 · 录入 / 查看逐发" onClick={openGhostPop}>
            <Icon id="i-user" />
          </button>
        )}

        {model.approx ? (
          <span
            className="pill"
            onMouseEnter={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              show({
                x: r.left + r.width / 2,
                y: r.bottom,
                below: true,
                date: '近似榜',
                value: '本场快照没有逐次提交',
                zero: false,
                sub: ['榜按终局判名 + 次数重建，逐发时刻上游未记', '所以格子只在判名那一刻出现，中间过程看不到'],
              });
            }}
            onMouseLeave={hide}
          >
            近似回放
          </span>
        ) : null}
        {review ? (
          <label className="switch">
            <input type="checkbox" checked={frozenView} onChange={(e) => setFrozenView(e.target.checked)} />
            封榜视角
          </label>
        ) : null}
        <label className="switch">
          <input type="checkbox" checked={onlyFormal} onChange={(e) => setOnlyFormal(e.target.checked)} />
          仅正式队
        </label>
      </div>

      <div className="content content--fit">
        <div className="simcol">
          {stale ? (
            <div className="alert alert--warn" role="status">
              <Icon id="i-warn" />
              <div>
                <b>另一个标签页改了本场草稿</b> · 这个页面不再写入，避免互相覆盖
              </div>
              <button
                className="alert__x"
                type="button"
                onClick={() => {
                  setStale(false);
                  setReloadNo((n) => n + 1);
                }}
              >
                重新读取
              </button>
            </div>
          ) : null}
          {draftErr !== null ? (
            <div className="alert alert--err" role="status">
              <Icon id="i-warn" />
              <div>
                <b>当前草稿读不出来</b> · {draftErr}
              </div>
              <button className="alert__x" type="button" onClick={() => setResetConfirm(true)}>
                重置草稿
              </button>
            </div>
          ) : null}
          {storageWarn !== null ? (
            <div className="alert alert--warn" role="status">
              <Icon id="i-warn" />
              <div>{storageWarn}</div>
            </div>
          ) : null}
          {saveErr !== null ? (
            <div className="alert alert--err" role="status">
              <Icon id="i-plug" />
              <div>{saveErr}</div>
              {draft?.pendingSave !== null ? (
                <button className="alert__x" type="button" disabled={saveBusy} onClick={requestSaveCurrent}>
                  重试对账
                </button>
              ) : null}
            </div>
          ) : null}
          {conflict !== null ? (
            <div className="alert alert--err" role="status">
              <Icon id="i-warn" />
              <div>
                <b>{conflict.kind === 'conflict' ? '存档在别处改过了' : '保存结果未知'}</b> · {conflict.message}
                <div className="hint">本地修改还在。可以重新读取服务端现状（会丢掉本地修改），或另存一份保留本地内容。</div>
              </div>
              <span className="arena-alert-acts">
                <button className="btn btn--xs btn--ghost" type="button" onClick={reloadFromServer}>
                  重新读取
                </button>
                <button className="btn btn--xs" type="button" onClick={requestSaveAs}>
                  另存
                </button>
              </span>
            </div>
          ) : null}
          {actionErr !== null ? (
            <div className="alert alert--err" role="status">
              <Icon id="i-plug" />
              <div>{actionErr}</div>
              <button className="alert__x" type="button" onClick={() => setActionErr(null)}>
                知道了
              </button>
            </div>
          ) : null}
          {note !== null ? (
            <div className="alert alert--ok" role="status">
              <Icon id="i-check" />
              <div>{note}</div>
              <button className="alert__x" type="button" onClick={() => setNote(null)}>
                知道了
              </button>
            </div>
          ) : null}
          {saveNote !== null && saveErr === null && conflict === null ? (
            <div className="alert alert--ok" role="status">
              <Icon id="i-check" />
              <div>{saveNote}</div>
              <button className="alert__x" type="button" onClick={() => setSaveNote(null)}>
                知道了
              </button>
            </div>
          ) : null}
          {viewError ? (
            <div className="alert alert--err" role="status">
              <Icon id="i-plug" />
              <div>
                <b>读档失败</b> · {view.error}
              </div>
              <span className="arena-alert-acts">
                <button className="btn btn--xs btn--ghost" type="button" onClick={() => setViewRetry((n) => n + 1)}>
                  重试
                </button>
                <button className="btn btn--xs btn--ghost" type="button" onClick={openHistoryLayer}>
                  历史成绩
                </button>
              </span>
            </div>
          ) : null}
          {draft === null && identity.kind === 'practice' ? (
            <div className="alert alert--warn" role="status">
              <Icon id="i-warn" />
              <div>这场还没有当前练习的草稿。</div>
              <button className="alert__x" type="button" onClick={beginNewPractice}>
                开始练习
              </button>
            </div>
          ) : null}

          {viewLoading ? (
            <div className="skel">
              <i />
              正在读取存档…
            </div>
          ) : null}

          {review ? (
            <div className="scrub">
              <span className="scrub__lab">回放</span>
              <span className="scrub__t" style={{ color: viewMs > model.freezeStart ? '#B4C0CF' : 'var(--accent-2)' }}>
                {clockHMS(viewMs)}
              </span>
              <span className="tl">
                <span className="tl__rail" />
                <span className="tl__fill" style={{ width: pct(viewMs, span) }} />
                <span className="tl__frz" style={{ left: pct(model.freezeStart, span), right: 0 }} />
                <span className="tl__mk" style={{ left: pct(model.freezeStart, span) }}>
                  <span>封榜 {freezeLabel}</span>
                </span>
                <input type="range" min={0} max={minutesOf(span)} step={1} value={minutesOf(viewMs)} aria-label="时间轴" onChange={(e) => scrub(Number(e.target.value))} />
              </span>
              <span className="scrub__acts">
                <button className="btn btn--xs btn--ghost" onClick={() => jump('0')}>
                  起点
                </button>
                <button className="btn btn--xs btn--ghost" onClick={() => jump('freeze')}>
                  封榜
                </button>
                <button className="btn btn--xs btn--ghost" onClick={() => jump('end')}>
                  终榜
                </button>
              </span>
            </div>
          ) : null}

          <div className="boardwrap" style={{ ['--np' as string]: model.problems.length }}>
            {inFrz ? (
              <div
                className="frost"
                onMouseEnter={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  show({
                    x: r.left + 220,
                    y: r.bottom,
                    below: true,
                    date: `封榜段 = 最后 ${clockHM(span - model.freezeStart)}`,
                    value: `定格在 ${freezeLabel}`,
                    zero: false,
                    valueClass: 'is-dim',
                    sub: ['段内提交只显时刻与次数，判名显示 ?', `名次与罚时定格在 ${freezeLabel} · 终局自动解封`],
                  });
                }}
                onMouseLeave={hide}
              >
                <Icon id="i-noflag" />
                <span>
                  {review ? '定格视角' : '封榜中'} · 名次定格在 <b>{freezeLabel}</b>
                </span>
                <span className="frost__r">
                  结果未知 {board.frzCells} 格 · 涉及 {board.frozenRows} 队
                </span>
              </div>
            ) : null}

            <div className="boardscroll" ref={boardBox} onMouseLeave={hide}>
              <div className="brow bhead">
                <div
                  className="h-r"
                  onMouseEnter={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    show({
                      x: r.left + 40,
                      y: r.bottom,
                      below: true,
                      date: '名次 R#',
                      value: model.bands.length > 0 ? `奖牌 = 正式队 ${bandRanges(model.bands)}` : '本场无奖牌规则',
                      zero: model.bands.length === 0,
                      sub: ['全场位置 · 打星队占位不计奖牌', '并列同名次、其后跳号'],
                    });
                  }}
                >
                  R#
                </div>
                <div
                  className="h-s"
                  onMouseEnter={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    show({ x: r.left + 20, y: r.bottom, below: true, date: '学校排名 S#', value: '每校头队', zero: false, sub: ['只标各校最好的一支', '打星队不计'] });
                  }}
                >
                  S#
                </div>
                <div className="h-org">Organization</div>
                <div className="h-team">Team</div>
                <div
                  className="h-sol"
                  onMouseEnter={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    show({ x: r.left + 24, y: r.bottom, below: true, date: '过题 Slv', value: frozen ? `定格在 ${freezeLabel}` : '实时', zero: false, sub: [`封榜段内定格在 ${freezeLabel}`] });
                  }}
                >
                  Slv
                </div>
                <div
                  className="h-pen"
                  onMouseEnter={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    show({ x: r.left + 30, y: r.bottom, below: true, date: '罚时 Pen', value: 'AC 分钟 + 20 × 失败', zero: false, sub: ['过题前的失败次数', 'CE 不罚'] });
                  }}
                >
                  Pen
                </div>
                {model.problems.map((p, i) => (
                  <ProblemHead key={p.alias ?? i} problem={p} col={board.col[i] ?? { ac: 0, sub: 0, frz: 0, postAc: 0 }} rows={teamCount} cap={board.cap} model={model} board={board} index={i} />
                ))}
              </div>

              {board.rows.map((r) => (
                <BoardRowView key={r.ti} row={r} team={r.ghost ? board.ghostTeam! : model.teams[r.ti]!} problems={model.problems} model={model} onCell={openCellPop} onTeam={openTeamPop} />
              ))}
            </div>

            <div className="board__foot">
              <span>
                榜上 <b>{teamCount}</b> 队 · 累计过题 <b>{board.solvedTotal}</b>
              </span>
              <span className="spacer" />
              <span className="key key--head">
                <span className="key__i">
                  <i className="phk is-quiet" />
                  无人提交
                </span>
                <span className="key__i">
                  <i className="phk is-pending" />
                  待定
                </span>
                <span className="key__i">
                  <i className="phk is-noone" />
                  交而没过
                </span>
                <span className="key__i">
                  <i className="phk is-any" />
                  有人过
                </span>
                <span className="key__i">
                  <i className="phk is-late" />
                  封榜后才解开
                </span>
              </span>
              <span className="key">
                <span className="key__i">
                  <i className="key__s key__s--pen">−</i>罚时
                </span>
                <span className="key__i">
                  <i className="key__s key__s--ac">✓</i>AC
                </span>
                <span className="key__i">
                  <i className="key__s key__s--fb">✦</i>首杀
                </span>
                <span className="key__i">
                  <i className="key__s key__s--frz">?</i>冻结
                </span>
                <span className="key__i">
                  <i className="key__s key__s--post" />封榜后
                </span>
              </span>
            </div>
          </div>
        </div>
      </div>

      {pop !== null ? (
        <Popover anchor={pop.anchor} viewport={{ w: window.innerWidth, h: window.innerHeight }} onClose={() => setPop(null)} width={pop.kind === 'ghost' ? 330 : 270} height={pop.kind === 'ghost' ? 500 : 260} label={pop.kind === 'ghost' ? '我的成绩' : '明细'} cls={pop.kind === 'ghost' ? 'pop--panel' : undefined}>
          {pop.kind === 'sub' ? (
            <SubPop model={model} ti={pop.ti} p={pop.p} viewMs={viewMs} cap={board.cap} ghost={currentGhost} />
          ) : pop.kind === 'team' ? (
            <TeamPop model={model} ti={pop.ti} board={board} />
          ) : (
            <GhostPanel
              problems={model.problems}
              durationMs={span}
              data={currentGhost}
              readOnly={identity.kind === 'view' || saveBusy}
              onChange={onGhostChange}
              onClear={onGhostClear}
            />
          )}
        </Popover>
      ) : null}

      {historyOpen ? (
        <HistoryDialog
          state={history}
          archived={false}
          hasDraft={draft !== null}
          currentId={identity.kind === 'view' ? identity.recordId : null}
          onRetry={() => void loadHistory()}
          onView={(id) => {
            setHistoryOpen(false);
            setIdentity({ kind: 'view', recordId: id });
          }}
          onEdit={(id) => void beginEdit(id)}
          onRestoreLegacy={() => void beginRestoreLegacy()}
          onClose={() => setHistoryOpen(false)}
        />
      ) : null}

      {nameState !== null ? (
        <NameDialog
          title={nameState.mode === 'save-as' ? '另存一份' : nameState.mode === 'switch' ? '保存后切换' : '保存成绩'}
          sub={
            nameState.mode === 'save-as'
              ? '另存会生成新的存档 ID，原档不变；保存成功后编辑目标切换到新档。'
              : nameState.mode === 'switch'
                ? '先给这份成绩起名并保存，成功后才切换；命名取消不会切换。'
                : '这是第一次保存这份草稿；名称默认本地日期时间，可修改。'
          }
          initial={nameState.initial}
          confirmLabel={saveBusy ? '保存中…' : '保存'}
          busy={saveBusy}
          error={nameErr}
          onCancel={() => {
            setNameState(null);
            setNameErr(null);
            switchOriginalRef.current = null;
          }}
          onConfirm={confirmName}
        />
      ) : null}

      {pending !== null && nameState === null ? (
        <ReplaceDialog
          kind={pending.case}
          targetLabel={
            pending.case === 'running'
              ? '当前练习'
              : pending.case === 'legacy'
                ? '旧成绩'
                : draft?.target !== null && draft !== null
                  ? `「${draft.target.name}」`
                  : '当前草稿'
          }
          busy={saveBusy}
          error={replaceErr ?? saveErr ?? conflict?.message ?? null}
          onCancel={() => {
            setPending(null);
            setReplaceErr(null);
            switchOriginalRef.current = null;
          }}
          onSaveSwitch={saveAndSwitch}
          onDiscardSwitch={discardAndSwitch}
        />
      ) : null}

      {legacyConfirm !== null ? (
        <ConfirmDialog
          title="旧回顾 · 先确认结束"
          body={
            <>
              这份旧存档保存时停在回顾模式，<b>不能证明它跑满了时长或真实的停止时间</b>。
              <br />
              确认“这份成绩已经结束”后，会按补录（manual / declared）进入编辑；保存时才把根文件升级为 schema 2。
            </>
          }
          confirmLabel="确认已结束，编辑成绩"
          onCancel={() => setLegacyConfirm(null)}
          onConfirm={confirmLegacyEdit}
        />
      ) : null}

      {resetConfirm ? (
        <ConfirmDialog
          title="重置本场草稿"
          body={
            <>
              当前草稿的格式读不懂。重置会删掉这份浏览器草稿并重新开始 —— 不会动工坊里的正式存档。
            </>
          }
          confirmLabel="重置草稿"
          danger
          onCancel={() => setResetConfirm(false)}
          onConfirm={() => {
            setResetConfirm(false);
            clearDraft(store, row.path);
            setDraftErr(null);
            commit(null, false);
            setReloadNo((n) => n + 1);
            setIdentity({ kind: 'review' });
          }}
        />
      ) : null}
    </>
  );
}

/* ---------- 列头 ---------- */

const HEAD_HINT = {
  quiet: '全场无人提交',
  pending: '封榜段内有活动 · 结果未定',
  noone: '有人交 · 无人过',
  any: '封榜前已有人过',
  late: '直到封榜后才被解开',
} as const;

const ProblemHead = memo(function ProblemHead({
  problem,
  col,
  rows,
  cap,
  model,
  board,
  index,
}: {
  problem: ContestModel['problems'][number];
  col: Board['col'][number];
  rows: number;
  cap: number;
  model: ContestModel;
  board: Board;
  index: number;
}) {
  const { show, hide } = useTip();
  const fb = board.rows.find((r) => r.cells[index]?.st === 'fb');
  const state = problemHeadState(col);
  const fbText =
    fb !== undefined
      ? `首杀 ${model.teams[fb.ti]?.org || model.teams[fb.ti]?.name || '队伍信息未收录'} · ${minutesOf(fb.cells[index]?.t ?? 0)}′`
      : col.ac > 0
        ? '当前视图无首杀'
        : cap >= model.duration
          ? '全场无人通过'
          : '尚无通过';
  return (
    <div
      className={`ph is-${state}`}
      onMouseEnter={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        show({
          x: r.left + r.width / 2,
          y: r.bottom,
          below: true,
          date: `${problem.alias ?? ''} · ${problem.title ?? ''}`,
          value: `${col.ac} / ${rows} 队过`,
          zero: col.ac === 0,
          sub: [HEAD_HINT[state], `交 ${col.sub} 次`, fbText, col.frz > 0 ? `另有 ${col.frz} 格封榜未定` : '', col.postAc > 0 && col.postAc < col.ac ? `其中 ${col.postAc} 队封榜后才过` : ''].filter((s) => s !== ''),
        });
      }}
      onMouseLeave={hide}
    >
      <b>{problem.alias}</b>
      <i>{col.ac}</i>
    </div>
  );
});

/* ---------- 一行 ---------- */

interface RowProps {
  row: BoardRow;
  team: TeamModel;
  problems: ContestModel['problems'];
  model: ContestModel;
  onCell: (ev: React.MouseEvent, ti: number, p: number) => void;
  onTeam: (ev: React.MouseEvent, ti: number) => void;
}

const BoardRowView = memo(function BoardRowView(props: RowProps) {
  const { row, team, problems, model, onCell, onTeam } = props;
  const { show, hide } = useTip();

  const cellNodes = row.cells.map((c, p) => (
    <CellView key={p} cell={c} ti={team.ti} p={p} problem={problems[p] ?? {}} row={row} team={team} freezeStart={model.freezeStart} approx={model.approx} onCell={onCell} />
  ));

  const teamTip = (e: React.MouseEvent): void => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const title = team.name === '' ? team.org || '队伍信息未收录' : team.name;
    show({
      x: r.left + Math.min(r.width / 2, 150),
      y: r.top,
      date: team.org === '' || team.name === '' ? title : `${title} · ${team.org}`,
      value: `第 ${row.rank} 名 · 过 ${row.solved} 题 · 罚时 ${row.pen}`,
      zero: false,
      valueClass: row.medal ? `is-${row.medal}` : 'is-dim',
      sub: row.ghost ? [`VP 手动录入${row.medal ? ` · ${row.medalTitle}` : ''}`, '点击看每题逐发'] : [`机位 #${team.seat}${row.star ? ' · 打星不占奖牌' : row.medal ? ` · ${row.medalTitle}` : ' · 正式队'}`, team.members.length > 0 ? '点击查看队员' : '队员名单未收录 · 点击看队伍信息'],
    });
  };

  return (
    <div
      className={`brow brow--body${row.medal ? ` m-${row.medal}` : ''}${row.star ? ' is-star' : ''}${row.ghost ? ' is-ghost' : ''}`}
      onMouseEnter={teamTip}
      onMouseLeave={hide}
      onClick={(e) => {
        hide();
        onTeam(e, team.ti);
      }}
    >
      <div className="c-r">
        <b>{row.rank}</b>
      </div>
      <div className="c-s">{row.srank === '' ? '' : <b>{row.srank}</b>}</div>
      <div className="c-org">{team.org}</div>
      <div className="c-team">
        <span className={`c-team__n${row.ghost ? ' is-you' : ''}`}>{team.name}</span>
        {row.star ? <span className="c-team__star">★</span> : null}
      </div>
      <div className="c-sol">
        <b>{row.solved}</b>
      </div>
      <div className="c-pen">
        <b>{row.pen}</b>
      </div>
      {cellNodes}
    </div>
  );
});

const CellView = memo(function CellView({
  cell,
  ti,
  p,
  problem,
  row,
  team,
  freezeStart,
  approx,
  onCell,
}: {
  cell: Cell;
  ti: number;
  p: number;
  problem: ContestModel['problems'][number];
  row: BoardRow;
  team: TeamModel;
  freezeStart: number;
  approx: boolean;
  onCell: (ev: React.MouseEvent, ti: number, p: number) => void;
}) {
  const { show, hide } = useTip();
  if (cell.st === 'none') return <div className="pcell is-none" />;

  const readout = (): { value: string; cls: string } => {
    if (cell.st === 'ac') return { value: `AC ${minutesOf(cell.t)}′ ×${cell.n}${cell.post ? ' · 封榜后' : ''}`, cls: 'is-ok' };
    if (cell.st === 'fb') return { value: `首杀 ${minutesOf(cell.t)}′${cell.post ? ' · 封榜后' : ''}`, cls: 'is-ok' };
    if (cell.st === 'pen') return { value: `未过 −${cell.n} · 末次 ${minutesOf(cell.t)}′${cell.post ? ' · 封榜后' : ''}`, cls: 'is-bad' };
    if (cell.st === 'ce') return { value: `CE · 不罚 · ${minutesOf(cell.t)}′`, cls: 'is-zero' };
    return { value: `封榜 ?${cell.n} · 末次 ${minutesOf(cell.t)}′`, cls: 'is-zero' };
  };
  const tip = readout();
  const sub: string[] = [];
  if (cell.post) sub.push('发生在封榜段 · 不计入定格名次');
  sub.push(`${team.name} · 第 ${row.rank} 名`);
  sub.push(approx ? '点击查看判名与次数' : '点击查看逐次提交');

  return (
    <div
      className={`pcell is-${cell.st} is-hit${cell.post ? ' is-post' : ''}`}
      onMouseEnter={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        show({ x: r.left + r.width / 2, y: r.top, date: `${problem.alias ?? ''} · ${problem.title ?? ''}`, value: tip.value, zero: tip.cls === 'is-zero', valueClass: tip.cls, sub });
      }}
      onMouseLeave={hide}
      onClick={(e) => {
        e.stopPropagation();
        hide();
        onCell(e, ti, p);
      }}
    >
      <span className="pcell__b">
        <span className="pcell__t">{minutesOf(cell.t)}</span>
        <span className="pcell__n">{cell.st === 'ac' ? (cell.n > 1 ? `×${cell.n}` : '') : cell.st === 'fb' ? 'FB' : cell.st === 'pen' ? `−${cell.n}` : cell.st === 'ce' ? 'CE' : `?${cell.n}`}</span>
        {cell.post ? <i className="pcell__dot" /> : null}
      </span>
    </div>
  );
});

/* ---------- 弹层内容 ---------- */

function SubPop({ model, ti, p, viewMs, cap, ghost }: { model: ContestModel; ti: number; p: number; viewMs: number; cap: number; ghost: GhostData | null }) {
  const problem = model.problems[p];
  if (ti === -1) {
    if (problem === undefined) return null;
    const head = { title: `${problem.alias ?? ''} · ${problem.title ?? ''}`, sub: '你 @我的成绩' };
    const rows = (ghost?.subs ?? [])
      .filter((s) => s.p === p && s.t * 60_000 <= viewMs)
      .sort((a, b) => a.t - b.t)
      .map((s) => ({ r: s.r, t: s.t * 60_000, frozen: s.t * 60_000 > cap }));
    return (
      <PopShell head={head}>
        {rows.length === 0 ? (
          <div className="hint">本题还没录。</div>
        ) : (
          <>
            {rows.map((x, i) => (
              <div className="pop__row" key={i}>
                <span className={x.frozen ? 'res res--frz' : resClass(x.r)}>{x.frozen ? 'Frozen' : x.r}</span>
                <span className="pop__tm num">{clockHMS(x.t)}</span>
                <span className="pop__lg">手动录入</span>
              </div>
            ))}
            <div className="hint" style={{ marginTop: 8 }}>
              {viewMs > model.freezeStart && viewMs < model.duration ? '封榜段内结果未公开，一律显示 Frozen · ' : ''}
              罚时 = 过题分钟 + 20 ×（过题前失败 · CE 不罚）
            </div>
          </>
        )}
      </PopShell>
    );
  }
  const team = model.teams[ti];
  if (team === undefined || problem === undefined) return null;
  const list = subsUntil(team.subs[p] ?? [], viewMs, cap, team.verdicts[p]);
  const verdict = team.verdicts[p];
  const fb = verdict === undefined || verdict === 'FB' ? team.subs[p]?.find((x) => x.result === 'FB') : undefined;
  const who = team.name === '' ? team.org || '队伍信息未收录' : team.org === '' ? team.name : `${team.name} @${team.org}`;
  const head = { title: `${problem.alias ?? ''} · ${problem.title ?? ''}`, sub: `${who}${fb !== undefined && toCap(fb) <= cap ? ' · 本题首杀' : ''}` };
  if (list.length === 0) {
    const s = team.summaries[p];
    if (s === undefined || s.t > viewMs) return <PopShell head={head}><div className="hint">本场未提交。</div></PopShell>;
    const shown = s.unknown || s.t > cap;
    return (
      <PopShell head={head}>
        <div className="pop__row">
          <span className={shown ? 'res res--frz' : s.accepted ? 'res res--ac' : 'res res--bad'}>{shown ? 'Frozen' : s.accepted ? (s.fb ? 'FB' : 'AC') : '未过'}</span>
          <span className="pop__tm num">{clockHMS(s.t)}</span>
          <span className="pop__lg">{s.tries} 发</span>
        </div>
        <div className="hint" style={{ marginTop: 8 }}>这题没有逐次提交记录，只有终局判名与总次数。</div>
      </PopShell>
    );
  }
  return (
    <PopShell head={head}>
      {list.map((x, i) => (
        <div className="pop__row" key={i}>
          <span className={x.frozen ? 'res res--frz' : resClass(x.r)}>{x.frozen ? 'Frozen' : x.r}</span>
          <span className="pop__tm num">{clockHMS(x.t)}</span>
          <span className="pop__lg">{x.language}</span>
        </div>
      ))}
      <div className="hint" style={{ marginTop: 8 }}>
        {viewMs > model.freezeStart && viewMs < model.duration ? '封榜段内结果未公开，一律显示 Frozen · ' : ''}
        罚时 = 过题分钟 + 20 ×（过题前失败 · CE 不罚）
      </div>
    </PopShell>
  );
}

const toCap = (x: SrkSolution): number => toMs(x.time);

function TeamPop({ model, ti, board }: { model: ContestModel; ti: number; board: Board }) {
  const row = board.rows.find((r) => r.ti === ti);
  if (ti === -1) {
    const g = board.ghostTeam;
    if (g === null || g === undefined) return null;
    return (
      <PopShell head={{ title: g.name, sub: g.org }}>
        <div className="pop__who">
          <div className="hint">VP 成绩手动录入，点格子看每题明细。</div>
        </div>
        <div className="pop__rule" />
        <div className="pop__kv">
          <span className="pop__k">Seat</span>
          <span className="pop__v num">{g.seat}</span>
        </div>
        <div className="pop__kv">
          <span className="pop__k">状态</span>
          <span className="pop__v">{row?.medal ? row.medalTitle : '正式队'}</span>
        </div>
      </PopShell>
    );
  }
  const team = model.teams[ti];
  if (team === undefined) return null;
  const title = team.name === '' ? team.org || '队伍信息未收录' : team.name;
  const head = { title, sub: team.name === '' || team.org === '' ? '' : team.org };
  return (
    <PopShell head={head}>
      <div className="pop__who">
        {team.members.length === 0 ? (
          <div className="hint">快照未收录队员名单。</div>
        ) : (
          team.members.map((m, i) => (
            <div className="pop__p" key={i}>
              <span className="av">{m.slice(0, 1)}</span>
              <span>{m}</span>
            </div>
          ))
        )}
      </div>
      <div className="pop__rule" />
      <div className="pop__kv">
        <span className="pop__k">Seat</span>
        <span className="pop__v num">#{team.seat}</span>
      </div>
      <div className="pop__kv">
        <span className="pop__k">状态</span>
        <span className="pop__v">{team.star ? <span className="tgtag">打星</span> : row?.medal ? `${row.medalTitle}` : '正式队'}</span>
      </div>
    </PopShell>
  );
}
