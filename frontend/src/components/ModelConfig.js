import React, { useEffect, useState } from 'react';
import { Alert, Button, Card, Form, Input, Select, Space, Tag, Typography, message } from 'antd';
import { apiGet, apiPost, apiPut } from '../utils/apiClient';

const { Title, Paragraph, Text } = Typography;

export default function ModelConfig() {
  const [form] = Form.useForm();
  const [config, setConfig] = useState(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  useEffect(() => {
    let mounted = true;
    apiGet('/model-config').then(result => {
      if (!mounted) return;
      setConfig(result.data);
      form.setFieldsValue({ model: result.data.model?.startsWith('deepseek-') ? result.data.model : 'deepseek-chat' });
    }).catch(error => message.error(error.message));
    return () => { mounted = false; };
  }, [form]);

  const save = async values => {
    setSaving(true);
    setTestResult(null);
    try {
      const result = await apiPut('/model-config', values);
      setConfig(result.data);
      form.setFieldValue('apiKey', '');
      message.success('模型配置已保存并立即生效');
    } catch (error) {
      message.error(error.message);
    } finally { setSaving(false); }
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await apiPost('/model-config/test');
      setTestResult(result.data.connected ? { type: 'success', text: `真实调用成功，当前模型：${result.data.model}` } :
        { type: 'error', text: 'DeepSeek 未返回有效结果' });
    } catch (error) {
      setTestResult({ type: 'error', text: error.message });
    } finally { setTesting(false); }
  };

  return <div style={{ padding: 24, maxWidth: 780, margin: '0 auto', overflowY: 'auto', height: '100%' }}>
    <Title level={2}>模型配置</Title>
    <Paragraph>DeepSeek 用于候选人简历评估、智能对话和相关 AI 功能。配置保存在本机，保存后立即用于新的请求。</Paragraph>
    <Card title="DeepSeek API" extra={<Tag color={config?.configured ? 'success' : 'warning'}>{config?.configured ? '已配置' : '未配置'}</Tag>}>
      <Form form={form} layout="vertical" onFinish={save} initialValues={{ model: 'deepseek-chat' }}>
        <Form.Item name="apiKey" label="API Key" extra={config?.configured ? '已存在密钥；留空可沿用当前密钥。页面不会显示现有密钥。' : '请填写 DeepSeek 控制台创建的 API Key。'}>
          <Input.Password placeholder={config?.configured ? '留空保持现有密钥' : 'sk-…'} autoComplete="new-password" />
        </Form.Item>
        <Form.Item name="model" label="模型" rules={[{ required: true }]}>
          <Select options={[{ value: 'deepseek-flash', label: 'DeepSeek Flash / deepseek-flash' }, { value: 'deepseek-chat', label: 'DeepSeek Chat / deepseek-chat' }, { value: 'deepseek-reasoner', label: 'DeepSeek Reasoner / deepseek-reasoner' }]} />
        </Form.Item>
        <Space>
          <Button type="primary" htmlType="submit" loading={saving}>保存配置</Button>
          <Button onClick={test} loading={testing} disabled={!config?.configured}>测试真实连接</Button>
        </Space>
      </Form>
      {testResult && <Alert style={{ marginTop: 16 }} type={testResult.type} showIcon message={testResult.text} />}
      <Paragraph style={{ marginTop: 16, marginBottom: 0 }}><Text type="secondary">测试会发送一条不含候选人信息的短消息；每次测试会产生少量 API 用量。</Text></Paragraph>
    </Card>
  </div>;
}
