/**
 * 主题 hook
 *
 * 负责读取 / 同步「浅色 / 深色」主题：
 *  - 读取 localStorage('dm_theme')，值取 'dark' | 'light'；
 *  - 缺省时回退到系统 prefers-color-scheme；
 *  - 通过设置 document.documentElement 的 data-theme 属性驱动 CSS 变量换肤；
 *  - 切换后即时写入 localStorage，并同步更新各端。
 */
import { useCallback, useEffect, useState } from 'react';

/** 主题类型 */
export type Theme = 'dark' | 'light';

/** localStorage 存储键名 */
const STORAGE_KEY = 'dm_theme';

/**
 * 读取系统偏好主题
 * @returns 系统偏好对应的主题
 */
function getSystemTheme(): Theme {
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return 'light';
}

/**
 * 解析主题：优先本地存储，其次回退到系统偏好
 * @returns 当前主题
 */
function resolveTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'dark' || stored === 'light') return stored;
  } catch {
    // 忽略 localStorage 不可用的情况
  }
  return getSystemTheme();
}

/**
 * 应用主题：写入根元素的 data-theme 属性
 * @param theme 目标主题
 */
function applyTheme(theme: Theme) {
  document.documentElement.setAttribute('data-theme', theme);
}

/**
 * 主题切换 hook
 * @returns 当前主题、切换方法与设置方法
 */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(resolveTheme);

  // 挂载时应用主题；主题变化时同步更新属性与本地存储
  useEffect(() => {
    applyTheme(theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // 忽略 localStorage 写入失败
    }
  }, [theme]);

  /**
   * 在浅色 / 深色之间切换
   */
  const toggleTheme = useCallback(() => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  }, []);

  /**
   * 设置指定主题
   * @param next 目标主题
   */
  const setThemeValue = useCallback((next: Theme) => {
    setTheme(next);
  }, []);

  return { theme, toggleTheme, setTheme: setThemeValue };
}
