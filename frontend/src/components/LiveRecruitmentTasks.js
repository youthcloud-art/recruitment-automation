import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Col, InputNumber, Progress, Row, Space, Statistic, Tag, Typography, message } from 'antd';
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
  if (batch?.pausedForVerification || /verif|captcha/i.test(String(status.status || '')) ||
      /VERIFICATION|RATE_LIMIT/.test(String(status.lastFailureCode || ''))) {
    return { label: '等待平台验证', color: 'warning' };
  }
  if (status.status === 'paused' || ['verification_required', 'login_required'].includes(batch?.stopReason)) {
    return { label: '已暂停', color: 'warning' };
  }
  if (batch?.stopReason && !['target_reached', 'stopped'].includes(batch.stopReason) &&
      Number(batch.targetCount) > Number(batch.saved ?? batch.collectedCount ?? 0)) {
    return { label: '目标未完成', color: 'warning' };
  }
  if (source === 'zlzp' && Number(status.targetCount) > Number(status.collectedCount) &&
      status.status !== 'idle') return { label: '目标未完成', color: 'warning' };
  if (status.lastError || status.error) return { label: '需检查', color: 'error' };
  return { label: '当前未采集', color: 'default' };
}

function recoveryHint(source, status) {
  if (!status) return '状态暂时不可用，请刷新；其他平台可继续使用。';
  const batch = source === 'qcwy' ? status.batch : status;
  const reason = String(status.lastFailureCode || batch?.stopReason || status.lastError || '').toUpperCase();
  if (/WINDOW_MINIMIZED|VIEWPORT_TOO_SMALL/.test(reason)) {
    return '专用 Chrome 被最小化或窗口太小；点页面顶部“服务器浏览器 → 恢复并最大化窗口”（或在服务器桌面恢复），再续接或重开一轮。';
  }
  if (/VERIFICATION|CAPTCHA|RATE_LIMIT/.test(reason) || batch?.pausedForVerification) {
    return '平台要求人工验证或暂时限流；在服务器浏览器按官方页面完成处理后再续采，不要反复请求验证码。';
  }
  if (/LOGIN/.test(reason)) return '登录已过期；在服务器专用浏览器完成登录，再启动本次采集。';
  if (/PERMISSION/.test(reason)) return '当前企业账号缺少该搜索权限，请先在招聘平台确认权限。';
  if (/RESULTS_EXHAUSTED|NO_RESULTS/.test(reason)) {
    return '当前关键词可访问结果已浏览完。已入库简历保留；可在岗位条件中增加相关关键词或调整平台筛选，再按剩余份数补采。';
  }
  if (/ATTEMPT_LIMIT/.test(reason)) {
    return '本轮已达到安全尝试上限。请检查搜索结果、重复记录与平台状态，然后按剩余份数启动新一轮；不会清除已有简历。';
  }
  if (/DOM|STRUCTURE|SELECTOR|PAGE/.test(reason)) {
    return '招聘平台页面结构可能变化；已保留入库结果。请在采集控制台查看提示并确认平台页面，再决定是否重试。';
  }
  return status.lastError || batch?.errors?.slice?.(-1)?.[0] || '';
}

