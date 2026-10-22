const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ModelConfigService } = require('../src/services/modelConfigService');

test('网页模型配置保存、重新加载并始终隐藏 API Key', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hire-smart-model-'));
  const file = path.join(directory, 'config.json');
  const keys = ['LLM_API_KEY', 'LLM_API_URL', 'LLM_MODEL'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    const service = new ModelConfigService(file);
    const status = service.save({ apiKey: 'sk-test_key_123456', model: 'deepseek-flash' });
    assert.equal(status.configured, true);
    assert.equal(status.model, 'deepseek-flash');
    assert.equal(JSON.stringify(status).includes('sk-test_key_123456'), false);
    assert.equal(new ModelConfigService(file).status().source, '网页配置');
    assert.equal(process.env.LLM_API_KEY, 'sk-test_key_123456');
    assert.throws(() => service.save({ model: 'untrusted-model' }), /支持的 DeepSeek 模型/);
    assert.equal(service.save({ apiKey: '', model: 'deepseek-chat' }).model, 'deepseek-chat');
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
