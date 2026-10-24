import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, Input, InputNumber, Progress, Select, Space, Tag, Typography, message } from 'antd';
import {
  PlayCircleOutlined, StopOutlined, ReloadOutlined, SearchOutlined
} from '@ant-design/icons';
import { apiGet, apiPost, apiPut } from '../utils/apiClient';
import { API_ENDPOINTS } from '../config/api';
import JobCriteriaEditor, { EMPTY_JOB } from './JobCriteriaEditor';
import CaptureTargetNotice from './CaptureTargetNotice';

const { Title, Paragraph, Text } = Typography;
const STOP_REASONS = {
  target_reached: '已达到目标份数',
  results_exhausted: '当前关键词的可访问结果已遍历，尚未达到目标份数',
  verification_required: '平台要求人工验证，采集已暂停',
  login_required: '登录已失效，采集已暂停',
  permission_required: '当前账号缺少人才搜索权限',
  attempt_limit: '已达到本次安全处理上限，保存结果可继续使用',
  stopped: '已手动停止',
  error: '采集发生异常，已保留已保存的结果'
};

function keywordFromJob(job) {
  const text = String(job || '').trim();
  const named = text.match(/(?:^|\n)\s*(?:岗位名称|招聘岗位|目标岗位|岗位|职位名称|职位)\s*[:：]\s*([^\n，,。；;（(]+)/);
  if (named?.[1]) return named[1].trim().slice(0, 30);
  const firstLine = text.split(/\r?\n/).map(line => line.trim())
    .find(line => line && line.length <= 30 && !/^(最低|必备|优先|主要|评估|学历|经验|职责|要求)/.test(line));
  return firstLine || '';
}

function educationFromJob(job) {
  const text = String(job || '');
  if (/硕士|研究生/.test(text)) return '硕士及以上';
  if (/本科/.test(text)) return '本科及以上';
  if (/大专/.test(text)) return '大专及以上';
  return '不限';
}

function mapJobEducation(job) {
  const raw = String(job?.education || '').trim();
  if (!raw || raw === '不限') return { value: educationFromJob(job?.jobRequirements), hint: '' };
  const degree = raw === '本科' ? '本科及以上'
    : raw === '大专' ? '大专及以上'
      : raw === '硕士' || raw === '研究生' ? '硕士及以上' : raw;
  if (['大专及以上', '本科及以上', '硕士及以上'].includes(degree)) {
    return { value: degree, hint: '' };
  }
  return { value: '不限',
    hint: `当前前程无忧原生学历筛选不支持“${raw}”；采集时学历按“不限”，详细岗位条件仍用于本机评估。` };
}

export default function WuyouControl() {
  const [status, setStatus] = useState({
    status: 'not_initialized', hasBrowser: false, isLoggedIn: false, url: null, batch: null
  });
  const [keyword, setKeyword] = useState('');
  const [jobCriteria, setJobCriteria] = useState(EMPTY_JOB);
  const [targetCount, setTargetCount] = useState(3);
  const [education, setEducation] = useState('不限');
  const [educationHint, setEducationHint] = useState('');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const jobRequirements = jobCriteria.jobRequirements || '';

  const handleJobCriteriaChange = job => {
    setJobCriteria(job);
    if (job?.title && (job.title !== jobCriteria.title ||
        job.searchKeywords !== jobCriteria.searchKeywords)) {
      setKeyword(job.searchKeywords || job.title);
    }
    if (job?.education !== jobCriteria.education) {
      const mapped = mapJobEducation(job);
      setEducation(mapped.value);
      setEducationHint(mapped.hint);
    }
    if (job?.targetCount !== jobCriteria.targetCount) {
      setTargetCount(Number.isInteger(job?.targetCount) && job.targetCount > 0
        ? job.targetCount : 3);
    }
  };

  const refreshStatus = useCallback(async () => {
    try {
      const result = await apiGet(API_ENDPOINTS.WUYOU.STATUS);
      if (result.success) {
        setStatus(result.data);
        setNotice(current => current.startsWith('状态读取失败：') ? '' : current);
      }
    } catch (error) {
      setNotice('状态读取失败：' + error.message);
    }
  }, []);

  useEffect(() => {
    refreshStatus();
    const timer = setInterval(refreshStatus, 4000);
    return () => clearInterval(timer);
  }, [refreshStatus]);

  useEffect(() => {
    apiGet('/recruitment-pipeline/active-job')
      .then(result => {
        const job = result.data || EMPTY_JOB;
        setJobCriteria(job);
        setKeyword(job.searchKeywords || job.title || keywordFromJob(job.jobRequirements));
        const mapped = mapJobEducation(job);
        setEducation(mapped.value);
        setEducationHint(mapped.hint);
        setTargetCount(Number.isInteger(job.targetCount) && job.targetCount > 0
          ? job.targetCount : 3);
      })
      .catch(error => setNotice('读取岗位条件失败：' + error.message));
  }, []);

  const execute = async (name, endpoint, payload = {}, onSuccess) => {
    setBusy(name);
    setNotice('');
    try {
      const result = await apiPost(endpoint, payload);
      if (!result.success) throw new Error(result.message || '操作失败');
      if (onSuccess) await onSuccess(result.data);
      await refreshStatus();
    } catch (error) {
      setNotice(error.message);
      message.error(error.message);
    } finally {
      setBusy('');
    }
  };

  const startCollection = async () => {
    const terms = [...new Set(keyword.split(/[,，、\n]/).map(value => value.trim()).filter(Boolean))];
    if (!terms.length || terms.length > 10 || terms.some(term => term.length > 30)) {
      return message.warning('请输入 1 到 10 个岗位关键词，每个不超过 30 字');
    }
    if (!Number.isInteger(targetCount) || targetCount < 1 || targetCount > 50) {
      return message.warning('目标份数应为 1 到 50');
    }
    if (!jobCriteria.title || !jobCriteria.jobRequirements) {
      return message.warning('请先填写或导入岗位条件，并保存后开始采集');
    }
    let savedJob;
    try {
      const result = await apiPut('/recruitment-pipeline/active-job', jobCriteria);
      savedJob = result.data;
      setJobCriteria(savedJob);
    } catch (error) {
      return message.error('保存岗位条件失败：' + error.message);
    }
    return execute('collect', API_ENDPOINTS.WUYOU.KEYWORD_BATCH,
      { keywords: terms, targetCount, jobRequirements: savedJob.jobRequirements, education },
      () => setNotice('已开始按岗位浏览简历，进度会自动更新。'));
  };

  const batch = status.batch || {};
  const statusName = status.status === 'ready'
    ? '已登录'
    : status.status === 'loading' ? '正在加载企业后台'
      : status.status === 'waiting_login' ? '等待登录'
        : status.status === 'verification_required' ? '等待人工验证'
          : status.status === 'permission_required' ? '账号权限不足' : '未启动';
  const progress = batch.targetCount > 0
    ? Math.min(100, Math.round((batch.saved || 0) / batch.targetCount * 100)) : 0;

  return (
    <div style={{ padding: '8px 16px 24px' }}>
      <Title level={3}>前程无忧企业端</Title>
      <Paragraph>
        在本机浏览器登录前程无忧企业账号，设置岗位关键词和要获取的简历份数后启动自动浏览。
        已加载岗位要求时，新入库简历会自动评估：已适配的成本核算经理/主管岗位使用本机专用规则，其他岗位使用 DeepSeek AI。
        之后可到“三平台候选人”复核、查看报告和发送邮件。
      </Paragraph>
      <Alert type="info" showIcon style={{ marginBottom: 20 }}
        message="登录与验证由你在浏览器完成"
        description="请在弹出的前程无忧窗口完成扫码、短信或验证码。系统不会代填或绕过验证；如采集期间出现验证，请在该窗口处理后查看进度或重新启动任务。"
      />
      {status.verificationRequired && <Alert type="warning" showIcon style={{ marginBottom: 16 }}
        message="平台要求人工验证" description="请在前程无忧浏览器窗口完成验证，再检查登录状态并重新启动未完成的采集。已入库简历会保留。" />}
      {status.permissionRequired && <Alert type="warning" showIcon style={{ marginBottom: 16 }}
        message="当前企业账号没有人才搜索权限" description="请在前程无忧企业后台检查账号权限或服务状态。" />}
      {status.noResults && status.status === 'ready' && <Alert type="info" showIcon style={{ marginBottom: 16 }}
        message="当前搜索没有结果" description="可以换一个岗位关键词，或检查平台上的筛选条件。" />}

      <Card title="浏览器与登录" style={{ marginBottom: 16 }}>
        <Space wrap>
          <Tag color={status.isLoggedIn ? 'success' : 'default'}>{statusName}</Tag>
          {!status.hasBrowser && (
            <Button type="primary" icon={<PlayCircleOutlined />} loading={busy === 'start'}
              onClick={() => execute('start', API_ENDPOINTS.WUYOU.START)}>
              启动前程无忧浏览器
            </Button>
          )}
          <Button icon={<ReloadOutlined />} onClick={refreshStatus}>检查登录状态</Button>
          {status.hasBrowser && (
            <Button danger icon={<StopOutlined />} disabled={Boolean(batch.running)} loading={busy === 'stop'}
              onClick={() => execute('stop', API_ENDPOINTS.WUYOU.STOP)}>
              关闭浏览器
            </Button>
          )}
        </Space>
        {status.status === 'waiting_login' && (
          <Paragraph style={{ marginTop: 12, marginBottom: 0 }}>
            请在弹出的前程无忧企业端浏览器中完成登录，完成后点击“检查登录状态”。
          </Paragraph>
        )}
      </Card>

      <JobCriteriaEditor value={jobCriteria} onChange={handleJobCriteriaChange}
        disabled={Boolean(batch.running)} />
      <CaptureTargetNotice job={jobCriteria} platform="wuyou" refreshKey={Boolean(batch.running)} />
      {educationHint && <Alert type="warning" showIcon style={{ marginBottom: 16 }}
        message={educationHint} />}
      {targetCount > 50 && <Alert type="warning" showIcon style={{ marginBottom: 16 }}
        message={`模板建议获取 ${targetCount} 份，前程无忧单次最多 50 份；请在下方将目标份数改为 50 或更少。`} />}

      <Card title="按岗位自动获取简历" style={{ marginBottom: 16 }}>
        <Space wrap align="end">
          <div>
            <Text>岗位关键词（最多 10 个，逐个搜索）</Text>
            <Input.TextArea value={keyword} onChange={event => setKeyword(event.target.value)}
              rows={2} style={{ display: 'block', width: 300, marginTop: 6 }}
              placeholder={'例如：成本核算经理\n成本经理\n成本会计'}
              disabled={Boolean(batch.running)} />
          </div>
          <div>
            <Text>目标简历份数</Text>
            <InputNumber min={1} max={50} precision={0} value={targetCount} onChange={setTargetCount}
              style={{ display: 'block', width: 150, marginTop: 6 }} disabled={Boolean(batch.running)} />
          </div>
          <div>
            <Text>学历（平台原生筛选）</Text>
            <Select value={education} onChange={setEducation} disabled={Boolean(batch.running)}
              style={{ display: 'block', width: 150, marginTop: 6 }}
              options={['不限', '大专及以上', '本科及以上', '硕士及以上']
                .map(value => ({ value, label: value }))} />
          </div>
          <Button type="primary" icon={<PlayCircleOutlined />}
            loading={busy === 'collect'} disabled={status.status !== 'ready' || Boolean(batch.running)}
            onClick={startCollection}>开始自动获取</Button>
          <Button icon={<SearchOutlined />} loading={busy === 'search'}
            disabled={status.status !== 'ready' || !keyword.trim() || Boolean(batch.running)}
            onClick={() => execute('search', API_ENDPOINTS.WUYOU.SEARCH,
              { keyword: keyword.split(/[,，、\n]/).map(value => value.trim()).find(Boolean) || '' },
              result => setNotice(result.message))}>只搜索</Button>
          {batch.running && <Button danger icon={<StopOutlined />}
            loading={busy === 'stop-batch'}
            onClick={() => execute('stop-batch', API_ENDPOINTS.WUYOU.STOP_BATCH, {},
              () => setNotice('已请求停止，当前简历处理完成后任务会结束。'))}>停止采集</Button>}
        </Space>
        <Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
          系统会尝试应用平台学历筛选，再依次搜索多个岗位词，逐屏读取当前账号可访问的简历；若平台筛选按钮被页面遮挡而当前岗位要求已加载，采集仍会继续，并按岗位要求在本机评估学历。目标份数只统计实际写入本机的新简历，重复或失败不会算作完成。
          页面加载和滚动可能需要一些时间，遇人工验证会暂停并保留已入库内容。其他平台筛选条件可先在前程无忧浏览器中设置。
          {jobRequirements ? ' 当前已加载岗位要求，可自动评估新简历。' : ' 当前未加载岗位要求，新简历只入库；请到“三平台候选人”填写岗位要求后评估。'}
        </Paragraph>
      </Card>

      {(batch.running || batch.processed > 0 || batch.errors?.length > 0 || batch.educationFilter?.applied === false) && (
        <Card title={batch.running ? '正在获取简历' : '上次采集结果'} style={{ marginBottom: 16 }}>
          <Space wrap>
            <Tag color={batch.running ? 'processing' : 'default'}>{batch.running ? '运行中' : '已结束'}</Tag>
            {batch.currentKeyword && <Text>当前关键词：{batch.currentKeyword}</Text>}
            <Text>新入库 {batch.saved || 0}/{batch.targetCount || targetCount} 份</Text>
            <Text>已发现 {batch.total || 0} 个候选人，尝试处理 {batch.processed || 0} 次</Text>
            <Text>重复 {batch.duplicates || 0} 份，失败 {batch.failed || 0} 次，重试 {batch.retries || 0} 次</Text>
            <Text>已完成关键词 {batch.keywordsCompleted || 0} 个，滚动 {batch.scrollRounds || 0} 轮</Text>
            <Text>已评估 {batch.evaluated || 0} 份</Text>
          </Space>
          {batch.targetCount > 0 && <Progress percent={progress} size="small" style={{ marginTop: 12 }} />}
          {batch.educationFilter?.applied === false && <Alert type="warning" showIcon style={{ marginTop: 12 }}
            message="平台学历预筛未应用，采集继续进行"
            description={batch.educationFilter.reason} />}
          {!batch.running && batch.stopReason && <Alert type={batch.stopReason === 'target_reached' ? 'success' : 'info'}
            showIcon style={{ marginTop: 12 }} message={STOP_REASONS[batch.stopReason] || '采集已结束'} />}
          {batch.errors?.length > 0 && <Alert type="warning" showIcon style={{ marginTop: 12 }}
            message={'有 ' + batch.errors.length + ' 项未能采集'}
            description={batch.errors.slice(-3).join('；')} />}
        </Card>
      )}
      {status.error && <Alert type="warning" showIcon style={{ marginBottom: 16 }} message={status.error} />}
      {notice && <Alert type="info" showIcon message={notice} />}
    </div>
  );
}
