/**
 * 模拟榜单容器（docs/contracts/16 §6）：目录 ↔ 回放 / 回顾 两块屏的切换与会话表刷新。
 *
 * 回放的「这一场正在播」状态全在 localStorage（每场一条），所以刷新页面回到目录时
 * 那一行仍然挂着「回放中 · 时刻」，点「回到回放」按开始时刻续钟 —— 容器只管切屏与传路径。
 */
import { useCallback, useState } from 'react';
import type { WorkArenaRecordDto } from '@anvil/shared';
import { ArenaCatalog } from './ArenaCatalog.tsx';
import { ArenaBoard } from './ArenaBoard.tsx';
import type { LeafRow } from './catalog.ts';
import type { Store } from './session.ts';

/** 访问器本身在隐私模式下会直接抛：进函数再取 + try，别让模块加载那一步就炸掉整棵树 */
function safeStore(): Store | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

interface Props {
  /** 目录场次往上报一层：侧栏页脚在 arena 语境要报这个数，而壳自己拉不到目录 */
  onCount: (n: number) => void;
  /** 从工坊「回到回放」进来的场次路径；目录就绪后自动进入并读 record.json */
  entryPath: string | null;
  /** 已消费入口后清掉 hash 查询，避免退回目录又被重新带入 */
  onEntryConsumed: () => void;
}

export function Arena({ onCount, entryPath, onEntryConsumed }: Props) {
  const [store] = useState(safeStore);
  const [open, setOpen] = useState<{ row: LeafRow; live: boolean; record: WorkArenaRecordDto | null } | null>(null);
  /** 离开回放屏就 +1：目录的「回放中」标记要立刻反映会话变化 */
  const [epoch, setEpoch] = useState(0);

  const enter = useCallback(
    (row: LeafRow, live: boolean, record: WorkArenaRecordDto | null = null) => setOpen({ row, live, record }),
    [],
  );
  const back = useCallback(() => {
    setOpen(null);
    setEpoch((n) => n + 1);
  }, []);

  if (store === null) return null;
  if (open === null) {
    return (
      <ArenaCatalog
        store={store}
        onEnter={enter}
        sessionEpoch={epoch}
        onCount={onCount}
        restorePath={entryPath}
        onRestoreConsumed={onEntryConsumed}
      />
    );
  }
  return (
    <ArenaBoard
      key={open.row.path}
      row={open.row}
      live={open.live}
      store={store}
      onBack={back}
      initialRecord={open.record}
    />
  );
}
