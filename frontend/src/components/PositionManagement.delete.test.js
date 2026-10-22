import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Modal } from 'antd';
import PositionManagement from './PositionManagement';
import { apiDelete, apiGet } from '../utils/apiClient';

jest.mock('../utils/apiClient', () => ({
  apiGet: jest.fn(), apiPost: jest.fn(), apiPut: jest.fn(), apiDelete: jest.fn()
}));
jest.mock('./PositionCreationModal', () => () => null);

const activeJob = {
  title: 'IT网络运维', searchKeywords: 'IT网络运维', location: '', education: '大专',
  minExperienceYears: 3, targetCount: null, jobRequirements: '网络运维岗位要求'
};
const otherJob = {
  title: '测试岗位', searchKeywords: '测试岗位', location: '', education: '',
  minExperienceYears: null, targetCount: null, jobRequirements: '独立测试岗位要求'
};

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: query => ({
      matches: false, media: query, onchange: null,
      addListener: jest.fn(), removeListener: jest.fn(),
      addEventListener: jest.fn(), removeEventListener: jest.fn(),
      dispatchEvent: jest.fn()
    })
  });
});

test('非当前岗位使用稳定的确认框，确认后才调用删除 API', async () => {
  apiGet.mockImplementation(endpoint => Promise.resolve(endpoint === '/positions'
    ? { success: true, data: [{ id: 'position-test', name: '测试岗位',
      title: '测试岗位', jobCriteria: otherJob }] }
    : { success: true, data: activeJob }));
  apiDelete.mockResolvedValue({ success: true });
  const confirm = jest.spyOn(Modal, 'confirm').mockImplementation(() => ({ destroy() {} }));
  try {
    render(<PositionManagement visible onClose={() => {}} />);
    const buttons = await screen.findAllByRole('button', { name: /删除/ });
    const enabled = buttons.find(button => !button.disabled);
    expect(enabled).toBeTruthy();
    fireEvent.click(enabled);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0].zIndex).toBeGreaterThan(1001);
    expect(apiDelete).not.toHaveBeenCalled();
    await act(async () => { await confirm.mock.calls[0][0].onOk(); });
    await waitFor(() => expect(apiDelete).toHaveBeenCalledWith('/positions/position-test'));
  } finally {
    confirm.mockRestore();
  }
});
