import { useState } from 'react';
import type { WorkTaxonomyDto } from '@anvil/shared';
import { Icon } from '../ui.tsx';

interface Props {
  taxonomy: WorkTaxonomyDto | null;
  error: string | null;
  selected: string | null;
  onSelect: (id: string | null) => void;
}

export function TagTree({ taxonomy, error, selected, onSelect }: Props) {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const toggle = (id: string): void => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (error !== null) {
    return (
      <div className="wk-note wk-note--bad">
        词表不可用：{error}
        <br />
        对象照常列出，标签编辑已禁用。
      </div>
    );
  }
  if (taxonomy === null) return <div className="wk-note">还没有词表。初始化工作区后会写入种子词表。</div>;

  return (
    <div className="wk-tree">
      {selected !== null ? (
        <button className="wk-tree__clear" onClick={() => onSelect(null)}>
          清除标签筛选
        </button>
      ) : null}
      {taxonomy.nodes.map((node) => {
        const children = node.children ?? [];
        const isOpen = open.has(node.id);
        return (
          <div key={node.id} className="wk-tree__group">
            <div className={`wk-tree__row${selected === node.id ? ' is-on' : ''}`}>
              {children.length > 0 ? (
                <button
                  className={`wk-tree__chev${isOpen ? ' is-open' : ''}`}
                  aria-label={isOpen ? '收起' : '展开'}
                  aria-expanded={isOpen}
                  onClick={() => toggle(node.id)}
                >
                  <Icon id="i-chev" />
                </button>
              ) : (
                <span className="wk-tree__chev wk-tree__chev--none" />
              )}
              <button className="wk-tree__name" onClick={() => onSelect(selected === node.id ? null : node.id)}>
                <span>{node.name}</span>
                <b className="num">{node.count}</b>
              </button>
            </div>
            {isOpen
              ? children.map((child) => (
                  <div key={child.id} className={`wk-tree__row wk-tree__row--child${selected === child.id ? ' is-on' : ''}`}>
                    <span className="wk-tree__chev wk-tree__chev--none" />
                    <button className="wk-tree__name" onClick={() => onSelect(selected === child.id ? null : child.id)}>
                      <span>{child.name}</span>
                      <b className="num">{child.count}</b>
                    </button>
                  </div>
                ))
              : null}
          </div>
        );
      })}
    </div>
  );
}
