import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, Form, Input, Spin, Typography, message } from 'antd';
import App from '../App';

const { Title, Text } = Typography;

async function authRequest(path, body) {
  const response = await fetch(`/api/auth/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin', cache: 'no-store',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.message || `请求失败 (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return result.data || {};
}

const shell = { minHeight: '100vh', display: 'grid', placeItems: 'center',
  padding: 20, background: 'linear-gradient(145deg,#edf5ff,#f6f8fc 55%,#e9f3ff)' };

export default function CompanyAuthGate({ onUnsupported = null }) {
  const [session, setSession] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const data = await authRequest('session');
      if (typeof data.authenticated !== 'boolean' || typeof data.setupRequired !== 'boolean') {
        if (onUnsupported) onUnsupported();
        else setError('服务器登录接口响应无效');
        return;
      }
      setSession(data);
      setError('');
    } catch (cause) {
      if (cause.status === 404 && onUnsupported) onUnsupported();
      else setError(cause.message);
    }
  }, [onUnsupported]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 60000);
    const visible = () => { if (!document.hidden) refresh(); };
    const unauthorized = () => refresh();
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('hiresmart:unauthorized', unauthorized);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('hiresmart:unauthorized', unauthorized);
    };
  }, [refresh]);

  const submit = async (path, values) => {
    setBusy(true);
    setError('');
    try { await authRequest(path, values); await refresh(); }
    catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  };
  const logout = async () => {
    try {
      await authRequest('logout', {});
      setSession({ authenticated: false, setupRequired: false });
    } catch {
      message.error('退出失败，请检查连接后重试');
    }
  };
  const changePassword = async (values) => {
    await authRequest('password', values);
    setSession({ authenticated: false, setupRequired: false });
  };
  if (session?.authenticated && session.user) {
    return <App companyAuth={{ user: session.user, logout, changePassword }} />;
  }
  return <div style={shell}>
    <Card style={{ width: 'min(100%, 440px)', borderRadius: 16, boxShadow: '0 18px 55px #18416d20' }}>
      <Title level={3} style={{ marginBottom: 4 }}>AI招聘</Title>
      <Text type="secondary">公司招聘助手 · 账号登录</Text>
      {error && <Alert type="error" showIcon message={error} style={{ marginTop: 20 }} />}
      {!session && !error && <div style={{ textAlign: 'center', padding: 32 }}><Spin /></div>}
      {!session && error && <Button onClick={refresh} style={{ marginTop: 20 }}>重试连接</Button>}
      {session?.setupRequired && !session.canSetup && <Alert type="info" showIcon
        style={{ marginTop: 24 }} message="等待管理员初始化"
        description="请在公司服务器本机浏览器打开此地址，先设置管理员密码。设置完成后刷新本页。" />}
      {session?.setupRequired && session.canSetup && <>
        <Alert type="info" showIcon style={{ marginTop: 20, marginBottom: 20 }}
          message="首次设置，仅在公司服务器上可操作"
          description="设置管理员 Mark 的密码。密码只保存为加盐哈希，且不会显示在页面或日志中。" />
        <Form layout="vertical" onFinish={values => submit('setup', values)}>
          <Form.Item label="管理员 Mark 的密码" name="adminPassword"
            rules={[{ required: true, min: 8, message: '至少 8 个字符' }]}>
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Form.Item label="确认密码" name="confirmPassword" dependencies={['adminPassword']}
            rules={[{ required: true, message: '请再次输入密码' }, ({ getFieldValue }) => ({
              validator(_, value) {
                return value === getFieldValue('adminPassword') ? Promise.resolve()
                  : Promise.reject(new Error('两次输入的密码不一致'));
              }
            })]}>
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={busy} block>创建管理员账号并进入系统</Button>
        </Form>
      </>}
      {session && !session.setupRequired && <Form layout="vertical" style={{ marginTop: 24 }}
        initialValues={{ username: 'Mark' }} onFinish={values => submit('login', values)}>
        <Form.Item name="username" label="账号" rules={[{ required: true }]}>
          <Input autoComplete="username" />
        </Form.Item>
        <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]}>
          <Input.Password autoComplete="current-password" />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={busy} block>登录</Button>
        <Text type="secondary" style={{ display: 'block', marginTop: 16 }}>
          登录有效期为 12 小时；退出后该账号的其他已登录窗口也会退出。
        </Text>
      </Form>}
    </Card>
  </div>;
}
