const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { ResumeImportService, SUPPORTED_EXTENSIONS, MAX_FILE_SIZE } = require('./resumeImportService');
const { RecruitmentPipelineService } = require('./recruitmentPipelineService');
const { QcwyImapConfigService, list } = require('./qcwyImapConfigService');

const MAX_EMAIL_SIZE = 15 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_MESSAGE = 20;
const MAX_UID_ATTEMPTS = 3;

function matchesSender(sender, allowlist) {
  const email = String(sender || '').trim().toLowerCase();
  return list(allowlist).some(entry => {
    const rule = entry.toLowerCase();
    return rule.startsWith('@') ? email.endsWith(rule) && email.length > rule.length : email === rule;
  });
}

function matchesJob(mail, config) {
  const keywords = list(config.jobKeywords || config.jobTitle).map(value => value.toLowerCase());
  const filenames = (mail.attachments || []).map(item => item.filename || '').join(' ');
  const content = `${mail.subject || ''}\n${mail.text || ''}\n${filenames}`.toLowerCase();
  return keywords.some(keyword => content.includes(keyword)) &&
    /简历|候选人|应聘|resume|applicant|candidate/i.test(content);
}

function safeStatus(state) {
  return { ...state };
}

class QcwyImapSyncService {
  constructor({
    config = new QcwyImapConfigService(),
    importer = new ResumeImportService(),
    pipeline = new RecruitmentPipelineService(),
    clientFactory = options => new ImapFlow(options),
    parseMail = source => simpleParser(source, { maxHtmlLengthToParse: 100000 }),
    checkpointFile = path.join(__dirname, '../../../.local/qcwy-imap-checkpoint.json'),
    setTimer = (callback, ms) => setInterval(callback, ms),
    clearTimer = timer => clearInterval(timer)
  } = {}) {
    this.config = config;
    this.importer = importer;
    this.pipeline = pipeline;
    this.clientFactory = clientFactory;
    this.parseMail = parseMail;
    this.checkpointFile = checkpointFile;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.timer = null;
    this.activeRun = null;
    this.stopRequested = false;
    this.state = {
      running: false, scheduled: false, processedMessages: 0, imported: 0,
      duplicates: 0, filtered: 0, noSupportedAttachment: 0, tooLarge: 0,
      failed: 0, evaluated: 0, deadLetters: [], lastSyncAt: null, lastError: null
    };
  }

  status() { return safeStatus(this.state); }

  connectOptions() {
    const current = this.config.current();
    if (!current.configured) throw new Error('请先配置 IMAP 收件邮箱、发件人筛选和岗位条件');
    return {
      host: current.host,
      port: current.port,
      secure: current.security === 'tls',
      doSTARTTLS: current.security === 'starttls',
      auth: { user: current.user, pass: this.config.password() },
      logger: false,
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 30000
    };
  }

  async verify() {
    const client = this.clientFactory(this.connectOptions());
    let lock;
    try {
      await client.connect();
      lock = await client.getMailboxLock(this.config.current().folder, { readOnly: true });
      return { connected: true, folder: this.config.current().folder };
    } catch (_) {
      throw new Error('IMAP 连接或登录失败；请检查服务器、授权码及邮箱是否开启 IMAP');
    } finally {
      if (lock) lock.release();
      await client.logout().catch(() => {});
    }
  }

  configureSchedule() {
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    const current = this.config.current();
    this.state.scheduled = Boolean(current.enabled && current.configured);
    if (!this.state.scheduled) return this.status();
    this.timer = this.setTimer(() => {
      if (!this.state.running) {
        try { this.syncNow(); }
        catch (_) { this.state.lastError = '自动同步未能启动，请检查 IMAP 设置'; }
      }
    }, current.pollMinutes * 60000);
    this.timer?.unref?.();
    if (!this.state.running) this.syncNow();
    return this.status();
  }

  stop() {
    this.stopRequested = true;
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    this.state.scheduled = false;
    return this.status();
  }

  syncNow() {
    if (this.state.running) throw new Error('前程无忧邮箱同步正在进行中');
    this.connectOptions();
    this.stopRequested = false;
    this.state = { ...this.state, running: true, processedMessages: 0, imported: 0,
      duplicates: 0, filtered: 0, noSupportedAttachment: 0, tooLarge: 0,
      failed: 0, evaluated: 0, lastError: null };
    this.activeRun = this.run().catch(() => {
      this.state.lastError = '同步失败；请检查 IMAP 设置、网络或本机同步断点文件后重试';
    }).finally(() => {
      this.state.running = false;
      this.state.lastSyncAt = new Date().toISOString();
      this.activeRun = null;
    });
    return this.status();
  }

