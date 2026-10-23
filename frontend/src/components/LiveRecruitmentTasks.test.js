import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import LiveRecruitmentTasks from './LiveRecruitmentTasks';
import { apiGet, apiPost } from '../utils/apiClient';

jest.mock('../utils/apiClient', () => ({ apiGet: jest.fn(), apiPost: jest.fn() }));
jest.mock('antd', () => {
  const React = require('react');
  const Box = ({ children, title, extra }) => <div>{title}{extra}{children}</div>;
  return {
    Alert: ({ message }) => <div>{message}</div>,
    Button: ({ children, onClick, disabled, loading }) =>
      <button onClick={onClick} disabled={disabled || loading}>{children}</button>,
    Card: Box, Col: Box, Row: Box, Space: Box,
    InputNumber: ({ value, onChange, ...props }) =>
      <input type="number" aria-label={props['aria-label']} value={value}
        onChange={event => onChange(Number(event.target.value))} />,
    Progress: ({ format }) => <div>{format()}</div>,
    Statistic: ({ title, value }) => <div>{title}: {value}</div>,
    Tag: Box, Typography: { Text: Box },
    message: { success: jest.fn(), error: jest.fn(), info: jest.fn() }
  };
});

const job = { title: '项目经理主管', jobRequirements: '项目经理主管，五年以上项目管理经验',
  targetCount: 6, location: '不限', searchKeywords: '项目经理主管' };
let totals;

beforeEach(() => {
  jest.clearAllMocks();
  totals = { boss: 3, zlzp: 3, qcwy: 3 };
  apiGet.mockImplementation(async url => {
    if (url === '/recruitment-pipeline/active-job') return { success: true, data: job };
    if (url.includes('/analytics?')) return { success: true, data: {
      job: { configured: true }, metrics: { total: 9, evaluated: 9, passed: 0, unevaluated: 0 },
      bySource: Object.entries(totals).map(([source, total]) => ({ source, total }))
    } };
    if (url === '/zhilian/login-status') return { success: true, data: { isLoggedIn: true } };
    if (url === '/wuyou/status?readOnly=1') return { success: true,
      data: { status: 'ready', isLoggedIn: true, batch: { running: false } } };
    return { success: true, data: { status: 'idle', isActive: false } };
  });
  apiPost.mockResolvedValue({ success: true, data: { isLoggedIn: true } });
});
afterEach(cleanup);

test('服务重启后可从页面按单次岗位目标重开 BOSS 任务', async () => {
  render(<LiveRecruitmentTasks onOpenPipeline={() => {}} onOpenControl={() => {}} />);
  fireEvent.click((await screen.findAllByRole('button', { name: '启动本次采集' }))[0]);
  await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/boss-zhipin/start-browsing', {
    mode: 'search', filters: { position: '项目经理主管' },
    targetCount: 6, maxRuntimeMinutes: 90
  }));
  expect(apiPost).toHaveBeenCalledWith('/boss-zhipin/start', {});
});

test('累计已达上次目标仍可启动新任务，单个平台状态不可用不影响其他平台', async () => {
  totals.boss = 6;
  const base = apiGet.getMockImplementation();
  apiGet.mockImplementation(url => url === '/wuyou/status?readOnly=1'
    ? Promise.reject(new Error('平台暂不可用')) : base(url));
  render(<LiveRecruitmentTasks onOpenPipeline={() => {}} onOpenControl={() => {}} />);
  const buttons = await screen.findAllByRole('button', { name: '启动本次采集' });
  expect(buttons[0].disabled).toBe(false);
  expect(buttons[1].disabled).toBe(false);
  fireEvent.click(buttons[1]);
  await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/zhilian/start-browsing', {
    mode: 'search', filters: { position: '项目经理主管', location: '不限' }, targetCount: 6
  }));
});

test('前程无忧从同一岗位条件按本次份数采集并复用服务器登录状态', async () => {
  render(<LiveRecruitmentTasks onOpenPipeline={() => {}} onOpenControl={() => {}} />);
  fireEvent.click((await screen.findAllByRole('button', { name: '启动本次采集' }))[2]);
  await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/wuyou/keyword-batch', {
    keywords: ['项目经理主管'], targetCount: 6,
    jobRequirements: job.jobRequirements, education: '不限'
  }));
  expect(apiPost).toHaveBeenCalledWith('/wuyou/start', {});
});

test('BOSS 人工验证后从独立按钮续接同一岗位断点', async () => {
  const base = apiGet.getMockImplementation();
  apiGet.mockImplementation(url => url === '/boss-zhipin/browsing-status'
    ? Promise.resolve({ success: true, data: { status: 'paused', resumeAvailable: true,
      mode: 'search', filters: { position: job.title }, targetCount: 6,
      collectedCount: 3, maxRuntimeMinutes: 90 } }) : base(url));
  render(<LiveRecruitmentTasks onOpenPipeline={() => {}} onOpenControl={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: '续接上次任务（剩余 3 份）' }));
  await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/boss-zhipin/start-browsing', {
    mode: 'search', filters: { position: job.title }, targetCount: 6,
    maxRuntimeMinutes: 90, resume: true
  }));
});

test('可为新一轮采集单独设置新增 20 份，不受历史累计数限制', async () => {
  totals.boss = 40;
  render(<LiveRecruitmentTasks onOpenPipeline={() => {}} onOpenControl={() => {}} />);
  fireEvent.change(await screen.findByRole('spinbutton', { name: 'BOSS 直聘本次新增份数' }),
    { target: { value: '20' } });
  fireEvent.click((await screen.findAllByRole('button', { name: '启动本次采集' }))[0]);
  await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/boss-zhipin/start-browsing', {
    mode: 'search', filters: { position: job.title }, targetCount: 20,
    maxRuntimeMinutes: 90
  }));
});
