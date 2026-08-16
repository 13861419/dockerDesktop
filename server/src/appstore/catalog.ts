/**
 * 应用商店应用目录
 *
 * 内置常用应用的静态元数据目录。由于项目无业务数据库，所有应用数据均来源于
 * 本目录定义，容器安装状态则通过容器 label 与 Docker 引擎关联。
 *
 * 自「应用商店支持用户自定义应用」起，应用集合由「内置目录 + 数据库自定义应用」合并：
 *  - APP_CATALOG 仍为内置静态数组（保持不变）
 *  - loadCustomApps() 从 appstore_custom_apps 表读取用户自定义应用
 *  - getAllApps() 合并两者作为对外统一的应用集合
 *  - findApp() 优先在内置查找，找不到再查自定义
 */

import { getDb } from '../storage';

/** 应用标签键：用于在容器上标记所属应用 id */
export const APP_LABEL_KEY = 'com.dockermanager.app';

/** 自定义应用 id 前缀：用于区分内置应用与该前缀下的用户自定义应用 */
export const CUSTOM_APP_PREFIX = 'custom-';

/** 端口映射定义 */
export interface AppPort {
  /** 容器内部端口 */
  container: number;
  /** 宿主机端口（未指定时默认使用与容器相同的端口） */
  host?: number;
}

/** 环境变量定义 */
export interface AppEnv {
  /** 环境变量键 */
  key: string;
  /** 环境变量值（未指定时使用内置默认值） */
  value?: string;
  /** 环境变量说明 */
  desc?: string;
}

/** 挂载卷定义 */
export interface AppVolume {
  /** 容器内挂载点 */
  container: string;
  /** 宿主机路径或命名卷（未指定时自动生成命名卷） */
  host?: string;
}

/**
 * Compose 套件定义（多容器编排应用）
 *
 * 当应用定义了本字段时，其安装不走"单容器 + label"，而是：
 *  - 把 compose 模板写入 Compose 项目目录（复用 routes/compose.ts 的逻辑）
 *  - 用 docker compose up -d 一键部署整套服务
 *  - 通过 appstore_instances 记录安装实例，支持升级/参数修改。
 */
export interface AppComposeDef {
  /** compose 文件模板内容（支持 ${VAR} 占位符，安装时被 env 覆盖替换） */
  compose: string;
  /** 需要在前端展示的服务名列表 */
  services: string[];
  /** 需要展示/可覆盖的端口（汇总） */
  ports: AppPort[];
  /** 需要展示/可覆盖的环境变量（映射到 compose 占位符） */
  env: AppEnv[];
  /** 需要展示/可覆盖的卷（汇总） */
  volumes: AppVolume[];
  /** 默认镜像标签版本（用于升级比对展示） */
  defaultVersion?: string;
}

/** 应用定义 */
export interface AppDefinition {
  /** 应用唯一 id */
  id: string;
  /** 应用名称 */
  name: string;
  /** 应用描述 */
  description: string;
  /** 应用分类 */
  category: string;
  /** 镜像名称，如 'nginx:latest' */
  image: string;
  /** 图标的 emoji */
  icon: string;
  /** 端口映射列表 */
  ports?: AppPort[];
  /** 环境变量列表 */
  env?: AppEnv[];
  /** 挂载卷列表 */
  volumes?: AppVolume[];
  /** 标签 */
  tags?: string[];
  /** Compose 套件定义（存在则以多容器编排方式安装） */
  compose?: AppComposeDef;
  /** 是否为用户自定义应用（仅 appstore_custom_apps 表来源的应用有此标记） */
  isCustom?: boolean;
}

