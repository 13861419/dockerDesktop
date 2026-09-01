/**
 * 帮助中心页面（纯前端）
 *
 * 内置快速上手指南、常见问题（FAQ）与功能速查表，
 * 便于新用户快速定位页面与排查常见疑问。零后端请求。
 */
import { useState } from 'react';
import Card from '../components/Card';
import { translateNow as t } from '../i18n';
import './help.less';

/** FAQ 条目 */
interface FaqItem {
  q: string;
  a: string;
}

/** 快速上手步骤 */
const QUICK_STEPS: Array<{ title: string; desc: string }> = [
  { title: t('登录面板'), desc: t('浏览器访问 http://localhost:9528，默认账号 admin / admin888，首次登录后请立即修改密码。') },
  { title: t('总览体检'), desc: t('「总览」查看主机 CPU / 内存 / 磁盘与容器实时曲线；「健康体检」一键扫描镜像、网络、卷与健康配置。') },
  { title: t('管理容器'), desc: t('「容器」页支持创建、启停、删除、进入终端、查看日志；可按标签、状态、镜像名过滤。') },
  { title: t('编排部署'), desc: t('「Compose」编写或由容器逆向生成 yaml；「应用商店」一键部署常用应用；「编排」管理启动依赖顺序。') },
  { title: t('告警通知'), desc: t('「告警中心」配置 CPU / 内存 / 磁盘 / GPU / 容器级阈值规则，支持「连续周期」防毛刺与「多渠道路由」（全部启用渠道或按级别分流），渠道可自定义消息模板变量，通过 Webhook / 邮件 / 钉钉 / 飞书 / Telegram / 企业微信 / Slack 等渠道推送；「送达率统计」按渠道汇总推送成功率与最近失败明细；「容器自愈」在健康检查失败或容器退出时自动重启/拉起（带冷却期防重）。') },
  { title: t('AI 助手（可选）'), desc: t('「设置 → AI 配置中心」添加任意 OpenAI 兼容端点后，即可使用对话、巡检、告警诊断、周报等 AI 能力。') },
];

