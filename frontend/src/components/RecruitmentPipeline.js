import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Checkbox, Col, Input, InputNumber, Modal, Row, Select, Space, Table, Tag, Typography, message } from 'antd';
import { DownloadOutlined, MailOutlined, ReloadOutlined, RobotOutlined } from '@ant-design/icons';
import { apiGet, apiPatch, apiPost, apiPut } from '../utils/apiClient';
import JobCriteriaEditor, { EMPTY_JOB } from './JobCriteriaEditor';

const { Text, Title } = Typography;
const SOURCES = [
  { value: 'boss', label: 'BOSS直聘' },
  { value: 'zlzp', label: '智联招聘' },
  { value: 'qcwy', label: '前程无忧' }
];
const STATUSES = [
  { value: 'new', label: '新入库' },
  { value: 'shortlisted', label: '待重点查看' },
  { value: 'viewed', label: '已查看' },
  { value: 'contacted', label: '已联系' },
  { value: 'rejected', label: '不合适' }
];
const statusLabel = value => STATUSES.find(item => item.value === value)?.label || '新入库';
const sourceLabel = value => SOURCES.find(item => item.value === value)?.label || value;
const reportFormatLabel = value => value === 'md' ? 'Markdown（.md）' : 'Word（.docx）';
const evaluationMethodLabel = evaluation => {
  if (!evaluation) return '尚未评估';
  if (evaluation.method === 'local') return Number(evaluation.evaluationVersion) === 2
    ? '成本核算专用规则（本机）' : '本机关键词证据评分';
  return 'DeepSeek AI 辅助评估';
};

