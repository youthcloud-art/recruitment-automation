import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, Checkbox, Col, Input, InputNumber, Row, Select, Space, Tag, Typography, message } from 'antd';
import { apiGet, apiPost, apiPut } from '../utils/apiClient';

const { Text } = Typography;
const INITIAL = {
  host: 'imap.qq.com', port: 993, security: 'tls', user: '', folder: 'INBOX',
  senderAllowlist: '@51job.com', jobTitle: '', jobKeywords: '', jobRequirements: '',
  pollMinutes: 15, maxMessages: 20, enabled: false
};
const titleFromRequirements = value =>
  String(value || '').match(/^\s*岗位[：:]\s*([^\n（(。；;]+)/)?.[1]?.trim() || '';

export default function QcwyInboxSettings({ jobRequirements }) {
  const [form, setForm] = useState(INITIAL);
  const [password, setPassword] = useState('');
  const [configured, setConfigured] = useState(false);
  const [hasPassword, setHasPassword] = useState(false);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState('');

  const refreshStatus = useCallback(() => {
    apiGet('/qcwy-inbox/status').then(result => setStatus(result.data)).catch(() => {});
  }, []);

  useEffect(() => {
    apiGet('/qcwy-inbox/config').then(result => {
      const data = result.data || {};
      setForm({ ...INITIAL, ...data,
        host: data.host || INITIAL.host,
        user: data.user || INITIAL.user,
        senderAllowlist: data.senderAllowlist || INITIAL.senderAllowlist,
        jobTitle: data.jobTitle || titleFromRequirements(jobRequirements),
        jobRequirements: data.jobRequirements || jobRequirements || '' });
      setConfigured(Boolean(data.configured));
      setHasPassword(Boolean(data.hasPassword));
    }).catch(() => {});
    refreshStatus();
    const timer = setInterval(refreshStatus, 4000);
    return () => clearInterval(timer);
  }, [refreshStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!jobRequirements) return;
    setForm(previous => ({ ...previous,
      jobRequirements: previous.jobRequirements || jobRequirements,
      jobTitle: previous.jobTitle || titleFromRequirements(jobRequirements)
    }));
  }, [jobRequirements]);

  const change = (field, value) => setForm(previous => ({ ...previous, [field]: value }));

  const save = async () => {
    setBusy('save');
    try {
      const result = await apiPut('/qcwy-inbox/config', { ...form, password });
      setForm({ ...INITIAL, ...result.data });
      setConfigured(Boolean(result.data.configured));
      setHasPassword(Boolean(result.data.hasPassword));
      setPassword('');
      refreshStatus();
      message.success('收件配置和岗位要求已保存到本机；开启自动同步后将定时收取');
    } catch (error) { message.error('保存失败：' + error.message); }
    finally { setBusy(''); }
  };

  const verify = async () => {
    setBusy('verify');
    try {
      await apiPost('/qcwy-inbox/verify', {});
      message.success('IMAP 连接和文件夹验证成功，未读取简历');
    } catch (error) { message.error(error.message); }
    finally { setBusy(''); }
  };

  const sync = async () => {
    setBusy('sync');
    try {
      const result = await apiPost('/qcwy-inbox/sync', {});
      setStatus(result.data);
      message.success('已开始同步符合条件的简历邮件');
    } catch (error) { message.error(error.message); }
    finally { setBusy(''); }
  };

  const stop = async () => {
    setBusy('stop');
    try {
      const result = await apiPost('/qcwy-inbox/stop', {});
      setStatus(result.data);
      change('enabled', false);
      message.info('自动同步已停止；当前邮件处理完成后结束');
    } catch (error) { message.error(error.message); }
    finally { setBusy(''); }
  };

  return <Card title="前程无忧官方邮件自动同步" style={{ marginBottom: 16 }}>
    <Alert showIcon type="info" style={{ marginBottom: 12 }}
      message="适用于前程无忧官方推送或转发到企业邮箱的简历附件"
      description="配置一次 IMAP 邮箱、发件人筛选白名单和岗位条件后，系统会定时只读收取 PDF/DOCX/TXT 附件，在本机去重并按岗位要求评估。已适配的成本核算经理/主管岗位使用本机专用规则，其他岗位使用 DeepSeek AI。首次默认只检查最近 20 封邮件，后续按邮件 UID 继续收取；可调整每轮上限。预填的 @51job.com 只是示例，请先在邮箱中确认平台真实邮件及实际发件地址；白名单本身不验证邮件身份。仅登录前程无忧网页不会使历史简历自动入库；若邮件只有通知链接而无简历附件，还需平台提供授权数据接口或正式导出。" />
    <Row gutter={10}>
      <Col xs={24} md={10}><Text>IMAP 服务器</Text><Input value={form.host} placeholder="例如 imap.企业域名"
        onChange={event => change('host', event.target.value)} /></Col>
      <Col xs={24} md={5}><Text>端口</Text><InputNumber min={1} max={65535} style={{ width: '100%' }}
        value={form.port} onChange={value => change('port', value ?? 993)} /></Col>
      <Col xs={24} md={9}><Text>加密方式</Text><Select value={form.security} style={{ width: '100%' }}
        onChange={value => change('security', value)} options={[
          { value: 'tls', label: 'SSL/TLS（通常 993）' },
          { value: 'starttls', label: '强制 STARTTLS（通常 143）' }
        ]} /></Col>
    </Row>
    <Row gutter={10} style={{ marginTop: 10 }}>
      <Col xs={24} md={12}><Text>收件邮箱账号</Text><Input value={form.user} placeholder="接收官方简历邮件的邮箱"
        onChange={event => change('user', event.target.value)} /></Col>
      <Col xs={24} md={12}><Text>IMAP 授权码或密码</Text><Input.Password value={password}
        placeholder={hasPassword ? '已保存；留空保持原值' : '填写 IMAP 授权码'}
        onChange={event => setPassword(event.target.value)} /></Col>
    </Row>
    <Row gutter={10} style={{ marginTop: 10 }}>
      <Col xs={24} md={8}><Text>邮箱文件夹</Text><Input value={form.folder} placeholder="INBOX"
        onChange={event => change('folder', event.target.value)} /></Col>
      <Col xs={24} md={16}><Text>发件人筛选白名单</Text><Input value={form.senderAllowlist}
        placeholder="例如 notification@example.com 或 @example.com；多个用逗号分隔"
        onChange={event => change('senderAllowlist', event.target.value)} /></Col>
    </Row>
    <Row gutter={10} style={{ marginTop: 10 }}>
      <Col xs={24} md={10}><Text>岗位名称</Text><Input value={form.jobTitle} placeholder="例如 成本核算经理"
        onChange={event => change('jobTitle', event.target.value)} /></Col>
      <Col xs={24} md={14}><Text>邮件匹配关键词</Text><Input value={form.jobKeywords}
        placeholder="可加岗位别称，多个用逗号分隔"
        onChange={event => change('jobKeywords', event.target.value)} /></Col>
    </Row>
    <div style={{ marginTop: 10 }}><Text>岗位要求（新简历将自动在本机评估）</Text>
      <Input.TextArea rows={3} maxLength={5000} value={form.jobRequirements}
        onChange={event => change('jobRequirements', event.target.value)}
        placeholder="填写岗位职责、必备技能和工作经验" />
      {jobRequirements && <Button size="small" onClick={() => change('jobRequirements', jobRequirements)}>
        使用上方已填写的岗位要求</Button>}
    </div>
    <Space wrap style={{ marginTop: 10 }}>
      <Text>每</Text><InputNumber min={5} max={1440} value={form.pollMinutes}
        onChange={value => change('pollMinutes', value ?? 15)} /><Text>分钟检查</Text>
      <Text>每轮最多</Text><InputNumber min={1} max={50} value={form.maxMessages}
        onChange={value => change('maxMessages', value ?? 20)} /><Text>封</Text>
      <Checkbox checked={form.enabled} onChange={event => change('enabled', event.target.checked)}>
        开启自动同步</Checkbox>
    </Space>
    <Space wrap style={{ marginTop: 12 }}>
      <Button type="primary" loading={busy === 'save'} onClick={save}>保存收件和岗位设置</Button>
      <Button disabled={!configured} loading={busy === 'verify'} onClick={verify}>测试 IMAP 连接</Button>
      <Button disabled={!configured || status?.running} loading={busy === 'sync'} onClick={sync}>立即同步一次</Button>
      {(status?.scheduled || status?.running) && <Button loading={busy === 'stop'} onClick={stop}>停止自动同步</Button>}
      {configured && <Tag color="green">已配置</Tag>}
      {status?.scheduled && <Tag color="blue">定时同步中</Tag>}
    </Space>
    {status && <div style={{ marginTop: 10 }}><Text type="secondary">
      {status.running ? '正在同步' : '上次同步结束'} · 已检查 {status.processedMessages} 封 · 新入库 {status.imported} 份
      · 去重 {status.duplicates} 份 · 本机评估 {status.evaluated} 份
      · 无支持附件 {status.noSupportedAttachment} 封 · 过大邮件/附件 {status.tooLarge} 项 · 失败 {status.failed} 项
      {status.lastSyncAt ? ` · ${new Date(status.lastSyncAt).toLocaleString('zh-CN')}` : ''}
    </Text></div>}
    {status?.lastError && <Alert type="warning" showIcon style={{ marginTop: 10 }} message={status.lastError} />}
    {status?.deadLetters?.length > 0 && <Alert type="warning" showIcon style={{ marginTop: 10 }}
      message={`${status.deadLetters.length} 封邮件在多次解析失败后被隔离`}
      description={`请核查错误发生时间附近的前程无忧原邮件；必要时可人工上传那封邮件的附件。技术编号与原因：${status.deadLetters.map(item => `UID ${item.uid}（${item.reason}）`).join('；')}`} />}
  </Card>;
}
