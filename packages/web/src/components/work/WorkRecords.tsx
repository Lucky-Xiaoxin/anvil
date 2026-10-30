/**
 * 比赛详情里的「历史成绩」区（docs/contracts/29 §6.2）：列档、查看、改名、删除、旧进度。
 * 榜单负责使用（查看 / 编辑 / 保存），工坊负责管理（名称 / 回收 / 恢复），数据同源不复制。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ArenaRecordsListDto, ArenaRecordSummaryDto } from '@anvil/shared';
import { arenaResultLabel } from '@anvil/shared';
import { listArenaRecords, renameArenaRecord, trashArenaRecord } from '../../api.ts';
import { messageOf } from '../../format.ts';
import { Icon } from '../ui.tsx';
import { ConfirmDialog, NameDialog } from '../arena/ArenaDialogs.tsx';
import { detachDraftTarget } from '../arena/draft.ts';
import { recordStamp } from '../arena/record.ts';
import { browserStore } from '../arena/session.ts';

interface Props {
  arenaPath: string;
  contestTitle: string;
  /** 宿主归档：列表只读，不出现改名 / 回收 / 旧进度恢复 */
  archived: boolean;
  onOpenRecord: (recordId: string) => void;
  onRestoreLegacy: () => void;
  /** 回收 / 改名后通知外层刷新回收站计数 */
  onChanged: () => void;
}

type LoadState = { status: 'loading' } | { status: 'ready'; dto: ArenaRecordsListDto } | { status: 'error'; message: string };

