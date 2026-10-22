import React, { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Empty, InputNumber, Modal, Select, Space, Spin, Tag, Typography } from 'antd';
import { ReloadOutlined, UserOutlined } from '@ant-design/icons';
import { apiGet } from '../utils/apiClient';
import ResumeDetailModal from './ResumeDetailModal';

const { Text } = Typography;
const SOURCE_LABELS = { boss: 'BOSS直聘', zlzp: '智联招聘', qcwy: '前程无忧' };

function emptyDescription(result) {
  if (!result?.job?.title) return '请先手填或导入岗位条件并应用，再采集、评估简历。';
  if (!result.evaluatedCount) return '当前岗位尚无按这版要求完成评估的简历。请先采集简历并在三平台候选人中批量评估。';
  return '当前筛选范围内没有达到分数线且具备可复核简历内容的候选人，可调整分数线或查看候选人管道。';
}

export default function ResumeRecommendationModal({ visible, onClose, onViewPipeline }) {
  const [source, setSource] = useState('');
  const [minScore, setMinScore] = useState(70);
  const [limit, setLimit] = useState(20);
  const [version, setVersion] = useState(0);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selectedResume, setSelectedResume] = useState(null);
  const [resumeBusyId, setResumeBusyId] = useState(null);
  const [resumeError, setResumeError] = useState('');
  const resumeRequest = useRef(0);

  useEffect(() => {
    // Closing or changing the recommendation filter invalidates a pending detail fetch.
    resumeRequest.current++;
    setSelectedResume(null);
    setResumeBusyId(null);
    setResumeError('');
  }, [visible, source, minScore, limit]);

  const openFullResume = async item => {
    const request = ++resumeRequest.current;
    setResumeBusyId(item.id);
    setResumeError('');
    try {
      const response = await apiGet(`/resume/${encodeURIComponent(item.id)}`);
      if (request !== resumeRequest.current) return;
      const resume = response?.data;
      if (!resume || String(resume.id) !== String(item.id) || resume.source !== item.source) {
        throw new Error('候选人详情与当前推荐卡不一致');
      }
      if (!String(resume.markdownContent || resume.parsedContent ||
        resume.originalText || resume.content || '').trim()) {
        throw new Error('这份简历没有可查看的正文');
      }
      setSelectedResume(resume);
    } catch (cause) {
      if (request === resumeRequest.current) {
        setResumeError(`打开完整简历失败：${cause.message || '请稍后重试'}`);
      }
    } finally {
      if (request === resumeRequest.current) setResumeBusyId(null);
    }
  };

  useEffect(() => {
    if (!visible) return undefined;
    let cancelled = false;
    setLoading(true);
    setError('');
    const params = { source, minScore };
    if (limit !== null) params.limit = limit;
    apiGet('/recruitment-pipeline/recommendations', params)
      .then(response => {
        if (!cancelled) setResult(response.data);
      })
      .catch(fetchError => {
        if (!cancelled) {
          setResult(null);
          setError(fetchError.message || '读取推荐结果失败');
        }
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [visible, source, minScore, limit, version]);

  return <>
    <Modal title={<Space><UserOutlined />简历推荐</Space>} open={visible} onCancel={onClose}
      footer={null} width={940} destroyOnHidden
      styles={{ body: { maxHeight: 'calc(100vh - 170px)', overflowY: 'auto' } }}>
      <Space wrap style={{ marginBottom: 14 }}>
        <Text>平台</Text>
        <Select aria-label="推荐平台" value={source} style={{ width: 145 }} onChange={setSource}
          options={[{ value: '', label: '全部平台' }, ...Object.entries(SOURCE_LABELS)
            .map(([value, label]) => ({ value, label }))]} />
        <Text>最低匹配分</Text>
        <InputNumber aria-label="推荐最低匹配分" min={0} max={100} precision={0}
          value={minScore} onChange={value => setMinScore(value ?? 70)} />
        <Text>展示份数</Text>
        <InputNumber aria-label="推荐展示份数" min={1} max={200} precision={0}
          placeholder="默认 20" value={limit} onChange={value => setLimit(value ?? 20)} />
        <Button icon={<ReloadOutlined />} onClick={() => setVersion(current => current + 1)}>刷新推荐</Button>
      </Space>
      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 14 }} />}
      {resumeError && <Alert type="error" showIcon message={resumeError} closable
        onClose={() => setResumeError('')} style={{ marginBottom: 14 }} />}
      {loading ? <div style={{ textAlign: 'center', padding: 45 }}><Spin tip="正在读取本机已评估简历" /></div> : result && <>
        <Alert type="info" showIcon style={{ marginBottom: 14 }}
          message={`当前岗位：${result.job.title || '尚未设置'} · 已评估 ${result.evaluatedCount} 份 · 符合条件 ${result.qualifiedCount} 份 · 当前展示 ${result.recommendations.length} 份`}
          description={result.job.recommendationTargetCount
            ? `岗位推荐目标 ${result.job.recommendationTargetCount} 份${result.targetShortfall === null
              ? '（当前按平台筛选，目标缺口请查看全部平台）'
              : `；目前还差 ${result.targetShortfall} 份`}。以下仅展示真实入库、同版岗位条件已评估且有简历内容的候选人。`
            : '仅展示真实入库、同版岗位条件已评估且有简历内容的候选人。匹配分供人工复核。'} />
        {result.recommendations.length ? result.recommendations.map((item, index) => (
          <Card key={item.id} size="small" style={{ marginBottom: 10 }}
            title={<Space wrap><Text strong>{index + 1}. {item.name}</Text>
              <Tag>{SOURCE_LABELS[item.source] || item.source}</Tag>
              <Tag color="blue">{item.matchScore}/100</Tag></Space>}>
            <Space wrap style={{ marginBottom: 8 }}>
              <Text type="secondary">求职岗位：{item.position || '未填写'}</Text>
              <Text type="secondary">经验：{item.experience || '未填写'}</Text>
              <Text type="secondary">学历：{item.education || '未填写'}</Text>
            </Space>
            <div>{item.summary || '评估摘要暂缺，请到候选人管道复核。'}</div>
            {item.strengths?.length > 0 && <div style={{ marginTop: 7 }}>
              <Text strong>岗位相关证据：</Text>{item.strengths.join('；')}
            </div>}
            {item.gaps?.length > 0 && <div style={{ marginTop: 7 }}>
              <Text strong>待核实：</Text>{item.gaps.join('；')}
            </div>}
            <Button type="link" style={{ paddingLeft: 0, marginTop: 4 }}
              loading={resumeBusyId === item.id} disabled={resumeBusyId !== null && resumeBusyId !== item.id}
              onClick={() => openFullResume(item)}>查看完整简历</Button>
          </Card>
        )) : <Empty description={emptyDescription(result)} style={{ padding: 25 }} />}
        <Space style={{ marginTop: 8 }}>
          <Text type="secondary">推荐不会替代人工复核，也不会自动联系候选人。</Text>
          <Button type="link" onClick={onViewPipeline}>前往三平台候选人</Button>
        </Space>
      </>}
    </Modal>
    <ResumeDetailModal visible={Boolean(selectedResume)} readOnly resume={selectedResume}
      onClose={() => setSelectedResume(null)} />
  </>;
}
