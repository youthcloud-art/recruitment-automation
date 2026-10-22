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

test('服务重启后可从页面按当前岗位剩余份数补采 BOSS', async () => {
  render(<LiveRecruitmentTasks onOpenPipeline={() => {}} onOpenControl={() => {}} />);
  fireEvent.click((await screen.findAllByRole('button', { name: '补齐剩余 3 份' }))[0]);
  await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/boss-zhipin/start-browsing', {
    mode: 'search', filters: { position: '项目经理主管' },
    targetCount: 3, maxRuntimeMinutes: 90
  }));
  expect(apiPost).toHaveBeenCalledWith('/boss-zhipin/start', {});
});

test('单个平台状态不可用不会禁用其他平台；目标已满不再补采', async () => {
  totals.boss = 6;
  const base = apiGet.getMockImplementation();
  apiGet.mockImplementation(url => url === '/wuyou/status?readOnly=1'
    ? Promise.reject(new Error('平台暂不可用')) : base(url));
  render(<LiveRecruitmentTasks onOpenPipeline={() => {}} onOpenControl={() => {}} />);
  const buttons = await screen.findAllByRole('button', { name: /补齐剩余/ });
  expect(buttons[0].disabled).toBe(true);
  expect(buttons[1].disabled).toBe(false);
  fireEvent.click(buttons[1]);
  await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/zhilian/start-browsing', {
    mode: 'search', filters: { position: '项目经理主管', location: '不限' }, targetCount: 3
  }));
});

test('前程无忧从同一岗位条件补齐目标并复用服务器登录状态', async () => {
  render(<LiveRecruitmentTasks onOpenPipeline={() => {}} onOpenControl={() => {}} />);
  fireEvent.click((await screen.findAllByRole('button', { name: '补齐剩余 3 份' }))[2]);
  await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/wuyou/keyword-batch', {
    keywords: ['项目经理主管'], targetCount: 3,
    jobRequirements: job.jobRequirements, education: '不限'
  }));
  expect(apiPost).toHaveBeenCalledWith('/wuyou/start', {});
});

test('BOSS 人工验证后只有同一岗位且剩余目标一致才续接断点', async () => {
  const base = apiGet.getMockImplementation();
  apiGet.mockImplementation(url => url === '/boss-zhipin/browsing-status'
    ? Promise.resolve({ success: true, data: { status: 'paused', resumeAvailable: true,
      mode: 'search', filters: { position: job.title }, targetCount: 6,
      collectedCount: 3, maxRuntimeMinutes: 90 } }) : base(url));
  render(<LiveRecruitmentTasks onOpenPipeline={() => {}} onOpenControl={() => {}} />);
  fireEvent.click((await screen.findAllByRole('button', { name: '补齐剩余 3 份' }))[0]);
  await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/boss-zhipin/start-browsing', {
    mode: 'search', filters: { position: job.title }, targetCount: 6,
    maxRuntimeMinutes: 90, resume: true
  }));
});
