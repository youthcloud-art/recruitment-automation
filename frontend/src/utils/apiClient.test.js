import { apiGet, apiPost, apiUpload } from './apiClient';

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

test('只读请求遇到短暂网关错误后重试一次，写入请求不重试', async () => {
  const failed = { ok: false, status: 503, statusText: 'Unavailable',
    clone: () => ({ json: async () => null }) };
  const success = { ok: true, headers: { get: () => 'application/json' },
    json: async () => ({ success: true }) };
  global.fetch = jest.fn().mockResolvedValueOnce(failed).mockResolvedValueOnce(success);
  await expect(apiGet('/tasks/stats')).resolves.toEqual({ success: true });
  expect(global.fetch).toHaveBeenCalledTimes(2);

  global.fetch = jest.fn().mockResolvedValue(failed);
  await expect(apiPost('/recruitment-pipeline/email/send', {})).rejects.toThrow('HTTP 503');
  expect(global.fetch).toHaveBeenCalledTimes(1);
});
