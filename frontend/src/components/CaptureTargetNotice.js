import React, { useEffect, useState } from 'react';
import { Alert } from 'antd';
import { apiGet } from '../utils/apiClient';

const SOURCE_BY_PLATFORM = {
  'boss-zhipin': 'boss', zhilian: 'zlzp', wuyou: 'qcwy'
};
const NAME_BY_PLATFORM = {
  'boss-zhipin': 'BOSS 直聘', zhilian: '智联招聘', wuyou: '前程无忧'
};

export function captureTargetNotice(job, platform, analytics) {
  if (!job?.title || !SOURCE_BY_PLATFORM[platform]) return null;
  const target = Number.isInteger(job.targetCount) && job.targetCount > 0
    ? job.targetCount : null;
  const recommendation = Number.isInteger(job.recommendationTargetCount) &&
    job.recommendationTargetCount > 0 ? job.recommendationTargetCount : null;
  const sameSavedJob = Boolean(job.updatedAt && analytics?.job?.updatedAt === job.updatedAt &&
    analytics.job.title === job.title);
  const source = sameSavedJob
    ? analytics.bySource?.find(row => row.source === SOURCE_BY_PLATFORM[platform]) : null;
  const evaluated = Number.isInteger(source?.evaluated) ? source.evaluated : null;
  const targetReached = target !== null && evaluated !== null && evaluated >= target;
  const message = targetReached
    ? `当前岗位在${NAME_BY_PLATFORM[platform]}已有 ${evaluated} 份完成评估，达到或超过单次采集目标 ${target} 份`
    : target === null && recommendation !== null
      ? `推荐名单目标 ${recommendation} 人不是采集上限`
      : `当前岗位单次采集目标：${target === null ? '未设置' : `${target} 份`}`;
  const description = targetReached
    ? '如再开始采集，将按新任务目标继续获取新简历；历史入库数量不会自动抵扣。若无需更多简历，请不要再次启动。'
    : `推荐名单目标${recommendation === null ? '未设置' : `为 ${recommendation} 人`}；`+
      `${target === null ? '请在岗位条件中填写“单次采集目标份数”，或在下方确认本次目标。' : '本次目标还可在下方调整。'}`+
      `${evaluated === null ? '' : ` 当前岗位在${NAME_BY_PLATFORM[platform]}已有 ${evaluated} 份完成评估；未评估的入库简历不计在内。`}`+
      ' 每次任务只按本次新入库份数停止。';
  return { type: targetReached || (target === null && recommendation !== null) ? 'warning' : 'info',
    message, description };
}

export default function CaptureTargetNotice({ job, platform, refreshKey }) {
  const [analytics, setAnalytics] = useState(null);
  useEffect(() => {
    if (!job?.updatedAt || !SOURCE_BY_PLATFORM[platform]) {
      setAnalytics(null);
      return;
    }
    let active = true;
    apiGet('/recruitment-pipeline/analytics', { scope: 'active' })
      .then(result => { if (active) setAnalytics(result.data || null); })
      .catch(() => { if (active) setAnalytics(null); });
    return () => { active = false; };
  }, [job?.updatedAt, platform, refreshKey]);
  const notice = captureTargetNotice(job, platform, analytics);
  return notice && <Alert showIcon {...notice} style={{ marginBottom: 16 }} />;
}
