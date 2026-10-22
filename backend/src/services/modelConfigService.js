const fs = require('fs');
const path = require('path');
const axios = require('axios');

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const ALLOWED_MODELS = new Set(['deepseek-flash', 'deepseek-chat', 'deepseek-reasoner']);

class ModelConfigService {
  constructor(file = path.join(__dirname, '../../storage/model-config.json')) {
    this.file = file;
    this.load();
  }

  load() {
    if (!fs.existsSync(this.file)) return;
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (typeof saved.apiKey === 'string' && saved.apiKey.trim() && ALLOWED_MODELS.has(saved.model)) {
        this.apply(saved);
      }
    } catch (error) {
      console.warn('模型配置文件无法读取；沿用环境变量配置');
    }
  }

  apply(config) {
    process.env.LLM_API_KEY = config.apiKey;
    process.env.LLM_API_URL = DEEPSEEK_URL;
    process.env.LLM_MODEL = config.model;
  }

  status() {
    return {
      configured: Boolean(process.env.LLM_API_KEY),
      provider: 'DeepSeek',
      model: process.env.LLM_MODEL || 'deepseek-chat',
      endpoint: process.env.LLM_API_URL || process.env.LLM_BASE_URL || DEEPSEEK_URL,
      source: fs.existsSync(this.file) ? '网页配置' : (process.env.LLM_API_KEY ? '现有本机配置' : '未配置')
    };
  }

  save({ apiKey, model }) {
    const nextModel = model || 'deepseek-chat';
    if (!ALLOWED_MODELS.has(nextModel)) throw new Error('请选择支持的 DeepSeek 模型');
    const nextKey = typeof apiKey === 'string' && apiKey.trim() ? apiKey.trim() : process.env.LLM_API_KEY;
    if (!nextKey || !/^sk-[A-Za-z0-9_-]{8,}$/.test(nextKey)) {
      throw new Error('请填写有效的 DeepSeek API Key');
    }
    const config = { apiKey: nextKey, model: nextModel };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(config), { mode: 0o600 });
      fs.renameSync(temporary, this.file);
      this.apply(config);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
    return this.status();
  }

  async test() {
    if (!process.env.LLM_API_KEY) throw new Error('请先保存 DeepSeek API Key');
    try {
      const response = await axios.post(DEEPSEEK_URL, {
        model: process.env.LLM_MODEL || 'deepseek-chat',
        messages: [{ role: 'user', content: '仅回复 OK' }],
        max_tokens: 8,
        stream: false
      }, {
        headers: { Authorization: `Bearer ${process.env.LLM_API_KEY}`, 'Content-Type': 'application/json' },
        timeout: 20000
      });
      return { connected: Boolean(response.data?.choices?.length), model: response.data?.model || process.env.LLM_MODEL };
    } catch (error) {
      const status = error.response?.status;
      if (status === 401 || status === 403) throw new Error('DeepSeek 拒绝了 API Key，请检查密钥');
      if (status === 402) throw new Error('DeepSeek 余额不足或计费不可用');
      if (status === 429) throw new Error('DeepSeek 请求频率受限，请稍后再试');
      throw new Error(status ? `DeepSeek 连接失败（HTTP ${status}）` : 'DeepSeek 连接超时或网络不可用');
    }
  }
}

module.exports = { ModelConfigService, DEEPSEEK_URL };