export default function RecruitmentPipeline({ sourceRequest = null }) {
  const [summary, setSummary] = useState({});
  const [candidates, setCandidates] = useState([]);
  const [candidateTotal, setCandidateTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [source, setSource] = useState(sourceRequest?.source || '');
  const [status, setStatus] = useState('');
  const [keyword, setKeyword] = useState('');
  const [jobRequirements, setJobRequirements] = useState('');
  const [jobCriteria, setJobCriteria] = useState(EMPTY_JOB);
  const [selected, setSelected] = useState(null);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState('');
  const [emailTo, setEmailTo] = useState('');
  const [minScore, setMinScore] = useState(70);
  const [topN, setTopN] = useState(10);
  const [emailReportFormat, setEmailReportFormat] = useState('docx');
  const [emailNewOnly, setEmailNewOnly] = useState(true);
  const [emailPreview, setEmailPreview] = useState(null);
  const [emailBatch, setEmailBatch] = useState(null);
  const [emailConfig, setEmailConfig] = useState(null);
  const [smtpForm, setSmtpForm] = useState({ host: '', port: 587, from: '', user: '', authEnabled: true, secure: 'auto', requireTLS: false });
  const [smtpPassword, setSmtpPassword] = useState('');
  const [batch, setBatch] = useState(null);
  const [pendingOnly, setPendingOnly] = useState(true);
  const [evaluationQueue, setEvaluationQueue] = useState(null);
  const previewGeneration = useRef(0);
  const listGeneration = useRef(0);
  const lastEvaluationQueueChange = useRef(null);

  useEffect(() => {
    setSource(sourceRequest?.source || '');
    setPage(1);
  }, [sourceRequest]);

  const refresh = useCallback(async () => {
    const generation = ++listGeneration.current;
    try {
      const [list, stats] = await Promise.all([
        apiGet('/recruitment-pipeline/candidates/page', {
          source, status, keyword, limit: pageSize, offset: (page - 1) * pageSize
        }),
        apiGet('/recruitment-pipeline/summary')
      ]);
      if (generation !== listGeneration.current) return;
      const data = list.data || { items: [], total: 0 };
      const lastPage = Math.max(1, Math.ceil(data.total / pageSize));
      if (page > lastPage) {
        setPage(lastPage);
        return;
      }
      setCandidates(data.items || []);
      setCandidateTotal(data.total || 0);
      setSummary(stats.data || {});
      setSelected(current => current
        ? (data.items || []).find(item => item.id === current.id) || current
        : null);
    } catch (error) {
      if (generation === listGeneration.current) message.error('读取候选人失败：' + error.message);
    }
  }, [source, status, keyword, page, pageSize]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    apiGet('/recruitment-pipeline/active-job')
      .then(result => {
        setJobCriteria(result.data || EMPTY_JOB);
        if (result.data?.jobRequirements) {
          setJobRequirements(current => current || result.data.jobRequirements);
        }
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    apiGet('/recruitment-pipeline/email/config')
      .then(result => {
        setEmailConfig(result.data);
        setSmtpForm({ host: result.data.host || '', port: result.data.port || 587,
          from: result.data.from || '', user: result.data.user || '',
          authEnabled: result.data.authEnabled || !result.data.configured,
          secure: result.data.secure || 'auto', requireTLS: Boolean(result.data.requireTLS) });
      })
      .catch(() => setEmailConfig({ configured: false }));
  }, []);
  useEffect(() => {
    previewGeneration.current++;
    setEmailPreview(null);
    setEmailBatch(null);
  }, [source, status, minScore, topN, jobRequirements, emailReportFormat]);
  useEffect(() => {
    let previousRunning = false;
    const poll = async () => {
      try {
        const result = await apiGet('/recruitment-pipeline/evaluate-batch/status');
        setBatch(result.data);
        if (previousRunning && !result.data.running) refresh();
        previousRunning = result.data.running;
      } catch (_) { /* 手动刷新仍可用 */ }
      try {
        const result = await apiGet('/recruitment-pipeline/evaluation-queue/status');
        setEvaluationQueue(result.data);
        const queueChange = ['completed', 'failed', 'deferred', 'overflowed']
          .map(field => result.data?.[field] || 0).join(':');
        if (lastEvaluationQueueChange.current !== null &&
            lastEvaluationQueueChange.current !== queueChange) refresh();
        lastEvaluationQueueChange.current = queueChange;
      } catch (_) { /* 旧版服务端仍可显示批量评估进度 */ }
    };
    poll();
    const timer = setInterval(poll, 2000);
    return () => clearInterval(timer);
  }, [refresh]);

  const update = async changes => {
    if (!selected) return;
    setBusy('save');
    try {
      const result = await apiPatch(`/recruitment-pipeline/candidates/${encodeURIComponent(selected.id)}`, changes);
      setSelected(result.data);
      setNotes(result.data.candidateNotes || '');
      if (changes.status) {
        previewGeneration.current++;
        setEmailPreview(null);
      }
      await refresh();
      message.success('跟进记录已保存');
    } catch (error) { message.error(error.message); }
    finally { setBusy(''); }
  };

  const evaluate = async () => {
    if (!selected || !jobCriteria.updatedAt || jobRequirements !== jobCriteria.jobRequirements) {
      message.warning('请先在上方保存并应用岗位条件');
      return;
    }
    setBusy('evaluate');
    try {
      const result = await apiPost(`/recruitment-pipeline/candidates/${encodeURIComponent(selected.id)}/evaluate`, { jobRequirements });
      setSelected(previous => ({ ...previous, matchScore: result.data.score, matchEvaluation: result.data }));
      await refresh();
      message.success(`${evaluationMethodLabel(result.data)}已完成`);
    } catch (error) { message.error(error.message); }
    finally { setBusy(''); }
  };

  const downloadReport = async format => {
    if (!jobCriteria.updatedAt || !jobCriteria.title || jobRequirements.trim().length < 5 ||
        jobRequirements !== jobCriteria.jobRequirements) {
      return message.warning('请先填写或导入当前岗位条件并保存，再导出初筛报告');
    }
    setBusy(`report-${format}`);
    try {
      const blob = await apiGet('/recruitment-pipeline/report',
        { source, status, minScore, topN: 100, format, jobRequirements },
        { responseType: 'blob' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `candidate-report.${format}`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { message.error('导出报告失败：' + error.message); }
    finally { setBusy(''); }
  };

  const previewEmail = async () => {
    if (!jobCriteria.updatedAt || jobRequirements.trim().length < 5 ||
        jobRequirements !== jobCriteria.jobRequirements) {
      return message.warning('请先保存并应用岗位条件，再预览本岗位已评估的候选人');
    }
    if (batch?.running) return message.warning('请等待批量评估完成后再预览');
    if (!emailTo.trim()) return message.warning('请先填写收件邮箱，以便恢复本机已发送批次');
    if (!emailNewOnly && emailBatch?.nextOffset >= emailBatch?.total) {
      return message.info('本轮合格候选人已全部发送。如需重新发送，请先结束本轮并核对收件箱。');
    }
    const generation = ++previewGeneration.current;
    setBusy('preview');
    try {
      const progress = await apiPost('/recruitment-pipeline/email/resume',
        { to: emailTo.trim(), source, status, minScore, topN, jobRequirements,
          reportFormat: emailReportFormat, newOnly: emailNewOnly });
      if (generation !== previewGeneration.current) return;
      if (!progress.data.hasMore) {
        setEmailPreview(null);
        setEmailBatch(!emailNewOnly && progress.data.sentCount
          ? { ...progress.data, to: emailTo.trim() } : null);
        return message.info(progress.data.sentCount ? '本轮合格候选人已全部发送，请核对收件箱'
          : '当前平台和状态下没有待发送的合格候选人');
      }
      const page = progress.data.nextOffset
        ? { offset: progress.data.nextOffset, poolFingerprint: progress.data.poolFingerprint }
        : {};
      const result = await apiPost('/recruitment-pipeline/email/preview',
        { to: emailTo.trim(), source, status, minScore, topN, jobRequirements,
          reportFormat: emailReportFormat, newOnly: emailNewOnly,
          ...(!emailNewOnly ? page : {}) });
      if (generation !== previewGeneration.current) return;
      setEmailBatch(!emailNewOnly && progress.data.sentCount
        ? { ...progress.data, to: emailTo.trim() } : null);
      setEmailPreview(result.data);
      if (progress.data.sentCount && !emailBatch?.sentCount) {
        message.info(`已从本机发送记录恢复进度：前 ${progress.data.sentCount} 份已发送`);
      }
      if (!result.data.count) message.info('当前平台和状态下没有待发送的合格候选人');
    } catch (error) { message.error(error.message); }
    finally { setBusy(''); }
  };

  const startBatchEvaluation = async () => {
    if (!jobCriteria.updatedAt || jobRequirements.trim().length < 5 ||
        jobRequirements !== jobCriteria.jobRequirements) {
      return message.warning('请先保存并应用岗位条件，再开始批量评估');
    }
    previewGeneration.current++;
    setEmailPreview(null);
    setBusy('batch');
    try {
      const result = await apiPost('/recruitment-pipeline/evaluate-batch/start',
        { source, status, jobRequirements, limit: 100, pendingOnly });
      setBatch(result.data);
      message.success(result.data.total ? '已开始批量评估'
        : pendingOnly ? '当前筛选没有从未评分的简历' : '当前筛选没有需要按本岗位重评的简历');
    } catch (error) { message.error(error.message); }
    finally { setBusy(''); }
  };

  const stopBatchEvaluation = async () => {
    try {
      await apiPost('/recruitment-pipeline/evaluate-batch/stop', {});
      message.info('将在当前候选人评估完成后停止');
    } catch (error) { message.error(error.message); }
  };

  const saveSmtpConfig = async () => {
    setBusy('smtp-save');
    try {
      await apiPut('/recruitment-pipeline/email/config', { ...smtpForm, password: smtpPassword });
      const result = await apiGet('/recruitment-pipeline/email/config');
      setEmailConfig(result.data);
      setSmtpPassword('');
      message.success('发件邮箱设置已保存到本机 backend/.env');
    } catch (error) { message.error('保存邮件设置失败：' + error.message); }
    finally { setBusy(''); }
  };

  const verifySmtp = async () => {
    setBusy('smtp-verify');
    try {
      await apiPost('/recruitment-pipeline/email/verify', {});
      message.success('SMTP 连接和登录验证成功，未发送邮件');
    } catch (error) { message.error('SMTP 验证失败：' + error.message); }
    finally { setBusy(''); }
  };

  const sendEmail = () => {
    if (!jobCriteria.updatedAt || jobRequirements !== jobCriteria.jobRequirements) {
      return message.warning('岗位条件已修改，请先保存并重新预览');
    }
    if (!emailPreview?.count || !emailPreview.previewToken) return message.warning('请先预览符合条件的简历');
    if (!emailTo.trim()) return message.warning('请输入收件邮箱');
    const generation = previewGeneration.current;
    const currentPreview = emailPreview;
    const batchNumber = Math.floor(currentPreview.offset / topN) + 1;
    const batchCount = Math.ceil(currentPreview.total / topN);
    Modal.confirm({
      title: emailNewOnly ? '确认发送新增合格候选人简历'
        : `确认发送第 ${batchNumber}/${batchCount} 批候选人简历`,
      content: `本批将 ${currentPreview.count} 份候选人材料及 ${reportFormatLabel(currentPreview.selection?.reportFormat || emailReportFormat)} 格式的初筛报告发送至 ${emailTo}。每一批邮件各附一份报告；网页采集的附件是页面提取文本，本地导入的文件在校验通过时保留原格式。请核对收件人和本批预览名单。`,
      okText: '确认发送',
      cancelText: '取消',
      onOk: async () => {
        if (generation !== previewGeneration.current) {
          message.warning('筛选条件或预览已改变，请重新预览本批');
          return;
        }
        setBusy('send');
        try {
          const result = await apiPost('/recruitment-pipeline/email/send',
            { to: emailTo.trim(), source, status, minScore, topN, jobRequirements,
              reportFormat: emailReportFormat, newOnly: emailNewOnly,
              ...(!emailNewOnly ? {
                offset: currentPreview.offset,
                ...(currentPreview.offset ? { poolFingerprint: currentPreview.poolFingerprint } : {})
              } : {}),
              previewToken: currentPreview.previewToken });
          setEmailBatch(emailNewOnly ? null : {
            nextOffset: result.data.nextOffset, total: result.data.total,
            sentCount: result.data.nextOffset, poolFingerprint: result.data.poolFingerprint,
            to: emailTo.trim() });
          setEmailPreview(null);
          if (result.data.receiptRecorded === false) {
            message.warning(`邮件已提交给 SMTP，但本机发送回执未更新；请核对收件箱，勿直接重发`);
          } else {
            message.success(emailNewOnly
              ? `已发送 ${result.data.count} 份新增合格候选人材料；可再次预览后续新增候选人`
              : `第 ${batchNumber}/${batchCount} 批已发送 ${result.data.count} 份简历${result.data.hasMore ? '，可预览下一批' : '，本轮已全部发送'}`);
          }
        } catch (error) {
          setEmailPreview(null);
          message.error('发送结果未确认：' + error.message + '。请先核对收件箱，勿直接重发');
          throw error;
        }
        finally { setBusy(''); }
      }
    });
  };

  const clearEmailBatch = () => {
    if (!emailBatch?.sentCount) return;
    Modal.confirm({
      title: '暂时退出本轮邮件发送？',
      content: `本轮已发送 ${emailBatch.sentCount} 份。进度保存在本机发送记录中；重新填写相同收件邮箱和条件后，可从下一批继续。`,
      okText: '退出本轮', cancelText: '继续本轮',
      onOk: () => { previewGeneration.current++; setEmailPreview(null); setEmailBatch(null); }
    });
  };

  const columns = [
    { title: '平台', dataIndex: 'source', width: 115, render: sourceLabel },
    { title: '候选人', dataIndex: 'name', width: 130, render: value => value || '未识别姓名' },
    { title: '求职岗位', width: 180, render: (_, row) => row.position || row.expectedPosition?.position ||
      (typeof row.expectedPosition === 'string' ? row.expectedPosition : '未填写') },
    { title: '岗位匹配分（当前页排序）', dataIndex: 'matchScore', width: 160,
      sorter: (a, b) => (a.matchScore ?? -1) - (b.matchScore ?? -1),
      render: (value, row) => Number.isFinite(value)
        ? <span title={`评估方式：${evaluationMethodLabel(row.matchEvaluation)}`}>{value}/100{row.matchEvaluation ? (row.matchEvaluation.method === 'local' ? '（本机）' : '（AI）') : ''}</span>
        : '未评估' },
    { title: '跟进状态', dataIndex: 'workflowStatus', width: 130,
      render: value => <Tag>{statusLabel(value)}</Tag> },
    { title: '入库时间', dataIndex: 'createdAt', width: 160,
      render: value => value ? new Date(value).toLocaleString('zh-CN') : '' },
    { title: '操作', width: 100, render: (_, row) => <Button type="link" onClick={() => {
      setSelected(row); setNotes(row.candidateNotes || '');
    }}>查看/跟进</Button> }
  ];

  return (
    <div style={{ padding: 24, overflowY: 'auto', height: 'calc(100vh - 64px)' }}>
      <Title level={3}>三平台候选人管道</Title>
      <Alert showIcon type="info" style={{ marginBottom: 16 }}
        message="三平台简历在这里统一跟进和导出。前程无忧已适配的成本核算经理/主管岗位使用本机专用规则，其他岗位与平台使用 DeepSeek AI 辅助评估；评估方式以每份简历的明细为准，分数仅供人工复核。" />
      <Row gutter={12} style={{ marginBottom: 16 }}>
        {SOURCES.map(item => <Col span={8} key={item.value}>
          <Card size="small" title={item.label}>
            <Text strong>{summary[item.value]?.total || 0} 份简历</Text>
            <div><Text type="secondary">待重点查看 {summary[item.value]?.byStatus?.shortlisted || 0} · 已联系 {summary[item.value]?.byStatus?.contacted || 0}</Text></div>
          </Card>
        </Col>)}
      </Row>
      <Space wrap style={{ marginBottom: 16 }}>
        <Select value={source} style={{ width: 155 }} disabled={Boolean(emailBatch?.sentCount)}
          onChange={value => { setSource(value); setPage(1); }}
          options={[{ value: '', label: '全部平台' }, ...SOURCES]} />
        <Select value={status} style={{ width: 155 }} disabled={Boolean(emailBatch?.sentCount)}
          onChange={value => { setStatus(value); setPage(1); }}
          options={[{ value: '', label: '全部状态' }, ...STATUSES]} />
        <Input.Search placeholder="搜索姓名、岗位、技能" allowClear style={{ width: 245 }}
          onSearch={value => { setKeyword(value); setPage(1); }}
          onChange={event => { if (!event.target.value && keyword) { setKeyword(''); setPage(1); } }} />
        <Button icon={<ReloadOutlined />} onClick={() => {
          previewGeneration.current++;
          setEmailPreview(null);
          refresh();
        }}>刷新</Button>
        <Button type="primary" icon={<DownloadOutlined />} loading={busy === 'report-docx'}
          onClick={() => downloadReport('docx')}>导出初筛 Word（前100份）</Button>
        <Button icon={<DownloadOutlined />} loading={busy === 'report-md'}
          onClick={() => downloadReport('md')}>导出初筛 Markdown（前100份）</Button>
      </Space>
      <JobCriteriaEditor value={jobCriteria}
        onChange={job => {
          setJobCriteria(job);
          setJobRequirements(job.jobRequirements || '');
        }}
        disabled={Boolean(batch?.running || emailBatch?.sentCount)} />
      <Table rowKey="id" dataSource={candidates} columns={columns} size="small" scroll={{ x: 950 }}
        pagination={{ current: page, pageSize, total: candidateTotal, showSizeChanger: true,
          pageSizeOptions: [10, 20, 50], showTotal: count => `共 ${count} 位候选人`,
          onChange: (nextPage, nextSize) => {
            setPageSize(nextSize);
            setPage(nextSize === pageSize ? nextPage : 1);
          } }} />
      <Card title="按岗位要求批量评估" style={{ marginBottom: 16 }}>
        <Text>当前岗位：{jobCriteria.title || '尚未设置'}。按当前平台与状态筛选，每次最多处理 100 份简历。</Text>
        <div style={{ marginTop: 10 }}>
          <Checkbox checked={pendingOnly} disabled={batch?.running}
            onChange={event => setPendingOnly(event.target.checked)}>
            只补评从未评分的简历（默认，不改动历史岗位评分）
          </Checkbox>
        </div>
        {!pendingOnly && <Alert type="warning" style={{ marginTop: 10 }}
          message="重新按当前岗位评估"
          description="会把历史岗位或旧版评分重新计算为当前岗位的 AI 结果，并覆盖原匹配分。" />}
        <Space wrap style={{ marginTop: 10 }}>
          <Button type="primary" icon={<RobotOutlined />} onClick={startBatchEvaluation}
            loading={busy === 'batch'} disabled={batch?.running || Boolean(emailBatch?.sentCount)}>
            {pendingOnly ? '补评未评分简历' : '按当前岗位重新评估'}
          </Button>
          {batch?.running && <Button onClick={stopBatchEvaluation}>停止</Button>}
          {batch?.startedAt && <Text>进度 {batch.processed}/{batch.total} · 新评估 {batch.evaluated} · 已跳过 {batch.skipped} · 失败 {batch.failed}</Text>}
        </Space>
        {batch?.paused && <Alert type="error" style={{ marginTop: 10 }}
          message="AI 评估已暂停" description={`${batch.pauseReason} 本批还有 ${Math.max(0, batch.total - batch.processed)} 份待补评。`} />}
        {evaluationQueue?.paused && <Alert type="error" style={{ marginTop: 10 }}
          message="新入库简历自动评估已暂停"
          description={`${evaluationQueue.pauseReason} 已保留 ${evaluationQueue.deferred} 份待补评简历；请在模型恢复后点击“批量评估岗位匹配”。`} />}
        {!batch?.paused && batch?.errors?.length > 0 && <Alert type="warning" style={{ marginTop: 10 }}
          message="部分简历评估失败" description={batch.errors.slice(-3).join('；')} />}
      </Card>
      <Card title="发件邮箱设置" style={{ marginBottom: 16 }}>
        <Text type="secondary">支持企业邮箱及提供标准 SMTP 的个人邮箱。配置仅保存在本机 backend/.env；授权码不会回显。</Text>
        <Row gutter={10} style={{ marginTop: 12 }}>
          <Col xs={24} md={12}><Text>SMTP 服务器</Text><Input value={smtpForm.host} placeholder="例如 smtp.企业域名"
            onChange={event => setSmtpForm({ ...smtpForm, host: event.target.value })} /></Col>
          <Col xs={24} md={5}><Text>端口</Text><InputNumber min={1} max={65535} style={{ width: '100%' }}
            value={smtpForm.port} onChange={value => setSmtpForm({ ...smtpForm, port: value ?? 587 })} /></Col>
          <Col xs={24} md={7}><Text>加密方式</Text><Select style={{ width: '100%' }} value={smtpForm.secure}
            onChange={value => setSmtpForm({ ...smtpForm, secure: value })}
            options={[{ value: 'auto', label: '自动（推荐）' }, { value: 'true', label: 'SSL/TLS' }, { value: 'false', label: 'STARTTLS/无' }]} /></Col>
        </Row>
        <Row gutter={10} style={{ marginTop: 10 }}>
          <Col xs={24} md={12}><Text>发件邮箱地址</Text><Input type="email" value={smtpForm.from}
            placeholder="发件人@公司域名" onChange={event => setSmtpForm({ ...smtpForm, from: event.target.value })} /></Col>
          <Col xs={24} md={12} style={{ paddingTop: 24 }}><Checkbox checked={smtpForm.authEnabled}
            onChange={event => setSmtpForm({ ...smtpForm, authEnabled: event.target.checked })}>需要账号密码或授权码</Checkbox>
            <Checkbox checked={smtpForm.requireTLS}
              onChange={event => setSmtpForm({ ...smtpForm, requireTLS: event.target.checked })}>强制 STARTTLS</Checkbox></Col>
        </Row>
        {smtpForm.authEnabled && <Row gutter={10} style={{ marginTop: 10 }}>
          <Col xs={24} md={12}><Text>SMTP 登录账号</Text><Input value={smtpForm.user}
            placeholder="通常是发件邮箱" onChange={event => setSmtpForm({ ...smtpForm, user: event.target.value })} /></Col>
          <Col xs={24} md={12}><Text>授权码或密码</Text><Input.Password value={smtpPassword}
            placeholder={emailConfig?.hasPassword ? '已保存；留空则保持原值' : '填写服务商提供的 SMTP 授权码'}
            onChange={event => setSmtpPassword(event.target.value)} /></Col>
        </Row>}
        <Space wrap style={{ marginTop: 12 }}>
          <Button type="primary" loading={busy === 'smtp-save'} onClick={saveSmtpConfig}>保存发件设置</Button>
          <Button disabled={!emailConfig?.configured} loading={busy === 'smtp-verify'}
            onClick={verifySmtp}>测试 SMTP 连接</Button>
          {emailConfig?.configured && <Tag color="green">已配置</Tag>}
        </Space>
      </Card>
      <Card title="发送候选人筛选报告和简历材料" style={{ marginBottom: 24 }}>
        <Space wrap style={{ marginBottom: 12 }}>
          <Text>最低岗位匹配分（默认 70；0 表示不限）</Text>
          <InputNumber min={0} max={100} value={minScore} disabled={Boolean(emailBatch?.sentCount)}
            onChange={value => setMinScore(value ?? 0)} />
          <Text>每封最多</Text>
          <InputNumber min={1} max={20} value={topN} disabled={Boolean(emailBatch?.sentCount)}
            onChange={value => setTopN(value ?? 10)} />
          <Text>份</Text>
          <Text>报告附件格式</Text>
          <Select style={{ width: 175 }} value={emailReportFormat} disabled={Boolean(emailBatch?.sentCount)}
            onChange={setEmailReportFormat}
            options={[{ value: 'docx', label: 'Word（推荐）' }, { value: 'md', label: 'Markdown' }]} />
          <Checkbox checked={emailNewOnly} disabled={Boolean(emailBatch?.sentCount)}
            onChange={event => {
              previewGeneration.current++;
              setEmailPreview(null);
              setEmailNewOnly(event.target.checked);
            }}>仅发送未发过的新候选人</Checkbox>
          <Button loading={busy === 'preview'} disabled={batch?.running ||
            Boolean(!emailNewOnly && emailBatch && emailBatch.nextOffset >= emailBatch.total)}
            onClick={previewEmail}>{emailBatch?.sentCount ? '预览下一批' : '预览候选人'}</Button>
          {emailBatch?.sentCount > 0 && <Button onClick={clearEmailBatch}>退出本轮</Button>}
        </Space>
        {emailBatch?.sentCount > 0 && <Alert style={{ marginBottom: 12 }} type="info"
          message={`本轮已发送 ${emailBatch.sentCount}/${emailBatch.total} 份；筛选条件已锁定，每批单独预览、确认，均附初筛报告。`}
          description={emailBatch.nextOffset < emailBatch.total
            ? '请点击“预览下一批”。刷新页面后填入同一收件邮箱即可恢复进度；候选人集合变化会暂停后续批次。'
            : '本轮已全部发送，请核对收件箱。'} />}
        {emailPreview && <Alert style={{ marginBottom: 12 }} type={emailPreview.count ? 'success' : 'warning'}
          message={emailNewOnly
            ? `新增候选人邮件预览：本封 ${emailPreview.count} 份，发送前共有 ${emailPreview.total} 份未发送`
            : `本批邮件预览：${emailPreview.count} 份（第 ${Math.floor(emailPreview.offset / topN) + 1}/${Math.max(1, Math.ceil(emailPreview.total / topN))} 批；合格总数 ${emailPreview.total} 份）`}
          description={<div>
            <div>本封附初筛报告：{reportFormatLabel(emailPreview.selection?.reportFormat || emailReportFormat)}</div>
            <div>{emailPreview.candidates.map(item => `${item.name}（${sourceLabel(item.source)}，${item.score}分；${item.attachmentType || '简历材料'}）`).join('、') || '请先填写本次岗位要求并完成对应的岗位评估。'}</div>
          </div>} />}
        <Space wrap>
          <Input style={{ width: 310 }} type="email" placeholder="先填收件邮箱；刷新后可恢复发送进度"
            value={emailTo} disabled={Boolean(emailBatch?.sentCount)}
            onChange={event => {
              previewGeneration.current++;
              setEmailPreview(null);
              setEmailTo(event.target.value);
            }} />
          <Button type="primary" icon={<MailOutlined />} loading={busy === 'send'}
            disabled={!emailConfig?.configured || !emailPreview?.count || batch?.running} onClick={sendEmail}>
            发送报告和简历附件
          </Button>
        </Space>
        {!emailConfig?.configured && <Alert showIcon type="info" style={{ marginTop: 12 }}
          message="请先在上方填写并保存发件邮箱设置" />}
      </Card>
      <Modal title={`${selected?.name || '候选人'} · ${sourceLabel(selected?.source)}`} open={Boolean(selected)}
        onCancel={() => setSelected(null)} footer={null} width={720} destroyOnClose>
        {selected && <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <div><Text>跟进状态：</Text><Select value={selected.workflowStatus || 'new'} style={{ width: 180 }}
            options={STATUSES} onChange={value => update({ status: value })} /></div>
          <div><Text>人工备注：</Text><Input.TextArea rows={3} maxLength={3000} value={notes}
            onChange={event => setNotes(event.target.value)} />
            <Button style={{ marginTop: 8 }} loading={busy === 'save'} onClick={() => update({ notes })}>保存备注</Button></div>
          <div><Text>当前岗位要求：</Text><Input.TextArea rows={4} value={jobRequirements}
            readOnly placeholder="请在上方岗位条件中填写或导入后保存" />
            <Button type="primary" icon={<RobotOutlined />} style={{ marginTop: 8 }}
              loading={busy === 'evaluate'} disabled={Boolean(emailBatch?.sentCount)}
              onClick={evaluate}>评估岗位匹配</Button></div>
          {selected.matchEvaluation && <Card size="small" title={`岗位匹配分 ${selected.matchScore}/100 · ${evaluationMethodLabel(selected.matchEvaluation)}`}>
            <p>{selected.matchEvaluation.summary}</p>
            <Text strong>相关优势：</Text><p>{selected.matchEvaluation.strengths?.join('；') || '暂无'}</p>
            <Text strong>待核实：</Text><p>{selected.matchEvaluation.gaps?.join('；') || '暂无'}</p>
          </Card>}
          {selected.sourceUrl && <a href={selected.sourceUrl} target="_blank" rel="noreferrer">在招聘平台查看原始页面</a>}
        </Space>}
      </Modal>
    </div>
  );
}
