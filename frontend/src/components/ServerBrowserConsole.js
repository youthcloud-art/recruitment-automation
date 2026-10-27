import React, { useEffect, useRef, useState } from 'react';
import { Alert, Button, Input, Modal, Select, Space, Tag, Typography } from 'antd';
import { DesktopOutlined } from '@ant-design/icons';
import { apiGet, apiPost } from '../utils/apiClient';

const ROOT = '/browser-console';
const PLATFORMS = [
  { value: 'boss', label: 'Boss直聘' },
  { value: 'zhilian', label: '智联招聘' },
  { value: 'wuyou', label: '前程无忧' }
];
const KEYS = [['Tab', '切换输入框'], ['Enter', '回车'], ['Backspace', '退格'],
  ['Escape', '关闭弹层'], ['Control+A', '全选']];

export function screenshotPoint(event, frame) {
  const box = event.currentTarget.getBoundingClientRect();
  if (!box.width || !box.height || !frame?.width || !frame?.height) return null;
  return {
    x: Math.max(0, Math.min(frame.width - 1, Math.floor((event.clientX - box.left) * frame.width / box.width))),
    y: Math.max(0, Math.min(frame.height - 1, Math.floor((event.clientY - box.top) * frame.height / box.height)))
  };
}

function newClientId() {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID() : `console-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function ServerBrowserConsole() {
  const [status, setStatus] = useState(null);
  const [open, setOpen] = useState(false);
  const [platform, setPlatform] = useState('boss');
  const [frame, setFrame] = useState(null);
  const [leased, setLeased] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [acting, setActing] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const clientId = useRef(newClientId());
  const visible = useRef(false);
  const currentPlatform = useRef(platform);
  const hasLease = useRef(false);
  const leaseAt = useRef(0);
  const connection = useRef(null);
  const frameRequest = useRef(null);
  const manualAction = useRef(false);
  const pendingRelease = useRef(Promise.resolve());
  const generation = useRef(0);
  const sessionStarted = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    apiGet(`${ROOT}/status`).then(result => {
      if (mounted.current) setStatus(result.data);
    }).catch(() => { /* Local deployments do not expose this feature. */ });
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    const openLocatedCandidate = event => {
      const requested = event.detail?.platform;
      if (!PLATFORMS.some(item => item.value === requested)) return;
      setPlatform(requested);
      setOpen(true);
    };
    window.addEventListener('company-browser-open', openLocatedCandidate);
    return () => window.removeEventListener('company-browser-open', openLocatedCandidate);
  }, []);

  const release = () => {
    if (!sessionStarted.current) return Promise.resolve();
    pendingRelease.current = apiPost(`${ROOT}/release`, { clientId: clientId.current }).catch(() => {});
    return pendingRelease.current;
  };

  const getFrame = async selected => {
    if (frameRequest.current) return frameRequest.current;
    const pending = (async () => {
      const result = await apiGet(`${ROOT}/screenshot`, { platform: selected, clientId: clientId.current }, { cache: 'no-store' });
      const next = result.data;
      if (!/^data:image\/(?:png|jpe?g);base64,/.test(next?.image || '') || !Number.isFinite(next.width) || next.width <= 0 || !Number.isFinite(next.height) || next.height <= 0) {
        throw new Error('服务器返回的浏览器画面无效，请重新连接');
      }
      if (mounted.current && visible.current && currentPlatform.current === selected && hasLease.current) setFrame(next);
    })();
    frameRequest.current = pending;
    try { return await pending; }
    finally { if (frameRequest.current === pending) frameRequest.current = null; }
  };

  const frameBusy = cause => /画面正在刷新|浏览器正在处理其他操作/.test(cause?.message || '');

  const connect = async selected => {
    const requestedGeneration = generation.current;
    if (connection.current) await connection.current.catch(() => {});
    await pendingRelease.current;
    if (!visible.current || currentPlatform.current !== selected || generation.current !== requestedGeneration) return;
    setConnecting(true);
    setError('');
    hasLease.current = false;
    setLeased(false);
    setFrame(null);
    sessionStarted.current = true;
    const pending = apiPost(`${ROOT}/session`, { platform: selected, clientId: clientId.current });
    connection.current = pending;
    try {
      await pending;
      if (!mounted.current || !visible.current) { await release(); return; }
      if (currentPlatform.current !== selected || generation.current !== requestedGeneration) return;
      leaseAt.current = Date.now();
      hasLease.current = true;
      setLeased(true);
      try { await getFrame(selected); }
      catch (cause) { if (!frameBusy(cause)) throw cause; }
    } catch (cause) {
      if (mounted.current && visible.current && currentPlatform.current === selected && generation.current === requestedGeneration) {
        hasLease.current = false;
        setLeased(false);
        setError(cause.message || '浏览器连接失败');
      }
    } finally {
      if (connection.current === pending) connection.current = null;
      if (mounted.current && visible.current && currentPlatform.current === selected && generation.current === requestedGeneration) setConnecting(false);
    }
  };

  useEffect(() => {
    if (!open) return undefined;
    visible.current = true;
    currentPlatform.current = platform;
    let disposed = false;
    let polling = false;
    connect(platform);
    const poll = async () => {
      if (disposed || polling || manualAction.current) return;
      polling = true;
      try {
        const next = await apiGet(`${ROOT}/status`, {}, { cache: 'no-store' });
        if (disposed) return;
        setStatus(next.data);
        if (!hasLease.current) return;
        if (Date.now() - leaseAt.current >= 20000) {
          await apiPost(`${ROOT}/session`, { platform, clientId: clientId.current });
          if (disposed) return;
          leaseAt.current = Date.now();
        }
        if (manualAction.current) return;
        await getFrame(platform);
      } catch (cause) {
        if (!disposed && !/画面正在刷新|浏览器正在处理其他操作/.test(cause.message || '')) {
          hasLease.current = false;
          setLeased(false);
          setFrame(null);
          setText('');
          setError(cause.message || '浏览器连接已断开，请重新连接');
        }
      } finally { polling = false; }
    };
    const timer = setInterval(poll, 2000);
    return () => { disposed = true; clearInterval(timer); };
    // Session lifetime follows the selected platform; polling uses refs for the lease.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, platform]);

  useEffect(() => () => {
    visible.current = false;
    hasLease.current = false;
    if (connection.current) connection.current.finally(release).catch(() => {});
    else release();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = () => {
    generation.current += 1;
    visible.current = false;
    hasLease.current = false;
    setOpen(false);
    setLeased(false);
    setText('');
    setFrame(null);
    setError('');
    if (connection.current) connection.current.finally(release).catch(() => {});
    else release();
  };

  const changePlatform = value => {
    generation.current += 1;
    currentPlatform.current = value;
    hasLease.current = false;
    setLeased(false);
    setText('');
    setFrame(null);
    setPlatform(value);
  };

  const selected = status?.platforms?.find(item => item.id === platform);
  const disabled = !leased || connecting || acting || Boolean(selected?.running);

  const action = async body => {
    if (disabled || !hasLease.current) return;
    setActing(true);
    manualAction.current = true;
    setError('');
    const selectedPlatform = platform;
    try {
      if (frameRequest.current) await frameRequest.current.catch(() => {});
      await apiPost(`${ROOT}/action`, { platform: selectedPlatform, clientId: clientId.current, ...body });
      if (visible.current && currentPlatform.current === selectedPlatform) {
        try { await getFrame(selectedPlatform); }
        catch (cause) { if (!frameBusy(cause)) throw cause; }
      }
    } catch (cause) {
      if (visible.current && currentPlatform.current === selectedPlatform) setError(cause.message || '操作失败，请重试');
    } finally { manualAction.current = false; if (mounted.current) setActing(false); }
  };

  const sendText = () => {
    if (!text || disabled) return;
    const value = text;
    setText('');
    action({ action: 'type', text: value });
  };

  const restoreWindow = async () => {
    if (disabled || !hasLease.current) return;
    setActing(true);
    manualAction.current = true;
    setError('');
    try {
      if (frameRequest.current) await frameRequest.current.catch(() => {});
      await apiPost(`${ROOT}/restore-window`, { platform, clientId: clientId.current });
      // Another operator's short screenshot can begin just after the window
      // was maximized. Keep the successful restore and let polling refresh.
      try { await getFrame(platform); }
      catch (cause) { if (!frameBusy(cause)) throw cause; }
    } catch (cause) { setError(cause.message || '未能恢复服务器浏览器窗口'); }
    finally { manualAction.current = false; if (mounted.current) setActing(false); }
  };

  if (!status?.enabled) return null;

  return <>
    <Button icon={<DesktopOutlined />} onClick={() => setOpen(true)}>服务器浏览器</Button>
    <Modal title="服务器浏览器 · 手动登录" open={open} onCancel={close} footer={null} width={1120} destroyOnClose>
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Typography.Text>在对应招聘平台启动浏览器后，可在这里查看服务器画面并手动扫码、输入或处理验证码。关闭窗口会释放操作权。</Typography.Text>
        <Space wrap>
          <Select aria-label="招聘平台" value={platform} options={PLATFORMS} onChange={changePlatform} style={{ width: 160 }} disabled={connecting || acting} />
          <Tag color={leased ? 'success' : status?.lock?.held ? 'warning' : 'default'}>{leased ? '当前由你操作' : status?.lock?.held ? '其他同事正在操作' : '尚未连接'}</Tag>
          {!leased && <Button loading={connecting} disabled={connecting} onClick={() => connect(platform)}>连接浏览器</Button>}
          {leased && <Button disabled={disabled} loading={acting} onClick={restoreWindow}>
            恢复并最大化窗口
          </Button>}
        </Space>
        {selected?.running && <Alert type="warning" showIcon message="此平台正在采集简历，画面可查看。请先停止采集再手动操作浏览器。" />}
        {selected && !selected.available && <Alert type="info" showIcon message="请先在此平台的采集页面启动或初始化浏览器，再点击连接浏览器。" />}
        {error && <Alert type="error" showIcon message={error} />}
        <div style={{ minHeight: 180, maxHeight: '55vh', overflow: 'auto', background: '#eef2f6', border: '1px solid #d9d9d9', borderRadius: 6 }}>
          {frame ? <img alt="服务器浏览器画面" src={frame.image} draggable={false}
            style={{ display: 'block', width: '100%', height: 'auto', cursor: disabled ? 'default' : 'crosshair' }}
            onClick={event => { const point = screenshotPoint(event, frame); if (point) action({ action: 'click', ...point }); }} />
            : <div style={{ padding: 48, textAlign: 'center', color: '#666' }}>{connecting ? '正在连接服务器浏览器…' : '连接后显示浏览器画面，约每 2 秒刷新一次'}</div>}
        </div>
        <Space.Compact style={{ width: '100%' }}>
          <Input.Password aria-label="发送到浏览器的文字" value={text} onChange={event => setText(event.target.value)} onPressEnter={sendText}
            placeholder="先点击画面中的输入框，再输入账号、密码或验证码" autoComplete="off" visibilityToggle={false} maxLength={512} disabled={disabled} />
          <Button type="primary" onClick={sendText} disabled={disabled || !text}>发送文字</Button>
        </Space.Compact>
        <Space wrap>
          {KEYS.map(([key, label]) => <Button key={key} disabled={disabled} onClick={() => action({ action: 'key', key })}>{label}</Button>)}
          <Button disabled={disabled} onClick={() => action({ action: 'scroll', deltaY: -600 })}>向上滚动</Button>
          <Button disabled={disabled} onClick={() => action({ action: 'scroll', deltaY: 600 })}>向下滚动</Button>
        </Space>
      </Space>
    </Modal>
  </>;
}
