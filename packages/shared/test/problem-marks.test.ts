import { describe, expect, it } from 'vitest';
import {
  cleanProblemTags,
  collectProblemTags,
  parseProblemMarksFile,
  parseProblemMarksInput,
  parseProblemSnapshot,
  prefillProblemMarks,
  problemMarkSummaryOf,
  problemMarksToJson,
  type ProblemMark,
  type ProblemMarksFile,
} from '@anvil/shared';

const ARENA = 'official/icpc/icpc2025/icpc2025shanghai.srk.json';

const file = (patch: Record<string, unknown> = {}) => ({
  schema: 1,
  arenaPath: ARENA,
  problems: [
    { alias: 'A', title: 'A. 某某题' },
    { alias: 'B', title: 'B. 另一题' },
    { alias: 'C', title: '' },
  ],
  marks: {
    A: { progress: 'contest-ac', star: false, tags: [], updatedAt: '2026-10-30T12:00:00.000Z' },
    B: { progress: 'todo', star: true, tags: ['dp'], updatedAt: '2026-10-30T12:00:00.000Z' },
  },
  prefillApplied: ['A'],
  ...patch,
});

const parseOk = (input: unknown, expected = ARENA): ProblemMarksFile => {
  const parsed = parseProblemMarksFile(input, expected);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.file;
};

const mark = (patch: Partial<ProblemMark> = {}): ProblemMark => ({
  progress: null,
  star: false,
  tags: [],
  updatedAt: '2026-10-30T12:00:00.000Z',
  ...patch,
});

describe('problem-marks 解析（30 §3.2）', () => {
  it('合法文件：题目顺序、标记、prefillApplied', () => {
    const parsed = parseOk(file());
    expect(parsed.problems.map((p) => p.alias)).toEqual(['A', 'B', 'C']);
    expect(parsed.marks.B).toEqual({ progress: 'todo', star: true, tags: ['dp'], updatedAt: '2026-10-30T12:00:00.000Z' });
    expect(parsed.prefillApplied).toEqual(['A']);
    expect(parsed.unreadableMarks).toBe(0);
  });

  it('schema 过高给 schema；合法但非 1 给 invalid；场次不一致给 arena-path', () => {
    expect(parseProblemMarksFile(file({ schema: 2 }), ARENA)).toMatchObject({ ok: false, code: 'schema' });
    expect(parseProblemMarksFile(file({ schema: 1.5 }), ARENA)).toMatchObject({ ok: false, code: 'invalid' });
    expect(parseProblemMarksFile(file(), 'official/icpc/other.srk.json')).toMatchObject({ ok: false, code: 'arena-path' });
  });

  it('题目为空 / alias 非法或重复 / title 超长 / 进度非法 → invalid', () => {
    expect(parseProblemMarksFile(file({ problems: [] }), ARENA).ok).toBe(false);
    expect(parseProblemMarksFile(file({ problems: [{ alias: 'A', title: '' }, { alias: 'A', title: '' }] }), ARENA).ok).toBe(false);
    expect(parseProblemMarksFile(file({ problems: [{ alias: '题一', title: '' }] }), ARENA).ok).toBe(false);
    expect(parseProblemMarksFile(file({ problems: [{ alias: 'A', title: 'x'.repeat(201) }] }), ARENA).ok).toBe(false);
    expect(
      parseProblemMarksFile(
        file({ marks: { A: { progress: 'done', star: false, tags: [], updatedAt: '2026-10-30T12:00:00.000Z' } } }),
        ARENA,
      ).ok,
    ).toBe(false);
  });

  it('未知 alias 的标记不进 DTO、原样保留；全空条目被丢弃', () => {
    const parsed = parseOk(
      file({
        marks: {
          Z: { progress: 'todo', star: false, tags: [], updatedAt: '2026-10-30T12:00:00.000Z' },
          A: { progress: null, star: false, tags: [], updatedAt: '2026-10-30T12:00:00.000Z' },
        },
      }),
    );
    expect(parsed.marks.A).toBeUndefined();
    expect(parsed.foreignMarks.Z).toBeDefined();
    expect(parsed.unreadableMarks).toBe(1);
    expect(problemMarksToJson(parsed).marks).toHaveProperty('Z');
  });

  it('标签清洗：trim / 去重 / 去空 / 上限 / 控制字符', () => {
    expect(cleanProblemTags([' dp ', 'dp', '', '字符串'])).toEqual({ ok: true, tags: ['dp', '字符串'] });
    expect(cleanProblemTags(Array.from({ length: 9 }, (_, i) => `t${i}`)).ok).toBe(false);
    expect(cleanProblemTags(['a'.repeat(25)]).ok).toBe(false);
    expect(cleanProblemTags(['a\nb']).ok).toBe(false);
  });

  it('未知顶层字段重写时保留', () => {
    const parsed = parseOk(file({ custom: { keep: 1 } }));
    expect(problemMarksToJson(parsed).custom).toEqual({ keep: 1 });
  });
});

