import React from 'react';
import { render, screen } from '@testing-library/react';
import CaptureTargetNotice, { captureTargetNotice } from './CaptureTargetNotice';
import JobCriteriaEditor from './JobCriteriaEditor';
import { apiGet } from '../utils/apiClient';

jest.mock('../utils/apiClient', () => ({ apiGet: jest.fn() }));

const job = { title: 'IT网络运维', updatedAt: '2026-10-21T00:00:00.000Z',
  recommendationTargetCount: 100, targetCount: null };
const analytics = { job: { title: job.title, updatedAt: job.updatedAt },
  bySource: [
    { source: 'boss', evaluated: 325 },
    { source: 'zlzp', evaluated: 21 },
    { source: 'qcwy', evaluated: 13 }
  ] };

beforeAll(() => {
  window.matchMedia = window.matchMedia || (() => ({ matches: false,
    addListener: () => {}, removeListener: () => {} }));
});
afterEach(() => jest.clearAllMocks());

test('Excel 推荐人数 100 不显示为采集上限，提示明确设置采集目标', () => {
  const notice = captureTargetNotice(job, 'boss-zhipin', analytics);
  expect(notice.type).toBe('warning');
  expect(notice.message).toContain('推荐名单目标 100 人不是采集上限');
  expect(notice.description).toContain('填写“单次采集目标份数”');
  expect(notice.description).toContain('已有 325 份完成评估');
});

test('本岗位已评估数达到采集目标时提示再次启动仍会新增，来源按平台区分', () => {
  const configured = { ...job, targetCount: 100 };
  const boss = captureTargetNotice(configured, 'boss-zhipin', analytics);
  expect(boss.type).toBe('warning');
  expect(boss.message).toContain('已有 325 份完成评估');
  expect(boss.message).toContain('达到或超过单次采集目标 100 份');
  expect(boss.description).toContain('历史入库数量不会自动抵扣');
  const exactlyMet = captureTargetNotice({ ...job, targetCount: 325 },
    'boss-zhipin', analytics);
  expect(exactlyMet.type).toBe('warning');
  expect(exactlyMet.message).toContain('达到或超过单次采集目标 325 份');
  const zhilian = captureTargetNotice(configured, 'zhilian', analytics);
  expect(zhilian.type).toBe('info');
  expect(zhilian.description).toContain('已有 21 份完成评估');
  expect(zhilian.description).not.toContain('325');
});

test('旧岗位统计不混入当前岗位提示', () => {
  const stale = { ...analytics, job: { ...analytics.job, updatedAt: 'older' } };
  const notice = captureTargetNotice({ ...job, targetCount: 100 }, 'wuyou', stale);
  expect(notice.message).toContain('单次采集目标：100 份');
  expect(notice.description).not.toContain('13 份');
});

test('保存的岗位加载本岗位来源评估库存', async () => {
  apiGet.mockResolvedValue({ success: true, data: analytics });
  render(<CaptureTargetNotice job={{ ...job, targetCount: 100 }}
    platform="boss-zhipin" refreshKey={false} />);
  expect(await screen.findByText(/已有 325 份完成评估/)).not.toBeNull();
  expect(apiGet).toHaveBeenCalledWith('/recruitment-pipeline/analytics', { scope: 'active' });
});

test('岗位编辑器在只有推荐目标时提示单次采集目标仍未设置', () => {
  render(<JobCriteriaEditor value={job} onChange={() => {}} />);
  expect(screen.getByText(/推荐名单目标为 100 人，单次采集目标尚未设置/)).not.toBeNull();
  expect(screen.getByText(/推荐名单目标人数（所有平台合计，不限制采集）/)).not.toBeNull();
});
