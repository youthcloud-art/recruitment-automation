const fs = require('fs-extra');
const path = require('path');

const KEYS = [
  'QCWY_IMAP_HOST', 'QCWY_IMAP_PORT', 'QCWY_IMAP_SECURITY',
  'QCWY_IMAP_USER', 'QCWY_IMAP_PASS_B64', 'QCWY_IMAP_FOLDER',
  'QCWY_IMAP_SENDERS', 'QCWY_IMAP_JOB_TITLE', 'QCWY_IMAP_KEYWORDS_B64',
  'QCWY_IMAP_JOB_REQUIREMENTS_B64', 'QCWY_IMAP_POLL_MINUTES',
  'QCWY_IMAP_MAX_MESSAGES', 'QCWY_IMAP_ENABLED'
];

function decode(value) {
  try { return Buffer.from(String(value || ''), 'base64').toString('utf8'); }
  catch (_) { return ''; }
}

function list(value) {
  return String(value || '').split(/[,，;；\n]+/).map(item => item.trim()).filter(Boolean);
}

function validateSenders(value) {
  const senders = [...new Set(list(value).map(item => item.toLowerCase()))];
  if (!senders.length || senders.length > 20) throw new Error('请填写 1～20 个发件邮箱筛选项或 @域名');
  const domain = '[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\\.[a-z]{2,}';
  const pattern = new RegExp(`^(?:[a-z0-9._%+-]+@${domain}|@${domain})$`, 'i');
  if (senders.some(item => !pattern.test(item) || /\.\./.test(item))) {
    throw new Error('发件人筛选格式无效，请填写完整邮箱或 @域名');
  }
  return senders;
}

class QcwyImapConfigService {
  constructor({ environment = process.env, file = require('../config/environmentFile').environmentFile(environment) } = {}) {
    this.file = file;
    this.environment = environment;
  }

  current() {
    const env = this.environment;
    const config = {
      host: env.QCWY_IMAP_HOST || '',
      port: Number(env.QCWY_IMAP_PORT) || 993,
      security: env.QCWY_IMAP_SECURITY || 'tls',
      user: env.QCWY_IMAP_USER || '',
      hasPassword: Boolean(env.QCWY_IMAP_PASS_B64),
      folder: env.QCWY_IMAP_FOLDER || 'INBOX',
      senderAllowlist: env.QCWY_IMAP_SENDERS || '',
      jobTitle: env.QCWY_IMAP_JOB_TITLE || '',
      jobKeywords: decode(env.QCWY_IMAP_KEYWORDS_B64),
      jobRequirements: decode(env.QCWY_IMAP_JOB_REQUIREMENTS_B64),
      pollMinutes: Number(env.QCWY_IMAP_POLL_MINUTES) || 15,
      maxMessages: Number(env.QCWY_IMAP_MAX_MESSAGES) || 20,
      enabled: env.QCWY_IMAP_ENABLED === 'true'
    };
    config.configured = Boolean(config.host && config.user && config.hasPassword &&
      config.senderAllowlist && config.jobTitle && config.jobRequirements.length >= 5);
    return config;
  }

  password() { return decode(this.environment.QCWY_IMAP_PASS_B64); }

  async save(input = {}) {
    const host = String(input.host || '').trim().toLowerCase();
    const port = Number(input.port);
    const security = String(input.security || 'tls').toLowerCase();
    const user = String(input.user || '').trim();
    const password = String(input.password || '');
    const retained = this.environment.QCWY_IMAP_PASS_B64 || '';
    const previous = this.current();
    if (!password && retained && (host !== previous.host || user !== previous.user)) {
      throw new Error('更换 IMAP 服务器或账号时请重新填写授权码');
    }
    const encodedPassword = password ? Buffer.from(password).toString('base64') : retained;
    const folder = String(input.folder || 'INBOX').trim();
    const senders = validateSenders(input.senderAllowlist);
    const jobTitle = String(input.jobTitle || '').trim();
    const keywords = [...new Set([jobTitle, ...list(input.jobKeywords)])];
    const jobRequirements = String(input.jobRequirements || '').trim();
    const pollMinutes = Number(input.pollMinutes ?? 15);
    const maxMessages = Number(input.maxMessages ?? 20);
    const enabled = input.enabled === true;
    if (!/^(?=.{3,253}$)[a-z0-9][a-z0-9.-]*[a-z0-9]$/i.test(host) ||
        /\.\./.test(host) || !host.includes('.')) throw new Error('IMAP 服务器地址无效');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('IMAP 端口无效');
    if (!['tls', 'starttls'].includes(security)) throw new Error('IMAP 加密方式无效');
    if (!user || user.length > 254 || /[\r\n]/.test(user)) throw new Error('IMAP 登录账号无效');
    if (!encodedPassword || password.length > 1024 || /[\r\n]/.test(password)) {
      throw new Error('请填写 IMAP 授权码或密码');
    }
    if (!folder || folder.length > 120 || /[\r\n\0]/.test(folder)) throw new Error('IMAP 文件夹无效');
    if (jobTitle.length < 2 || jobTitle.length > 100) throw new Error('岗位名称需为 2～100 字');
    if (keywords.length > 20 || keywords.some(item => item.length > 100)) throw new Error('岗位关键词过多或过长');
    if (jobRequirements.length < 5 || jobRequirements.length > 5000) throw new Error('岗位要求需为 5～5000 字');
    if (!Number.isInteger(pollMinutes) || pollMinutes < 5 || pollMinutes > 1440) {
      throw new Error('自动同步间隔需为 5～1440 分钟');
    }
    if (!Number.isInteger(maxMessages) || maxMessages < 1 || maxMessages > 50) {
      throw new Error('每轮处理邮件数需为 1～50');
    }
    const values = {
      QCWY_IMAP_HOST: host,
      QCWY_IMAP_PORT: String(port),
      QCWY_IMAP_SECURITY: security,
      QCWY_IMAP_USER: user,
      QCWY_IMAP_PASS_B64: encodedPassword,
      QCWY_IMAP_FOLDER: folder,
      QCWY_IMAP_SENDERS: senders.join(','),
      QCWY_IMAP_JOB_TITLE: jobTitle,
      QCWY_IMAP_KEYWORDS_B64: Buffer.from(keywords.join(',')).toString('base64'),
      QCWY_IMAP_JOB_REQUIREMENTS_B64: Buffer.from(jobRequirements).toString('base64'),
      QCWY_IMAP_POLL_MINUTES: String(pollMinutes),
      QCWY_IMAP_MAX_MESSAGES: String(maxMessages),
      QCWY_IMAP_ENABLED: String(enabled)
    };
    const existing = await fs.readFile(this.file, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    const newline = existing.includes('\r\n') ? '\r\n' : '\n';
    const seen = new Set();
    const next = existing.split(/\r?\n/).map(line => {
      const match = line.match(/^\s*(QCWY_IMAP_[A-Z_]+)\s*=/);
      if (!match || !KEYS.includes(match[1])) return line;
      const key = match[1];
      if (seen.has(key)) return '';
      seen.add(key);
      return `${key}=${values[key]}`;
    });
    for (const key of KEYS) if (!seen.has(key)) next.push(`${key}=${values[key]}`);
    const temporary = `${this.file}.${process.pid}.qcwy.tmp`;
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

module.exports = { QcwyImapConfigService, validateSenders, list };