export function WorkRecords({ arenaPath, contestTitle, archived, onOpenRecord, onRestoreLegacy, onChanged }: Props) {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rename, setRename] = useState<ArenaRecordSummaryDto | null>(null);
  const [renameErr, setRenameErr] = useState<string | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);
  const [trashTarget, setTrashTarget] = useState<ArenaRecordSummaryDto | null>(null);
  const [trashLegacy, setTrashLegacy] = useState<{ revision: string; savedAt: string } | null>(null);
  const seq = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    const token = ++seq.current;
    setState((prev) => (prev.status === 'ready' ? prev : { status: 'loading' }));
    try {
      const dto = await listArenaRecords(arenaPath);
      if (token !== seq.current) return;
      setState({ status: 'ready', dto });
      setErr(null);
    } catch (error) {
      if (token !== seq.current) return;
      setState({ status: 'error', message: messageOf(error) });
    }
  }, [arenaPath]);

  useEffect(() => {
    void refresh();
    return () => {
      seq.current += 1;
    };
  }, [refresh]);

  const dto = state.status === 'ready' ? state.dto : null;
  const records = dto?.records ?? [];
  const errors = dto?.errors ?? [];
  const legacy = dto?.legacy ?? null;

  const confirmRename = (name: string): void => {
    if (rename === null) return;
    setRenameBusy(true);
    setRenameErr(null);
    void (async () => {
      try {
        await renameArenaRecord({ arenaPath, recordId: rename.recordId, expectedRevision: rename.revision, name });
        setRename(null);
        await refresh();
        onChanged();
      } catch (error) {
        setRenameErr(messageOf(error));
      } finally {
        setRenameBusy(false);
      }
    })();
  };

  const confirmTrash = (): void => {
    if (trashTarget === null && trashLegacy === null) return;
    const target = trashTarget;
    const legacyTarget = trashLegacy;
    setBusy('trash');
    setErr(null);
    setNotice(null);
    void (async () => {
      try {
        const recordId = target?.recordId ?? 'legacy';
        await trashArenaRecord({
          arenaPath,
          recordId,
          expectedRevision: target?.revision ?? legacyTarget!.revision,
          confirm: true,
        });
        // 同一浏览器里可能还有指向这份档的草稿：解除 target，保留成绩，下次保存新建
        const store = browserStore();
        if (store !== null && detachDraftTarget(store, arenaPath, recordId)) {
          setNotice('原存档已删除；这场本地草稿已解除保存目标，下次保存会新建一份。');
        }
        setTrashTarget(null);
        setTrashLegacy(null);
        await refresh();
        onChanged();
      } catch (error) {
        setErr(messageOf(error));
        setTrashTarget(null);
        setTrashLegacy(null);
      } finally {
        setBusy(null);
      }
    })();
  };

  return (
    <section className="wk-sec wk-records">
      <div className="wk-sec__title">
        <span>历史成绩</span>
        <b className="num">{records.length}</b>
        {archived ? <span className="wk-sec__note">比赛已归档 · 只读</span> : null}
        <button type="button" className="btn btn--xs btn--ghost wk-records__refresh" disabled={state.status === 'loading'} onClick={() => void refresh()}>
          <Icon id="i-sync" />
          刷新
        </button>
      </div>
      {state.status === 'loading' ? <div className="wk-empty wk-empty--small">正在读存档…</div> : null}
      {state.status === 'error' ? (
        <div className="alert alert--err" role="status">
          <Icon id="i-plug" />
          <div>历史成绩读取失败：{state.message}</div>
          <button className="alert__x" type="button" onClick={() => void refresh()}>
            重试
          </button>
        </div>
      ) : null}
      {err !== null ? (
        <div className="alert alert--err" role="status">
          <Icon id="i-warn" />
          <div>{err}</div>
          <button className="alert__x" type="button" onClick={() => setErr(null)}>
            知道了
          </button>
        </div>
      ) : null}
      {notice !== null ? (
        <div className="alert alert--ok" role="status">
          <Icon id="i-check" />
          <div>{notice}</div>
          <button className="alert__x" type="button" onClick={() => setNotice(null)}>
            知道了
          </button>
        </div>
      ) : null}
      {state.status === 'ready' ? (
        <>
          {records.length === 0 && legacy === null && errors.length === 0 ? (
            <div className="wk-empty wk-empty--small">还没有历史成绩。在回放页结束练习后保存，就会出现在这里。</div>
          ) : null}
          {records.map((rec) => (
            <div className="wk-rec" key={rec.recordId}>
              <div className="wk-rec__main">
                <div className="wk-rec__name">
                  {rec.name}
                  {rec.recordId === 'legacy' ? <span className="wk-badge">旧根文件</span> : null}
                </div>
                <div className="wk-rec__meta">
                  <span>{arenaResultLabel(rec.result)}</span>
                  <span className="wk-dot" />
                  <span>{recordStamp(rec.updatedAt)}</span>
                  <span className="wk-dot" />
                  <span>{rec.submissionCount} 发</span>
                </div>
              </div>
              <div className="wk-rec__acts">
                <button type="button" className="btn btn--xs" onClick={() => onOpenRecord(rec.recordId)}>
                  <Icon id="i-eye" />
                  查看
                </button>
                {archived ? null : (
                  <>
                    <button type="button" className="btn btn--xs btn--ghost" onClick={() => { setRename(rec); setRenameErr(null); }}>
                      <Icon id="i-pencil" />
                      改名
                    </button>
                    <button type="button" className="btn btn--xs btn--ghost" disabled={busy !== null} onClick={() => setTrashTarget(rec)}>
                      <Icon id="i-trash" />
                      删除
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
          {legacy !== null ? (
            <div className="wk-rec wk-rec--legacy">
              <div className="wk-rec__main">
                <div className="wk-rec__name">旧进度 · 未结束</div>
                <div className="wk-rec__meta">
                  <span>保存于 {recordStamp(legacy.savedAt)}</span>
                  <span className="wk-dot" />
                  <span>{legacy.submissionCount} 发</span>
                  <span className="wk-dot" />
                  <span>不计入历史成绩</span>
                </div>
              </div>
              <div className="wk-rec__acts">
                <button
                  type="button"
                  className="btn btn--xs"
                  disabled={archived}
                  title={archived ? '比赛已归档：先取消归档再恢复为当前练习' : '复制旧成绩与位置，按暂停态进入当前练习'}
                  onClick={onRestoreLegacy}
                >
                  恢复为当前练习
                </button>
                {archived ? null : (
                  <button
                    type="button"
                    className="btn btn--xs btn--ghost"
                    disabled={busy !== null}
                    title="把旧根文件单独移入回收站；原文件按 revision 校验"
                    onClick={() => {
                      setTrashLegacy({ revision: legacy.revision, savedAt: legacy.savedAt });
                      setErr(null);
                    }}
                  >
                    <Icon id="i-trash" />
                    删除
                  </button>
                )}
              </div>
            </div>
          ) : null}
          {errors.length > 0 ? (
            <div className="wk-records__errors">
              {errors.map((e) => (
                <div className="wk-error" key={e.file}>
                  <span className="wk-error__kind">存档</span>
                  <code>{e.file}</code>
                  <span className="wk-error__msg">{e.message}</span>
                </div>
              ))}
            </div>
          ) : null}
          <p className="wk-hint">
            查看 / 编辑在回放页；这里只管名称与回收。删除只进回收站，清空回收站才永久删除。
          </p>
        </>
      ) : null}

      {rename !== null ? (
        <NameDialog
          title="存档改名"
          sub={`「${contestTitle}」· 改名不改变存档 ID 与内容。`}
          initial={rename.name}
          confirmLabel="改名"
          busy={renameBusy}
          error={renameErr}
          onCancel={() => setRename(null)}
          onConfirm={confirmRename}
        />
      ) : null}
      {trashTarget !== null || trashLegacy !== null ? (
        <ConfirmDialog
          title={trashTarget !== null ? '删除存档' : '删除旧进度'}
          body={
            trashTarget !== null ? (
              <>
                把「<b>{trashTarget.name}</b>」从「{contestTitle}」移入回收站？
                <br />
                比赛、题组与其它成绩不受影响；可从回收站恢复，清空回收站才永久删除。
              </>
            ) : (
              <>
                把「{contestTitle}」的<b>旧进度</b>（保存于 {recordStamp(trashLegacy!.savedAt)}）移入回收站？
                <br />
                旧进度不是正式成绩；恢复后仍是原 schema 1 旧进度，不会被转成完赛档。
              </>
            )
          }
          confirmLabel="移入回收站"
          danger
          busy={busy === 'trash'}
          error={err}
          onCancel={() => {
            setTrashTarget(null);
            setTrashLegacy(null);
          }}
          onConfirm={confirmTrash}
        />
      ) : null}
    </section>
  );
}
