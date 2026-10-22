// Local, privacy-minimal checkpoint for BOSS cards that fail only
// after an acknowledged card click. The file never contains candidate text,
// name, contact details, OCR, or a resume URL.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_FILE = path.resolve(__dirname, '../../../.local/boss-card-quarantine.json');
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 2000;
const JOB_ID = /^[A-Za-z0-9_-]{1,128}$/;
const FINGERPRINT = /^[a-f0-9]{64}$/;
const ENTRY_KEYS = ['cardFingerprint', 'failedAt', 'failureCode', 'jobId'];

function quarantineError(message) {
  const error = new Error(message);
  error.code = 'BOSS_CARD_QUARANTINE_INVALID';
  return error;
}

function validateEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
      JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(ENTRY_KEYS) ||
      typeof entry.jobId !== 'string' || !JOB_ID.test(entry.jobId) ||
      typeof entry.cardFingerprint !== 'string' || !FINGERPRINT.test(entry.cardFingerprint) ||
      entry.failureCode !== 'BOSS_CDP_TIMEOUT' ||
      typeof entry.failedAt !== 'string' ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(entry.failedAt) ||
      !Number.isFinite(Date.parse(entry.failedAt))) {
    throw quarantineError('BOSS 暂缓候选卡记录格式无效，请检查或手动重置');
  }
  return entry;
}

class BossCardQuarantine {
  constructor({file = DEFAULT_FILE, now = Date.now} = {}) {
    this.file = file;
    this.now = now;
  }

  load() {
    let saved;
    try { saved = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return [];
      throw quarantineError('BOSS 暂缓候选卡记录无法读取，请检查或手动重置');
    }
    if (saved?.version !== 1 || !Array.isArray(saved.entries) ||
        saved.entries.length > MAX_ENTRIES) {
      throw quarantineError('BOSS 暂缓候选卡记录格式无效，请检查或手动重置');
    }
    return saved.entries.map(validateEntry);
  }

  activeEntries() {
    const now = this.now();
    return this.load().filter(entry => {
      const age = now - Date.parse(entry.failedAt);
      return age >= 0 && age < TTL_MS;
    });
  }

  has(jobId, cardFingerprint) {
    if (typeof jobId !== 'string' || !JOB_ID.test(jobId) ||
        typeof cardFingerprint !== 'string' || !FINGERPRINT.test(cardFingerprint)) {
      throw quarantineError('BOSS 暂缓候选卡查询参数无效');
    }
    return this.activeEntries().some(entry =>
      entry.jobId === jobId && entry.cardFingerprint === cardFingerprint);
  }

  mark(jobId, cardFingerprint, failureCode = 'BOSS_CDP_TIMEOUT') {
    if (typeof jobId !== 'string' || !JOB_ID.test(jobId) ||
        typeof cardFingerprint !== 'string' || !FINGERPRINT.test(cardFingerprint) ||
        failureCode !== 'BOSS_CDP_TIMEOUT') {
      throw quarantineError('BOSS 暂缓候选卡写入参数无效');
    }
    const entries = this.activeEntries().filter(entry =>
      entry.jobId !== jobId || entry.cardFingerprint !== cardFingerprint);
    entries.push({jobId,cardFingerprint,failureCode,
      failedAt:new Date(this.now()).toISOString()});
    const bounded = entries.slice(-MAX_ENTRIES);
    fs.mkdirSync(path.dirname(this.file),{recursive:true,mode:0o700});
    const temporary = `${this.file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(temporary,JSON.stringify({version:1,entries:bounded}),{mode:0o600});
      fs.renameSync(temporary,this.file);
    } finally {
      try { fs.unlinkSync(temporary); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return bounded.length;
  }

  summary() { return {count:this.activeEntries().length,ttlHours:TTL_MS/3600000}; }

  clear() {
    // Manual reset must also recover a damaged checkpoint file.
    let count=0;
    try { count=this.load().length; }
    catch (error) { if (error.code !== 'BOSS_CARD_QUARANTINE_INVALID') throw error; }
    try { fs.unlinkSync(this.file); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return count;
  }
}

module.exports = {BossCardQuarantine,TTL_MS};
