import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, Col, Progress, Row, Space, Statistic, Tag, Typography, message } from 'antd';
import { apiGet, apiPost } from '../utils/apiClient';

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
  const [recovering, setRecovering] = useState(null);

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

  const recover = async (source) => {
    if (recovering) return;
    setRecovering(source.key);
    try {
      // Read the server again immediately before starting. The five-second
      // display snapshot may already be stale on another operator's screen.
      const [jobReply, analyticsReply, statusReply] = await Promise.all([
        apiGet('/recruitment-pipeline/active-job'),
        apiGet('/recruitment-pipeline/analytics?scope=active'),
        apiGet(source.statusUrl)
      ]);
      if (!jobReply?.success || !analyticsReply?.success || !statusReply?.success) {
        throw new Error('无法确认服务器当前岗位、入库数量或采集状态，请稍后刷新');
      }
      const currentJob = jobReply.data;
      const currentAnalytics = analyticsReply.data;
      const currentStatus = statusReply.data;
      if (!currentJob?.title || !currentJob?.jobRequirements ||
          currentAnalytics?.job?.configured !== true) {
        throw new Error('请先保存完整岗位要求，再补齐简历');
      }
      const goal = Number(currentJob.targetCount);
      if (!Number.isInteger(goal) || goal < 1 || goal > 200) {
        throw new Error('请先在岗位设置中保存 1～200 份目标数量');
      }
      const captured = Number(currentAnalytics.bySource?.find(row => row.source === source.key)?.total);
      if (!Number.isInteger(captured) || captured < 0) {
        throw new Error('当前岗位已入库数量不可用，请先刷新');
      }
      const remaining = goal - captured;
      if (remaining <= 0) {
        message.info(`${source.label}已达到当前岗位的 ${goal} 份目标`);
        await refresh();
        return;
      }
      if (currentStatus.isActive || currentStatus.batch?.running) {
        throw new Error(`${source.label}采集仍在运行，请勿重复启动`);
      }
      if (source.key === 'boss') {
        await apiPost('/boss-zhipin/start', {});
        const checkpointRemaining = Number(currentStatus.targetCount) -
          Number(currentStatus.collectedCount);
        const exactResume = currentStatus.resumeAvailable === true &&
          currentStatus.mode === 'search' &&
          currentStatus.filters?.position === currentJob.title &&
          checkpointRemaining === remaining &&
          Number.isInteger(Number(currentStatus.maxRuntimeMinutes)) &&
          Number(currentStatus.maxRuntimeMinutes) >= 1;
        await apiPost('/boss-zhipin/start-browsing', exactResume
          ? { mode: 'search', filters: currentStatus.filters,
              targetCount: currentStatus.targetCount,
              maxRuntimeMinutes: currentStatus.maxRuntimeMinutes, resume: true }
          : { mode: 'search', filters: { position: currentJob.title },
              targetCount: remaining, maxRuntimeMinutes: 90 });
      } else if (source.key === 'zlzp') {
        await apiPost('/zhilian/init', {});
        const login = await apiGet('/zhilian/login-status');
        if (!login?.success || !login.data?.isLoggedIn) {
          throw new Error('智联需要在服务器浏览器中完成登录或平台验证，再点击补齐');
        }
        await apiPost('/zhilian/start-browsing', {
          mode: 'search',
          filters: { position: currentJob.title, location: currentJob.location || '不限' },
          targetCount: remaining
        });
      } else {
        const session = await apiPost('/wuyou/start', {});
        if (!session?.success || !session.data?.isLoggedIn) {
          throw new Error('前程无忧需要在服务器浏览器中完成登录或平台验证，再点击补齐');
        }
        const keywords = String(currentJob.searchKeywords || currentJob.title)
          .split(/[,，、\n]/).map(value => value.trim()).filter(Boolean);
        const education = { '本科': '本科及以上', '大专': '大专及以上',
          '硕士': '硕士及以上', '研究生': '硕士及以上' }[currentJob.education] ||
          (['不限', '大专及以上', '本科及以上', '硕士及以上'].includes(currentJob.education)
            ? currentJob.education : '不限');
        await apiPost('/wuyou/keyword-batch', {
          keywords, targetCount: Math.min(remaining, 30),
          jobRequirements: currentJob.jobRequirements, education
        });
      }
      message.success(`${source.label}已按当前岗位补采，目标新增 ${Math.min(remaining, source.key === 'qcwy' ? 30 : remaining)} 份`);
      await refresh();
    } catch (error) {
      message.error(error.message || '补齐采集未能启动');
    } finally {
      setRecovering(null);
    }
  };

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
              {(counts.nameNeedsReview > 0 || counts.positionNeedsReview > 0 || counts.parseNeedsReview > 0) &&
                <div><Text type="warning">待核实：姓名 {counts.nameNeedsReview || 0} 份，求职岗位 {counts.positionNeedsReview || 0} 份，结构化解析 {counts.parseNeedsReview || 0} 份。平台匿名展示时系统不会编造姓名。</Text></div>}
              {target > 0 && <Progress percent={Math.min(100, Math.round(count / target * 100))} format={() => `${count}/${target}`} style={{ marginTop: 8 }} />}
              <Space wrap>
                <Button size="small" type="primary" loading={recovering === source.key}
                  disabled={Boolean(recovering) || !snapshot?.analytics || !job.jobRequirements || !target || count >= target || state.label === '采集中'}
                  onClick={() => recover(source)}>补齐剩余 {Math.max(0, target - count)} 份</Button>
                <Button size="small" type="link" onClick={() => onOpenPipeline(source.key)}>查看简历</Button>
                <Button size="small" type="link" onClick={() => onOpenControl(source.key)}>采集控制台</Button>
              </Space>
            </Card>
          </Col>;
        })}
      </Row>
      <div style={{ marginTop: 10 }}><Text type="secondary">采集暂停或服务重启后，可直接点“补齐剩余”续采。若平台要求登录或安全验证，先用页顶“服务器浏览器”在原窗口完成，再点补齐；已入库简历会去重保留。</Text></div>
    </>}
  </Card>;
}