  checkpointKey(current) {
    return crypto.createHash('sha256')
      .update(`${current.host}\n${current.user}\n${current.folder}`.toLowerCase())
      .digest('hex');
  }

  async readCheckpoint(key, uidValidity) {
    let missing = false;
    const saved = await fs.readJson(this.checkpointFile).catch(error => {
      if (error.code === 'ENOENT') { missing = true; return null; }
      throw error;
    });
    if (missing) return null;
    if (!saved || typeof saved !== 'object' || typeof saved.key !== 'string' ||
        typeof saved.uidValidity !== 'string' ||
        !Number.isSafeInteger(saved.lastUid) || saved.lastUid < 0 ||
        (saved.failure != null &&
          (!Number.isSafeInteger(saved.failure.uid) || !Number.isSafeInteger(saved.failure.attempts) ||
           saved.failure.attempts < 1 || saved.failure.attempts >= MAX_UID_ATTEMPTS)) ||
        (saved.deadLetters !== undefined && !Array.isArray(saved.deadLetters))) {
      throw new Error('Invalid IMAP checkpoint');
    }
    if (saved.key !== key || saved.uidValidity !== uidValidity) return null;
    return { lastUid: saved.lastUid, failure: saved.failure || null,
      deadLetters: (saved.deadLetters || []).slice(-20) };
  }

  async writeCheckpoint(key, uidValidity, checkpoint) {
    await fs.ensureDir(path.dirname(this.checkpointFile));
    const temporary = `${this.checkpointFile}.${process.pid}.tmp`;
    try {
      await fs.writeJson(temporary, { key, uidValidity, ...checkpoint }, { spaces: 0, mode: 0o600 });
      await fs.move(temporary, this.checkpointFile, { overwrite: true });
    } finally {
      await fs.remove(temporary).catch(() => {});
    }
  }

  async processMessage(source, current) {
    let mail;
    try { mail = await this.parseMail(source); }
    catch (_) {
      this.state.failed++;
      this.state.lastError = '邮件解析失败，已保留该邮件位置供下次重试';
      return { complete: false, permanent: true };
    }
    const senders = mail.from?.value || [];
    if (senders.length !== 1 || !matchesSender(senders[0].address, current.senderAllowlist) ||
        !matchesJob(mail, current)) {
      this.state.filtered++;
      return { complete: true };
    }
    const supported = (mail.attachments || [])
      .filter(item => SUPPORTED_EXTENSIONS.has(path.extname(item.filename || '').toLowerCase()));
    if (!supported.length) {
      this.state.noSupportedAttachment++;
      return { complete: true };
    }
    if (supported.length > MAX_ATTACHMENTS_PER_MESSAGE) {
      this.state.failed++;
      this.state.lastError = '单封邮件的简历附件超过 20 份，已暂停并保留该邮件位置';
      return { complete: false, permanent: true };
    }
    let hadFailure = false;
    for (const attachment of supported) {
      if (this.stopRequested) break;
      if (!Buffer.isBuffer(attachment.content) || !attachment.content.length ||
          attachment.content.length > MAX_FILE_SIZE) {
        this.state.tooLarge++;
        continue;
      }
      try {
        const result = await this.importer.importFile({
          originalname: path.basename(attachment.filename), buffer: attachment.content
        }, { source: 'qcwy', localOnly: true });
        if (result.duplicate) this.state.duplicates++;
        else this.state.imported++;
        if (result.resume?.id && result.resume.matchEvaluation?.jobRequirements !== current.jobRequirements) {
          await this.pipeline.evaluate(result.resume.id, current.jobRequirements);
          this.state.evaluated++;
        }
      } catch (_) {
        // Keep this UID so a transient import/evaluation failure can retry.
        this.state.failed++;
        hadFailure = true;
      }
    }
    if (hadFailure) this.state.lastError = '部分简历导入或评估失败，已保留该邮件位置供下次重试';
    return { complete: !this.stopRequested && !hadFailure, permanent: false };
  }