export default function LiveRecruitmentTasks({ onOpenPipeline, onOpenControl, refreshKey = 0 }) {
  const [snapshot, setSnapshot] = useState(null);
  const [failed, setFailed] = useState(false);
  const [recovering, setRecovering] = useState(null);
  const [perRunTargets, setPerRunTargets] = useState({});
  const [actionError, setActionError] = useState({});
  const refreshing = useRef(false);
  const collecting = useRef(false);

  const refresh = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    try {
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
      collecting.current = data.slice(3).some(status => status?.isActive || status?.batch?.running);
    } finally { refreshing.current = false; }
  }, []);

  useEffect(() => {
    refresh();
    let ticks = 0;
    const timer = setInterval(() => {
      if (document.hidden) return;
      ticks++;
      if (collecting.current || ticks % 3 === 0) refresh();
    }, 5000);
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

  const recover = async (source, resumeCheckpoint = false) => {
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
        throw new Error('请先保存完整岗位要求，再启动采集');
      }
      const defaultTarget = Number(currentJob.targetCount) || 3;
      const max = source.key === 'qcwy' ? 50 : 200;
      const requested = Number(perRunTargets[source.key] ?? Math.min(defaultTarget, max));
      if (!Number.isInteger(requested) || requested < 1 || requested > max) {
        throw new Error(`${source.label}本次新增份数需为 1～${max}`);
      }
      if (currentStatus.isActive || currentStatus.batch?.running) {
        throw new Error(`${source.label}采集仍在运行，请勿重复启动`);
      }
      if (source.key === 'boss') {
        await apiPost('/boss-zhipin/start', {});
        const exactResume = resumeCheckpoint && currentStatus.resumeAvailable === true &&
          currentStatus.mode === 'search' &&
          currentStatus.filters?.position === currentJob.title &&
          Number.isInteger(Number(currentStatus.maxRuntimeMinutes)) &&
          Number(currentStatus.maxRuntimeMinutes) >= 1;
        if (resumeCheckpoint && !exactResume) {
          throw new Error('断点已失效或岗位条件变化；请点击“启动本次采集”重新开始，已入库简历会去重保留');
        }
        await apiPost('/boss-zhipin/start-browsing', exactResume
          ? { mode: 'search', filters: currentStatus.filters,
              targetCount: currentStatus.targetCount,
              maxRuntimeMinutes: currentStatus.maxRuntimeMinutes, resume: true }
          : { mode: 'search', filters: { position: currentJob.title },
              targetCount: requested, maxRuntimeMinutes: 90 });
      } else if (source.key === 'zlzp') {
        await apiPost('/zhilian/init', {});
        const login = await apiGet('/zhilian/login-status');
        if (!login?.success || !login.data?.isLoggedIn) {
          throw new Error('智联需要在服务器浏览器中完成登录或平台验证，再点击补齐');
        }
        await apiPost('/zhilian/start-browsing', {
          mode: 'search',
          filters: { position: currentJob.searchKeywords || currentJob.title,
            location: currentJob.location || '不限' },
          targetCount: requested
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
          keywords, targetCount: requested,
          jobRequirements: currentJob.jobRequirements, education
        });
      }
      setActionError(previous => ({ ...previous, [source.key]: '' }));
      message.success(`${source.label}已${resumeCheckpoint ? '续接上次任务' : `启动本次采集，目标新增 ${requested} 份`}`);
      await refresh();
    } catch (error) {
      setActionError(previous => ({ ...previous, [source.key]: error.message || '采集未能启动' }));
      message.error(error.message || '采集未能启动');
    } finally {
      setRecovering(null);
    }
  };

  return <Card title="当前岗位 · 实时执行进度" style={{ marginBottom: 20 }} extra={<Space><Text type="secondary">{snapshot ? `更新于 ${snapshot.synchronizedAt.toLocaleTimeString()} · 采集中每 5 秒、空闲时每 15 秒同步` : '同步中…'}</Text><Button size="small" onClick={refresh}>立即刷新</Button></Space>}>
    {failed && <Alert type="warning" showIcon message="部分平台状态暂时不可用；其他数据仍会自动同步。" style={{ marginBottom: 14 }} />}
    {!job?.title ? <Alert type="info" showIcon message="尚未设置当前岗位，请先在三平台候选人中导入或填写岗位条件。" /> : <>
      <Space style={{ marginBottom: 14 }} wrap>
        <Text strong style={{ fontSize: 18 }}>{job.title}</Text>
        <Tag>单次默认 {target || '未设置'} 份</Tag>
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
          const status = snapshot?.statuses?.[index];
          const state = collectorState(source.key, status);
          const count = Number(counts.total) || 0;
          const batch = source.key === 'qcwy' ? status?.batch : status;
          const taskTarget = Number(batch?.targetCount) || 0;
          const taskSaved = Number(source.key === 'qcwy' ? batch?.saved : batch?.collectedCount) || 0;
          const runLimit = source.key === 'qcwy' ? 50 : 200;
          const sameJob = source.key === 'zlzp'
            ? batch?.filters?.position === (job.searchKeywords || job.title)
            : source.key === 'qcwy' && String(job.searchKeywords || job.title)
              .split(/[,，、\n]/).map(value => value.trim()).includes(batch?.currentKeyword);
          const remaining = sameJob && taskTarget > taskSaved && taskTarget <= runLimit
            ? taskTarget - taskSaved : 0;
          const runTarget = perRunTargets[source.key] ?? Math.min(target || 3, runLimit);
          const hint = recoveryHint(source.key, status);
          return <Col xs={24} md={8} key={source.key}>
            <Card size="small" title={source.label} extra={<Tag color={state.color}>{state.label}</Tag>}>
              <Text>当前岗位已关联 {count} 份 · 已评估 {counts.evaluated || 0} 份 · 符合 {counts.passed || 0} 份</Text>
              {(counts.nameNeedsReview > 0 || counts.positionNeedsReview > 0 || counts.parseNeedsReview > 0) &&
                <div><Text type="warning">待核实：姓名 {counts.nameNeedsReview || 0} 份，求职岗位 {counts.positionNeedsReview || 0} 份，结构化解析 {counts.parseNeedsReview || 0} 份。平台匿名展示时系统不会编造姓名。</Text></div>}
              {taskTarget > 0 && <Progress percent={Math.min(100, Math.round(taskSaved / taskTarget * 100))}
                format={() => `上次任务 ${taskSaved}/${taskTarget}`} style={{ marginTop: 8 }} />}
              {remaining > 0 && state.label !== '采集中' &&
                <Button size="small" style={{ marginTop: 8 }}
                  onClick={() => setPerRunTargets(previous => ({ ...previous, [source.key]: remaining }))}>
                  将本次新增设为尚差 {remaining} 份
                </Button>}
              {hint && (state.color === 'warning' || state.color === 'error') &&
                <Alert type="warning" showIcon style={{ marginTop: 8 }} message={hint} />}
              {actionError[source.key] && <Alert type="error" showIcon style={{ marginTop: 8 }}
                message={actionError[source.key]} />}
              <Space wrap style={{ marginTop: 9 }}>
                <Text>本次新增</Text>
                <InputNumber aria-label={`${source.label}本次新增份数`} min={1} max={runLimit}
                  precision={0} style={{ width: 82 }} value={runTarget}
                  onChange={value => setPerRunTargets(previous => ({ ...previous, [source.key]: value ?? 1 }))} />
                <Button size="small" type="primary" loading={recovering === source.key}
                  disabled={Boolean(recovering) || !snapshot?.analytics || !job.jobRequirements || state.label === '采集中'}
                  onClick={() => recover(source)}>启动本次采集</Button>
                {source.key === 'boss' && status?.resumeAvailable &&
                  <Button size="small" loading={recovering === source.key}
                    disabled={Boolean(recovering) || state.label === '采集中'}
                    onClick={() => recover(source, true)}>
                    续接上次任务（剩余 {Math.max(0, Number(status.targetCount) - Number(status.collectedCount))} 份）
                  </Button>}
                <Button size="small" type="link" onClick={() => onOpenPipeline(source.key)}>查看简历</Button>
                <Button size="small" type="link" onClick={() => onOpenControl(source.key)}>采集控制台</Button>
              </Space>
            </Card>
          </Col>;
        })}
      </Row>
      <div style={{ marginTop: 10 }}><Text type="secondary">岗位里的采集目标是每次任务的默认份数，可在这里另填本次新增目标。采集暂停后先查看提示；平台登录或安全验证必须在服务器原窗口完成。已入库记录保留并去重，BOSS 可在断点有效时续接。</Text></div>
    </>}
  </Card>;
}
