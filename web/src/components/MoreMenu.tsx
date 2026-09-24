/**
 * 行内"更多操作"下拉菜单（1.67.0）
 *
 * 表格操作列收纳辅助入口：主行只保留高频操作，其余按语义分组收入本菜单，
 * 交互机制与 StateActions 一致（fixed 定位 / 外点关闭 / ESC / 滚动关闭 / sticky 提升）。
 */
import React, { useEffect, useRef, useState } from 'react';
import { useLang } from '../i18n';
import './MoreMenu.less';

export interface MoreMenuItem {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** 危险操作（红色文案） */
  danger?: boolean;
  /** 渲染为分组标题（该条仅作为分隔与组名，不可点击） */
  group?: boolean;
  /** 悬停提示 */
  title?: string;
}

export default function MoreMenu({ items, disabled }: { items: MoreMenuItem[]; disabled?: boolean }) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top?: number; bottom?: number; left?: number; right?: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  function toggle() {
    if (!open && ref.current) {
      const rect = ref.current.getBoundingClientRect();
      // 预估菜单高度（与 .more-menu__panel 的 max-height:60vh 上限一致）
      const estH = Math.min(items.length * 33 + 12, window.innerHeight * 0.6);
      const pos: { top?: number; bottom?: number; left?: number; right?: number } = { top: rect.bottom + 4, left: rect.left };
      // 靠近视口右缘时改为右对齐展开，避免菜单溢出屏幕
      if (rect.left + 160 > window.innerWidth) {
        pos.left = undefined;
        pos.right = Math.max(0, window.innerWidth - rect.right);
      }
      // 靠近视口底部时改为向上展开，避免菜单被页面底部裁掉（1.89.1）
      if (window.innerHeight - rect.bottom < estH + 8) {
        delete pos.top;
        pos.bottom = window.innerHeight - rect.top + 4;
      }
      setMenuPos(pos);
    }
    setOpen(!open);
  }

  useEffect(() => {
    if (!open) return;
    const td = ref.current?.closest('td');
    const prev = td?.style.zIndex ?? '';
    if (td) td.style.zIndex = '60';
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onScroll = () => setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      if (td) td.style.zIndex = prev;
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open]);

  return (
    <div className="more-menu" ref={ref}>
      <button type="button" className={`more-menu__trigger${open ? ' is-open' : ''}`} onClick={toggle} disabled={!!disabled}>
        {t('更多')}
        <span className="more-menu__caret" />
      </button>
      {open && menuPos && (
        <div
          className="more-menu__panel"
          style={{
            top: menuPos.top ?? 'auto',
            bottom: menuPos.bottom ?? 'auto',
            left: menuPos.left ?? 'auto',
            right: menuPos.right ?? 'auto',
          }}
        >
          {items.map((it, idx) =>
            it.group ? (
              <div key={idx} className="more-menu__group">
                {it.label}
              </div>
            ) : it.disabled ? (
              <button
                key={idx}
                type="button"
                className={`more-menu__item more-menu__item--disabled${it.danger ? ' more-menu__item--danger' : ''}`}
                disabled
              >
                {it.label}
              </button>
            ) : (
              <button
                key={idx}
                type="button"
                className={`more-menu__item${it.danger ? ' more-menu__item--danger' : ''}`}
                title={it.title}
                onClick={() => {
                  setOpen(false);
                  it.onClick();
                }}
              >
                {it.label}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}
