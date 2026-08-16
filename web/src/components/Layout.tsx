/**
 * 主布局组件
 *
 * 浅色侧边栏 + 顶栏 + 内容区，使用 React Router 的 NavLink 实现导航。
 */
import React from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useToast } from './Toast';
import { post } from '../api/client';
import { clearToken, isAdmin } from '../api/auth';
import './Layout.less';

interface NavItem {
  to: string;
  label: string;
  icon: React.ReactNode;
  end?: boolean;
  /** 标记为 true 时该菜单仅对管理员显示（配合路由级守卫） */
  adminOnly?: boolean;
}

const iconProps = {
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

const NAV_ITEMS: NavItem[] = [
  {
    to: '/',
    label: '总览',
    end: true,
    icon: (
      <svg {...iconProps}>
        <rect x="3" y="3" width="7" height="9" rx="1" />
        <rect x="14" y="3" width="7" height="5" rx="1" />
        <rect x="14" y="12" width="7" height="9" rx="1" />
        <rect x="3" y="16" width="7" height="5" rx="1" />
      </svg>
    ),
  },
  {
    to: '/containers',
    label: '容器',
    icon: (
      <svg {...iconProps}>
        <rect x="3" y="4" width="18" height="13" rx="2" />
        <path d="M8 21h8M12 17v4" />
      </svg>
    ),
  },
  {
    to: '/images',
    label: '镜像',
    icon: (
      <svg {...iconProps}>
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="9" cy="9" r="2" />
        <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
      </svg>
    ),
  },
  {
    to: '/build',
    label: '构建镜像',
    adminOnly: true,
    icon: (
      <svg {...iconProps}>
        <polygon points="3 11 3 21 14 21 11 11 3 11" />
        <rect x="3" y="3" width="7" height="4" />
      </svg>
    ),
  },
  {
    to: '/volumes',
    label: '数据卷',
    icon: (
      <svg {...iconProps}>
        <path d="M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3Z" />
        <path d="M4 7v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7" />
        <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
      </svg>
    ),
  },
  {
    to: '/storage',
    label: '存储',
    icon: (
      <svg {...iconProps}>
        <rect x="3" y="3" width="18" height="8" rx="2" />
        <rect x="3" y="13" width="18" height="8" rx="2" />
        <path d="M7 7h.01M7 17h.01" />
      </svg>
    ),
  },
  {
    to: '/networks',
    label: '网络',
    icon: (
      <svg {...iconProps}>
        <circle cx="12" cy="5" r="2.5" />
        <circle cx="5" cy="19" r="2.5" />
        <circle cx="19" cy="19" r="2.5" />
        <path d="M10.5 6.5 6.5 17M13.5 6.5l4 10.5M7.5 19h9" />
      </svg>
    ),
  },
  {
    to: '/compose',
    label: 'Compose',
    icon: (
      <svg {...iconProps}>
        <path d="M4 5h16v10H4z" />
        <path d="M2 15h20v-2H2zM3 13l3-6M21 13l-3-6M9 13l3-6M15 13l-3-6" />
        <path d="M7 13v-3h10v3" />
      </svg>
    ),
  },
  {
    to: '/appstore',
    label: '应用商店',
    icon: (
      <svg {...iconProps}>
        <path d="M20 6 9 17l-5-5" />
        <path d="M21 12a9 9 0 1 1-9-9" />
        <path d="M15 3h6v6" />
      </svg>
    ),
  },
  {
    to: '/tasks',
    label: '计划任务',
    icon: (
      <svg {...iconProps}>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </svg>
    ),
  },
  {
    to: '/files',
    label: '文件管理',
    icon: (
      <svg {...iconProps}>
        <path d="M4 19V5c0-1 1-2 2-2h4l2 2h6c1 0 2 1 2 2v12" />
        <path d="M2 19h20" />
      </svg>
    ),
  },
  {
    to: '/hostfiles',
    label: '宿主机文件',
    icon: (
      <svg {...iconProps}>
        <rect x="3" y="4" width="18" height="4" rx="1" />
        <path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8" />
        <path d="M12 8v8M8 12l4-4 4 4" />
      </svg>
    ),
  },
  {
    to: '/hostterminal',
    label: '宿主机终端',
    icon: (
      <svg {...iconProps}>
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="m7 9 3 3-3 3M13 15h4" />
      </svg>
    ),
  },
  {
    to: '/engines',
    label: 'Docker 引擎',
    adminOnly: true,
    icon: (
      <svg {...iconProps}>
        <path d="M10 17h.01M14 17h.01M6 17h.01M4 17h.01M18 13h.01M20 9h.01M16 5h.01" />
        <rect x="3" y="3" width="18" height="14" rx="2" />
        <path d="M4 7h16M4 10h16" />
      </svg>
    ),
  },
  {
    to: '/cloudbackup',
    label: '云端备份',
    adminOnly: true,
    icon: (
      <svg {...iconProps}>
        <path d="M17.5 19a4.5 4.5 0 1 0-.42-8.98A5 5 0 0 0 7 11a3.5 3.5 0 0 0-.5 6.97" />
        <path d="M12 19v-8M8 15l4 4 4-4" />
      </svg>
    ),
  },
  {
    to: '/backups',
    label: '备份恢复',
    icon: (
      <svg {...iconProps}>
        <rect x="3" y="4" width="18" height="5" rx="1" />
        <path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9" />
        <path d="M10 13h4" />
      </svg>
    ),
  },
  {
    to: '/databases',
    label: '数据库',
    icon: (
      <svg {...iconProps}>
        <ellipse cx="12" cy="5" rx="8" ry="3" />
        <path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
        <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
      </svg>
    ),
  },
  {
    to: '/settings',
    label: '设置',
    icon: (
      <svg {...iconProps}>
        <path d="M19.4 13a7.9 7.9 0 0 0 .1-1 7.9 7.9 0 0 0-.1-1l2.1-1.6a.5.5 0 0 0 .1-.6l-2-3.5a.5.5 0 0 0-.6-.2l-2.5 1a7.7 7.7 0 0 0-1.7-1l-.4-2.7a.5.5 0 0 0-.5-.4h-4a.5.5 0 0 0-.5.4l-.4 2.7a7.7 7.7 0 0 0-1.7 1l-2.5-1a.5.5 0 0 0-.6.2l-2 3.5a.5.5 0 0 0 .1.6L5 11a8 8 0 0 0 0 2l-2.1 1.6a.5.5 0 0 0-.1.6l2 3.5a.5.5 0 0 0 .6.2l2.5-1a7.7 7.7 0 0 0 1.7 1l.4 2.7a.5.5 0 0 0 .5.4h4a.5.5 0 0 0 .5-.4l.4-2.7a7.7 7.7 0 0 0 1.7-1l2.5 1a.5.5 0 0 0 .6-.2l2-3.5a.5.5 0 0 0-.1-.6z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    ),
  },
  {
    to: '/hub',
    label: '镜像中心',
    icon: (
      <svg {...iconProps}>
        <path d="M3 7a3 3 0 0 1 3-3h4c1.1 0 2 .9 2 2v3c0 1.1-.9 2-2 2H6a3 3 0 0 1-3-3V7Z" />
        <path d="M3 7v5a3 3 0 0 0 3 3h4c1.1 0 2-.9 2-2V9a2 2 0 0 0-2-2H6z" />
        <path d="M13 9a2 2 0 0 1 1-1.7 3 3 0 0 1 4.5 3 3 3 0 0 1 1 5.8 2.5 2.5 0 0 1-3.5 3.2" />
        <path d="M13 17h6" />
        <path d="M3 17h7" />
      </svg>
    ),
  },
  {
    to: '/operation-logs',
    label: '操作日志',
    icon: (
      <svg {...iconProps}>
        <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.7 21a2 2 0 0 1-3.4 0" />
      </svg>
    ),
  },
  {
    to: '/notifications',
    label: '告警中心',
    adminOnly: true,
    icon: (
      <svg {...iconProps}>
        <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
        <path d="M12 9v4M12 17h.01" />
      </svg>
    ),
  },
  {
    to: '/events',
    label: '事件流',
    icon: (
      <svg {...iconProps}>
        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
      </svg>
    ),
  },
  {
    to: '/sites',
    label: '站点反代',
    adminOnly: true,
    icon: (
      <svg {...iconProps}>
        <path d="M9 3h6l1 5H8z" />
        <path d="M8 8c0 4 2 7 4 9 2-2 4-5 4-9M8 8h8" />
        <path d="M12 17V3" />
      </svg>
    ),
  },
  {
    to: '/firewall',
    label: '防火墙',
    adminOnly: true,
    icon: (
      <svg {...iconProps}>
        <path d="M12 3c4 2.5 6 6 6 9a6 6 0 0 1-12 0c0-3 2-6.5 6-9Z" />
        <path d="M9.5 13.5 11 15l2.5-3" />
      </svg>
    ),
  },
];

/**
 * 主布局
 */
export default function Layout() {
  const { showToast } = useToast();
  const navigate = useNavigate();

  // 当前用户是否为管理员：非管理员时过滤掉仅管理员的菜单项（隐藏入口）
  const admin = isAdmin();
  const visibleNav = NAV_ITEMS.filter((item) => !item.adminOnly || admin);

  /**
   * 退出登录：通知后端登出、清除本地 token 并跳转登录页
   */
  async function handleLogout() {
    try {
      // 携带当前 token 调用登出接口，失败时也继续本地清理
      await post('/api/auth/logout');
    } catch {
      // 忽略登出接口错误，确保本地清理与跳转始终执行
    }
    clearToken();
    showToast('已退出登录', 'info');
    navigate('/login', { replace: true });
  }

  return (
    <div className="layout">
      {/* 侧边栏 */}
      <aside className="sidebar">
        <div className="sidebar__brand">
          <div className="sidebar__logo">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3Z" />
              <path d="M4 7v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7" />
              <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
            </svg>
          </div>
          <div className="sidebar__title">
            <span className="sidebar__name">Docker</span>
            <span className="sidebar__sub">管理面板</span>
          </div>
        </div>

        <nav className="sidebar__nav">
          {visibleNav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => `nav-item ${isActive ? 'nav-item--active' : ''}`}
            >
              <span className="nav-item__icon">{item.icon}</span>
              <span className="nav-item__label">{item.label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="sidebar__footer">
          <div className="sidebar__conn">
            <button
              className="nav-item"
              onClick={() => showToast('Docker 连接正常', 'info')}
              title="连接状态"
            >
              <span className="nav-item__icon">
                <span className="conn-dot" />
              </span>
              <span className="nav-item__label">已连接</span>
            </button>
          </div>
          <button className="nav-item nav-item--logout" onClick={handleLogout} title="退出登录">
            <span className="nav-item__icon">
              <svg {...iconProps}>
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <path d="m16 17 5-5-5-5M21 12H9" />
              </svg>
            </span>
            <span className="nav-item__label">退出登录</span>
          </button>
        </div>
      </aside>

      {/* 主内容区 */}
      <main className="main">
        <div className="main__content">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
