import React, { useRef, useState } from 'react';
import { Alert, Button, Card, Col, Input, InputNumber, Row, Space, Tag, Typography, message } from 'antd';
import { DownloadOutlined, SaveOutlined, UploadOutlined } from '@ant-design/icons';
import { apiGet, apiPut, apiUpload } from '../utils/apiClient';

const { Text } = Typography;
export const EMPTY_JOB = {
  title: '', searchKeywords: '', location: '', education: '',
  minExperienceYears: null, targetCount: null, recommendationTargetCount: null,
  jobRequirements: '', updatedAt: null
};

export default function JobCriteriaEditor({ value = EMPTY_JOB, onChange, disabled = false,
  persistImport = true, showSave = true, showHelp = true,
  title = '岗位条件（采集前设置）' }) {
  const [busy, setBusy] = useState('');
  const fileInput = useRef(null);
  const job = { ...EMPTY_JOB, ...(value || {}) };
  const setField = (field, content) => onChange({ ...job, [field]: content, updatedAt: null });

  const save = async () => {
    setBusy('save');
    try {
      const result = await apiPut('/recruitment-pipeline/active-job', job);
      onChange(result.data);
      message.success('岗位条件已保存在本机，三个平台将使用这份配置');
    } catch (error) { message.error('保存岗位条件失败：' + error.message); }
    finally { setBusy(''); }
  };

  const downloadTemplate = async () => {
    setBusy('download');
    try {
      const blob = await apiGet('/recruitment-pipeline/active-job/template', {},
        { responseType: 'blob' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = '岗位条件模板.xlsx';
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { message.error('下载岗位条件模板失败：' + error.message); }
    finally { setBusy(''); }
  };

  const importFile = async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (fileInput.current) fileInput.current.value = '';
    if (!/\.xlsx$/i.test(file.name) || file.size > 1_500_000) {
      message.error('请选择不超过 1.5 MB 的 .xlsx 岗位条件文件');
      return;
    }
    setBusy('import');
    try {
      const body = new FormData();
      body.append('file', file);
      const result = await apiUpload(persistImport
        ? '/recruitment-pipeline/active-job/import'
        : '/recruitment-pipeline/active-job/preview-import', body);
      onChange(persistImport ? result.data : { ...result.data, updatedAt: null });
      message.success(persistImport ? '岗位条件已导入并保存，可在页面继续修改'
        : '岗位条件已读取，请检查后点击“创建并应用”');
    } catch (error) { message.error('导入岗位条件失败：' + error.message); }
    finally { setBusy(''); }
  };

  return (
    <Card title={title} style={{ marginBottom: 16 }}>
      <Space wrap style={{ marginBottom: 12 }}>
        <Button icon={<DownloadOutlined />} loading={busy === 'download'}
          onClick={downloadTemplate}>下载岗位条件模板</Button>
        <Button icon={<UploadOutlined />} loading={busy === 'import'}
          disabled={disabled} onClick={() => fileInput.current?.click()}>导入已填写模板</Button>
        <input ref={fileInput} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          style={{ display: 'none' }} onChange={importFile} />
        {showSave && <Button type="primary" icon={<SaveOutlined />} loading={busy === 'save'}
          disabled={disabled} onClick={save}>保存并应用岗位</Button>}
        {showSave && (job.updatedAt ? <Tag color="green">已保存并应用</Tag>
          : <Tag color="gold">{job.title ? '有未保存的修改' : '尚未设置岗位'}</Tag>)}
      </Space>
      <Row gutter={12}>
        <Col xs={24} md={12}>
          <Text>岗位名称（必填）</Text>
          <Input value={job.title} maxLength={100} disabled={disabled}
            placeholder="例如：成本核算经理"
            onChange={event => setField('title', event.target.value)} />
        </Col>
        <Col xs={24} md={12}>
          <Text>搜索关键词（选填，默认岗位名称）</Text>
          <Input value={job.searchKeywords} maxLength={200} disabled={disabled}
            placeholder="多个词用逗号分隔，最多 10 个"
            onChange={event => setField('searchKeywords', event.target.value)} />
        </Col>
      </Row>
      <Row gutter={12} style={{ marginTop: 10 }}>
        <Col xs={24} md={8}>
          <Text>工作地点</Text>
          <Input value={job.location} maxLength={100} disabled={disabled}
            placeholder="例如：深圳"
            onChange={event => setField('location', event.target.value)} />
        </Col>
        <Col xs={24} md={8}>
          <Text>最低经验（年）</Text>
          <InputNumber min={0} max={50} precision={0} style={{ width: '100%' }}
            value={job.minExperienceYears} disabled={disabled}
            onChange={number => setField('minExperienceYears', number)} />
        </Col>
        <Col xs={24} md={8}>
          <Text>最低学历</Text>
          <Input value={job.education} maxLength={100} disabled={disabled}
            placeholder="例如：本科及以上"
            onChange={event => setField('education', event.target.value)} />
        </Col>
      </Row>
      <Row gutter={12} style={{ marginTop: 10 }}>
        <Col xs={24} md={12}>
          <Text>推荐名单目标人数（所有平台合计，不限制采集）</Text>
          <InputNumber min={1} max={200} precision={0} style={{ width: '100%' }}
            value={job.recommendationTargetCount} disabled={disabled}
            onChange={number => setField('recommendationTargetCount', number)} />
        </Col>
        <Col xs={24} md={12}>
          <Text>单次采集目标份数（按本次新入库自动停止，前程无忧最多 30）</Text>
          <InputNumber min={1} max={200} precision={0} style={{ width: '100%' }}
            value={job.targetCount} disabled={disabled}
            onChange={number => setField('targetCount', number)} />
        </Col>
      </Row>
      <div style={{ marginTop: 10 }}>
        <Text>详细岗位要求（必填，用于简历匹配评估）</Text>
        <Input.TextArea rows={5} maxLength={5000} value={job.jobRequirements}
          disabled={disabled} placeholder="填写必需技能、经验、职责及加分条件；导入模板后可继续编辑"
          onChange={event => setField('jobRequirements', event.target.value)} />
      </div>
      {(showHelp || (job.recommendationTargetCount && !job.targetCount)) &&
      <Alert type={job.recommendationTargetCount && !job.targetCount ? 'warning' : 'info'}
        showIcon style={{ marginTop: 12 }}
        message={job.recommendationTargetCount && !job.targetCount
          ? `推荐名单目标为 ${job.recommendationTargetCount} 人，单次采集目标尚未设置；请填写上方采集份数，或在平台页面确认本次目标。`
          : '岗位名称和关键词用于平台检索；详细条件用于采后评估。推荐人数与单次采集目标分别设置；每次任务按本次新入库份数停止。'} />}
    </Card>
  );
}
