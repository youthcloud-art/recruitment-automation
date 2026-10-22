import { apiUpload } from './apiClient';

test('文件上传使用浏览器生成的 multipart 边界', async () => {
  const response = {
    ok: true,
    headers: { get: () => 'application/json' },
    json: async () => ({ success: true })
  };
  global.fetch = jest.fn().mockResolvedValue(response);
  const formData = new FormData();
  formData.append('source', 'qcwy');

  await apiUpload('/resume-library/upload', formData);

  const [, options] = global.fetch.mock.calls[0];
  expect(options.body).toBe(formData);
  expect(options.headers['Content-Type']).toBeUndefined();
});
