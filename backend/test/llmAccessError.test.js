const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const LLMService = require('../src/services/llmService');
const { classifyLlmAccessError } = require('../src/services/llmAccessError');

test('402、401、403 归类为需要人工修复的模型访问故障，429 保持可重试', () => {
  assert.equal(classifyLlmAccessError({ response: { status: 402 } }).code, 'LLM_BILLING_REQUIRED');
  assert.equal(classifyLlmAccessError({ httpStatus: 401 }).code, 'LLM_AUTH_FAILED');
  assert.equal(classifyLlmAccessError({ response: { status: 403 } }).code, 'LLM_ACCESS_FORBIDDEN');
  assert.equal(classifyLlmAccessError(new Error('LLM API错误: 402 Payment Required')).code,
    'LLM_BILLING_REQUIRED');
  assert.equal(classifyLlmAccessError({ response: { status: 429 } }), null);
});

test('LLMService 将模拟的 402 响应转换为不泄漏密钥的明确补评提示', async () => {
  const previous = { key: process.env.LLM_API_KEY, url: process.env.LLM_API_URL };
  const originalPost = axios.post;
  process.env.LLM_API_KEY = 'unit-test-secret-only';
  process.env.LLM_API_URL = 'https://example.invalid/v1/chat/completions';
  axios.post = async () => { throw Object.assign(new Error('Request failed with status code 402'),
    { response: { status: 402, statusText: 'Payment Required' } }); };
  try {
    await assert.rejects(new LLMService().chatWithLLM([{ role: 'user', content: 'test' }]), error => {
      assert.equal(error.code, 'LLM_BILLING_REQUIRED');
      assert.equal(error.httpStatus, 402);
      assert.match(error.message, /需检查余额\/计费/);
      assert.doesNotMatch(error.message, /unit-test-secret-only/);
      return true;
    });
  } finally {
    axios.post = originalPost;
    if (previous.key === undefined) delete process.env.LLM_API_KEY;
    else process.env.LLM_API_KEY = previous.key;
    if (previous.url === undefined) delete process.env.LLM_API_URL;
    else process.env.LLM_API_URL = previous.url;
  }
});
