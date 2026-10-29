/**
 * 模拟榜单容器（docs/contracts/16 §6 + docs/contracts/29 §5.4）：目录 ↔ 回放 / 回顾 / 历史。
 *
 * 深链口径：`#/arena?path=` 进入该场当前练习（有草稿）或终榜；`&record=` 只读打开指定档；
 * `&legacy=restore` 请求把旧 live 恢复为当前练习。
 */
import { useCallback, useEffect, useState } from 'react';
import { ArenaCatalog } from './ArenaCatalog.tsx';
import { ArenaBoard, type ArenaEntryMode } from './ArenaBoard.tsx';
import type { LeafRow } from './catalog.ts';
import type { Store } from './session.ts';

/** 访问器本身在隐私模式下会直接抛：进函数再取 + try */
function safeStore(): Store | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export interface ArenaEntry {
  path: string;
  recordId: string | null;
  restoreLegacy: boolean;
}

interface OpenState {
  row: LeafRow;
  mode: ArenaEntryMode;
  recordId: string | null;
  openHistory: boolean;
}

interface Props {
  onCount: (n: number) => void;
  /** 从工坊 / 深链进来的场次 */
  entry: ArenaEntry | null;
  onEntryConsumed: () => void;
}

export function Arena({ onCount, entry, onEntryConsumed }: Props) {
  const [store] = useState(safeStore);
  const [open, setOpen] = useState<OpenState | null>(null);
  /** 离开回放屏 / 草稿变化就 +1：目录的状态标记要立刻反映 */
  const [epoch, setEpoch] = useState(0);

  const enter = useCallback((row: LeafRow, mode: ArenaEntryMode, opts: { recordId?: string | null; openHistory?: boolean } = {}) => {
    setOpen({ row, mode, recordId: opts.recordId ?? null, openHistory: opts.openHistory === true });
  }, []);
  const back = useCallback(() => {
    setOpen(null);
    setEpoch((n) => n + 1);
  }, []);
  const bump = useCallback(() => setEpoch((n) => n + 1), []);

  /* 已在回放里又收到新深链（工坊 / 粘链接）：先回目录，让目录按 record 打开指定档 */
  useEffect(() => {
    if (entry !== null) setOpen(null);
  }, [entry]);

  if (store === null) return null;
  if (open === null) {
    return (
      <ArenaCatalog
        store={store}
        onEnter={enter}
        sessionEpoch={epoch}
        onCount={onCount}
        entry={entry}
        onEntryConsumed={onEntryConsumed}
      />
    );
  }
  return (
    <ArenaBoard
      key={`${open.row.path}|${open.mode}|${open.recordId ?? ''}|${open.openHistory ? 'h' : ''}`}
      row={open.row}
      mode={open.mode}
      recordId={open.recordId}
      openHistory={open.openHistory}
      store={store}
      onBack={back}
      onDraftChanged={bump}
    />
  );
}
