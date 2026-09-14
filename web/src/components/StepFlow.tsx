/**
 * 步骤化输出节点流（Coze 风格，1.66.0 计划任务 / 1.68.0 自动化共用）
 *
 * 以纵向节点列表呈现一次执行的各步骤：名称 / 状态 / 耗时 / 输出，
 * 状态通过颜色区分（ok 绿 / fail 红 / skip 灰）。
 */
import React from 'react';
import { useLang } from '../i18n';
import './stepflow.less';

export interface FlowStep {
  name: string;
  status: 'ok' | 'fail' | 'skip';
  /** 耗时（毫秒），缺省不显示 */
  durationMs?: number;
  /** 步骤输出文本 */
  output?: string;
}

export default function StepFlow({ steps }: { steps: FlowStep[] }) {
  const { t } = useLang();
  return (
    <div className="sflow">
      {steps.map((st, idx) => (
        <div key={idx} className={`sflow__step sflow__step--${st.status}`}>
          <div className="sflow__head">
            <span className="sflow__dot" />
            <span className="sflow__name">{st.name}</span>
            <span className={`sflow__status sflow__status--${st.status}`}>
              {st.status === 'ok' ? t('成功') : st.status === 'fail' ? t('失败') : t('跳过')}
            </span>
            {typeof st.durationMs === 'number' && (
              <span className="sflow__dur">{st.durationMs} ms</span>
            )}
          </div>
          {st.output && <pre className="sflow__output">{st.output}</pre>}
        </div>
      ))}
    </div>
  );
}