  async run() {
    const current = this.config.current();
    const client = this.clientFactory(this.connectOptions());
    let lock;
    try {
      await client.connect();
      lock = await client.getMailboxLock(current.folder, { readOnly: true });
      const uidValidity = String(client.mailbox?.uidValidity || '');
      const uidNext = Number(client.mailbox?.uidNext || 1);
      if (!Number.isSafeInteger(uidNext) || uidNext < 1) throw new Error('Invalid UIDNEXT');
      const key = this.checkpointKey(current);
      const checkpoint = await this.readCheckpoint(key, uidValidity) ||
        { lastUid: null, failure: null, deadLetters: [] };
      this.state.deadLetters = checkpoint.deadLetters;
      // On first connection scan only the newest bounded window. Subsequent
      // scans resume in UID order, including previously read messages.
      const firstUid = checkpoint.lastUid === null
        ? Math.max(1, uidNext - current.maxMessages) : checkpoint.lastUid + 1;
      if (checkpoint.lastUid === null) checkpoint.lastUid = firstUid - 1;
      const lastUid = Math.min(uidNext - 1, firstUid + current.maxMessages - 1);
      if (lastUid < firstUid) return;
      const messages = await client.fetchAll(`${firstUid}:${lastUid}`,
        { uid: true, size: true, envelope: true }, { uid: true });
      const ordered = (messages || []).filter(item => item.uid >= firstUid && item.uid <= lastUid)
        .sort((a, b) => a.uid - b.uid);
      for (const message of ordered) {
        if (this.stopRequested) break;
        let outcome = { complete: true };
        const envelopeFrom = message.envelope?.from;
        if (!Array.isArray(envelopeFrom) || envelopeFrom.length !== 1 ||
            !matchesSender(envelopeFrom[0]?.address, current.senderAllowlist)) {
          this.state.filtered++;
        } else if (message.size > MAX_EMAIL_SIZE) {
          this.state.tooLarge++;
        } else {
          try {
            const fetched = await client.fetchOne(message.uid, { source: true }, { uid: true });
            if (fetched?.source?.length > MAX_EMAIL_SIZE) this.state.tooLarge++;
            else if (fetched?.source?.length) outcome = await this.processMessage(fetched.source, current);
            else {
              this.state.failed++;
              this.state.lastError = '邮件正文获取失败，已保留该邮件位置供下次重试';
              outcome = { complete: false, permanent: false };
            }
          } catch (_) {
            this.state.failed++;
            this.state.lastError = '邮件正文获取失败，已保留该邮件位置供下次重试';
            outcome = { complete: false, permanent: false };
          }
        }
        if (!outcome.complete) {
          if (this.stopRequested) return;
          if (!outcome.permanent) {
            checkpoint.failure = null;
            await this.writeCheckpoint(key, uidValidity, checkpoint);
            return;
          }
          const attempts = checkpoint.failure?.uid === message.uid
            ? checkpoint.failure.attempts + 1 : 1;
          if (attempts < MAX_UID_ATTEMPTS) {
            checkpoint.failure = { uid: message.uid, attempts,
              reason: this.state.lastError || '邮件处理失败' };
            await this.writeCheckpoint(key, uidValidity, checkpoint);
            return;
          }
          const reason = this.state.lastError || '邮件处理失败';
          checkpoint.deadLetters = [...checkpoint.deadLetters,
            { uid: message.uid, reason, at: new Date().toISOString() }].slice(-20);
          this.state.deadLetters = checkpoint.deadLetters;
          this.state.lastError = `邮件 UID ${message.uid} 连续 ${MAX_UID_ATTEMPTS} 次处理失败，已隔离供人工查看；后续邮件继续同步`;
        }
        this.state.processedMessages++;
        checkpoint.lastUid = message.uid;
        checkpoint.failure = null;
        await this.writeCheckpoint(key, uidValidity, checkpoint);
      }
      if (!this.stopRequested && checkpoint.lastUid < lastUid) {
        checkpoint.lastUid = lastUid;
        await this.writeCheckpoint(key, uidValidity, checkpoint);
      }
    } finally {
      if (lock) lock.release();
      await client.logout().catch(() => {});
    }
  }
}

module.exports = { QcwyImapSyncService, matchesSender, matchesJob, MAX_EMAIL_SIZE, MAX_UID_ATTEMPTS };
