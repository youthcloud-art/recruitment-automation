import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ServerBrowserConsole, { screenshotPoint } from './ServerBrowserConsole';
import { apiGet, apiPost } from '../utils/apiClient';

jest.mock('../utils/apiClient', () => ({ apiGet: jest.fn(), apiPost: jest.fn() }));
jest.mock('@ant-design/icons', () => ({ DesktopOutlined: () => null }));
jest.mock('antd', () => {
  const React = require('react');
  const Space = ({ children }) => <div>{children}</div>;
  Space.Compact = Space;
  return {
    Alert: ({ message }) => <div role="alert">{message}</div>,
    Button: ({ children, onClick, disabled, loading }) => <button onClick={onClick} disabled={disabled || loading}>{children}</button>,
    Input: { Password: ({ visibilityToggle, onPressEnter, ...props }) => <input type="password" {...props} onKeyDown={event => { if (event.key === 'Enter') onPressEnter(); }} /> },
    Modal: ({ open, title, onCancel, children }) => open ? <section aria-label={title}>{children}<button onClick={onCancel}>关闭窗口</button></section> : null,
    Select: ({ options, onChange, style, ...props }) => <select {...props} onChange={event => onChange(event.target.value)}>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>,
    Space, Tag: ({ children }) => <span>{children}</span>, Typography: { Text: ({ children }) => <span>{children}</span> }
  };
});

const status = { enabled: true, lock: { held: false }, platforms: [
  { id: 'boss', available: true, running: false },
  { id: 'zhilian', available: true, running: false },
  { id: 'wuyou', available: true, running: false }
] };
const frame = { image: 'data:image/png;base64,ZmFrZQ==', width: 1000, height: 500 };

beforeEach(() => {
  jest.clearAllMocks();
  apiGet.mockImplementation(url => Promise.resolve({ success: true, data: url.endsWith('/status') ? status : frame }));
  apiPost.mockResolvedValue({ success: true, data: { platform: 'boss' } });
});
afterEach(() => { cleanup(); jest.useRealTimers(); });

async function openConsole() {
  fireEvent.click(await screen.findByRole('button', { name: '服务器浏览器' }));
  return screen.findByAltText('服务器浏览器画面');
}

test('本地后端未启用时隐藏入口，卸载也不申请或释放操作锁', async () => {
  apiGet.mockResolvedValue({ success: true, data: { enabled: false } });
  const view = render(<ServerBrowserConsole />);
  await waitFor(() => expect(apiGet).toHaveBeenCalledWith('/browser-console/status'));
  expect(screen.queryByRole('button', { name: '服务器浏览器' })).toBeNull();
  view.unmount();
  expect(apiPost).not.toHaveBeenCalled();
});

test('缩放截图的点击准确映射到服务器像素，并携带当前操作锁', async () => {
  render(<ServerBrowserConsole />);
  const image = await openConsole();
  image.getBoundingClientRect = () => ({ left: 10, top: 20, width: 500, height: 250 });
  await act(async () => { fireEvent.click(image, { clientX: 260, clientY: 145 }); });
  await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/browser-console/action', expect.objectContaining({
    platform: 'boss', clientId: expect.any(String), action: 'click', x: 500, y: 250
  })));
});

test('文字以密码框输入，发送后立即清空；关闭窗口释放锁', async () => {
  render(<ServerBrowserConsole />);
  await openConsole();
  const input = screen.getByLabelText('发送到浏览器的文字');
  expect(input.type).toBe('password');
  fireEvent.change(input, { target: { value: 'manual-code' } });
  fireEvent.click(screen.getByRole('button', { name: '发送文字' }));
  expect(input.value).toBe('');
  await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/browser-console/action', expect.objectContaining({ action: 'type', text: 'manual-code' })));
  fireEvent.click(screen.getByRole('button', { name: '关闭窗口' }));
  await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/browser-console/release', { clientId: expect.any(String) }));
  expect(screen.queryByAltText('服务器浏览器画面')).toBeNull();
});

test('采集中只显示画面，禁用浏览器输入和点击操作', async () => {
  apiGet.mockImplementation(url => Promise.resolve({ success: true, data: url.endsWith('/status')
    ? { ...status, platforms: [{ id: 'boss', available: true, running: true }] } : frame }));
  render(<ServerBrowserConsole />);
  const image = await openConsole();
  expect(screen.getByText(/请先停止采集再手动操作浏览器/)).not.toBeNull();
  expect(screen.getByLabelText('发送到浏览器的文字').disabled).toBe(true);
  fireEvent.click(image, { clientX: 100, clientY: 100 });
  expect(apiPost.mock.calls.filter(([url]) => url.endsWith('/action'))).toHaveLength(0);
});

