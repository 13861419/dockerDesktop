/**
 * 帮助中心页面（纯前端）
 *
 * 内置快速上手指南、常见问题（FAQ）与功能速查表，
 * 便于新用户快速定位页面与排查常见疑问。零后端请求。
 */
import { useState } from 'react';
import Card from '../components/Card';
import './help.less';

/** FAQ 条目 */
interface FaqItem {
  q: string;
  a: string;
}

/** 快速上手步骤 */
const QUICK_STEPS: Array<{ title: string; desc: string }> = [
  { title: '登录面板', desc: '浏览器访问 http://localhost:9528，默认账号 admin / admin888，首次登录后请立即修改密码。' },
  { title: '总览体检', desc: '「总览」查看主机 CPU / 内存 / 磁盘与容器实时曲线；「健康体检」一键扫描镜像、网络、卷与健康配置。' },
  { title: '管理容器', desc: '「容器」页支持创建、启停、删除、进入终端、查看日志；可按标签、状态、镜像名过滤。' },
  { title: '编排部署', desc: '「Compose」编写或由容器逆向生成 yaml；「应用商店」一键部署常用应用；「编排」管理启动依赖顺序。' },
  { title: '告警通知', desc: '「告警中心」配置 CPU / 内存 / 磁盘 / GPU / 容器级阈值规则，支持「连续周期」防毛刺，通过 Webhook / 邮件 / 钉钉 / 飞书 / Telegram / 企业微信 / Slack 等渠道推送。' },
  { title: 'AI 助手（可选）', desc: '「设置 → AI 配置中心」添加任意 OpenAI 兼容端点后，即可使用对话、巡检、告警诊断、周报等 AI 能力。' },
];

/** 常见问题 */
const FAQ_ITEMS: FaqItem[] = [
  {
    q: '忘记了管理员密码怎么办？',
    a: '如已修改默认密码，可在服务器上停止面板后删除数据目录中的 docker-manager.db（及同目录 -wal / -shm 文件）再重启，面板会以默认账号 admin / admin888 重新初始化；操作前注意备份。',
  },
  {
    q: '如何管理远程 Docker 引擎？',
    a: '「Docker 引擎」页（管理员）新增端点（npipe://、unix://、tcp:// 均可），切换当前引擎后容器、镜像、监控、事件流等全部能力自动切到新引擎；「聚合」「端口地图」「网络拓扑」支持跨引擎汇总。',
  },
  {
    q: 'Webhook 自动部署如何使用？',
    a: '「计划任务」中创建 git-pull-build 或 compose-update-release 类型任务，复制生成的 Webhook 地址填入 Gitea / GitHub 等平台，代码 push 后自动完成 拉取 → 构建 → 部署。',
  },
  {
    q: '镜像漏洞扫描提示未检测到 Trivy？',
    a: '漏洞扫描依赖本机安装 Trivy 二进制（面板自动检测 PATH）。安装后无需重启面板即可扫描；未安装时页面会给出明确的不可用原因。',
  },
  {
    q: '高危操作审批流如何开启？',
    a: '「设置 → 系统参数 → 安全」中开启「高危操作审批流」。开启后非管理员的删除容器操作会进入「审批中心」待审批，管理员批准后系统执行；普通用户也可在审批中心主动提交镜像删除、网络清理等申请。',
  },
  {
    q: '告警频繁误报（瞬时毛刺）怎么处理？',
    a: '编辑告警规则时把「连续周期」调大（如 3，即连续约 30 秒超阈值才触发）。1 = 立即告警；配合静默时段、工作时段与推送聚合窗口，可实现完整的告警防抖。',
  },
  {
    q: '支持哪些通知渠道？',
    a: '内置 Webhook、邮件（SMTP）、钉钉、飞书、Telegram、企业微信、Slack 七类渠道，可添加多个并按启停控制；「测试推送」可验证连通性，danger 级告警还可联动 AI 诊断。',
  },
  {
    q: 'AI 助手如何配置？',
    a: '「设置 → AI 配置」添加任意 OpenAI 兼容端点（云端如 DeepSeek / OpenAI / 智谱，本地如 Ollama / LM Studio / Docker Model Runner），密钥加密存储。未配置时 AI 入口自动隐藏，不影响其它功能。',
  },
  {
    q: '数据都存在哪里？',
    a: '全部数据存储在单个 SQLite 数据库文件（数据目录 docker-manager.db），无外部数据库依赖。「设置 → 数据备份与恢复」支持一键导出 / 导入整库，云端备份支持 S3 / OSS / WebDAV。',
  },
  {
    q: 'Prometheus / Grafana 如何对接？',
    a: '后端内置 /metrics 端点（Prometheus 文本格式，dm_* 指标族），可在「设置 → 系统参数」配置抓取 Token；「总览 → 资源监控 → 导出 Grafana」可下载直接导入的 Dashboard JSON。',
  },
  {
    q: '如何备份/恢复面板自身的数据？',
    a: '「设置 → 面板数据库备份管理」（管理员）可对面板 SQLite 数据库做一致性快照（不停服）、一键恢复与下载；也可在「计划任务」创建「数据库备份」类型任务定时自动备份，保留份数在系统参数中配置。',
  },
  {
    q: '安全基线扫描能自动修复吗？',
    a: '「安全基线」页（/policy）内置 6 项只读检查。内存 / CPU / 重启策略违规支持在线一键修复（修复后自动复检）；特权模式、敏感挂载需重建容器。开启审批流后，非管理员提交的修复会转入审批中心。',
  },
];