describe('题目快照校验', () => {
  it('最多 40 题；正常别名通过', () => {
    expect(parseProblemSnapshot([{ alias: 'A', title: '' }]).ok).toBe(true);
    expect(parseProblemSnapshot(Array.from({ length: 41 }, (_, i) => ({ alias: `P${i}`, title: '' }))).ok).toBe(false);
  });
});

describe('预填（30 §3.4）', () => {
  it('AC 只填空进度；非 AC、越界、已有进度、prefillApplied 都跳过', () => {
    const base = {
      problems: [
        { alias: 'A', title: '' },
        { alias: 'B', title: '' },
        { alias: 'C', title: '' },
        { alias: 'D', title: '' },
      ],
      marks: {
        B: mark({ progress: 'todo' }),
        C: mark({ star: true, tags: ['dp'] }),
        D: mark({ progress: 'contest-ac' }),
      },
      prefillApplied: ['D'],
    };
    const out = prefillProblemMarks(
      base,
      [
        { p: 0, r: 'AC' },
        { p: 1, r: 'AC' },
        { p: 2, r: 'AC' },
        { p: 3, r: 'AC' },
        { p: 9, r: 'AC' },
        { p: 0, r: 'WA' },
      ],
      '2026-10-30T13:00:00.000Z',
    );
    expect(out.marks.A!.progress).toBe('contest-ac');
    expect(out.marks.B!.progress).toBe('todo');
    expect(out.marks.C).toMatchObject({ progress: 'contest-ac', star: true, tags: ['dp'] });
    expect(out.prefillApplied).toEqual(['D', 'A', 'C']);
    expect(out.changed).toBe(true);
  });

  it('重复调用幂等；清空后不再填回', () => {
    const first = prefillProblemMarks({ problems: [{ alias: 'A', title: '' }], marks: {}, prefillApplied: [] }, [{ p: 0, r: 'AC' }], 'x');
    const second = prefillProblemMarks(
      { problems: [{ alias: 'A', title: '' }], marks: first.marks, prefillApplied: first.prefillApplied },
      [{ p: 0, r: 'AC' }],
      'x',
    );
    expect(second.changed).toBe(false);
    const cleared = prefillProblemMarks(
      { problems: [{ alias: 'A', title: '' }], marks: {}, prefillApplied: first.prefillApplied },
      [{ p: 0, r: 'AC' }],
      'x',
    );
    expect(cleared.marks.A).toBeUndefined();
    expect(cleared.changed).toBe(false);
  });
});

describe('汇总与标签补全（30 §3.5 / §4.1）', () => {
  it('未标记不计数；星标-only 计入 marked 与 starred、不计 todo', () => {
    const summary = problemMarkSummaryOf({
      problems: [{ alias: 'A', title: '' }, { alias: 'B', title: '' }, { alias: 'C', title: '' }],
      marks: {
        A: mark({ progress: 'todo' }),
        B: mark({ star: true }),
        C: mark({ tags: ['dp'] }),
      },
    });
    expect(summary).toEqual({ total: 3, marked: 3, todo: 1, starred: 1 });
    expect(problemMarkSummaryOf({ problems: [{ alias: 'A', title: '' }, { alias: 'B', title: '' }], marks: {} })).toEqual({
      total: 2,
      marked: 0,
      todo: 0,
      starred: 0,
    });
  });

  it('标签补全按次数降序再字母序，最多 200', () => {
    const tags = collectProblemTags([
      { marks: { A: mark({ tags: ['dp', '图论'] }) } },
      { marks: { A: mark({ tags: ['dp', 'bfs'] }) } },
      { marks: { A: mark({ tags: ['bfs'] }) } },
    ]);
    expect(tags).toEqual(['bfs', 'dp', '图论']);
  });
});

