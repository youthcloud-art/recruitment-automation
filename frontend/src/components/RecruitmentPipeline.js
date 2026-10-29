import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Checkbox, Col, Input, InputNumber, Modal, Row, Select, Space, Table, Tag, Typography, message } from 'antd';
import { DeleteOutlined, DownloadOutlined, InfoCircleOutlined, MailOutlined, ReloadOutlined, RobotOutlined } from '@ant-design/icons';
import { apiGet, apiPatch, apiPost, apiPut } from '../utils/apiClient';
import JobCriteriaEditor, { EMPTY_JOB } from './JobCriteriaEditor';
import { ACTIVE_JOB_CHANGED } from '../utils/activeJobEvents';
import './RecruitmentPipeline.css';

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
  const [loadedListKey, setLoadedListKey] = useState('');
  const [listLoadError, setListLoadError] = useState(false);
  const [availableJobs, setAvailableJobs] = useState([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [source, setSource] = useState(sourceRequest?.source || '');
  const [viewJobTitle, setViewJobTitle] = useState('');
  const [viewJobGroup, setViewJobGroup] = useState('');
  const [scoreOrder, setScoreOrder] = useState('createdAt');
  const [showGuide, setShowGuide] = useState(() => {
    try { return window.localStorage.getItem('recruitment-pipeline-guide') !== 'hidden'; }
    catch (_) { return true; }
  });
  const [showJobEditor, setShowJobEditor] = useState(false);
  const [reportMinScore, setReportMinScore] = useState(0);
  const [reportCount, setReportCount] = useState(null);
  const [reportPreview, setReportPreview] = useState(null);
  const [reportPreviewBusy, setReportPreviewBusy] = useState(false);
  const [reportRevision, setReportRevision] = useState(0);
  const [selectedHistoryIds, setSelectedHistoryIds] = useState([]);
  const [status, setStatus] = useState('');
  const [keyword, setKeyword] = useState('');
  const [jobRequirements, setJobRequirements] = useState('');
  const [jobCriteria, setJobCriteria] = useState(EMPTY_JOB);
  const [selected, setSelected] = useState(null);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState('');
  const [locating, setLocating] = useState(false);
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
  const reportGeneration = useRef(0);
  const listKey = JSON.stringify([source, status, keyword, viewJobTitle,
    viewJobGroup, scoreOrder, page, pageSize]);
  const listMatchesQuery = loadedListKey === listKey;

  const toggleGuide = () => setShowGuide(previous => {
    try { window.localStorage.setItem('recruitment-pipeline-guide', previous ? 'hidden' : 'visible'); }
    catch (_) { /* Page still works when storage is disabled. */ }
    return !previous;
  });

  useEffect(() => {
    setSource(sourceRequest?.source || '');
    setViewJobTitle('');
    setViewJobGroup('');
    setPage(1);
  }, [sourceRequest]);

  useEffect(() => { setSelectedHistoryIds([]); },
    [source, status, keyword, viewJobTitle, viewJobGroup, scoreOrder, page, pageSize]);

  const refresh = useCallback(async () => {
    const generation = ++listGeneration.current;
    setListLoadError(false);
    try {
      const [list, stats, jobs] = await Promise.all([
        apiGet('/recruitment-pipeline/candidates/page', {
          source, status, keyword, jobTitle: viewJobTitle, jobGroup: viewJobGroup,
          sortBy: scoreOrder,
          limit: pageSize, offset: (page - 1) * pageSize
        }),
        apiGet('/recruitment-pipeline/summary'),
        apiGet('/recruitment-pipeline/candidates/jobs')
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
      setLoadedListKey(listKey);
      setSummary(stats.data || {});
      setAvailableJobs(jobs.data || []);
      setSelected(current => current
        ? (data.items || []).find(item => item.id === current.id) || current
        : null);
    } catch (error) {
      if (generation === listGeneration.current) {
        setListLoadError(true);
        message.error('读取候选人失败：' + error.message);
      }
    }
  }, [source, status, keyword, viewJobTitle, viewJobGroup, scoreOrder, page, pageSize, listKey]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    const generation = ++reportGeneration.current;
    if (!viewJobTitle || !viewJobGroup) {
      setReportPreview(null);
      setReportPreviewBusy(false);
      return;
    }
    setReportPreviewBusy(true);
    const timer = setTimeout(() => {
      apiGet('/recruitment-pipeline/report/preview', {
        jobTitle: viewJobTitle, jobGroup: viewJobGroup, source, status, keyword,
        minScore: reportMinScore
      }).then(result => {
        if (generation === reportGeneration.current) setReportPreview(result.data);
      }).catch(error => {
        if (generation === reportGeneration.current) {
          setReportPreview(null);
          message.error('读取报告份数失败：' + error.message);
        }
      }).finally(() => {
        if (generation === reportGeneration.current) setReportPreviewBusy(false);
      });
    }, 250);
    return () => clearTimeout(timer);
  }, [viewJobTitle, viewJobGroup, source, status, keyword, reportMinScore, candidateTotal, reportRevision]);
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
    const onJobChanged = event => {
      const job = event.detail?.job;
      if (!job?.title) return;
      setJobCriteria(job);
      setJobRequirements(job.jobRequirements || '');
      setReportRevision(value => value + 1);
      refresh();
    };
    window.addEventListener(ACTIVE_JOB_CHANGED, onJobChanged);
    return () => window.removeEventListener(ACTIVE_JOB_CHANGED, onJobChanged);
  }, [refresh]);
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
    let active = false;
    let polling = false;
    const poll = async () => {
      if (polling || document.hidden) return;
      polling = true;
      try {
        const result = await apiGet('/recruitment-pipeline/evaluate-batch/status');
        setBatch(result.data);
        if (previousRunning && !result.data.running) refresh();
        previousRunning = result.data.running;
        active = Boolean(result.data.running);
      } catch (_) { /* 手动刷新仍可用 */ }
      try {
        const result = await apiGet('/recruitment-pipeline/evaluation-queue/status');
        setEvaluationQueue(result.data);
        active = active || Boolean(result.data?.running || result.data?.queued);
        const queueChange = ['completed', 'failed', 'deferred', 'overflowed']
          .map(field => result.data?.[field] || 0).join(':');
        if (lastEvaluationQueueChange.current !== null &&
            lastEvaluationQueueChange.current !== queueChange) {
          refresh();
          setReportRevision(value => value + 1);
        }
        lastEvaluationQueueChange.current = queueChange;
      } catch (_) { /* 旧版服务端仍可显示批量评估进度 */ }
      finally { polling = false; }
    };
    poll();
    let ticks = 0;
    const timer = setInterval(() => {
      ticks++;
      if (active || ticks % 5 === 0) poll();
    }, 2000);
    window.addEventListener('focus', poll);
    return () => { clearInterval(timer); window.removeEventListener('focus', poll); };
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
      if (changes.status) setReportRevision(value => value + 1);
      message.success('跟进记录已保存');
    } catch (error) { message.error(error.message); }
    finally { setBusy(''); }
  };

  const evaluate = async () => {
    if (selected?.jobGroup === 'historical') {
      message.warning('该简历属于历史/已删除岗位，恢复并应用原岗位后才能重新评估');
      return;
    }
    if (selected?.hiringJobTitle && selected.hiringJobTitle !== '招聘岗位待核实' &&
        jobCriteria.title && selected.hiringJobTitle !== jobCriteria.title) {
      message.warning(`这份简历归属“${selected.hiringJobTitle}”，请先应用该岗位条件后再评估`);
      return;
    }
    if (!selected || !jobCriteria.updatedAt || jobRequirements !== jobCriteria.jobRequirements) {
      message.warning('请先在列表下方保存并应用岗位条件');
      return;
    }
    setBusy('evaluate');
    try {
      const result = await apiPost(`/recruitment-pipeline/candidates/${encodeURIComponent(selected.id)}/evaluate`, { jobRequirements });
      setSelected(previous => ({ ...previous, matchScore: result.data.score, matchEvaluation: result.data }));
      await refresh();
      setReportRevision(value => value + 1);
      message.success(`${evaluationMethodLabel(result.data)}已完成`);
    } catch (error) { message.error(error.message); }
    finally { setBusy(''); }
  };

  const reportSelectedCount = Math.min(500, reportPreview?.eligibleCount || 0,
    reportCount === null ? 500 : reportCount);

  const downloadReport = async format => {
    if (!viewJobTitle || !viewJobGroup) return message.warning('请先选择一个招聘岗位，再导出该岗位的初筛报告');
    if (!reportSelectedCount) return message.warning('当前条件下暂无已完成有效评估且达到分数线的简历');
    setBusy(`report-${format}`);
    try {
      const blob = await apiGet('/recruitment-pipeline/report',
        { source, status, keyword, jobTitle: viewJobTitle, jobGroup: viewJobGroup,
          minScore: reportMinScore, topN: reportSelectedCount, format },
        { responseType: 'blob' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${viewJobTitle.replace(/[\\/:*?"<>|]/g, '_')}-初筛报告-${reportSelectedCount}份.${format}`;
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

  const locateOnServer = async candidate => {
    setLocating(true);
    try {
      const result = await apiPost('/browser-console/locate-candidate', { candidateId: candidate.id });
      if (result.data?.recovered && result.data?.recordId) {
        setSelected(previous => previous?.id === candidate.id ? {
          ...previous, platformRecordId:result.data.recordId,
          platformLocatorStatus:'platform_card', sourceCandidateId:result.data.recordId,
          sourceCandidateIdSource:'platform_card'
        } : previous);
        refresh();
      }
      message.success(result.data?.recovered ? '已核对原候选卡并补录 BOSS 平台编号' :
        '已在公司服务器专用浏览器打开目标候选人');
      window.dispatchEvent(new CustomEvent('company-browser-open', {
        detail: { platform: candidate.source === 'zlzp' ? 'zhilian'
          : candidate.source === 'qcwy' ? 'wuyou' : 'boss' }
      }));
    } catch (error) { message.error(error.message || '定位失败，请在服务器浏览器核对'); }
    finally { setLocating(false); }
  };

  const confirmDeleteHistorical = (ids, title) => {
    Modal.confirm({
      title: `永久删除 ${ids.length} 份历史岗位简历？`,
      content: `岗位：${title}。只删除所选的 ${ids.length} 份本机候选人记录，不删除岗位或其他平台/岗位的简历；删除后不能撤销。`,
      okText: '确认删除所选简历', okType: 'danger', cancelText: '取消', zIndex: 1300,
      onOk: async () => {
        const result = await apiPost('/recruitment-pipeline/candidates/historical/delete',
          { ids, jobTitle: title });
        if (!result.success) throw new Error(result.message || '删除失败');
        message.success(`已删除 ${result.data.count} 份历史岗位简历`);
        setSelectedHistoryIds([]);
        setSelected(null);
        setPage(1);
        refresh();
      }
    });
  };

  const columns = [
    { title: '平台', dataIndex: 'source', width: 115, render: sourceLabel },
    { title: '候选人', dataIndex: 'name', width: 170, render: value => {
      const label = value || '未识别姓名';
      const needsReview = /未识别|待核实|平台脱敏|平台称呼/.test(label);
      return <span>{label}{needsReview && <Tag color="gold" style={{ marginLeft: 5 }}>待核实</Tag>}</span>;
    } },
    { title: '平台记录号', dataIndex: 'platformRecordId', width: 190,
      render: (value, row) => value
        ? <Text copyable={{ text: value }} ellipsis={{ tooltip: `${value} · 平台编号未必支持关键词搜索，请从详情定位` }} style={{ maxWidth: 150 }}>
            {value}</Text>
        : <Tag color="gold" title="本机简历号或文本指纹不能代替招聘平台的唯一编号">待平台核实</Tag> },
    { title: '招聘岗位', dataIndex: 'hiringJobTitle', width: 175,
      render: value => value && value !== '招聘岗位待核实' ? value :
        <Tag color="gold">招聘岗位待核实</Tag> },
    { title: '岗位归属', dataIndex: 'jobGroup', width: 125,
      render: value => <Tag color={value === 'current' ? 'green' : 'default'}>
        {value === 'current' ? '在用岗位' : '历史/已删除'}</Tag> },
    { title: '求职岗位', width: 180, render: (_, row) => row.position || row.expectedPosition?.position ||
      (typeof row.expectedPosition === 'string' ? row.expectedPosition : '未填写') },
    { title: '岗位匹配分', dataIndex: 'matchScore', width: 160,
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
    <div className="recruitment-pipeline">
      <div className="pipeline-heading">
        <div><Title level={3} style={{ marginBottom: 4 }}>三平台候选人管道</Title>
          <Text type="secondary">先查看候选人，再按岗位、平台与评分缩小范围；岗位条件可在列表下方展开。</Text></div>
        <Button icon={<InfoCircleOutlined />} onClick={toggleGuide}>
          {showGuide ? '收起说明' : '显示说明'}
        </Button>
      </div>
      {showGuide && <Alert showIcon type="info" className="pipeline-guide"
        message="三平台简历在这里统一跟进和导出。前程无忧已适配的成本核算经理/主管岗位使用本机专用规则，其他岗位与平台使用 DeepSeek AI 辅助评估；评估方式以每份简历的明细为准，分数仅供人工复核。" />
      }
      <Row gutter={[12, 12]} className="pipeline-summary">
        {SOURCES.map(item => <Col xs={24} sm={12} lg={8} key={item.value}>
          <Card size="small" title={item.label}>
            <Text strong>{summary[item.value]?.total || 0} 份简历</Text>
            <div><Text type="secondary">待重点查看 {summary[item.value]?.byStatus?.shortlisted || 0} · 已联系 {summary[item.value]?.byStatus?.contacted || 0}</Text></div>
          </Card>
        </Col>)}
      </Row>
      <Space wrap className="pipeline-toolbar">
        <Select aria-label="招聘岗位筛选" value={viewJobTitle
          ? JSON.stringify({ title: viewJobTitle, jobGroup: viewJobGroup }) : ''}
          style={{ width: 280 }} showSearch optionFilterProp="label"
          onChange={value => {
            const selectedJob = value ? JSON.parse(value) : { title: '', jobGroup: '' };
            setViewJobTitle(selectedJob.title);
            setViewJobGroup(selectedJob.jobGroup);
            setPage(1);
          }}
          options={[{ value: '', label: `全部招聘岗位（${availableJobs.reduce((count, job) => count + job.total, 0)}）` },
            ...availableJobs.map(job => ({ value: JSON.stringify({ title: job.title, jobGroup: job.jobGroup }),
              label: `${job.jobGroup === 'current' ? '在用岗位' : '历史/已删除'} · ${job.title}（${job.total}）` }))]} />
        <Select value={source} style={{ width: 155 }} disabled={Boolean(emailBatch?.sentCount)}
          onChange={value => { setSource(value); setPage(1); }}
          options={[{ value: '', label: '全部平台' }, ...SOURCES]} />
        <Select value={status} style={{ width: 155 }} disabled={Boolean(emailBatch?.sentCount)}
          onChange={value => { setStatus(value); setPage(1); }}
          options={[{ value: '', label: '全部状态' }, ...STATUSES]} />
        <Select aria-label="匹配分排序" value={scoreOrder} style={{ width: 165 }}
          onChange={value => { setScoreOrder(value); setPage(1); }}
          options={[{ value: 'createdAt', label: '按入库时间' },
            { value: 'scoreDesc', label: '匹配分从高到低' },
            { value: 'scoreAsc', label: '匹配分从低到高' }]} />
        <Input.Search placeholder="搜索姓名、岗位、平台记录号" allowClear style={{ width: 245 }}
          onSearch={value => { setKeyword(value); setPage(1); }}
          onChange={event => { if (!event.target.value && keyword) { setKeyword(''); setPage(1); } }} />
        <Button icon={<ReloadOutlined />} onClick={() => {
          previewGeneration.current++;
          setEmailPreview(null);
          refresh();
          setReportRevision(value => value + 1);
        }}>刷新</Button>
        <Button onClick={() => {
          setShowJobEditor(true);
          setTimeout(() => document.getElementById('pipeline-job-editor')?.scrollIntoView({ block: 'start' }), 0);
        }}>设置岗位条件</Button>
        {viewJobGroup === 'historical' && viewJobTitle && <Button danger icon={<DeleteOutlined />}
          disabled={!selectedHistoryIds.length || Boolean(batch?.running)}
          onClick={() => confirmDeleteHistorical(selectedHistoryIds, viewJobTitle)}>
          删除已选历史简历（{selectedHistoryIds.length}）</Button>}
      </Space>
      <div className="pipeline-context" role="status">
        <Text strong>当前查看：</Text><Text>{viewJobTitle
          ? `${viewJobGroup === 'current' ? '在用岗位' : '历史/已删除'} · ${viewJobTitle}`
          : '全部招聘岗位'} · {source ? sourceLabel(source) : '全部平台'} · {listMatchesQuery
            ? `${candidateTotal} 位候选人` : listLoadError ? '读取失败' : '正在读取…'}</Text>
        {showGuide && <Text type="secondary">岗位、平台与状态可组合筛选；未评估简历排在评分列表末尾。不同岗位条件版本的分数不能直接比较。</Text>}
      </div>
      <Card size="small" className="pipeline-report" title="按实际岗位导出初筛报告">
        <Space wrap>
          <Text>{viewJobTitle
            ? `${viewJobGroup === 'current' ? '在用' : '历史'} · ${viewJobTitle}`
            : '请先在上方选择一个岗位'}</Text>
          <Text>最低匹配分</Text>
          <InputNumber aria-label="报告最低匹配分" min={0} max={100} precision={0}
            value={reportMinScore} onChange={value => setReportMinScore(value ?? 0)} />
          <Text>报告份数</Text>
          <Select aria-label="报告份数方式" value={reportCount === null ? 'all' : 'custom'}
            style={{ width: 158 }} onChange={value => setReportCount(value === 'all' ? null : 1)}
            options={[{ value: 'all', label: '全部符合条件' }, { value: 'custom', label: '指定份数' }]} />
          {reportCount !== null && <InputNumber aria-label="指定报告份数" min={1} max={500}
            precision={0} value={reportCount} onChange={value => setReportCount(value ?? 1)} />}
          <Button type="primary" icon={<DownloadOutlined />} loading={busy === 'report-docx'}
            disabled={!viewJobTitle || reportPreviewBusy || !reportSelectedCount}
            onClick={() => downloadReport('docx')}>导出 Word（{reportSelectedCount} 份）</Button>
          <Button icon={<DownloadOutlined />} loading={busy === 'report-md'}
            disabled={!viewJobTitle || reportPreviewBusy || !reportSelectedCount}
            onClick={() => downloadReport('md')}>导出 Markdown（{reportSelectedCount} 份）</Button>
        </Space>
        <div className="pipeline-report-note"><Text type="secondary">
          {viewJobTitle ? reportPreviewBusy ? '正在核对本岗位可导出份数…'
            : `本次筛选共 ${reportPreview?.total || 0} 份，已有效评估且达到分数线 ${reportPreview?.eligibleCount || 0} 份；单份报告最多 500 份。`
            : '报告按所选岗位、平台、状态和搜索关键词生成；默认排除人工标记为“不合适”的简历。'}
        </Text></div>
      </Card>
      <Table rowKey="id" dataSource={listMatchesQuery ? candidates : []}
        loading={!listMatchesQuery && !listLoadError}
        columns={columns} size="small" scroll={{ x: 1440 }}
        rowSelection={viewJobGroup === 'historical' && viewJobTitle ? {
          selectedRowKeys: selectedHistoryIds,
          onChange: keys => setSelectedHistoryIds(keys),
          getCheckboxProps: row => ({ disabled: row.jobGroup !== 'historical' })
        } : undefined}
        pagination={{ current: page, pageSize,
          total: listMatchesQuery ? candidateTotal : 0, showSizeChanger: true,
          pageSizeOptions: [10, 20, 50], showTotal: count => `共 ${count} 位候选人`,
          onChange: (nextPage, nextSize) => {
            setPageSize(nextSize);
            setPage(nextSize === pageSize ? nextPage : 1);
          } }} />
      <div id="pipeline-job-editor" className="pipeline-job-section">
        <div className="pipeline-section-heading">
          <div><Title level={4} style={{ marginBottom: 2 }}>岗位条件</Title>
            <Text type="secondary">当前应用：{jobCriteria.title || '尚未设置'}。新采集和批量评估使用这里保存的条件。</Text></div>
          <Button onClick={() => setShowJobEditor(value => !value)}>
            {showJobEditor ? '收起岗位条件' : '展开岗位条件'}
          </Button>
        </div>
        {showJobEditor && <JobCriteriaEditor value={jobCriteria}
          onChange={job => {
            setJobCriteria(job);
            setJobRequirements(job.jobRequirements || '');
          }} showHelp={showGuide}
          disabled={Boolean(batch?.running || emailBatch?.sentCount)} />}
      </div>
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
          <div><Text>招聘岗位：{selected.hiringJobTitle || '招聘岗位待核实'}</Text>
            {selected.name === '姓名待核实' && <Text type="warning"> · 平台未提供可核实姓名，请在原始页面确认</Text>}</div>
          <div><Text strong>{selected.platformRecordKind || '平台记录号'}：</Text>
            {selected.platformRecordId
              ? <Text copyable={{ text: selected.platformRecordId }}>{selected.platformRecordId}</Text>
              : <Text type="warning">平台未提供可验证编号；本机简历号不能用于平台查找</Text>}
            {selected.platformRecordId && <div><Text type="secondary">平台记录号用于核对身份，招聘平台的关键词搜索框未必支持按此编号查询。</Text></div>}
            {selected.platformLocatorStatus === 'platform_card' &&
              <div><Text type="secondary">编号来自平台候选卡；可在服务器当前岗位结果中按编号定位。</Text></div>}
            {selected.platformRecordId && ((selected.source === 'boss' &&
              ['platform_card','official_url'].includes(selected.platformLocatorStatus)) ||
              (selected.platformLocatorStatus === 'official_url' &&
              ['zlzp', 'qcwy'].includes(selected.source))) &&
              <Button style={{ marginTop: 8 }} loading={locating} onClick={() => locateOnServer(selected)}>
                在公司服务器浏览器定位原候选人
              </Button>}
            {!selected.platformRecordId && selected.source === 'boss' &&
              (selected.platformLocatorStatus === 'unavailable') &&
              (selected.sourceCardFingerprint
                ? <div><Button style={{ marginTop: 8 }} loading={locating}
                    onClick={() => locateOnServer(selected)}>核对候选卡并补录平台编号</Button>
                  <div><Text type="secondary">请先在服务器 BOSS 浏览器打开该招聘岗位的原候选结果。</Text></div>
                </div>
                : <div><Text type="secondary">这份旧记录没有可核对的候选卡证据；重新采集同一官方简历后，系统可据完整简历内容补录编号。</Text></div>)}
          </div>
          {selected.jobGroup === 'historical' && <Alert type="info" showIcon
            message="历史/已删除岗位简历已单独保留"
            description="可查看、记录跟进或单独删除；重新评估前请先在岗位管理中恢复并应用原岗位。" />}
          {selected.jobGroup === 'historical' && <Button danger icon={<DeleteOutlined />}
            disabled={Boolean(batch?.running)}
            onClick={() => confirmDeleteHistorical([selected.id], selected.hiringJobTitle || '招聘岗位待核实')}>
            删除这份历史简历</Button>}
          <div><Text>跟进状态：</Text><Select value={selected.workflowStatus || 'new'} style={{ width: 180 }}
            options={STATUSES} onChange={value => update({ status: value })} /></div>
          <div><Text>人工备注：</Text><Input.TextArea rows={3} maxLength={3000} value={notes}
            onChange={event => setNotes(event.target.value)} />
            <Button style={{ marginTop: 8 }} loading={busy === 'save'} onClick={() => update({ notes })}>保存备注</Button></div>
          <div><Text>当前岗位要求：</Text><Input.TextArea rows={4} value={jobRequirements}
            readOnly placeholder="请在上方岗位条件中填写或导入后保存" />
            <Button type="primary" icon={<RobotOutlined />} style={{ marginTop: 8 }}
              loading={busy === 'evaluate'} disabled={Boolean(emailBatch?.sentCount) || selected.jobGroup === 'historical'}
              onClick={evaluate}>评估岗位匹配</Button></div>
          {selected.matchEvaluation && <Card size="small" title={`岗位匹配分 ${selected.matchScore}/100 · ${evaluationMethodLabel(selected.matchEvaluation)}`}>
            <p>{selected.matchEvaluation.summary}</p>
            <Text strong>相关优势：</Text><p>{selected.matchEvaluation.strengths?.join('；') || '暂无'}</p>
            <Text strong>待核实：</Text><p>{selected.matchEvaluation.gaps?.join('；') || '暂无'}</p>
          </Card>}
          {selected.source === 'zlzp'
            ? <Text type="secondary">智联详情依赖官方搜索结果；直接打开保存的地址不会自动恢复原候选人弹窗。请使用上方的服务器浏览器定位，并以详情简历号核对。</Text>
            : selected.platformRecordUrl
              ? <a href={selected.platformRecordUrl} target="_blank" rel="noreferrer">在当前电脑打开官方来源页面</a>
              : <Text type="secondary">当前来源地址无法精准定位该候选人，已隐藏通用链接。</Text>}
        </Space>}
      </Modal>
    </div>
  );
}
