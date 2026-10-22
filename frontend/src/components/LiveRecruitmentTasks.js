import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, Col, Progress, Row, Space, Statistic, Tag, Typography } from 'antd';
import { apiGet } from '../utils/apiClient';

const { Text } = Typography;
const SOURCES = [
  { key: 'boss', label: 'BOSS 直聘', statusUrl: '/boss-zhipin/browsing-status' },
  { key: 'zlzp', label: '智联招聘', statusUrl: '/zhilian/browsing-status' },
  { key: 'qcwy', label: '前程无忧', statusUrl: '/wuyou/status?readOnly=1' }
];

function collectorState(source, status) {
  if (!status) return { label: '状态不可用', color: 'default' };
  const batch = source === 'qcwy' ? status.batch : status;
  if (batch?.running || status.isActive) return { label: '采集中', color: 'processing' };
  if (batch?.pausedForVerification || /verif|captcha/i.test(String(status.status || ''))) return { label: '等待平台验证', color: 'warning' };
  if (status.status === 'paused' || batch?.stopReason === 'paused') return { label: '已暂停', color: 'warning' };
  if (status.lastError || status.error) return { label: '需检查', color: 'error' };
  return { label: '当前未采集', color: 'default' };
}

export default function LiveRecruitmentTasks({ onOpenPipeline, onOpenControl, refreshKey = 0 }) {
  const [snapshot, setSnapshot] = useState(null);
  const [failed, setFailed] = useState(false);

  const refresh = useCallback(async () => {
    const urls = [
      '/recruitment-pipeline/active-job',
      '/recruitment-pipeline/analytics?scope=active',
      '/recruitment-pipeline/evaluation-queue/status',
      ...SOURCES.map(source => source.statusUrl)
    ];
    const results = await Promise.allSettled(urls.map(url => apiGet(url)));
    const data = results.map(result => result.status === 'fulfilled' && result.value?.success ? result.value.data : null);
    setFailed(data.some(value => value === null));
    setSnapshot({ job: data[0], analytics: data[1], queue: data[2], statuses: data.slice(3), synchronizedAt: new Date() });
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 5000);
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(timer); window.removeEventListener('focus', onFocus); };
  }, [refresh]);

  useEffect(() => {
    if (refreshKey) refresh();
  }, [refreshKey, refresh]);

  const job = snapshot?.job;
  const metrics = snapshot?.analytics?.metrics || {};
  const bySource = snapshot?.analytics?.bySource || [];
  const target = Number(job?.targetCount) || 0;

  return <Card title="当前岗位 · 实时执行进度" style={{ marginBottom: 20 }} extra={<Space><Text type="secondary">{snapshot ? `更新于 ${snapshot.synchronizedAt.toLocaleTimeString()} · 每 5 秒同步` : '同步中…'}</Text><Button size="small" onClick={refresh}>立即刷新</Button></Space>}>
    {failed && <Alert type="warning" showIcon message="部分平台状态暂时不可用；其他数据仍会自动同步。" style={{ marginBottom: 14 }} />}
    {!job?.title ? <Alert type="info" showIcon message="尚未设置当前岗位，请先在三平台候选人中导入或填写岗位条件。" /> : <>
      <Space style={{ marginBottom: 14 }} wrap>
        <Text strong style={{ fontSize: 18 }}>{job.title}</Text>
        <Tag>目标 {target || '未设置'} 份</Tag>
        <Button type="link" onClick={() => onOpenPipeline()}>查看岗位与候选人</Button>
      </Space>
      <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
        <Col xs={12} md={6}><Statistic title="当前岗位已关联" value={metrics.total ?? '—'} /></Col>
        <Col xs={12} md={6}><Statistic title="已完成评估" value={metrics.evaluated ?? '—'} /></Col>
        <Col xs={12} md={6}><Statistic title="符合条件" value={metrics.passed ?? '—'} /></Col>
        <Col xs={12} md={6}><Statistic title="待评估" value={metrics.unevaluated ?? '—'} /></Col>
      </Row>
      {snapshot?.queue && <Text type={snapshot.queue.paused ? 'warning' : 'secondary'}>AI 评估队列：排队 {snapshot.queue.queued}，{snapshot.queue.running ? '正在执行' : '空闲'}{snapshot.queue.paused ? `；已暂停：${snapshot.queue.pauseReason || '需检查模型配置'}` : ''}</Text>}
      {snapshot?.analytics?.scopeNote && <div style={{ marginTop: 8 }}><Text type="secondary">{snapshot.analytics.scopeNote}</Text></div>}
      <Row gutter={[12, 12]} style={{ marginTop: 14 }}>
        {SOURCES.map((source, index) => {
          const counts = bySource.find(item => item.source === source.key) || {};
          const state = collectorState(source.key, snapshot?.statuses?.[index]);
          const count = Number(counts.total) || 0;
          return <Col xs={24} md={8} key={source.key}>
            <Card size="small" title={source.label} extra={<Tag color={state.color}>{state.label}</Tag>}>
              <Text>当前岗位已关联 {count} 份 · 已评估 {counts.evaluated || 0} 份 · 符合 {counts.passed || 0} 份</Text>
              {target > 0 && <Progress percent={Math.min(100, Math.round(count / target * 100))} format={() => `${count}/${target}`} style={{ marginTop: 8 }} />}
              <Space><Button size="small" type="link" onClick={() => onOpenPipeline(source.key)}>查看简历</Button><Button size="small" type="link" onClick={() => onOpenControl(source.key)}>采集控制台</Button></Space>
            </Card>
          </Col>;
        })}
      </Row>
    </>}
  </Card>;
}
