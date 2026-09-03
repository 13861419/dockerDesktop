/**
 * Helm Release secret 深度解码（1.16.0）
 *
 * sh.helm.release.v1.<name>.v<rev> secret 的 data.release 为 base64(protobuf Release)。
 * 此处实现无依赖的迷你 protobuf 解析器，仅提取所需字段：
 *   Release{1: chart, 4: info, 5: name, 6: namespace, 7: version}
 *   Chart {1: metadata}; Metadata {1: name, 4: version}
 *   Info {1: first_deployed, 2: last_deployed(Timestamp{1: seconds}), 4: description, 5: status enum}
 */
import zlib from 'zlib';

/** 状态枚举（hapi/release/status.proto） */
const HELM_STATUS: Record<number, string> = {
  1: 'deployed',
  2: 'uninstalled',
  3: 'uninstalling',
  4: 'pending-install',
  5: 'pending-upgrade',
  6: 'pending-rollback',
  7: 'failed',
};

/** 解析后的 Helm Release 元信息 */
export interface HelmReleaseMeta {
  chartName: string;
  chartVersion: string;
  status: string;
  lastDeployedAt: number | null;
}

interface PbField {
  field: number;
  wireType: number;
  varint?: bigint;
  bytes?: Buffer;
}

function readVarint(buf: Buffer, pos: { v: number }): bigint {
  let result = 0n;
  let shift = 0n;
  for (;;) {
    if (pos.v >= buf.length) throw new Error('varint overflow');
    const b = buf[pos.v++];
    result |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) break;
    shift += 7n;
  }
  return result;
}

/** 解析 protobuf 消息为顶层字段列表（varint / length-delimited / fixed） */
export function parseFields(buf: Buffer): PbField[] {
  const out: PbField[] = [];
  const pos = { v: 0 };
  while (pos.v < buf.length) {
    const key = readVarint(buf, pos);
    const field = Number(key >> 3n);
    const wireType = Number(key & 7n);
    if (field === 0) break;
    if (wireType === 0) {
      out.push({ field, wireType, varint: readVarint(buf, pos) });
    } else if (wireType === 2) {
      const len = Number(readVarint(buf, pos));
      out.push({ field, wireType, bytes: buf.subarray(pos.v, pos.v + len) });
      pos.v += len;
    } else if (wireType === 1) {
      pos.v += 8;
    } else if (wireType === 5) {
      pos.v += 4;
    } else {
      break;
    }
  }
  return out;
}

function findField(fields: PbField[], n: number): PbField | undefined {
  return fields.find((f) => f.field === n);
}

function fieldString(f?: PbField): string {
  return f?.bytes ? f.bytes.toString('utf8') : '';
}

/** 从 protobuf Timestamp bytes 提取秒级时间（毫秒） */
function timestampToMs(f?: PbField): number | null {
  if (!f?.bytes) return null;
  try {
    const ts = parseFields(f.bytes);
    const seconds = findField(ts, 1);
    if (!seconds?.varint) return null;
    return Number(seconds.varint) * 1000;
  } catch {
    return null;
  }
}

/**
 * 解码 helm release secret 的 data.release（base64(protobuf)）。
 * 解析失败（非标准 payload / 格式变化）返回 null，调用方降级为 secret labels 信息。
 */
export function decodeHelmRelease(base64Payload: string): HelmReleaseMeta | null {
  try {
    let raw = Buffer.from(base64Payload, 'base64');
    // 兼容 gzip 包裹的 payload（magic 1f 8b）
    if (raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b) {
      raw = zlib.gunzipSync(raw);
    }
    const release = parseFields(raw);
    let chartName = '';
    let chartVersion = '';
    const chartField = findField(release, 1);
    if (chartField?.bytes) {
      const chart = parseFields(chartField.bytes);
      const metadataField = findField(chart, 1); // Chart.metadata
      if (metadataField?.bytes) {
        const meta = parseFields(metadataField.bytes);
        chartName = fieldString(findField(meta, 1));
        chartVersion = fieldString(findField(meta, 4));
      }
    }
    let status = '';
    let lastDeployedAt: number | null = null;
    const infoField = findField(release, 4);
    if (infoField?.bytes) {
      const info = parseFields(infoField.bytes);
      const statusNum = findField(info, 5);
      if (statusNum?.varint !== undefined) status = HELM_STATUS[Number(statusNum.varint)] || '';
      lastDeployedAt = timestampToMs(findField(info, 2));
    }
    if (!chartName && !status) return null;
    return { chartName, chartVersion, status, lastDeployedAt };
  } catch {
    return null;
  }
}

/** 测试辅助：编码 protobuf Release 消息（与 decodeHelmRelease 互逆，用于校验 wire format） */
export function encodeHelmReleaseForTest(meta: {
  chartName: string;
  chartVersion: string;
  status: number;
  lastDeployedSec: number;
}): Buffer {
  const encodeVarint = (value: number): Buffer => {
    const out: number[] = [];
    let v = value;
    for (;;) {
      if (v < 0x80) {
        out.push(v);
        break;
      }
      out.push((v & 0x7f) | 0x80);
      v = v >>> 7;
    }
    return Buffer.from(out);
  };
  const encodeField = (field: number, payload: Buffer): Buffer => {
    const key = encodeVarint((field << 3) | 2);
    return Buffer.concat([key, encodeVarint(payload.length), payload]);
  };
  const encodeVarintField = (field: number, value: number): Buffer =>
    Buffer.concat([Buffer.from(encodeVarint((field << 3) | 0)), encodeVarint(value)]);
  const metadata = Buffer.concat([
    encodeField(1, Buffer.from(meta.chartName, 'utf8')),
    encodeField(4, Buffer.from(meta.chartVersion, 'utf8')),
  ]);
  const timestamp = encodeVarintField(1, meta.lastDeployedSec);
  const info = Buffer.concat([encodeField(2, timestamp), encodeVarintField(5, meta.status)]);
  const chart = encodeField(1, metadata);
  return Buffer.concat([encodeField(1, chart), encodeField(4, info)]);
}
