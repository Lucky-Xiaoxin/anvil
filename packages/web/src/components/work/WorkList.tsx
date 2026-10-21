import type { WorkObjectDto, WorkScanErrorDto, WorkTaxonomyDto, WorkTrashDto, WorkUnregisteredDto } from '@anvil/shared';
import { fmtInt } from '../../format.ts';
import { Icon } from '../ui.tsx';
import { KIND_NAME, isoDate, primaryName } from './derive.ts';

interface Props {
  objects: WorkObjectDto[];
  taxonomy: WorkTaxonomyDto | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  unregistered: WorkUnregisteredDto[];
  errors: WorkScanErrorDto[];
  trash: WorkTrashDto[];
  trashView: boolean;
  onAdopt: (item: WorkUnregisteredDto) => void;
  onRestore: (id: string) => void;
  busyId: string | null;
}

const ERROR_NAME: Record<WorkScanErrorDto['kind'], string> = {
  'meta-invalid': 'meta 不合法',
  'parent-missing': '父对象缺失',
  'tag-missing': '标签悬空',
  symlink: '符号链接',
  scan: '读取失败',
};

export function WorkList(props: Props) {
  const { objects, taxonomy, selectedId, trashView, trash, unregistered, errors } = props;

  if (trashView) {
    return (
      <div className="wk-list">
        <div className="wk-sec__title">
          <span>回收站</span>
          <b className="num">{trash.length}</b>
        </div>
        {trash.length === 0 ? (
          <div className="wk-empty">回收站是空的。</div>
        ) : (
          trash.map((item) => (
            <div className="wk-row wk-row--trash" key={`${item.id}-${item.trashedAt}`}>
              <div className="wk-row__main">
                <div className="wk-row__title">{item.title}</div>
                <div className="wk-row__meta">
                  <span>{isoDate(item.trashedAt)}</span>
                  <span className="wk-dot" />
                  <code>{item.originalRelPath}</code>
                </div>
              </div>
              <button className="btn btn--sm" disabled={props.busyId !== null} onClick={() => props.onRestore(item.id)}>
                恢复
              </button>
            </div>
          ))
        )}
        <p className="wk-hint">恢复按原路径移回；原路径被占或父目录缺失时会拒绝，不会自动改名。</p>
      </div>
    );
  }

  return (
    <div className="wk-list">
      <div className="wk-sec__title">
        <span>对象</span>
        <b className="num">{objects.length}</b>
      </div>
      {objects.length === 0 ? (
        <div className="wk-empty">没有符合条件的对象。换个筛选，或新建一个。</div>
      ) : (
        objects.map((obj) => (
          <button
            key={obj.id}
            className={`wk-row${selectedId === obj.id ? ' is-on' : ''}`}
            aria-current={selectedId === obj.id ? 'true' : undefined}
            onClick={() => props.onSelect(obj.id)}
          >
            <div className="wk-row__main">
              <div className="wk-row__title">
                {obj.title}
                {obj.effectiveArchived ? <span className="wk-badge">归档</span> : null}
              </div>
              <div className="wk-row__meta">
                <span className="wk-kind">{KIND_NAME[obj.kind]}</span>
                <span>{isoDate(obj.createdAt)}</span>
                {primaryName(obj, taxonomy) !== null ? (
                  <>
                    <span className="wk-dot" />
                    <span className="wk-row__tag">{primaryName(obj, taxonomy)}</span>
                  </>
                ) : null}
                <span className="wk-dot" />
                <span>{fmtInt(obj.fileCount)} 个文件</span>
              </div>
            </div>
            {obj.labels.length > 0 ? (
              <span className="wk-row__labels">
                {obj.labels.slice(0, 3).map((label) => (
                  <span className="wk-chip" key={label}>
                    {label}
                  </span>
                ))}
              </span>
            ) : null}
          </button>
        ))
      )}

      {unregistered.length > 0 ? (
        <div className="wk-sec">
          <div className="wk-sec__title">
            <span>未登记</span>
            <b className="num">{unregistered.length}</b>
          </div>
          {unregistered.map((item) => (
            <div className="wk-row wk-row--mini" key={item.relPath}>
              <div className="wk-row__main">
                <div className="wk-row__title">
                  <code>{item.relPath}</code>
                </div>
                <div className="wk-row__meta">
                  <span>推断：{item.kindHint === null ? '未定' : KIND_NAME[item.kindHint]}</span>
                </div>
              </div>
              <button className="btn btn--xs" disabled={props.busyId !== null} onClick={() => props.onAdopt(item)}>
                <Icon id="i-plus" />
                登记
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {errors.length > 0 ? (
        <div className="wk-sec">
          <div className="wk-sec__title">
            <span>错误</span>
            <b className="num">{errors.length}</b>
          </div>
          {errors.map((err, i) => (
            <div className="wk-error" key={`${err.relPath}-${err.kind}-${i}`}>
              <span className="wk-error__kind">{ERROR_NAME[err.kind]}</span>
              <code>{err.relPath === '' ? '（根）' : err.relPath}</code>
              <span className="wk-error__msg">{err.message}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
