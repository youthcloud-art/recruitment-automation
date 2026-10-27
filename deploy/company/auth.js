'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const COOKIE = 'hiresmart_session';
const SESSION_MS = 12 * 60 * 60 * 1000;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;
const USER_NAME = 'Mark';

function validPassword(value) {
  return typeof value === 'string' && value.length >= 8 && value.length <= 128 &&
    Buffer.byteLength(value, 'utf8') <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
}

function makePassword(password) {
  const salt = crypto.randomBytes(16);
  const digest = crypto.scryptSync(password, salt, 64);
  return { salt: salt.toString('base64'), hash: digest.toString('base64') };
}

function verifyPassword(password, saved) {
  // Run the same expensive operation for an unknown username.
  const salt = saved?.salt || Buffer.alloc(16).toString('base64');
  const expected = saved?.hash || Buffer.alloc(64).toString('base64');
  let actual;
  try { actual = crypto.scryptSync(String(password || ''), Buffer.from(salt, 'base64'), 64); }
  catch { return false; }
  const bytes = Buffer.from(expected, 'base64');
  return bytes.length === actual.length && crypto.timingSafeEqual(bytes, actual) && Boolean(saved);
}

function parseCookie(header) {
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === COOKIE) return part.slice(index + 1).trim();
  }
  return '';
}

function writeState(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
}

function readState(file) {
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`公司账号文件无法读取: ${error.message}`);
  }
  if (value.version !== 1 || !/^[A-Za-z0-9+/=]{40,}$/.test(value.secret || '') ||
      !value.users?.[USER_NAME]?.salt || !value.users?.[USER_NAME]?.hash ||
      value.users[USER_NAME]?.role !== 'admin' ||
      !Number.isInteger(value.users[USER_NAME]?.sessionVersion)) {
    throw new Error('公司账号文件格式无效；已停止账号验证');
  }
  return value;
}

class CompanyAuth {
  constructor(file, { now = () => Date.now() } = {}) {
    this.file = file || null;
    this.now = now;
    this.state = file ? readState(file) : null;
    this.failures = new Map();
    this.sockets = new Map();
  }

  get enabled() { return Boolean(this.file); }
  get setupRequired() { return this.enabled && !this.state; }

  cookie(token, secure = false) {
    return `${COOKIE}=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${SESSION_MS / 1000}` +
      (secure ? '; Secure' : '');
  }

  clearCookie(secure = false) {
    return `${COOKIE}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0` + (secure ? '; Secure' : '');
  }

  issue(name) {
    const account = this.state.users[name];
    const now = this.now();
    const payload = Buffer.from(JSON.stringify({ name, version: account.sessionVersion,
      issuedAt: now, expiresAt: now + SESSION_MS, nonce: crypto.randomBytes(12).toString('base64url') }))
      .toString('base64url');
    const signature = crypto.createHmac('sha256', Buffer.from(this.state.secret, 'base64'))
      .update(payload).digest('base64url');
    return `${payload}.${signature}`;
  }

  current(req) {
    if (!this.state) return null;
    const token = parseCookie(req.headers.cookie);
    if (token.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return null;
    const [payload, signature] = token.split('.');
    const expected = crypto.createHmac('sha256', Buffer.from(this.state.secret, 'base64'))
      .update(payload).digest();
    const actual = Buffer.from(signature, 'base64url');
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      const account = this.state.users[data.name];
      if (!account || data.version !== account.sessionVersion ||
          !Number.isSafeInteger(data.expiresAt) || data.expiresAt <= this.now() ||
          !Number.isSafeInteger(data.issuedAt) || data.issuedAt > this.now() + 60000) return null;
      return { name: data.name, role: account.role, expiresAt: data.expiresAt };
    } catch { return null; }
  }

  attempt(address) {
    const key = String(address || 'unknown');
    const entry = this.failures.get(key);
    if (!entry || entry.until <= this.now()) { this.failures.delete(key); return false; }
    return entry.count >= MAX_FAILURES;
  }

  failed(address) {
    const key = String(address || 'unknown');
    const entry = this.failures.get(key);
    const count = entry && entry.until > this.now() ? entry.count + 1 : 1;
    this.failures.set(key, { count, until: this.now() + FAILURE_WINDOW_MS });
    if (this.failures.size > 2000) {
      for (const [item, record] of this.failures) {
        if (record.until <= this.now()) this.failures.delete(item);
      }
    }
  }

  setup(adminPassword) {
    if (!this.setupRequired) throw new Error('账号已初始化');
    if (!validPassword(adminPassword)) {
      throw new Error('密码需为 8～128 个字符，不得包含控制字符');
    }
    const state = { version: 1, secret: crypto.randomBytes(32).toString('base64'), users: {
      Mark: { role: 'admin', ...makePassword(adminPassword), sessionVersion: 1 }
    } };
    writeState(this.file, state);
    this.state = state;
    return this.issue(USER_NAME);
  }

  login(name, password, address) {
    if (this.attempt(address)) return { rateLimited: true };
    const account = name === USER_NAME ? this.state?.users[USER_NAME] : null;
    if (!verifyPassword(password, account)) {
      this.failed(address);
      return { invalid: true };
    }
    this.failures.delete(String(address || 'unknown'));
    return { token: this.issue(name), user: { name, role: account.role } };
  }

  updatePassword(name, currentPassword, nextPassword) {
    const account = name === USER_NAME ? this.state?.users[USER_NAME] : null;
    if (!account || !validPassword(nextPassword)) throw new Error('新密码需为 8～128 个字符');
    if (!verifyPassword(currentPassword, account)) throw new Error('当前密码不正确');
    if (verifyPassword(nextPassword, account)) throw new Error('新密码不能与当前密码相同');
    const replacement = makePassword(nextPassword);
    const nextState = { ...this.state, users: { ...this.state.users,
      [name]: { ...account, ...replacement, sessionVersion: account.sessionVersion + 1 } } };
    writeState(this.file, nextState);
    this.state = nextState;
    this.closeSockets(name);
  }

  logout(name) {
    const account = this.state?.users[name];
    if (!account) return;
    const nextState = { ...this.state, users: { ...this.state.users,
      [name]: { ...account, sessionVersion: account.sessionVersion + 1 } } };
    writeState(this.file, nextState);
    this.state = nextState;
    this.closeSockets(name);
  }

  trackSocket(user, socket) {
    if (!this.enabled || !user) return;
    const sockets = this.sockets.get(user.name) || new Set();
    sockets.add(socket);
    this.sockets.set(user.name, sockets);
    const timeout = setTimeout(() => socket.destroy(), Math.max(1, user.expiresAt - this.now()));
    timeout.unref?.();
    socket.on('close', () => {
      clearTimeout(timeout);
      sockets.delete(socket);
      if (!sockets.size) this.sockets.delete(user.name);
    });
  }

  closeSockets(name) {
    for (const socket of this.sockets.get(name) || []) socket.destroy();
    this.sockets.delete(name);
  }
}

module.exports = { CompanyAuth, validPassword };
