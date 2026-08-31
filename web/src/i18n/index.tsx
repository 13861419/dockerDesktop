/**
 * 轻量 i18n（零依赖，gettext 风格）
 *
 * 设计要点：
 * - 中文原文即 key：t('容器') 在英文包有映射时返回英文，否则回退中文原文；
 *   因此未迁移页面零影响，已迁移页面只需包裹 t() 并维护 en 字典。
 * - 少量多义/上下文场景使用语义键（如 'nav.settings'），en 与 zh 字典同时登记。
 * - 语言偏好持久化到 localStorage（dm.lang），默认 zh，切换即时生效（Context 触发重渲染）。
 */
import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { en } from './en';
import { zh } from './zh';

export type Lang = 'zh' | 'en';

const STORAGE_KEY = 'dm.lang';

function initialLang(): Lang {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'en' || v === 'zh') return v;
  } catch {
    // 隐私模式等场景读取失败时使用默认语言
  }
  return 'zh';
}

export type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** 模块级当前语言：供非 React 上下文（如工具函数）使用，Provider 初始化与切换时同步 */
let activeLang: Lang = initialLang();

/**
 * 独立于 React 树的翻译函数（语言切换后新调用即时生效，但不触发重渲染）
 */
export function translateNow(key: string, vars?: Record<string, string | number>): string {
  return translate(activeLang, key, vars);
}

interface I18nCtx {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: Translate;
}

const Ctx = createContext<I18nCtx>({
  lang: 'zh',
  setLang: () => {},
  t: (k) => k,
});

/**
 * 翻译查找顺序：
 * - en：en[key] → zh[key]（语义键兜底）→ key 本身（中文原文即兜底）
 * - zh：zh[key]（仅语义键需要）→ key 本身
 */
function translate(lang: Lang, key: string, vars?: Record<string, string | number>): string {
  let s: string;
  if (lang === 'en') {
    s = en[key] ?? zh[key] ?? key;
  } else {
    s = zh[key] ?? key;
  }
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.split(`{{${k}}}`).join(String(v));
    }
  }
  return s;
}

/** i18n 提供者：包裹应用根节点，切换语言时触发整树重渲染 */
export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);

  const setLang = useCallback((l: Lang) => {
    activeLang = l;
    setLangState(l);
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      // 持久化失败不阻塞切换
    }
    try {
      document.documentElement.lang = l === 'zh' ? 'zh-CN' : 'en';
    } catch {
      // 非浏览器环境忽略
    }
  }, []);

  const t = useCallback<Translate>(
    (key, vars) => translate(lang, key, vars),
    [lang]
  );

  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** 获取语言状态与翻译函数 */
export function useLang() {
  return useContext(Ctx);
}
