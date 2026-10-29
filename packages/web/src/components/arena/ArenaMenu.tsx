/**
 * 回放顶栏「更多」菜单（docs/contracts/29 §6.1.1）：触发器带可见文字，
 * 菜单支持 Tab / Enter 展开、方向键移动、Escape 关闭并归还焦点。
 */
import { useEffect, useRef, useState } from 'react';

export interface ArenaMenuItem {
  key: string;
  label: string;
  meta?: string;
  disabled?: boolean;
  danger?: boolean;
  onSelect: () => void;
}

export function ArenaMenu({ items }: { items: ArenaMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const itemsRef = useRef<Array<HTMLButtonElement | null>>([]);

  const close = (restoreFocus = false): void => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };

  const openMenu = (index: number): void => {
    const enabled = items.map((item, i) => (item.disabled === true ? -1 : i)).filter((i) => i >= 0);
    const target = enabled.includes(index) ? index : enabled[0] ?? -1;
    setOpen(true);
    requestAnimationFrame(() => {
      if (target >= 0) itemsRef.current[target]?.focus();
    });
  };

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent): void => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) === true || triggerRef.current?.contains(target) === true) return;
      close();
    };
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
  }, [open]);

  const onMenuKey = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const enabled = items.map((item, i) => (item.disabled === true ? -1 : i)).filter((i) => i >= 0);
    if (enabled.length === 0) return;
    const at = enabled.indexOf(items.findIndex((_, i) => itemsRef.current[i] === document.activeElement));
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
      return;
    }
    if (e.key === 'Tab') {
      // 让 Tab 正常离开：关闭菜单并把焦点交还触发器，随后浏览器继续走下一个可聚焦元素
      close(true);
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      let next: number;
      if (e.key === 'Home') next = enabled[0]!;
      else if (e.key === 'End') next = enabled[enabled.length - 1]!;
      else if (e.key === 'ArrowDown') next = enabled[(at + 1) % enabled.length]!;
      else next = enabled[(at - 1 + enabled.length) % enabled.length]!;
      itemsRef.current[next]?.focus();
    }
  };

  return (
    <span className="arena-more">
      <button
        ref={triggerRef}
        type="button"
        className="btn btn--sm btn--ghost arena-more__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        title="更多操作"
        onClick={() => (open ? close() : openMenu(-1))}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
            if (!open) {
              e.preventDefault();
              openMenu(-1);
            }
          }
        }}
      >
        <span aria-hidden="true" className="arena-more__dots">⋯</span>
        更多
      </button>
      {open ? (
        <div ref={menuRef} className="arena-menu" role="menu" aria-label="更多操作" onKeyDown={onMenuKey}>
          {items.map((item, i) => (
            <button
              key={item.key}
              ref={(el) => {
                itemsRef.current[i] = el;
              }}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className={`arena-menu__item${item.danger === true ? ' is-danger' : ''}`}
              disabled={item.disabled === true}
              onClick={() => {
                close(true);
                item.onSelect();
              }}
            >
              <span className="arena-menu__label">{item.label}</span>
              {item.meta !== undefined ? <span className="arena-menu__meta">{item.meta}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </span>
  );
}
