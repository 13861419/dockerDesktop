/**
 * Compose 内置模板与模板下拉工具
 *
 * 从 Compose 页抽出（1.92.0 重构）：新建弹窗与模板下拉共用。
 */
import { translateNow as t } from '../i18n';
import type { ComposeTemplate } from '../types';

/**
 * 内置 docker-compose.yml 模板（自有定义，其结构与用户 Compose 模板一致）
 */
export const COMPOSE_TEMPLATES: {
  /** 模板唯一标识 */
  id: string;
  /** 模板名称（下拉中展示） */
  name: string;
  /** 模板说明（下拉预览行展示） */
  description: string;
  /** 完整的 docker-compose.yml 文本 */
  content: string;
}[] = [
  {
    id: 'wordpress',
    name: 'WordPress',
    description: t('WordPress + MySQL 博客站点'),
    content: `version: "3"
services:
  wordpress:
    image: wordpress:latest
    restart: always
    ports:
      - "8080:80"
    environment:
      WORDPRESS_DB_HOST: db
      WORDPRESS_DB_USER: wordpress
      WORDPRESS_DB_PASSWORD: wordpress
      WORDPRESS_DB_NAME: wordpress
    volumes:
      - wordpress_data:/var/www/html
    depends_on:
      - db
  db:
    image: mysql:8.0
    restart: always
    environment:
      MYSQL_DATABASE: wordpress
      MYSQL_USER: wordpress
      MYSQL_PASSWORD: wordpress
      MYSQL_ROOT_PASSWORD: rootpass
    volumes:
      - db_data:/var/lib/mysql
volumes:
  wordpress_data:
  db_data:`,
  },
  {
    id: 'nginx',
    name: t('Nginx 静态站'),
    description: t('Nginx 静态网站托管'),
    content: `version: "3"
services:
  web:
    image: nginx:alpine
    restart: always
    ports:
      - "8080:80"
    volumes:
      - ./html:/usr/share/nginx/html:ro
      - ./nginx.conf:/etc/nginx/conf.d/default.conf:ro`,
  },
  {
    id: 'redis',
    name: 'Redis',
    description: t('Redis 缓存服务（含密码）'),
    content: `version: "3"
services:
  redis:
    image: redis:7-alpine
    restart: always
    ports:
      - "6379:6379"
    command: redis-server --requirepass redispass
    volumes:
      - redis_data:/data
volumes:
  redis_data:`,
  },
  {
    id: 'postgres',
    name: 'PostgreSQL',
    description: t('PostgreSQL 数据库服务'),
    content: `version: "3"
services:
  postgres:
    image: postgres:16-alpine
    restart: always
    ports:
      - "5432:5432"
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: appdb
    volumes:
      - pg_data:/var/lib/postgresql/data
volumes:
  pg_data:`,
  },
  {
    id: 'node',
    name: t('Node.js 应用'),
    description: t('Node.js 应用 + 构建后运行'),
    content: `version: "3"
services:
  app:
    build: .
    restart: always
    ports:
      - "3000:3000"
    environment:
      NODE_ENV: production
    volumes:
      - ./:/app
    command: npm start`,
  },
];

/**
 * 根据下拉 value 查找对应的 Compose 模板（内置或用户自建）
 * 用户模板的 value 以 'tpl:' 前缀标识模板 id，用于区分内置模板名与用户模板
 * @param value 下拉 value（'' 表示空白）
 * @param userTemplates 用户自建模板列表
 * @returns 命中的模板，未命中则返回 undefined
 */
export function findTemplateByValue(value: string, userTemplates: ComposeTemplate[]) {
  if (!value) return undefined;
  if (value.startsWith('tpl:')) {
    return userTemplates.find((tpl) => 'tpl:' + tpl.id === value);
  }
  return COMPOSE_TEMPLATES.find((tpl) => tpl.id === value);
}
