import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Form, Input, Spin, message } from 'antd';
import App from '../App';
import campusImage from '../assets/unionwell-campus.jpg';
import './CompanyAuthGate.css';

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
      message.destroy();
    } catch {
      message.error('退出失败，请检查连接后重试');
    }
  };
  const changePassword = async (values) => {
    await authRequest('password', values);
    setSession({ authenticated: false, setupRequired: false });
    message.destroy();
  };
  if (session?.authenticated && session.user) {
    return <App companyAuth={{ user: session.user, logout, changePassword }} />;
  }
  return <div className="company-auth-shell">
    <div className="company-auth-frame">
      <aside className="company-auth-visual" aria-label="公司园区">
        <img src={campusImage} alt="" aria-hidden="true" />
        <div className="company-auth-visual-content">
          <span className="company-auth-visual-label">UNIONWELL · HIRESMART</span>
          <div>
            <h2>让合适的人才<br />与机会相遇</h2>
            <p>以清晰的流程，连接岗位与候选人。</p>
          </div>
        </div>
      </aside>
      <main className="company-auth-panel">
        <div className="company-auth-panel-inner">
          <div className="company-auth-brand"><span className="company-auth-brand-mark">H</span><span>HireSmart</span></div>
          <h1>{session?.setupRequired ? '设置管理员账号' : '欢迎回来'}</h1>
          <p className="company-auth-intro">登录 AI 招聘工作台，继续管理岗位、候选人与招聘任务。</p>
          <div className="company-auth-form-card">
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
      {session && !session.setupRequired && <Form layout="vertical"
        onFinish={values => submit('login', values)}>
        <Form.Item name="username" label="账号" rules={[{ required: true }]}>
          <Input autoComplete="username" placeholder="请输入账号" />
        </Form.Item>
        <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]}>
          <Input.Password autoComplete="current-password" placeholder="请输入密码" />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={busy} block>登录</Button>
      </Form>}
          </div>
          <p className="company-auth-footnote">公司内部招聘工作台</p>
        </div>
      </main>
    </div>
  </div>;
}
