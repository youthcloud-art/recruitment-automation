const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_FILE = path.resolve(__dirname, '../../../.local/collection-runs/boss.json');

class CollectionRunJournal {
  constructor(file = DEFAULT_FILE) { this.file = file; }

  read() {
    try {
      const value = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (value?.version !== 1 || !['search', 'recommended'].includes(value.mode) ||
          !Number.isInteger(value.targetCount) || value.targetCount < 1 ||
          !Number.isInteger(value.saved) || value.saved < 0 ||
          !/^[a-f0-9]{64}$/.test(value.jobSignature || '') ||
          typeof value.jobTitle !== 'string' || !value.jobTitle) return null;
      return value;
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
      throw error;
    }
  }

  write({ mode, targetCount, jobSignature, jobTitle, status }) {
    const value = {
      version: 1, mode, targetCount, jobSignature, jobTitle,
      filters: mode === 'search' ? { position: jobTitle } : null,
      maxRuntimeMinutes: Number(status.maxRuntimeMinutes) || 90,
      state: status.state || 'running', saved: Number(status.saved) || 0,
      attempted: Number(status.attempted) || 0,
      skipped: Number(status.skipped) || 0,
      startedAt: status.startedAt || null,
      finishedAt: status.finishedAt || null,
      lastFailureCode: String(status.lastFailureCode || '').slice(0, 80),
      updatedAt: new Date().toISOString()
    };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
      fs.renameSync(temporary, this.file);
    } finally {
      try { fs.unlinkSync(temporary); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    return value;
  }

  clear() {
    try { fs.unlinkSync(this.file); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  interruptedStatus(job) {
    const saved = this.read();
    if (!saved) return null;
    const sameJob = saved.jobSignature === job?.signature;
    const state = saved.saved >= saved.targetCount ? 'completed'
      : saved.state === 'running' ? 'paused' : saved.state;
    const interrupted = saved.state === 'running' && state !== 'completed';
    return {
      status: state,
      isActive: false,
      mode: saved.mode,
      requestedMode: saved.mode,
      filters: sameJob ? saved.filters : null,
      candidates: [],
      targetCount: saved.targetCount,
      collectedCount: saved.saved,
      processedCount: saved.saved,
      attemptedCount: saved.attempted,
      skippedCount: saved.skipped,
      likedCount: 0,
      dislikedCount: 0,
      currentIndex: saved.attempted,
      currentCardIndex: -1,
      lastCardIndex: -1,
      scrollRounds: 0,
      currentPhase: state,
      maxRuntimeMinutes: saved.maxRuntimeMinutes,
      resumeAvailable: false,
      lastFailureCode: state === 'completed' ? ''
        : sameJob ? interrupted ? 'BOSS_RUNTIME_RESTARTED' : saved.lastFailureCode
          : 'BOSS_JOB_CHANGED',
      completionReason: state === 'completed' ? '已达到目标新增简历份数'
        : sameJob
          ? '采集进程已结束。已入库简历保留；确认 BOSS 原页面后，可按尚差份数启动新一轮，系统自动去重。'
          : '采集后岗位条件已变化；请核对岗位后再启动新一轮。',
      lastError: state === 'paused'
        ? interrupted ? '服务重启后原采集进程已结束，请确认平台页面并补采剩余份数。'
          : '上次采集已暂停，请确认平台页面并按剩余份数补采。'
        : '',
      startedAt: saved.startedAt,
      finishedAt: saved.finishedAt,
      journalUpdatedAt: saved.updatedAt
    };
  }
}

module.exports = { CollectionRunJournal };
