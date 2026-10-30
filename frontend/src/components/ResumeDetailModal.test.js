import React from 'react';
import { render, screen } from '@testing-library/react';
import ResumeDetailModal from './ResumeDetailModal';
import { apiGet } from '../utils/apiClient';

jest.mock('../utils/apiClient', () => ({ apiGet: jest.fn() }));

test('居中的可移动简历窗口显示后端整理结果并隐藏页面页脚', async () => {
  apiGet.mockResolvedValue({ data: { name: '吴女士（平台称呼）', source: '智联招聘',
    metadata: [['招聘岗位', '磁轴销售工程师']],
    sections: [{ title: '工作经历', paragraphs: ['负责磁轴产品销售'] }],
    note: '根据已保存的简历内容整理排版；原始采集记录保持不变。' } });
  render(<ResumeDetailModal visible onClose={() => {}} resume={{ id: 'resume_12345678' }} />);
  expect(await screen.findByText('负责磁轴产品销售')).not.toBeNull();
  expect(screen.getByRole('dialog', { name: '简历详情' }).className).toContain('resume-window');
  expect(screen.queryByText('举报')).toBeNull();
  expect(apiGet).toHaveBeenCalledWith('/resume/resume_12345678/presentation');
});