test('其他同事持锁时显示占用提示，不加载截图或允许输入', async () => {
  apiGet.mockResolvedValue({ success: true, data: { ...status, lock: { held: true } } });
  apiPost.mockRejectedValue(new Error('其他同事正在操作'));
  render(<ServerBrowserConsole />);
  const button = await screen.findByRole('button', { name: '服务器浏览器' });
  await act(async () => { fireEvent.click(button); });
  await waitFor(() => expect(screen.getAllByText('其他同事正在操作').length).toBeGreaterThan(0));
  expect(screen.queryByAltText('服务器浏览器画面')).toBeNull();
  expect(screen.getByLabelText('发送到浏览器的文字').disabled).toBe(true);
});

test('平台切换重新申请对应平台，持续打开时每两秒更新画面并续期', async () => {
  jest.useFakeTimers();
  render(<ServerBrowserConsole />);
  await openConsole();
  fireEvent.change(screen.getByLabelText('招聘平台'), { target: { value: 'zhilian' } });
  await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/browser-console/session', expect.objectContaining({ platform: 'zhilian' })));
  await screen.findByAltText('服务器浏览器画面');
  const before = apiGet.mock.calls.filter(([url]) => url.endsWith('/screenshot')).length;
  await act(async () => { jest.advanceTimersByTime(2000); });
  await waitFor(() => expect(apiGet.mock.calls.filter(([url]) => url.endsWith('/screenshot')).length).toBeGreaterThan(before));
  const leases = apiPost.mock.calls.filter(([url]) => url.endsWith('/session')).length;
  await act(async () => { jest.advanceTimersByTime(20000); });
  await waitFor(() => expect(apiPost.mock.calls.filter(([url]) => url.endsWith('/session')).length).toBeGreaterThan(leases));
});

test('点击边界被限制在截图范围内，无尺寸时不发送坐标', () => {
  const currentTarget = { getBoundingClientRect: () => ({ left: 10, top: 10, width: 100, height: 100 }) };
  expect(screenshotPoint({ currentTarget, clientX: -10, clientY: 999 }, frame)).toEqual({ x: 0, y: 499 });
  expect(screenshotPoint({ currentTarget, clientX: 10, clientY: 10 }, null)).toBeNull();
});

test('连接请求未完成就关闭时不显示旧画面，返回后释放锁', async () => {
  let finishSession;
  apiPost.mockImplementation(url => url.endsWith('/session')
    ? new Promise(resolve => { finishSession = resolve; }) : Promise.resolve({ success: true }));
  render(<ServerBrowserConsole />);
  fireEvent.click(await screen.findByRole('button', { name: '服务器浏览器' }));
  await waitFor(() => expect(finishSession).toEqual(expect.any(Function)));
  fireEvent.click(screen.getByRole('button', { name: '关闭窗口' }));
  await act(async () => { finishSession({ success: true, data: { platform: 'boss' } }); });
  await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/browser-console/release', { clientId: expect.any(String) }));
  expect(screen.queryByAltText('服务器浏览器画面')).toBeNull();
  expect(apiGet.mock.calls.filter(([url]) => url.endsWith('/screenshot'))).toHaveLength(0);
});

test('恢复窗口等待正在刷新的画面，不会把短暂冲突当作操作权丢失', async () => {
  jest.useFakeTimers();
  render(<ServerBrowserConsole />);
  await openConsole();
  let finishFrame;
  let deferNextFrame = true;
  apiGet.mockImplementation(url => {
    if (url.endsWith('/status')) return Promise.resolve({ success: true, data: status });
    if (deferNextFrame) {
      deferNextFrame = false;
      return new Promise(resolve => { finishFrame = resolve; });
    }
    return Promise.resolve({ success: true, data: frame });
  });
  await act(async () => { jest.advanceTimersByTime(2000); });
  await waitFor(() => expect(finishFrame).toEqual(expect.any(Function)));
  fireEvent.click(screen.getByRole('button', { name: '恢复并最大化窗口' }));
  expect(apiPost.mock.calls.filter(([url]) => url.endsWith('/restore-window'))).toHaveLength(0);
  await act(async () => { finishFrame({ success: true, data: frame }); });
  await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/browser-console/restore-window',
    expect.objectContaining({ platform: 'boss', clientId: expect.any(String) })));
  expect(screen.getByText('当前由你操作')).not.toBeNull();
});
