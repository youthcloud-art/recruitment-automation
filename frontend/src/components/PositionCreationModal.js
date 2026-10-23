import React, { useEffect, useState } from 'react';
import { Alert, Button, Input, Modal, Space, Typography, message } from 'antd';
import { apiGet, apiPost } from '../utils/apiClient';
import JobCriteriaEditor, { EMPTY_JOB } from './JobCriteriaEditor';

const { Paragraph, Text } = Typography;

export default function PositionCreationModal({ visible, onClose, onCreated, initialText = '', initialJob = null }) {
  const [job, setJob] = useState({ ...EMPTY_JOB });
  const [draftText, setDraftText] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!visible) return;
    const description = String(initialText || '').trim();
    const usefulDescription = description.length >= 10 &&
      !/我想创建一个新的岗位|请帮我生成岗位描述/.test(description) ? description : '';
    setDraftText(usefulDescription);
    setJob(initialJob ? { ...EMPTY_JOB, ...initialJob, updatedAt: null } : { ...EMPTY_JOB });
  }, [visible, initialText, initialJob]);

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
      const result = await apiPost('/positions/create-local', { job });
      if (!result.success) throw new Error(result.message || '创建岗位失败');
      message.success(result.reused ? '已有岗位已重新应用到三平台' : '本地岗位已创建并应用到三平台');
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
    <Modal title="创建本地招聘岗位" open={visible} onCancel={onClose} width={920} zIndex={1200}
      style={{ top: 24 }} styles={{ body: { maxHeight: 'calc(100vh - 210px)', overflowY: 'auto' } }}
      destroyOnClose footer={[
        <Button key="cancel" onClick={onClose} disabled={busy}>取消</Button>,
        <Button key="create" type="primary" loading={busy} onClick={create}>创建并应用到三平台</Button>
      ]}>
      <Alert type="info" showIcon style={{ marginBottom: 12 }}
        message="创建的是本机岗位与采集筛选条件，不会自动在招聘平台发布职位。"
        description="可描述岗位生成可编辑草稿、手填条件、用 Excel 模板导入，或载入当前岗位继续编辑。只有点击“创建并应用到三平台”才会替换当前采集岗位。" />
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
      {job.title && job.jobRequirements &&
        <div style={{ maxHeight: 160, overflowY: 'auto', whiteSpace: 'pre-wrap', padding: 12,
          background: '#f5f7fa', borderRadius: 6 }}>
          <Text strong>{job.title} · 岗位描述预览</Text>
          <Paragraph style={{ marginTop: 8, marginBottom: 0 }}>{job.jobRequirements}</Paragraph>
        </div>}
    </Modal>
  );
}