/** 功能速查表：页面路径 -> 用途 */
const FEATURE_INDEX: Array<{ path: string; name: string; desc: string }> = [
  { path: '/', name: '总览', desc: '引擎信息、资源监控曲线、一键体检入口' },
  { path: '/health', name: '健康体检', desc: '一键体检：悬空镜像、停止容器、网络、卷、安全配置' },
  { path: '/containers', name: '容器', desc: '生命周期管理、终端、日志、标签过滤、批量操作' },
  { path: '/templates', name: '容器模板', desc: '模板一键创建容器' },
  { path: '/orchestrate', name: '编排', desc: '多容器启动依赖顺序编排与执行' },
  { path: '/assistant', name: 'AI 助手', desc: '对话、知识库、巡检、告警诊断、周报、用量治理' },
  { path: '/images', name: '镜像', desc: '列表、搜索、拉取（多源容灾）、导出、层分析、漏洞扫描' },
  { path: '/build', name: '构建镜像', desc: '在线构建（SSE 实时日志）、层热力图、时长对比' },
  { path: '/hub', name: '镜像中心', desc: '镜像源管理与加速配置' },
  { path: '/volumes', name: '数据卷', desc: '列表、克隆、导出 tar、标签过滤' },
  { path: '/storage', name: '存储', desc: 'Docker 磁盘占用与宿主机分区使用率' },
  { path: '/networks', name: '网络', desc: '网络管理与清理' },
  { path: '/topology', name: '网络拓扑', desc: '容器-网络-端口关系可视化' },
  { path: '/ports', name: '端口地图', desc: '跨引擎端口占用与冲突检测' },
  { path: '/compose', name: 'Compose', desc: '工程管理、yaml 编辑、容器逆向推导' },
  { path: '/appstore', name: '应用商店', desc: '一键部署常用应用' },
  { path: '/tasks', name: '计划任务', desc: '定时备份/清理/构建/Webhook 触发' },
  { path: '/files', name: '文件管理', desc: '容器文件浏览与传输' },
  { path: '/hostfiles', name: '宿主机文件', desc: '宿主机文件管理' },
  { path: '/hostterminal', name: '宿主机终端', desc: '宿主机 Shell' },
  { path: '/engines', name: 'Docker 引擎', desc: '多引擎管理与切换' },
  { path: '/cloudbackup', name: '云端备份', desc: 'S3 / OSS / WebDAV 远程备份' },
  { path: '/swarm', name: 'Swarm', desc: '集群服务查看' },
  { path: '/backups', name: '备份恢复', desc: '数据卷 / Compose / 站点备份' },
  { path: '/databases', name: '数据库', desc: 'MySQL / PostgreSQL / Redis 可视化' },
  { path: '/settings', name: '设置', desc: '账号、备份、AI 配置、系统参数、用户管理' },
  { path: '/logs', name: '日志聚合', desc: '跨容器日志检索与导出' },
  { path: '/operation-logs', name: '操作日志', desc: '全量操作审计' },
  { path: '/notifications', name: '告警中心', desc: '告警规则（含连续周期防抖）、七类通知渠道、记录与 AI 诊断' },
  { path: '/events', name: '事件流', desc: 'Docker 事件实时流与持久化历史' },
  { path: '/tools', name: '工具箱', desc: 'JSON / 正则 / Base64 / 时间戳 / 进制 / 端口网段计算' },
  { path: '/approvals', name: '审批中心', desc: '高危操作审批与记录' },
  { path: '/policy', name: '安全基线', desc: '6 项只读基线检查、违规报告与在线一键修复' },
];

/** FAQ 折叠面板项 */
function Faq({ item }: { item: FaqItem }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`help-faq__item ${open ? 'help-faq__item--open' : ''}`}>
      <button type="button" className="help-faq__q" onClick={() => setOpen(!open)}>
        <span className="help-faq__marker">{open ? '−' : '+'}</span>
        {item.q}
      </button>
      {open && <div className="help-faq__a">{item.a}</div>}
    </div>
  );
}

/** 帮助中心页面入口 */
export default function Help() {
  return (
    <div className="help-page">
      <Card title="快速上手">
        <ol className="help-steps">
          {QUICK_STEPS.map((s, i) => (
            <li key={i} className="help-steps__item">
              <span className="help-steps__num">{i + 1}</span>
              <div>
                <div className="help-steps__title">{s.title}</div>
                <div className="help-steps__desc">{s.desc}</div>
              </div>
            </li>
          ))}
        </ol>
      </Card>

      <Card title="常见问题（FAQ）">
        <div className="help-faq">
          {FAQ_ITEMS.map((f, i) => (
            <Faq key={i} item={f} />
          ))}
        </div>
      </Card>

      <Card title="功能速查">
        <table className="help-table">
          <thead>
            <tr>
              <th style={{ width: '22%' }}>页面</th>
              <th style={{ width: '18%' }}>名称</th>
              <th>主要用途</th>
            </tr>
          </thead>
          <tbody>
            {FEATURE_INDEX.map((f) => (
              <tr key={f.path}>
                <td className="help-table__path">{f.path}</td>
                <td>{f.name}</td>
                <td className="help-table__desc">{f.desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