describe('客户端 marks 校验（30 §4.2）', () => {
  const problems = [
    { alias: 'A', title: '' },
    { alias: 'B', title: '' },
  ];

  it('整份替换：空条目丢弃；未知 alias / 非法进度 / 标签超限拒绝', () => {
    expect(parseProblemMarksInput({ A: { progress: null, star: false, tags: [] } }, problems)).toEqual({ ok: true, marks: {} });
    expect(parseProblemMarksInput({ Z: { progress: 'todo', star: false, tags: [] } }, problems).ok).toBe(false);
    expect(parseProblemMarksInput({ A: { progress: 'done', star: false, tags: [] } }, problems).ok).toBe(false);
    expect(parseProblemMarksInput({ A: { progress: 'todo', star: true, tags: ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9'] } }, problems).ok).toBe(false);
    const ok = parseProblemMarksInput({ A: { progress: 'todo', star: true, tags: ['dp'] } }, problems);
    expect(ok).toEqual({ ok: true, marks: { A: { progress: 'todo', star: true, tags: ['dp'] } } });
  });
});
describe('原型键收口（30 §5）', () => {
  it('外来 __proto__ 条目：不污染原型，重写时原样保留', () => {
    const raw = JSON.parse(
      `{"schema":1,"arenaPath":"${ARENA}","problems":[{"alias":"A","title":""}],"marks":{"__proto__":{"progress":"todo","star":false,"tags":[],"updatedAt":"2026-10-30T12:00:00.000Z"},"Z":{"progress":"todo","star":false,"tags":[],"updatedAt":"2026-10-30T12:00:00.000Z"}},"prefillApplied":[]}`,
    );
    const parsed = parseProblemMarksFile(raw, ARENA);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(Object.getPrototypeOf(parsed.file.foreignMarks)).toBeNull();
    expect(Object.hasOwn(parsed.file.foreignMarks, '__proto__')).toBe(true);
    expect(parsed.file.unreadableMarks).toBe(2);

    const text = JSON.stringify(problemMarksToJson(parsed.file));
    expect(text).toContain('"__proto__"');
    const back = JSON.parse(text) as { marks: Record<string, unknown> };
    expect(Object.hasOwn(back.marks, '__proto__')).toBe(true);
  });

  it('alias 为 toString / valueOf：预填、重写、整份输入都不崩', () => {
    const problems = [
      { alias: 'toString', title: 'T' },
      { alias: 'valueOf', title: 'V' },
    ];
    const file: ProblemMarksFile = {
      schema: 1,
      arenaPath: ARENA,
      problems,
      marks: Object.create(null) as Record<string, never>,
      foreignMarks: Object.create(null) as Record<string, never>,
      prefillApplied: [],
      raw: {},
      unreadableMarks: 0,
    };
    const filled = prefillProblemMarks(file, [{ p: 0, r: 'AC' }, { p: 1, r: 'AC' }], '2026-10-30T12:00:00.000Z');
    expect(filled.changed).toBe(true);
    expect(filled.marks['toString']?.progress).toBe('contest-ac');
    expect(filled.marks['valueOf']?.progress).toBe('contest-ac');

    const text = JSON.stringify(
      problemMarksToJson({ ...file, marks: filled.marks, prefillApplied: filled.prefillApplied }),
    );
    expect(text).toContain('"toString"');
    expect(text).toContain('"valueOf"');
    expect(parseProblemMarksInput({ toString: { progress: 'todo', star: false, tags: [] } }, problems).ok).toBe(true);
  });
});
