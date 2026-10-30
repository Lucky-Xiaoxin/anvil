/** 工坊错误：kind 是契约 §9.2 的错误码，status 是它对外的 HTTP 状态 */
export type WorkErrorKind =
  | 'workspace-unconfigured'
  | 'workspace-uninitialized'
  | 'root-invalid'
  | 'root-missing'
  | 'root-not-empty'
  | 'root-version'
  | 'invalid'
  | 'not-found'
  | 'conflict'
  | 'problem-set-mismatch'
  | 'unsafe-path'
  | 'path-occupied'
  | 'parent-missing'
  | 'editor-unavailable'
  | 'import-source-invalid'
  | 'import-limit'
  | 'import-plan-expired'
  | 'import-root-changed'
  | 'import-source-changed'
  | 'import-conflict'
  | 'internal';

const STATUS: Record<WorkErrorKind, number> = {
  'workspace-unconfigured': 409,
  'workspace-uninitialized': 409,
  'root-invalid': 400,
  'root-missing': 409,
  'root-not-empty': 409,
  'root-version': 409,
  invalid: 400,
  'not-found': 404,
  conflict: 409,
  'problem-set-mismatch': 409,
  'unsafe-path': 400,
  'path-occupied': 409,
  'parent-missing': 409,
  'editor-unavailable': 502,
  'import-source-invalid': 400,
  'import-limit': 400,
  'import-plan-expired': 409,
  'import-root-changed': 409,
  'import-source-changed': 409,
  'import-conflict': 400,
  internal: 500,
};

export class WorkError extends Error {
  readonly kind: WorkErrorKind;
  readonly status: number;
  /** root-not-empty 用：根目录里已有多少项（按忽略规则统计） */
  readonly entries?: number;

  constructor(kind: WorkErrorKind, message: string, entries?: number) {
    super(message);
    this.name = 'WorkError';
    this.kind = kind;
    this.status = STATUS[kind];
    this.entries = entries;
  }
}
