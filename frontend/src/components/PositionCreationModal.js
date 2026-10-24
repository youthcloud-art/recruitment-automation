import React, { useEffect, useState } from 'react';
import { Alert, Button, Input, Modal, Select, Space, Typography, message } from 'antd';
import { apiGet, apiPost } from '../utils/apiClient';
import JobCriteriaEditor, { EMPTY_JOB } from './JobCriteriaEditor';
import { notifyActiveJobChanged } from '../utils/activeJobEvents';

const { Paragraph, Text } = Typography;

export default function PositionCreationModal({ visible, onClose, onCreated, initialText = '', initialJob = null,
  initialMetadata = null, revisingPositionId = null }) {
  const [job, setJob] = useState({ ...EMPTY_JOB });
  const [metadata, setMetadata] = useState({ department: '', salary: '' });
  const [applyTo, setApplyTo] = useState('all');
  const [draftText, setDraftText] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!visible) return;
    const description = String(initialText || '').trim();
    const usefulDescription = description.length >= 10 &&
      !/我想创建一个新的岗位|请帮我生成岗位描述/.test(description) ? description : '';
    setDraftText(usefulDescription);
    setJob(initialJob ? { ...EMPTY_JOB, ...initialJob, updatedAt: null } : { ...EMPTY_JOB });
    setMetadata({ department: initialMetadata?.department || '',
      salary: initialMetadata?.salary || '' });
    setApplyTo('all');
  }, [visible, initialText, initialJob, initialMetadata]);

  const loadCurrent = async () => {
    try {
      const result = await apiGet('/recruitment-pipeline/active-job');
      if (!result.data?.title) {
        message.info('当前还没有已保存的岗位条件');
        return;
      }
      setJob({ ...EMPTY_JOB, ...result.data, updatedAt: null });
      message.success('已载入当前岗位条件，可修改后创建');
    } catch (error) { message.error('载入当前岗位失败：' + error.message); }
  };

  const create = async () => {
    if (!job.title?.trim() || !job.jobRequirements?.trim()) {
      message.warning('请填写岗位名称和详细岗位要求');
      return;
    }
    setBusy(true);
    try {
      const result = await apiPost(revisingPositionId
        ? `/positions/${encodeURIComponent(revisingPositionId)}/revise-local`
        : '/positions/create-local', { job, metadata, applyTo });
      if (!result.success) throw new Error(result.message || '创建岗位失败');
      notifyActiveJobChanged(result.job, applyTo);
      message.success(result.archivedPrevious ? '新版岗位已应用，旧版简历已移入历史岗位'
        : result.reused ? '已有岗位已重新应用' : '本地岗位已创建并应用');
      if (result.warning) message.warning(result.warning);
      onCreated?.(result);
      onClose?.();
    } catch (error) { message.error('创建岗位失败：' + error.message); }
    finally { setBusy(false); }
  };

  const generateDraft = async () => {
    setBusy(true);
    try {
      const result = await apiPost('/positions/draft-local', { description: draftText });
      setJob({ ...EMPTY_JOB, ...result.data, updatedAt: null });
      message.success(result.data?.title
        ? '已整理成可编辑的岗位描述草稿，请核对条件'
        : '已整理岗位要求，请补充岗位名称后核对条件');
    } catch (error) { message.error('整理岗位描述失败：' + error.message); }
    finally { setBusy(false); }
  };

  return (
    <Modal title={revisingPositionId ? '修订本地招聘岗位' : '创建本地招聘岗位'} open={visible} onCancel={onClose} width={920} zIndex={1200}
      style={{ top: 24 }} styles={{ body: { maxHeight: 'calc(100vh - 210px)', overflowY: 'auto' } }}
      destroyOnClose footer={[
        <Button key="cancel" onClick={onClose} disabled={busy}>取消</Button>,
        <Button key="create" type="primary" loading={busy} onClick={create}>
          {revisingPositionId ? '保存新版并应用' : '创建并应用'}</Button>
      ]}>
      <Alert type="info" showIcon style={{ marginBottom: 12 }}
        message="创建的是本机岗位与采集筛选条件，不会自动在招聘平台发布职位。"
        description={revisingPositionId
          ? '修改筛选条件会建立新版并应用；旧版岗位及其候选人会单独保留在历史岗位。'
          : '可描述岗位生成可编辑草稿、手填条件、用 Excel 模板导入，或载入当前岗位继续编辑。保存时选择应用到三平台或指定平台。'} />
      <Input.TextArea value={draftText} onChange={event => setDraftText(event.target.value)}
        rows={3} maxLength={5000} disabled={busy}
        placeholder="例如：招聘项目经理主管，至少 5 年项目管理经验，本科及以上，负责项目计划、交付和团队协调；希望获取 18 份简历。" />
      <Button style={{ marginTop: 8, marginBottom: 12 }} onClick={generateDraft}
        loading={busy} disabled={draftText.trim().length < 10}>根据描述整理可编辑 JD 草稿</Button>
      <Space style={{ marginBottom: 12 }}>
        <Button onClick={loadCurrent} disabled={busy}>载入当前岗位条件</Button>
        <Button onClick={() => setJob({ ...EMPTY_JOB })} disabled={busy}>清空重填</Button>
      </Space>
      <JobCriteriaEditor value={job} onChange={setJob} disabled={busy}
        persistImport={false} showSave={false} title="填写岗位条件 / 导入 Excel 模板" />
      <Space style={{ marginBottom: 16 }} wrap>
        <Text strong>应用范围</Text>
        <Select aria-label="应用范围" value={applyTo} onChange={setApplyTo}
          disabled={busy} style={{ width: 260 }} options={[
            { value: 'all', label: '智联、前程无忧、BOSS 三平台' },
            { value: 'zlzp', label: '仅智联招聘' },
            { value: 'qcwy', label: '仅前程无忧' },
            { value: 'boss', label: '仅 BOSS 直聘' }
          ]} />
        <Text type="secondary">未选中的平台继续使用原有岗位条件。</Text>
      </Space>
      <Space direction="vertical" style={{ width: '100%', marginBottom: 16 }}>
        <Text type="secondary">以下资料用于本地岗位列表展示，不作为平台搜索或 AI 评分条件。</Text>
        <Space wrap>
          <Input aria-label="所属部门" placeholder="所属部门（选填）" maxLength={100}
            style={{ width: 220 }} disabled={busy} value={metadata.department}
            onChange={event => setMetadata(current => ({ ...current, department: event.target.value }))} />
          <Input aria-label="薪资范围" placeholder="薪资范围（选填）" maxLength={100}
            style={{ width: 220 }} disabled={busy} value={metadata.salary}
            onChange={event => setMetadata(current => ({ ...current, salary: event.target.value }))} />
        </Space>
      </Space>
      {job.title && job.jobRequirements &&
        <div style={{ maxHeight: 160, overflowY: 'auto', whiteSpace: 'pre-wrap', padding: 12,
          background: '#f5f7fa', borderRadius: 6 }}>
          <Text strong>{job.title} · 岗位描述预览</Text>
          <Paragraph style={{ marginTop: 8, marginBottom: 0 }}>{job.jobRequirements}</Paragraph>
        </div>}
    </Modal>
  );
}
