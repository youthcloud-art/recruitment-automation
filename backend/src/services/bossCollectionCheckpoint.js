const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_FILE = path.resolve(__dirname, '../../../.local/boss-collection-checkpoint.json');

function taskSignature({ mode, filters, targetCount, job }) {
  const normalized = {
    mode: String(mode || ''),
    filters: Object.fromEntries(Object.entries(filters || {})
      .filter(([, value]) => value !== undefined && value !== null)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, String(value).trim()])),
    targetCount: Number(targetCount),
    title: String(job?.title || '').trim(),
    requirements: String(job?.jobRequirements || '').trim()
  };
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

class BossCollectionCheckpoint {
  constructor(file = DEFAULT_FILE) { this.file = file; }

  load() {
    let saved;
    try { saved = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new Error(`BOSS 采集进度文件无法读取: ${error.message}`);
    }
    if (saved?.version !== 1 || !/^[a-f0-9]{64}$/.test(saved.signature || '') ||
        !['running', 'paused', 'completed'].includes(saved.state) ||
        !Number.isInteger(saved.processedCount) || saved.processedCount < 0 ||
        !Number.isInteger(saved.nextKeywordIndex) || saved.nextKeywordIndex < 0 ||
        !Number.isInteger(saved.targetCount) || saved.targetCount < 1) {
      throw new Error('BOSS 采集进度文件格式无效，请检查文件后手动重置');
    }
    return saved;
  }

  save(progress) {
    const value = { version: 1, ...progress, updatedAt: new Date().toISOString() };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
      fs.renameSync(temporary, this.file);
    } finally {
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return value;
  }

  clear() {
    try { fs.unlinkSync(this.file); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

module.exports = { BossCollectionCheckpoint, taskSignature };
