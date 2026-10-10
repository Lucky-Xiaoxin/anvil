/**
 * 模拟榜单容器（docs/16 §6）：目录 ↔ 回放 / 回顾 两块屏的切换与会话表刷新。
 *
 * 回放的「这一场正在播」状态全在 localStorage（每场一条），所以刷新页面回到目录时
 * 那一行仍然挂着「回放中 · 时刻」，点「回到回放」按开始时刻续钟 —— 容器只管切屏与传路径。
 */
import { useCallback, useState } from 'react';
import { ArenaCatalog } from './ArenaCatalog.tsx';
import { ArenaBoard } from './ArenaBoard.tsx';
import type { LeafRow } from './catalog.ts';

const store = typeof window === 'undefined' ? null : window.localStorage;

export function Arena() {
  const [open, setOpen] = useState<{ row: LeafRow; live: boolean } | null>(null);
  /** 离开回放屏就 +1：目录的「回放中」标记要立刻反映会话变化 */
  const [epoch, setEpoch] = useState(0);

  const enter = useCallback((row: LeafRow, live: boolean) => setOpen({ row, live }), []);
  const back = useCallback(() => {
    setOpen(null);
    setEpoch((n) => n + 1);
  }, []);

  if (store === null) return null;
  if (open === null) return <ArenaCatalog store={store} onEnter={enter} sessionEpoch={epoch} />;
  return <ArenaBoard key={open.row.path} row={open.row} live={open.live} store={store} onBack={back} />;
}
