import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ResumeRecommendationModal from './ResumeRecommendationModal';
import { apiGet } from '../utils/apiClient';

jest.mock('../utils/apiClient', () => ({ apiGet: jest.fn() }));
jest.mock('./ResumeDetailModal', () => ({
  __esModule: true,
  default: ({ visible, resume, readOnly }) => visible
    ? <div data-testid="full-resume">{readOnly ? '只读' : '可编辑'}：{resume.originalText}</div>
    : null
}));

const card = { id: 'boss-123', name: '候选人', source: 'boss', position: 'IT网络运维',
  experience: '5年', education: '大专', matchScore: 82, summary: '具备网络设备运维经验',
  strengths: ['交换机维护'], gaps: [] };
const recommendations = { success: true, data: { job: { title: 'IT网络运维',
  recommendationTargetCount: 100 }, evaluatedCount: 1, qualifiedCount: 1,
  targetShortfall: 99, recommendations: [card] } };

beforeAll(() => {
  window.matchMedia = window.matchMedia || (() => ({ matches: false,
    addListener: () => {}, removeListener: () => {} }));
});
afterEach(() => jest.clearAllMocks());

test('推荐卡只读加载对应候选人的完整简历', async () => {
  apiGet.mockImplementation(url => url === '/recruitment-pipeline/recommendations'
    ? Promise.resolve(recommendations)
    : Promise.resolve({ success: true, data: { id: card.id, source: card.source,
      originalText: '真实简历全文：交换机、路由器、服务器运维经历。' } }));
  render(<ResumeRecommendationModal visible onClose={() => {}} onViewPipeline={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: '查看完整简历' }));
  await waitFor(() => expect(apiGet).toHaveBeenCalledWith('/resume/boss-123'));
  expect((await screen.findByTestId('full-resume')).textContent).toContain('只读：真实简历全文');
});

test('候选人详情身份不一致时拒绝展示', async () => {
  apiGet.mockImplementation(url => url === '/recruitment-pipeline/recommendations'
    ? Promise.resolve(recommendations)
    : Promise.resolve({ success: true, data: { id: 'other-id', source: card.source,
      originalText: '不属于此卡的简历' } }));
  render(<ResumeRecommendationModal visible onClose={() => {}} onViewPipeline={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: '查看完整简历' }));
  expect(await screen.findByText(/候选人详情与当前推荐卡不一致/)).not.toBeNull();
  expect(screen.queryByTestId('full-resume')).toBeNull();
});
