import { useEffect, useRef, useState } from 'react';
import {
  PROBLEM_PROGRESS_NAME,
  PROBLEM_TAG_LEN_MAX,
  PROBLEM_TAGS_MAX,
  type ProblemMarkInput,
  type ProblemMarksDto,
  type ProblemMarksProblem,
  type ProblemMarkProgress,
} from '@anvil/shared';
import { ApiError, getArenaContest, getWorkObject, syncProblemMarks, updateProblemMarks } from '../../api.ts';
import { messageOf } from '../../format.ts';
import { Icon } from '../ui.tsx';
import { problemsFromArena } from './derive.ts';

interface Props {
  contestId: string;
  arenaPath: string;
  marks: ProblemMarksDto | null;
  error: string | null;
  archived: boolean;
  /** 本工作区已用过的题目标签（最多 200，界面只取前 20 条做补全） */
  suggestions: string[];
  onChanged: () => void;
  /** 有未落盘修改时告知父级，切换对象前拦一下（30 §6.2） */
  onUnsavedChange?: (unsaved: boolean) => void;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error' | 'conflict';

const PROGRESS_OPTIONS: ReadonlyArray<{ value: ProblemMarkProgress | null; label: string }> = [
  { value: null, label: '未标记' },
  { value: 'todo', label: PROBLEM_PROGRESS_NAME.todo },
  { value: 'post-solved', label: PROBLEM_PROGRESS_NAME['post-solved'] },
  { value: 'contest-ac', label: PROBLEM_PROGRESS_NAME['contest-ac'] },
];

function inputsOf(dto: ProblemMarksDto | null): Record<string, ProblemMarkInput> {
  const out: Record<string, ProblemMarkInput> = Object.create(null) as Record<string, ProblemMarkInput>;
  for (const [alias, mark] of Object.entries(dto?.marks ?? {})) {
    out[alias] = { progress: mark.progress, star: mark.star, tags: [...mark.tags] };
  }
  return out;
}

function summaryText(problems: ProblemMarksProblem[], local: Readonly<Record<string, ProblemMarkInput>>): string {
  let marked = 0;
  let todo = 0;
  let starred = 0;
  let postSolved = 0;
  let contestAc = 0;
  for (const mark of Object.values(local)) {
    marked += 1;
    if (mark.progress === 'todo') todo += 1;
    if (mark.progress === 'post-solved') postSolved += 1;
    if (mark.progress === 'contest-ac') contestAc += 1;
    if (mark.star) starred += 1;
  }
  const parts = [`${problems.length} 题`];
  if (marked === 0) return `${problems.length} 题 · 还没有标记。只标记你在意的题。`;
  parts.push(`已标记 ${marked}`);
  if (todo > 0) parts.push(`待补 ${todo}`);
  if (postSolved > 0) parts.push(`已补 ${postSolved}`);
  if (contestAc > 0) parts.push(`已过 ${contestAc}`);
  if (starred > 0) parts.push(`重点 ${starred}`);
  return parts.join(' · ');
}

export function ProblemMarks(props: Props) {
  const [problems, setProblems] = useState<ProblemMarksProblem[]>(() => props.marks?.problems ?? []);
  const [local, setLocal] = useState<Record<string, ProblemMarkInput>>(() => inputsOf(props.marks));
  const [loadError, setLoadError] = useState<string | null>(props.error);
  const [fillError, setFillError] = useState<string | null>(null);
  const [unreadable, setUnreadable] = useState(props.marks?.unreadableMarks ?? 0);
  const [filling, setFilling] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [tagDrafts, setTagDrafts] = useState<Record<string, string>>({});
  const [tagWarn, setTagWarn] = useState<string | null>(null);

  const setUnsaved = (unsaved: boolean): void => {
    (window as unknown as { __anvilMarksUnsaved?: boolean }).__anvilMarksUnsaved = unsaved;
    props.onUnsavedChange?.(unsaved);
  };

  const revisionRef = useRef(props.marks?.revision ?? '');
  const localRef = useRef(local);
  const pendingRef = useRef<Record<string, ProblemMarkInput>>({});
  const versionRef = useRef(0);
  const dirtyRef = useRef(false);
  const inFlightRef = useRef(false);

  const applyDto = (dto: ProblemMarksDto | null, error: string | null): void => {
    const next = inputsOf(dto);
    localRef.current = next;
    setLocal(next);
    setProblems(dto?.problems ?? []);
    setUnreadable(dto?.unreadableMarks ?? 0);
    setLoadError(error);
    setFillError(null);
    revisionRef.current = dto?.revision ?? '';
    setSaveState('idle');
    setSaveError(null);
    setTagDrafts({});
    dirtyRef.current = false;
    pendingRef.current = {};
    setUnsaved(false);
  };

  useEffect(() => {
    applyDto(props.marks, props.error);
    // 只在切换比赛时重置；同场的本地编辑不会被父级列表刷新覆盖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.contestId]);

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent): void => {
      if (!dirtyRef.current) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      setUnsaved(false);
    };
    // onUnsavedChange 是父级稳定回调，不随每次渲染重挂监听
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pump = async (): Promise<void> => {
    if (inFlightRef.current || !dirtyRef.current) return;
    const payload = pendingRef.current;
    const version = versionRef.current;
    inFlightRef.current = true;
    let ok = false;
    try {
      const res = await updateProblemMarks({
        arenaPath: props.arenaPath,
        expectedRevision: revisionRef.current,
        marks: payload,
      });
      revisionRef.current = res.problemMarks.revision;
      ok = true;
      props.onChanged();
      if (versionRef.current === version) {
        const next = inputsOf(res.problemMarks);
        localRef.current = next;
        setLocal(next);
        setUnreadable(res.problemMarks.unreadableMarks ?? 0);
        dirtyRef.current = false;
        setUnsaved(false);
        setSaveState('saved');
      } else {
        setSaveState('saving');
      }
    } catch (err) {
      if (err instanceof ApiError && err.kind === 'conflict') {
        setSaveState('conflict');
        setSaveError('另一页面已更新，重新载入后再改');
        dirtyRef.current = true;
        setUnsaved(true);
      } else {
        setSaveState('error');
        setSaveError(messageOf(err));
        dirtyRef.current = true;
        setUnsaved(true);
      }
    } finally {
      inFlightRef.current = false;
      if (ok && dirtyRef.current) void pump();
    }
  };

  const queueSave = (next: Record<string, ProblemMarkInput>): void => {
    localRef.current = next;
    setLocal(next);
    pendingRef.current = next;
    versionRef.current += 1;
    dirtyRef.current = true;
    setUnsaved(true);
    setSaveState('saving');
    setSaveError(null);
    void pump();
  };

  const commit = (alias: string, next: ProblemMarkInput): void => {
    if (saveState === 'conflict') return;
    const all = { ...localRef.current };
    if (next.progress === null && !next.star && next.tags.length === 0) delete all[alias];
    else all[alias] = next;
    queueSave(all);
  };

  const markOf = (alias: string): ProblemMarkInput =>
    Object.hasOwn(local, alias) ? local[alias]! : { progress: null, star: false, tags: [] };

  const setProgress = (alias: string, progress: ProblemMarkProgress | null): void => {
    commit(alias, { ...markOf(alias), progress });
  };

  const toggleStar = (alias: string): void => {
    const mark = markOf(alias);
    commit(alias, { ...mark, star: !mark.star });
  };

  const addTag = (alias: string): void => {
    const mark = markOf(alias);
    if (mark.tags.length >= PROBLEM_TAGS_MAX) {
      setTagWarn(`每题最多 ${PROBLEM_TAGS_MAX} 个标签`);
      return;
    }
    const raw = (Object.hasOwn(tagDrafts, alias) ? tagDrafts[alias]! : '').trim();
    if (raw === '') return;
    if (raw.length > PROBLEM_TAG_LEN_MAX) {
      setTagWarn(`标签最多 ${PROBLEM_TAG_LEN_MAX} 个字`);
      return;
    }
    if (mark.tags.includes(raw)) {
      setTagDrafts((d) => ({ ...d, [alias]: '' }));
      return;
    }
    setTagWarn(null);
    setTagDrafts((d) => ({ ...d, [alias]: '' }));
    commit(alias, { ...mark, tags: [...mark.tags, raw] });
  };

  const removeTag = (alias: string, tag: string): void => {
    const mark = markOf(alias);
    commit(alias, { ...mark, tags: mark.tags.filter((t) => t !== tag) });
  };

  async function fillFromBoard(): Promise<void> {
    if (filling) return;
    setFilling(true);
    setFillError(null);
    try {
      const contest = await getArenaContest(props.arenaPath);
      const nextProblems = problemsFromArena(contest.data);
      if (nextProblems.length === 0) throw new ApiError('榜单里没有题目，不能建立题目清单');
      const res = await syncProblemMarks({ arenaPath: props.arenaPath, problems: nextProblems });
      applyDto(res.problemMarks, null);
      props.onChanged();
    } catch (err) {
      setFillError(`题目清单同步失败 · ${messageOf(err)}`);
    } finally {
      setFilling(false);
    }
  }

  async function reloadFromServer(): Promise<void> {
    setFilling(true);
    setLoadError(null);
    setFillError(null);
    try {
      const detail = await getWorkObject(props.contestId);
      applyDto(detail.problemMarks ?? null, detail.problemMarksError ?? null);
    } catch (err) {
      setLoadError(messageOf(err));
    } finally {
      setFilling(false);
    }
  }

  const retrySave = (): void => {
    setSaveError(null);
    setSaveState('saving');
    dirtyRef.current = true;
    pendingRef.current = localRef.current;
    versionRef.current += 1;
    void pump();
  };

  const saveLabel =
    saveState === 'saving'
      ? '保存中…'
      : saveState === 'saved'
        ? '已保存'
        : saveState === 'error'
          ? '保存失败 · 重试'
          : saveState === 'conflict'
            ? '另一页面已更新，重新载入后再改'
            : null;

  return (
    <section className="wk-sec wk-marks">
      <div className="wk-sec__title wk-marks__title" id="wk-problems" tabIndex={-1}>
        <span>题目标记</span>
        {problems.length > 0 ? <span className="wk-sec__note">{summaryText(problems, local)}</span> : null}
        <span className="wk-marks__save" role="status">
          {saveState === 'error' ? (
            <button className="wk-marks__retry" onClick={retrySave}>
              {saveLabel}
            </button>
          ) : (
            saveLabel
          )}
        </span>
      </div>
      {props.archived ? <p className="wk-hint">已归档；题目标记仍可修改。</p> : null}

      {loadError !== null ? (
        <div className="alert alert--err" role="status">
          <Icon id="i-warn" />
          <div>
            <b>标记读不出来</b> · {loadError}。成绩与对象不受影响。
          </div>
          <button className="btn btn--xs btn--ghost" disabled={filling} onClick={() => void reloadFromServer()}>
            重试
          </button>
        </div>
      ) : fillError !== null ? (
        <div className="alert alert--err" role="status">
          <Icon id="i-plug" />
          <div>{fillError}</div>
          <button className="btn btn--xs btn--ghost" disabled={filling} onClick={() => void fillFromBoard()}>
            {filling ? '同步中…' : '重试'}
          </button>
        </div>
      ) : problems.length === 0 ? (
        <div className="wk-marks__empty">
          <span className="wk-muted">还没有题目清单。</span>
          <button className="btn btn--sm" disabled={filling} onClick={() => void fillFromBoard()}>
            {filling ? '同步中…' : '从榜单补齐'}
          </button>
        </div>
      ) : (
        <>
          {tagWarn !== null ? <div className="wk-note wk-note--bad">{tagWarn}</div> : null}
          {unreadable > 0 ? (
            <div className="wk-note">有 {unreadable} 条标记未能读取（题目清单里没有对应题号）。文件已保留。</div>
          ) : null}
          <datalist id="wk-problem-tag-suggest">
            {props.suggestions.slice(0, 20).map((tag) => (
              <option value={tag} key={tag} />
            ))}
          </datalist>
          <div className="wk-marks__rows">
            {problems.map((problem) => {
              const mark = markOf(problem.alias);
              const marked = Object.hasOwn(local, problem.alias);
              const disabled = saveState === 'conflict';
              return (
                <div className={`wk-mark${marked ? ' is-marked' : ''}`} key={problem.alias}>
                  <span className="wk-mark__alias" title={`题号 ${problem.alias}`}>
                    {problem.alias}
                  </span>
                  <span className="wk-mark__title" title={problem.title}>
                    {problem.title === '' ? <span className="wk-muted">（无题名）</span> : problem.title}
                  </span>
                  <span className="wk-mark__controls">
                    <span className="wk-mark__seg" role="radiogroup" aria-label={`${problem.alias} 进度`}>
                      {PROGRESS_OPTIONS.map((option) => (
                        <label
                          className={`wk-mark__opt${mark.progress === option.value ? ' is-on' : ''}${option.value === null ? ' is-none' : ''}`}
                          key={option.label}
                        >
                          <input
                            type="radio"
                            name={`wk-progress-${problem.alias}`}
                            checked={mark.progress === option.value}
                            disabled={disabled}
                            onChange={() => setProgress(problem.alias, option.value)}
                          />
                          <span>{option.label}</span>
                        </label>
                      ))}
                    </span>
                    <button
                      type="button"
                      className={`wk-mark__star${mark.star ? ' is-on' : ''}`}
                      aria-pressed={mark.star}
                      disabled={disabled}
                      title={mark.star ? '取消重点' : '标为重点'}
                      onClick={() => toggleStar(problem.alias)}
                    >
                      <Icon id="i-star" />
                      重点
                    </button>
                  </span>
                  <span className="wk-mark__tags">
                    {mark.tags.map((tag) => (
                      <span className="wk-chip" key={tag}>
                        {tag}
                        <button
                          className="wk-chip__x"
                          aria-label={`移除标签 ${tag}`}
                          disabled={disabled}
                          onClick={() => removeTag(problem.alias, tag)}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                    <input
                      className="wk-labelinput wk-mark__taginput"
                      value={Object.hasOwn(tagDrafts, problem.alias) ? (tagDrafts[problem.alias] ?? '') : ''}
                      placeholder={mark.tags.length >= PROBLEM_TAGS_MAX ? '最多 8 个' : '加标签（如 dp / 字符串）'}
                      maxLength={PROBLEM_TAG_LEN_MAX}
                      list="wk-problem-tag-suggest"
                      disabled={disabled || mark.tags.length >= PROBLEM_TAGS_MAX}
                      aria-label={`${problem.alias} 加标签`}
                      onChange={(e) => setTagDrafts((d) => ({ ...d, [problem.alias]: e.target.value }))}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          // 输入法选词的回车不算提交
                          if (e.nativeEvent.isComposing) return;
                          e.preventDefault();
                          addTag(problem.alias);
                        }
                      }}
                    />
                  </span>
                </div>
              );
            })}
          </div>
        </>
      )}

      {saveState === 'conflict' ? (
        <div className="alert alert--err" role="status">
          <Icon id="i-warn" />
          <div>
            <b>另一页面已更新</b> · 本地未提交的修改还在。重新载入会丢掉本地修改。
          </div>
          <span className="arena-alert-acts">
            <button className="btn btn--xs btn--ghost" disabled={filling} onClick={() => void reloadFromServer()}>
              重新载入
            </button>
          </span>
        </div>
      ) : saveState === 'error' ? (
        <div className="alert alert--err" role="status">
          <Icon id="i-plug" />
          <div>{saveError ?? '保存失败'}；本地修改还在。</div>
          <button className="btn btn--xs btn--ghost" onClick={retrySave}>
            重试
          </button>
        </div>
      ) : null}
    </section>
  );
}