/** 内置应用目录 */
export const APP_CATALOG: AppDefinition[] = [
  {
    id: 'nginx',
    name: 'Nginx',
    description: '高性能的 HTTP 与反向代理服务器，常用于静态文件托管与负载均衡',
    category: 'Web 服务器',
    image: 'nginx:latest',
    icon: '🚀',
    ports: [{ container: 80, host: 8080 }],
    tags: ['web', 'proxy', 'http'],
  },
  {
    id: 'redis',
    name: 'Redis',
    description: '开源的内存键值数据库，支持数据结构存储、缓存与消息队列',
    category: '数据库',
    image: 'redis:latest',
    icon: '🔴',
    ports: [{ container: 6379, host: 6379 }],
    tags: ['cache', 'database', 'kv'],
  },
  {
    id: 'mysql',
    name: 'MySQL',
    description: '流行的开源关系型数据库，广泛用于各类业务数据存储',
    category: '数据库',
    image: 'mysql:latest',
    icon: '🐬',
    ports: [{ container: 3306, host: 3306 }],
    env: [
      { key: 'MYSQL_ROOT_PASSWORD', value: 'root123', desc: 'root 用户密码' },
      { key: 'MYSQL_DATABASE', value: 'app', desc: '默认创建的数据库' },
    ],
    volumes: [{ container: '/var/lib/mysql', host: 'dm-mysql-data' }],
    tags: ['database', 'sql'],
  },
  {
    id: 'postgres',
    name: 'PostgreSQL',
    description: '功能强大的开源对象关系型数据库，以稳定与扩展性著称',
    category: '数据库',
    image: 'postgres:latest',
    icon: '🐘',
    ports: [{ container: 5432, host: 5432 }],
    env: [
      { key: 'POSTGRES_PASSWORD', value: 'postgres123', desc: '数据库密码' },
      { key: 'POSTGRES_USER', value: 'postgres', desc: '数据库用户' },
      { key: 'POSTGRES_DB', value: 'app', desc: '默认创建的数据库' },
    ],
    volumes: [{ container: '/var/lib/postgresql/data', host: 'dm-postgres-data' }],
    tags: ['database', 'sql'],
  },
  {
    id: 'mongo',
    name: 'MongoDB',
    description: '面向文档的 NoSQL 数据库，适合灵活多变的数据模型',
    category: '数据库',
    image: 'mongo:latest',
    icon: '🍃',
    ports: [{ container: 27017, host: 27017 }],
    env: [{ key: 'MONGO_INITDB_ROOT_USERNAME', value: 'root', desc: '管理员用户名' }],
    volumes: [{ container: '/data/db', host: 'dm-mongo-data' }],
    tags: ['database', 'nosql'],
  },
  {
    id: 'portainer',
    name: 'Portainer',
    description: '轻量级 Docker 管理面板，提供图形化的容器、镜像与网络管理',
    category: '管理工具',
    image: 'portainer/portainer-ce:latest',
    icon: '🛠️',
    ports: [{ container: 9000, host: 9000 }],
    volumes: [
      { container: '/var/run/docker.sock', host: '/var/run/docker.sock' },
      { container: '/data', host: 'dm-portainer-data' },
    ],
    tags: ['docker', 'panel', 'admin'],
  },
  {
    id: 'adminer',
    name: 'Adminer',
    description: '轻量级的数据库管理工具，支持 MySQL / PostgreSQL / MongoDB 等',
    category: '管理工具',
    image: 'adminer:latest',
    icon: '🗄️',
    ports: [{ container: 8080, host: 8088 }],
    tags: ['database', 'admin', 'tools'],
  },
  {
    id: 'node',
    name: 'Node.js',
    description: 'JavaScript 运行时环境，可用于运行 Node 应用或前端构建任务',
    category: '开发工具',
    image: 'node:lts',
    icon: '🟢',
    ports: [{ container: 3000, host: 3000 }],
    tags: ['runtime', 'javascript', 'dev'],
  },
  {
    id: 'python',
    name: 'Python',
    description: '通用编程语言运行时，适合脚本、数据分析与后端开发',
    category: '开发工具',
    image: 'python:3-slim',
    icon: '🐍',
    ports: [{ container: 8000, host: 8000 }],
    tags: ['runtime', 'python', 'dev'],
  },
  {
    id: 'alpine',
    name: 'Alpine',
    description: '极精简的 Linux 发行版镜像，适合作为基础镜像与调试容器',
    category: '系统工具',
    image: 'alpine:latest',
    icon: '🏔️',
    tags: ['linux', 'system', 'minimal'],
  },
  {
    id: 'wordpress',
    name: 'WordPress',
    description: '经典建站套件：WordPress + MySQL，一键搭建博客/内容站点（多容器 Compose 编排）',
    category: '建站',
    image: 'wordpress:latest',
    icon: '📄',
    tags: ['web', 'blog', 'cms', 'compose'],
    compose: {
      services: ['wordpress', 'mysql'],
      ports: [{ container: 80, host: 8080 }],
      env: [
        { key: 'MYSQL_ROOT_PASSWORD', value: 'root123', desc: 'MySQL root 用户密码' },
        { key: 'MYSQL_DATABASE', value: 'wordpress', desc: 'WordPress 数据库名' },
        { key: 'MYSQL_USER', value: 'wp', desc: 'WordPress 数据库用户' },
        { key: 'MYSQL_PASSWORD', value: 'wppass123', desc: 'WordPress 数据库用户密码' },
      ],
      volumes: [{ container: '/var/lib/mysql', host: 'dm-wp-mysql-data' }],
      defaultVersion: 'latest',
      compose: `services:
  mysql:
    image: mysql:8.0
    container_name: dm-wordpress-mysql
    restart: unless-stopped
    environment:
      MYSQL_ROOT_PASSWORD: \${MYSQL_ROOT_PASSWORD}
      MYSQL_DATABASE: \${MYSQL_DATABASE}
      MYSQL_USER: \${MYSQL_USER}
      MYSQL_PASSWORD: \${MYSQL_PASSWORD}
    volumes:
      - dm-wp-mysql-data:/var/lib/mysql
  wordpress:
    image: wordpress:latest
    container_name: dm-wordpress
    restart: unless-stopped
    depends_on:
      - mysql
    environment:
      WORDPRESS_DB_HOST: mysql:3306
      WORDPRESS_DB_USER: \${MYSQL_USER}
      WORDPRESS_DB_PASSWORD: \${MYSQL_PASSWORD}
      WORDPRESS_DB_NAME: \${MYSQL_DATABASE}
    ports:
      - "80:80"
    volumes:
      - wordpress_data:/var/www/html
volumes:
  dm-wp-mysql-data:
  wordpress_data:
`,
    },
  },
  {
    id: 'nginx-php',
    name: 'Nginx + PHP',
    description: 'LNMP 建站套件：Nginx + PHP-FPM + MariaDB，一站搭建 PHP 站点（多容器 Compose 编排）',
    category: '建站',
    image: 'nginx:latest',
    icon: '🌐',
    tags: ['web', 'lnmp', 'php', 'compose'],
    compose: {
      services: ['nginx', 'php', 'mariadb'],
      ports: [{ container: 80, host: 8081 }],
      env: [
        { key: 'MYSQL_ROOT_PASSWORD', value: 'root123', desc: 'MariaDB root 用户密码' },
        { key: 'PHP_UPLOAD_LIMIT', value: '128M', desc: 'PHP 上传大小限制' },
      ],
      volumes: [{ container: '/var/www/html', host: 'dm-nginxphp-web' }],
      defaultVersion: 'latest',
      compose: `services:
  mariadb:
    image: mariadb:11
    container_name: dm-nginxphp-mariadb
    restart: unless-stopped
    environment:
      MYSQL_ROOT_PASSWORD: \${MYSQL_ROOT_PASSWORD}
    volumes:
      - dm-nginxphp-db:/var/lib/mysql
  php:
    image: php:8.2-fpm
    container_name: dm-nginxphp-php
    restart: unless-stopped
    depends_on:
      - mariadb
    volumes:
      - dm-nginxphp-web:/var/www/html
  nginx:
    image: nginx:latest
    container_name: dm-nginxphp-nginx
    restart: unless-stopped
    depends_on:
      - php
    ports:
      - "80:80"
    volumes:
      - dm-nginxphp-web:/var/www/html:ro
volumes:
  dm-nginxphp-web:
  dm-nginxphp-db:
`,
    },
  },
  {
    id: 'redis-stack',
    name: 'Redis Stack',
    description: 'Redis + RedisInsight 管理台：键值数据库套件，自带可视化查看与诊断（多容器 Compose 编排）',
    category: '数据库',
    image: 'redis/redis-stack-server:latest',
    icon: '🧰',
    tags: ['redis', 'cache', 'database', 'compose'],
    compose: {
      services: ['redis', 'redisinsight'],
      ports: [
        { container: 6379, host: 6379 },
        { container: 8001, host: 8001 },
      ],
      env: [
        { key: 'REDIS_PASSWORD', value: '', desc: 'Redis 访问密码（留空则无需密码）' },
      ],
      volumes: [{ container: '/data', host: 'dm-redisstack-data' }],
      defaultVersion: 'latest',
      compose: `services:
  redis:
    image: redis/redis-stack-server:latest
    container_name: dm-redisstack-redis
    restart: unless-stopped
    command: redis-stack-server --appendonly yes
    ports:
      - "6379:6379"
    volumes:
      - dm-redisstack-data:/data
  redisinsight:
    image: redis/redisinsight:latest
    container_name: dm-redisstack-insight
    restart: unless-stopped
    depends_on:
      - redis
    ports:
      - "8001:8001"
volumes:
  dm-redisstack-data:
`,
    },
  },
  {
    id: 'grafana-prometheus',
    name: 'Grafana + Prometheus',
    description: '监控告警套件：Prometheus 采集指标 + Grafana 可视化大盘 + Node Exporter 主机监控（多容器 Compose 编排）',
    category: '监控',
    image: 'grafana/grafana:latest',
    icon: '📈',
    tags: ['monitoring', 'grafana', 'prometheus', 'compose'],
    compose: {
      services: ['grafana', 'prometheus'],
      ports: [
        { container: 3000, host: 3000 },
        { container: 9090, host: 9090 },
      ],
      env: [
        { key: 'GF_ADMIN_USER', value: 'admin', desc: 'Grafana 登录用户名' },
        { key: 'GF_ADMIN_PASSWORD', value: 'admin123', desc: 'Grafana 登录密码' },
      ],
      volumes: [
        { container: '/var/lib/grafana', host: 'dm-grafana-data' },
        { container: '/prometheus', host: 'dm-prom-data' },
      ],
      defaultVersion: 'latest',
      compose: `services:
  grafana:
    image: grafana/grafana:latest
    container_name: dm-grafana
    restart: unless-stopped
    environment:
      GF_SECURITY_ADMIN_USER: \${GF_ADMIN_USER}
      GF_SECURITY_ADMIN_PASSWORD: \${GF_ADMIN_PASSWORD}
    ports:
      - "3000:3000"
    volumes:
      - dm-grafana-data:/var/lib/grafana
  prometheus:
    image: prom/prometheus:latest
    container_name: dm-prometheus
    restart: unless-stopped
    ports:
      - "9090:9090"
    volumes:
      - dm-prom-data:/prometheus
volumes:
  dm-grafana-data:
  dm-prom-data:
`,
    },
  },
];