/** 常见问题 */
const FAQ_ITEMS: FaqItem[] = [
  {
    q: t('忘记了管理员密码怎么办？'),
    a: t('如已修改默认密码，可在服务器上停止面板后删除数据目录中的 docker-manager.db（及同目录 -wal / -shm 文件）再重启，面板会以默认账号 admin / admin888 重新初始化；操作前注意备份。'),
  },
  {
    q: t('如何管理远程 Docker 引擎？'),
    a: t('「Docker 引擎」页（管理员）新增端点（npipe://、unix://、tcp:// 均可），切换当前引擎后容器、镜像、监控、事件流等全部能力自动切到新引擎；「聚合」「端口地图」「网络拓扑」支持跨引擎汇总。'),
  },
  {
    q: t('Webhook 自动部署如何使用？'),
    a: t('「计划任务」中创建 git-pull-build 或 compose-update-release 类型任务，复制生成的 Webhook 地址填入 Gitea / GitHub 等平台，代码 push 后自动完成 拉取 → 构建 → 部署。'),
  },
  {
    q: t('镜像漏洞扫描提示未检测到 Trivy？'),
    a: t('漏洞扫描依赖本机安装 Trivy 二进制（面板自动检测 PATH）。安装后无需重启面板即可扫描；未安装时页面会给出明确的不可用原因。'),
  },
  {
    q: t('高危操作审批流如何开启？'),
    a: t('「设置 → 系统参数 → 安全」中开启「高危操作审批流」。开启后非管理员的删除容器/卷、停止编排、批量删镜像、清理类等高危操作会进入「审批中心」待审批，管理员批准后系统执行；普通用户也可在审批中心主动提交申请。若在「角色管理」中为角色授予了对应操作权限（如「删除容器」），该角色可直接执行、无需审批。'),
  },
  {
    q: t('告警频繁误报（瞬时毛刺）怎么处理？'),
    a: t('编辑告警规则时把「连续周期」调大（如 3，即连续约 30 秒超阈值才触发）。1 = 立即告警；配合静默时段、工作时段与推送聚合窗口，可实现完整的告警防抖。'),
  },
  {
    q: t('支持哪些通知渠道？'),
    a: t('内置 Webhook、邮件（SMTP）、钉钉、飞书、Telegram、企业微信、Slack 七类渠道，可添加多个并按启停控制；「测试推送」可验证连通性，danger 级告警还可联动 AI 诊断。「推送路由」可选仅首个启用渠道、全部启用渠道或按 warn / danger / recovery 级别分流；每个渠道还可配置消息模板（{{level}} / {{message}} / {{time}} / {{channel}} 变量）自定义推送文案。'),
  },
  {
    q: t('如何给团队成员分配有限的操作权限？'),
    a: t('「设置 → 角色管理」新建自定义角色，按组勾选 14 项资源域权限（容器 / 镜像 / 卷 / 网络 / 编排 / 自愈），然后在「账号管理」中把用户角色设为该角色。角色成员只能在页面上看到已授权的操作按钮；容器终端等高危入口也按权限放行。角色权限仅作用于资源管理域，用户管理、系统设置、引擎切换等系统操作始终需要管理员。'),
  },
  {
    q: t('AI 助手如何配置？'),
    a: t('「设置 → AI 配置」添加任意 OpenAI 兼容端点（云端如 DeepSeek / OpenAI / 智谱，本地如 Ollama / LM Studio / Docker Model Runner），密钥加密存储。未配置时 AI 入口自动隐藏，不影响其它功能。'),
  },
  {
    q: t('数据都存在哪里？'),
    a: t('全部数据存储在单个 SQLite 数据库文件（数据目录 docker-manager.db），无外部数据库依赖。「设置 → 数据备份与恢复」支持一键导出 / 导入整库，云端备份支持 S3 / OSS / WebDAV。'),
  },
  {
    q: t('Prometheus / Grafana 如何对接？'),
    a: t('后端内置 /metrics 端点（Prometheus 文本格式，dm_* 指标族），可在「设置 → 系统参数」配置抓取 Token；「总览 → 资源监控 → 导出 Grafana」可下载直接导入的 Dashboard JSON。'),
  },
  {
    q: t('如何备份/恢复面板自身的数据？'),
    a: t('「设置 → 面板数据库备份管理」（管理员）可对面板 SQLite 数据库做一致性快照（不停服）、一键恢复与下载；也可在「计划任务」创建「数据库备份」类型任务定时自动备份，保留份数在系统参数中配置。'),
  },
  {
    q: t('安全基线扫描能自动修复吗？'),
    a: t('「安全基线」页（/policy）内置 6 项只读检查。内存 / CPU / 重启策略违规支持在线一键修复（修复后自动复检）；特权模式、敏感挂载需重建容器。开启审批流后，非管理员提交的修复会转入审批中心。'),
  },
  {
    q: t('界面支持哪些语言？如何切换？'),
    a: t('「设置 → 关于 → 界面语言」可在中文 / English 间一键切换，偏好即时生效并记住（存于浏览器本地）。1.0.0 起全部页面完成中英文覆盖，未收录文案自动回退中文显示。'),
  },
  {
    q: t('如何开启 2FA 两步验证？'),
    a: t('「设置 → 安全加固 → 两步验证（2FA）」点击「生成密钥」，用 Google Authenticator 等认证器 App 扫码或手动录入密钥，输入首枚验证码确认。此后登录在密码之后还需输入 6 位验证码；关闭 2FA 需输入当前验证码确认。建议管理员强制团队关键账号开启。'),
  },
  {
    q: t('登录被提示「当前 IP 不在允许访问的白名单内」？'),
    a: t('管理员开启了 IP 白名单（全局或按用户）。请确认你的出口 IP 在白名单 CIDR 范围内；若全局白名单把管理机自身也排除导致自锁，需在服务器数据目录的 SQLite 设置表中清空 security.ipAllowlist 键恢复访问。配置时务必先加入当前管理机 IP。'),
  },
];

