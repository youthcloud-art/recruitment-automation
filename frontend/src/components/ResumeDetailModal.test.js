import React from 'react';
import { render, screen } from '@testing-library/react';
import ResumeDetailModal from './ResumeDetailModal';

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }) => <div>{children}</div>
}));

test('只读详情展示平台保存的原始简历全文，不显示无处理器的操作按钮', () => {
  render(<ResumeDetailModal visible readOnly onClose={() => {}}
    resume={{ originalText: 'IT网络运维候选人的完整工作经历\n交换机和 Linux 服务器维护' }} />);
  expect(screen.getByText(/交换机和 Linux 服务器维护/)).not.toBeNull();
  expect(screen.queryByRole('button', { name: '标记感兴趣' })).toBeNull();
  expect(screen.queryByRole('button', { name: '下载简历' })).toBeNull();
});