/**
 * 将 compose 模板中的 ${VAR} 占位符替换为实际值（未提供的变量保留原占位符或替换为空）
 * @param template compose 模板字符串
 * @param values 键值对（key 为占位符名，不含 $ 与花括号）
 * @returns 替换后的模板
 */
export function renderComposeTemplate(template: string, values: Record<string, string>): string {
  return String(template).replace(/\$\{(\w+)\}/g, (_, key: string) =>
    values[key] !== undefined ? String(values[key]) : '',
  );
}

/**
 * 从 appstore_custom_apps 表读取全部用户自定义应用并组装为 AppDefinition 列表。
 *
 * 表中的 ports/env/volumes/tags 以 JSON 字符串存储，读取时安全解析：
 *  - 解析成功且为数组则使用
 *  - 解析失败或格式非法时回退为空数组（容错，避免单条坏数据拖垮整个目录）
 * compose 字段可选，存在时解析为 AppComposeDef；解析失败则忽略该 compose（回退单容器）。
 * @returns 自定义应用定义列表
 */
export function loadCustomApps(): AppDefinition[] {
  const rows = (
    getDb()
      .prepare(
        'SELECT id, name, description, category, image, icon, ports, env, volumes, tags, compose FROM appstore_custom_apps',
      )
      .all() as unknown as Array<{
      id: string;
      name: string;
      description: string;
      category: string;
      image: string;
      icon: string;
      ports: string;
      env: string;
      volumes: string;
      tags: string;
      compose: string | null;
    }>
  ) || [];

  /**
   * 安全解析 JSON 数组，解析失败（含非数组）返回空数组
   * @param raw 原始 JSON 字符串
   * @returns 解析后的数组
   */
  function safeParseArray(raw: string): any[] {
    try {
      const value = JSON.parse(raw);
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  }

  return rows.map((row) => {
    // 组装自定义应用定义，统一标记 isCustom
    const app: AppDefinition = {
      id: row.id,
      name: row.name,
      description: row.description || '',
      category: row.category || '自定义',
      image: row.image,
      icon: row.icon || '📦',
      ports: safeParseArray(row.ports || '[]'),
      env: safeParseArray(row.env || '[]'),
      volumes: safeParseArray(row.volumes || '[]'),
      tags: safeParseArray(row.tags || '[]'),
      isCustom: true,
    };
    // compose 可选：存在时安全解析为 AppComposeDef，失败则忽略
    if (row.compose) {
      try {
        const parsed = JSON.parse(row.compose);
        if (parsed && typeof parsed === 'object') {
          app.compose = parsed as AppComposeDef;
        }
      } catch {
        // compose 解析失败则忽略该字段，按单容器应用处理
      }
    }
    return app;
  });
}

/**
 * 获取全部应用定义（内置 + 用户自定义合并）
 * 保持内置应用在前、自定义应用在后的稳定顺序。
 * @returns 全部应用定义列表
 */
export function getAllApps(): AppDefinition[] {
  return [...APP_CATALOG, ...loadCustomApps()];
}

/**
 * 根据应用 id 查找应用定义
 * @param id 应用 id
 * @returns 匹配的应用定义，未找到时返回 undefined
 */
export function findApp(id: string): AppDefinition | undefined {
  // 优先在内置目录中查找
  const builtin = APP_CATALOG.find((app) => app.id === id);
  if (builtin) return builtin;
  // 内置未命中且非自定义前缀直接返回（避免无谓的数据库查询）
  if (!id || !id.startsWith(CUSTOM_APP_PREFIX)) return undefined;
  // 再从用户自定义应用表中查找
  return loadCustomApps().find((app) => app.id === id);
}
