/**
 * Cron 表达式解析与预览（工具箱用，1.75.7）
 *
 * 语义与 server/src/scheduler.ts 的 nextRunTime 完全一致：
 *  - 标准 5 段：分 时 日 月 周
 *  - 字段支持：星号、星号加步进、数字、区间、区间加步进，可逗号组合
 *  - 周字段归一为 周一=0 … 周日=6（面板调度器语义，与标准 cron 的周日=0 不同）
 */

export interface CronFieldInfo {
  label: string;
  value: string;
  desc: string;
}

export interface CronParseResult {
  valid: boolean;
  error: string;
  fields: CronFieldInfo[];
  next: number[];
}

/** 周字段 0-6（周一=0） */
const DOW_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const MONTH_NAMES = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
const FIELD_LABELS = ['分', '时', '日', '月', '周'];

/** 校验单个字段写法（与调度器 isValidField 一致） */
function isValidField(field: string): boolean {
  return field.split(',').every((f) => {
    if (f === '*') return true;
    const m = f.match(/^(\*|(\d{1,4})(?:-(\d{1,4}))?)(\/(\d{1,4}))?$/);
    if (!m) return false;
    if (m[4] && Number(m[4]) <= 0) return false;
    if (m[2] !== undefined) {
      const a = Number(m[2]);
      const b = m[3] !== undefined ? Number(m[3]) : a;
      if (a > b) return false;
    }
    return true;
  });
}

/** 判断值是否命中字段（与调度器 matches 一致） */
function matches(field: string, value: number): boolean {
  return field.split(',').some((f) => {
    if (f === '*') return true;
    const m = f.match(/^(\*|(\d{1,4})(?:-(\d{1,4}))?)(\/(\d+))?$/);
    if (!m) return false;
    const step = m[5] ? Number(m[5]) : 1;
    if (step <= 0) return false;
    let a = 0;
    let b = Number.MAX_SAFE_INTEGER;
    if (m[1] !== '*') {
      a = Number(m[2]);
      b = m[3] !== undefined ? Number(m[3]) : a;
      if (a > b) return false;
    }
    return value >= a && value <= b && (value - a) % step === 0;
  });
}

/** 单字段人类可读描述 */
function describeField(kind: 'min' | 'hour' | 'dom' | 'month' | 'dow', field: string): string {
  const name = { min: '分钟', hour: '小时', dom: '日', month: '月', dow: '周' }[kind];
  if (field === '*') return `每个${name}`;
  if (field.startsWith('*/')) return `每 ${field.slice(2)} ${name}`;
  const nameOf = (v: number) => (kind === 'dow' ? DOW_NAMES[v % 7] : kind === 'month' ? `${v}月` : `${v}`);
  return (
    field
      .split(',')
      .map((f) => {
        const m = f.match(/^(\*|(\d{1,4})(?:-(\d{1,4}))?)(\/(\d+))?$/);
        if (!m) return f;
        if (m[1] === '*') return `每 ${m[5]} ${name}`;
        if (m[3] !== undefined) {
          if (kind === 'dow') return `${nameOf(Number(m[2]))}至${nameOf(Number(m[3]))}`;
          return `${nameOf(Number(m[2]))} 至 ${nameOf(Number(m[3]))} ${name}`;
        }
        return nameOf(Number(f));
      })
      .join('、') + (kind === 'min' || kind === 'hour' ? `（${name}）` : '')
  );
}

/**
 * 解析 cron 表达式：返回字段说明与未来 5 次执行时间
 * @param cron cron 表达式（5 段）
 * @param from 从该时间起算（默认当前时间）
 */
export function parseCron(cron: string, from: number = Date.now()): CronParseResult {
  const parts = (cron || '').trim().split(/\s+/);
  if (parts.length !== 5) {
    return { valid: false, error: '需要 5 段（分 时 日 月 周），空格分隔', fields: [], next: [] };
  }
  if (!parts.every(isValidField)) {
    return { valid: false, error: '存在无法识别的字段写法（支持 *、*/n、n、a-b、a-b/n 与逗号组合）', fields: [], next: [] };
  }
  const kinds = ['min', 'hour', 'dom', 'month', 'dow'] as const;
  const fields = parts.map((value, i) => ({ label: FIELD_LABELS[i], value, desc: describeField(kinds[i], value) }));

  // 与调度器一致：从下一个整分钟起逐分钟扫描，最多 2 年
  const next: number[] = [];
  let t = new Date(Math.floor(from / 60000) * 60000 + 60000);
  const limit = from + 2 * 366 * 24 * 3600 * 1000;
  while (t.getTime() < limit && next.length < 5) {
    if (
      matches(parts[0], t.getMinutes()) &&
      matches(parts[1], t.getHours()) &&
      matches(parts[3], t.getMonth() + 1) &&
      matches(parts[2], t.getDate()) &&
      matches(parts[4], (t.getDay() + 6) % 7)
    ) {
      next.push(t.getTime());
    }
    t = new Date(t.getTime() + 60000);
  }
  return { valid: true, error: '', fields, next };
}
