const fs = require('fs-extra');
const path = require('path');
const { validateEmail } = require('./candidateEmailService');

const KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_FROM', 'SMTP_USER', 'SMTP_PASS',
  'SMTP_PASS_B64', 'SMTP_SECURE', 'SMTP_REQUIRE_TLS'];

class SmtpConfigService {
  constructor({ environment = process.env, file = require('../config/environmentFile').environmentFile(environment) } = {}) {
    this.file = file;
    this.environment = environment;
  }

  current() {
    const env = this.environment;
    return {
      host: env.SMTP_HOST || '',
      port: Number(env.SMTP_PORT) || 587,
      from: env.SMTP_FROM || '',
      user: env.SMTP_USER || '',
      authEnabled: Boolean(env.SMTP_USER),
      hasPassword: Boolean(env.SMTP_PASS_B64 || env.SMTP_PASS),
      secure: env.SMTP_SECURE || 'auto',
      requireTLS: env.SMTP_REQUIRE_TLS === 'true'
    };
  }

  async save(input = {}) {
    const host = String(input.host || '').trim();
    const port = Number(input.port);
    const from = String(input.from || '').trim();
    const authEnabled = input.authEnabled !== false;
    const user = authEnabled ? String(input.user || '').trim() : '';
    const password = authEnabled ? String(input.password || '') : '';
    const secure = String(input.secure || 'auto').toLowerCase();
    const requireTLS = input.requireTLS === true;
    if (!host || host.length > 253 || /[\s/#\\]/.test(host)) throw new Error('SMTP 服务器地址无效');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SMTP 端口无效');
    if (!validateEmail(from)) throw new Error('发件邮箱地址无效');
    if (!['auto', 'true', 'false'].includes(secure)) throw new Error('SMTP 加密方式无效');
    if (authEnabled && (!user || user.length > 254 || /[\r\n]/.test(user))) throw new Error('SMTP 登录账号无效');
    if (password.length > 1024 || /[\r\n]/.test(password)) throw new Error('SMTP 授权码无效');
    const retainedPassword = this.environment.SMTP_PASS_B64 ||
      (this.environment.SMTP_PASS ? Buffer.from(this.environment.SMTP_PASS).toString('base64') : '');
    const encodedPassword = authEnabled
      ? (password ? Buffer.from(password).toString('base64') : retainedPassword) : '';
    if (authEnabled && !encodedPassword) throw new Error('请填写 SMTP 授权码或密码');
    const values = {
      SMTP_HOST: host,
      SMTP_PORT: String(port),
      SMTP_FROM: from,
      SMTP_USER: user,
      SMTP_PASS: '',
      SMTP_PASS_B64: encodedPassword,
      SMTP_SECURE: secure,
      SMTP_REQUIRE_TLS: String(requireTLS)
    };
    const existing = await fs.readFile(this.file, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    const newline = existing.includes('\r\n') ? '\r\n' : '\n';
    const lines = existing.split(/\r?\n/);
    const seen = new Set();
    const next = lines.map(line => {
      const match = line.match(/^\s*(SMTP_[A-Z_]+)\s*=/);
      if (!match || !KEYS.includes(match[1])) return line;
      const key = match[1];
      if (seen.has(key)) return '';
      seen.add(key);
      return `${key}=${values[key]}`;
    });
    for (const key of KEYS) if (!seen.has(key)) next.push(`${key}=${values[key]}`);
    const temporary = `${this.file}.${process.pid}.tmp`;
    try {
      await fs.writeFile(temporary, next.join(newline).replace(/(?:\r?\n)*$/, newline), { mode: 0o600 });
      await fs.move(temporary, this.file, { overwrite: true });
    } finally {
      await fs.remove(temporary).catch(() => {});
    }
    Object.assign(this.environment, values);
    return this.current();
  }
}

module.exports = { SmtpConfigService };