/** 功能速查表：页面路径 -> 用途 */
const FEATURE_INDEX: Array<{ path: string; name: string; desc: string }> = [
  { path: '/', name: t('总览'), desc: t('引擎信息、资源监控曲线、一键体检入口') },
  { path: '/health', name: t('健康体检'), desc: t('一键体检：悬空镜像、停止容器、网络、卷、安全配置') },
  { path: '/containers', name: t('容器'), desc: t('生命周期管理、终端、日志、标签过滤、批量操作') },
  { path: '/templates', name: t('容器模板'), desc: t('模板一键创建容器') },
  { path: '/orchestrate', name: t('编排'), desc: t('多容器启动依赖顺序编排与执行') },
  { path: '/assistant', name: t('AI 助手'), desc: t('对话、知识库、巡检、告警诊断、周报、用量治理') },
  { path: '/images', name: t('镜像'), desc: t('列表、搜索、拉取（多源容灾）、导出、层分析、漏洞扫描') },
  { path: '/build', name: t('构建镜像'), desc: t('在线构建（SSE 实时日志）、层热力图、时长对比') },
  { path: '/hub', name: t('镜像中心'), desc: t('镜像源管理与加速配置') },
  { path: '/volumes', name: t('数据卷'), desc: t('列表、克隆、导出 tar、标签过滤') },
  { path: '/storage', name: t('存储'), desc: t('Docker 磁盘占用与宿主机分区使用率') },
  { path: '/networks', name: t('网络'), desc: t('网络管理与清理') },
  { path: '/topology', name: t('网络拓扑'), desc: t('容器-网络-端口关系可视化') },
  { path: '/ports', name: t('端口地图'), desc: t('跨引擎端口占用与冲突检测') },
  { path: '/compose', name: t('Compose'), desc: t('工程管理、yaml 编辑、容器逆向推导') },
  { path: '/appstore', name: t('应用商店'), desc: t('一键部署常用应用') },
  { path: '/tasks', name: t('计划任务'), desc: t('定时备份/清理/构建/Webhook 触发') },
  { path: '/files', name: t('文件管理'), desc: t('容器文件浏览与传输') },
  { path: '/hostfiles', name: t('宿主机文件'), desc: t('宿主机文件管理') },
  { path: '/hostterminal', name: t('宿主机终端'), desc: t('宿主机 Shell') },
  { path: '/engines', name: t('Docker 引擎'), desc: t('多引擎管理与切换') },
  { path: '/cloudbackup', name: t('云端备份'), desc: t('S3 / OSS / WebDAV 远程备份') },
  { path: '/swarm', name: t('Swarm'), desc: t('集群服务查看') },
  { path: '/backups', name: t('备份恢复'), desc: t('数据卷 / Compose / 站点备份') },
  { path: '/databases', name: t('数据库'), desc: t('MySQL / PostgreSQL / Redis 可视化') },
  { path: '/settings', name: t('设置'), desc: t('账号、角色管理（RBAC）、2FA 两步验证、在线会话、IP 白名单、密码策略、界面语言切换、备份、AI 配置、系统参数、用户管理') },
  { path: '/logs', name: t('日志聚合'), desc: t('跨容器日志检索与导出') },
  { path: '/operation-logs', name: t('操作日志'), desc: t('全量操作审计') },
  { path: '/notifications', name: t('告警中心'), desc: t('告警规则（含连续周期防抖）、七类通知渠道、多渠道路由、送达率统计、记录与 AI 诊断') },
  { path: '/events', name: t('事件流'), desc: t('Docker 事件实时流与持久化历史') },
  { path: '/tools', name: t('工具箱'), desc: t('JSON / 正则 / Base64 / 时间戳 / 进制 / 端口网段计算') },
  { path: '/approvals', name: t('审批中心'), desc: t('高危操作审批与记录（含编排停止/批量删镜像/清理类）、近 30 天审批统计、记录导出 CSV') },
  { path: '/policy', name: t('安全基线'), desc: t('6 项只读基线检查、违规报告与在线一键修复') },
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
      <Card title={t('快速上手')}>
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

      <Card title={t('常见问题（FAQ）')}>
        <div className="help-faq">
          {FAQ_ITEMS.map((f, i) => (
            <Faq key={i} item={f} />
          ))}
        </div>
      </Card>

      <Card title={t('功能速查')}>
        <table className="help-table">
          <thead>
            <tr>
              <th style={{ width: '22%' }}>{t('页面')}</th>
              <th style={{ width: '18%' }}>{t('名称')}</th>
              <th>{t('主要用途')}</th>
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
