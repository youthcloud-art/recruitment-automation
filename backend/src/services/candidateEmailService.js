const nodemailer = require('nodemailer');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const { RecruitmentPipelineService, SOURCES, STATUSES } = require('./recruitmentPipelineService');
const { isSameZhilianResume } = require('../utils/zhilianResumeIdentity');
const { markdownToDocx } = require('./candidateReportDocx');
const { buildResumePresentation, presentationMarkdown } = require('./resumePresentation');
const { candidateName, candidatePosition, hiringJobTitle } = require('../utils/candidateDisplay');
const { platformLocator } = require('../utils/platformLocator');
const { hasTrackedActiveJob } = require('../utils/activeJobScope');

const SOURCE_NAMES = { boss: 'BOSS直聘', zlzp: '智联招聘', qcwy: '前程无忧' };
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const FILE_TYPES = { '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.txt': 'text/plain; charset=utf-8' };
const ATTACHMENT_LABELS = {
  original: '导入的原文件',
  'import-text': '整理排版的 Word 简历（由导入文本生成，非原版文件）',
  'page-text': '整理排版的 Word 简历（由页面提取文本生成，非平台原版文件）'
};

function isWithin(directory, target) {
  const relative = path.relative(directory, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function validateEmail(value) {
  return typeof value === 'string' && value.length <= 254 &&
    /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(value);
}

function normalizeSelection(input = {}) {
  const source = String(input.source || '');
  const status = String(input.status || '');
  const minScore = Number(input.minScore ?? 70);
  const topN = Number(input.topN ?? 10);
  const offset = Number(input.offset ?? 0);
  const poolFingerprint = String(input.poolFingerprint || '');
  const newOnly = input.newOnly ?? false;
  const jobRequirements = String(input.jobRequirements || '').trim();
  const reportFormat = input.reportFormat ?? 'docx';
  if (source && !SOURCES.includes(source)) throw new Error('不支持的招聘平台');
  if (status && !STATUSES.includes(status)) throw new Error('不支持的跟进状态');
  if (!Number.isInteger(minScore) || minScore < 0 || minScore > 100) throw new Error('最低匹配分需为 0～100');
  if (!Number.isInteger(topN) || topN < 1 || topN > 20) throw new Error('每封邮件最多发送 20 份简历');
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000) throw new Error('邮件批次偏移量无效');
  if (poolFingerprint && !/^[a-f0-9]{64}$/i.test(poolFingerprint)) throw new Error('邮件批次指纹无效');
  if (offset && !poolFingerprint) throw new Error('继续下一批前请先预览并保留首批指纹');
  if (typeof newOnly !== 'boolean') throw new Error('新增候选人筛选参数无效');
  if (newOnly && (offset || poolFingerprint)) throw new Error('新增候选人须从未发送名单重新预览');
  if (jobRequirements.length < 5 || jobRequirements.length > 5000) throw new Error('岗位要求需为 5～5000 字');
  if (!['docx', 'md'].includes(reportFormat)) throw new Error('不支持的初筛报告格式，请选择 Word 或 Markdown');
  return { source, status, minScore, topN, offset, poolFingerprint, jobRequirements, reportFormat, newOnly };
}

function assessmentPoints(value) {
  const points = Array.isArray(value)
    ? value.filter(point => typeof point === 'string')
      .map(point => point.replace(/[\r\n]/g, ' ').trim()).filter(Boolean)
    : [];
  return points.length ? points.map(point => `- ${point}`) : ['- 暂无'];
}

function platformRecord(item) {
  const locator = platformLocator(item);
  return { label: locator.kind || '平台记录号', id: locator.id || '待平台核实' };
}

function recipientLookupLine(item, assistantLink) {
  const record = platformRecord(item);
  if (item.source === 'qcwy') {
    return record.id === '待平台核实'
      ? '前程无忧简历 ID 待平台核实；请招聘管理员核对官方详情后再查找'
      : `前程无忧简历 ID：${record.id}（请在前程无忧官方简历 ID 查询入口核对）`;
  }
  const platform = item.source === 'zlzp' ? '智联' : 'BOSS';
  return assistantLink
    ? `${platform} 助手记录：${assistantLink}（仅供已获助手授权者查看；官方原候选人需在公司服务器浏览器再次核对）`
    : `${platform} 助手记录：暂无可用链接；请联系招聘管理员在公司服务器核对原候选人`;
}

function assistantOrigin(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash) return '';
    return url.origin;
  } catch (_) { return ''; }
}

function reportCell(value) {
  return String(value ?? '').replace(/[\r\n|]/g, ' ').trim();
}

function jobTitleFromRequirements(requirements) {
  const firstLine = String(requirements || '').split(/[\r\n\u2028\u2029]/, 1)[0]
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').trim();
  const match = firstLine.match(/^岗位(?:名称)?\s*[：:]\s*(.+)$/u);
  if (!match) return '';
  const title = match[1].replace(/\s*[（(]\s*(?:依据|根据|参照).+$/u, '').trim();
  return [...title].length >= 2 && [...title].length <= 40 &&
    /^[\p{L}\p{N}\s·.()（）&+/_-]+$/u.test(title) ? title : '';
}

function isCurrentEvaluation(item, requirements) {
  return item.matchEvaluation?.jobRequirements === requirements &&
    Number.isFinite(item.matchScore) &&
    !['pending', 'failed'].includes(item.matchEvaluationStatus);
}

function isSupportedEvaluation(item, requireQcwyRecommendation = true) {
  const evaluation = item.matchEvaluation || {};
  if (item.source !== 'qcwy') {
    // Legacy keyword/manual scores must never enter an active-job mailout,
    // even if their stored requirements happen to match the current JD.
    // Keep an explicit AI recommendation veto consistent with the Word report.
    return ['zlzp', 'boss'].includes(item.source) &&
      evaluation.method === 'llm' && evaluation.evaluationVersion === 1 &&
      Boolean(evaluation.evaluatedAt) && evaluation.recommendationEligible !== false;
  }
  // The cost-accounting rubric has explicit minimum-evidence gates. Generic jobs
  // use the versioned AI assessment and the caller's score threshold instead.
  return (evaluation.method === 'local' && evaluation.evaluationVersion === 2 &&
    (!requireQcwyRecommendation || evaluation.recommendationEligible === true)) ||
    (evaluation.method === 'llm' && evaluation.evaluationVersion === 1 &&
      Boolean(evaluation.evaluatedAt) && evaluation.recommendationEligible !== false);
}

class CandidateEmailService {
  constructor({ pipeline = new RecruitmentPipelineService(), transportFactory = nodemailer.createTransport,
    now = Date.now, resumeDirectory = path.join(__dirname, '../../storage/resume_library'),
    deliveryReceiptDirectory = null,
    publicOrigin = process.env.ASSISTANT_PUBLIC_ORIGIN } = {}) {
    this.pipeline = pipeline;
    this.transportFactory = transportFactory;
    this.now = now;
    this.previews = new Map();
    this.resumeDirectory = path.resolve(resumeDirectory);
    // The HTTP route enables this durable guard. Tests and offline callers can
    // opt in with their own temporary directory without touching live records.
    this.deliveryReceiptDirectory = deliveryReceiptDirectory && path.resolve(deliveryReceiptDirectory);
    this.publicOrigin = assistantOrigin(publicOrigin);
  }

  candidateLink(item) {
    return this.publicOrigin && /^resume_[A-Za-z0-9_-]{8,100}$/.test(item.id || '')
      ? `${this.publicOrigin}/?candidate=${encodeURIComponent(item.id)}` : '';
  }

  configuration() {
    const required = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_FROM'];
    const missing = required.filter(key => !process.env[key]);
    const hasPassword = Boolean(process.env.SMTP_PASS_B64 || process.env.SMTP_PASS);
    if (Boolean(process.env.SMTP_USER) !== hasPassword) {
      missing.push(process.env.SMTP_USER ? 'SMTP_PASS' : 'SMTP_USER');
    }
    return { configured: missing.length === 0, missing };
  }

  activeJobGroup(requirements) {
    return hasTrackedActiveJob(this.pipeline.store, this.pipeline.activeJob?.(), requirements)
      ? 'current' : '';
  }

  select(input, { excludedHashes = null, recipientJobKey = '' } = {}) {
    const selection = normalizeSelection(input);
    const selectedZhilian = [];
    const sourceRecords = this.pipeline.list({ source: selection.source, status: selection.status,
      limit: 10000, jobGroup: this.activeJobGroup(selection.jobRequirements) });
    if (sourceRecords.length >= 10000) {
      throw new Error('单次邮件筛选最多检查 10000 份简历，请按平台或跟进状态缩小范围');
    }
    const eligible = sourceRecords
      // An HR rejection takes precedence over an earlier AI score. Keep an
      // explicit rejected-status selection available for audit/export.
      .filter(item => selection.status
        ? (item.workflowStatus || 'new') === selection.status
        : (item.workflowStatus || 'new') !== 'rejected')
      .filter(item => Number.isFinite(item.matchScore) && item.matchScore >= selection.minScore &&
        item.matchEvaluation?.jobRequirements === selection.jobRequirements &&
        isCurrentEvaluation(item, selection.jobRequirements) &&
        isSupportedEvaluation(item) &&
        (item.originalText || item.content))
      .sort((a, b) => b.matchScore - a.matchScore ||
        String(a.source || '').localeCompare(String(b.source || '')) ||
        String(a.id || '').localeCompare(String(b.id || '')))
      .filter(item => {
        if (item.source !== 'zlzp') return true;
        if (selectedZhilian.some(existing => isSameZhilianResume(existing, item))) return false;
        selectedZhilian.push(item);
        return true;
      })
      .filter(item => !excludedHashes || !excludedHashes.has(crypto.createHash('sha256')
        .update(`${recipientJobKey}:${item.source}:${item.id}`).digest('hex')));
    // Lock the ordered candidate pool across batches. New resumes or changed
    // evaluations stop a later batch instead of silently shifting its offset.
    const poolHash = crypto.createHash('sha256');
    for (const item of eligible) poolHash.update(JSON.stringify({
      id: item.id, source: item.source, matchScore: item.matchScore,
      name: item.name, position: item.position, expectedPosition: item.expectedPosition,
      matchEvaluation: item.matchEvaluation, originalText: item.originalText,
      content: item.content, filePath: item.filePath, fileHash: item.fileHash
    })).update('\n');
    const poolFingerprint = poolHash.digest('hex');
    if (selection.poolFingerprint && selection.poolFingerprint !== poolFingerprint) {
      throw new Error('候选人集合已变化，请核对已发送批次后重新预览');
    }
    const candidates = eligible.slice(selection.offset, selection.offset + selection.topN);
    return { selection, candidates, total: eligible.length, poolFingerprint,
      nextOffset: selection.offset + candidates.length };
  }

  screeningSummary(selection, candidates) {
    const evaluated = this.pipeline.list({ source: selection.source, status: selection.status,
      limit: 10000, jobGroup: this.activeJobGroup(selection.jobRequirements) })
      .filter(item => (!selection.source || item.source === selection.source) &&
        (selection.status
          ? (item.workflowStatus || 'new') === selection.status
          : (item.workflowStatus || 'new') !== 'rejected') &&
        isCurrentEvaluation(item, selection.jobRequirements) &&
        isSupportedEvaluation(item, false));
    const sources = selection.source ? [selection.source] : Object.keys(SOURCE_NAMES)
      .filter(source => evaluated.some(item => item.source === source) ||
        candidates.some(item => item.source === source));
    const bySource = Object.fromEntries(sources.map(source => [source, {
      evaluated: evaluated.filter(item => item.source === source).length,
      attached: candidates.filter(item => item.source === source).length
    }]));
    const qcwy = evaluated.filter(item => item.source === 'qcwy');
    const qcwyLocal = qcwy.filter(item => item.matchEvaluation.method === 'local');
    const qcwyAi = qcwy.filter(item => item.matchEvaluation.method === 'llm');
    const localEligible = qcwyLocal.filter(item =>
      item.matchEvaluation.recommendationEligible === true).length;
    const localBelowMinimum = qcwyLocal.filter(item =>
      Object.values(item.matchEvaluation.requiredEvidence || {}).some(evidence =>
        evidence?.status === 'not_met')).length;
    return {
      sources, bySource,
      qcwy: {
        evaluated: qcwy.length,
        local: qcwyLocal.length,
        localEligible,
        localBelowMinimum,
        localPending: qcwyLocal.length - localEligible - localBelowMinimum,
        ai: qcwyAi.length,
        aiAtOrAboveScore: qcwyAi.filter(item => item.matchScore >= selection.minScore).length
      }
    };
  }

  async preview(input) {
    const { selection, candidates, total, poolFingerprint, nextOffset } = input?.newOnly
      ? await this.selectUndelivered(input) : this.select(input);
    const attachments = await this.candidateAttachments(candidates);
    const screening = this.screeningSummary(selection, candidates);
    for (const [token, saved] of this.previews) {
      if (saved.expiresAt <= this.now()) this.previews.delete(token);
    }
    while (this.previews.size >= 100) this.previews.delete(this.previews.keys().next().value);
    const previewToken = candidates.length ? crypto.randomBytes(24).toString('hex') : null;
    if (previewToken) {
      this.previews.set(previewToken, {
        fingerprint: this.fingerprint(selection, candidates, attachments, screening, poolFingerprint),
        expiresAt: this.now() + 10 * 60 * 1000
      });
    }
    return {
      selection,
      screening,
      previewToken,
      count: candidates.length,
      total,
      offset: selection.offset,
      nextOffset,
      hasMore: nextOffset < total,
      poolFingerprint,
      candidates: candidates.map((item, index) => ({
        id: item.id,
        name: candidateName(item),
        source: item.source,
        platformRecordId: platformRecord(item).id,
        assistantLink: this.candidateLink(item),
        score: item.matchScore,
        position: candidatePosition(item),
        attachmentType: ATTACHMENT_LABELS[attachments[index].attachmentKind]
      }))
    };
  }

  fingerprint(selection, candidates, attachments, screening, poolFingerprint) {
    const files = attachments.map(file => ({ filename: file.filename,
      // OOXML ZIP metadata can differ between two otherwise identical renders.
      hash: file.fingerprintHash || crypto.createHash('sha256').update(file.content).digest('hex') }));
    return crypto.createHash('sha256').update(JSON.stringify({ selection, candidates, files,
      screening, poolFingerprint })).digest('hex');
  }

  async originalAttachment(item, index) {
    // 官方文件导入器保存 fileHash；平台网页采集记录继续使用原文 TXT。
    if (typeof item.filePath !== 'string' || !/^[a-f0-9]{32}$/i.test(item.fileHash || '')) return null;
    // Legacy records hold absolute paths from the original PC. After a full
    // data-directory restore, look for that same filename under the current
    // library, then verify the original MD5 before attaching anything.
    const { portableBasename } = require('../utils/portablePath');
    const storedAbsolute = path.isAbsolute(item.filePath) || path.win32.isAbsolute(item.filePath);
    const requested = storedAbsolute
      ? path.resolve(this.resumeDirectory, portableBasename(item.filePath))
      : path.resolve(this.resumeDirectory, item.filePath);
    const extension = path.extname(requested).toLowerCase();
    if (!FILE_TYPES[extension] || !isWithin(this.resumeDirectory, requested)) return null;
    let handle;
    try {
      const directory = await fs.realpath(this.resumeDirectory);
      const target = await fs.realpath(requested);
      if (!isWithin(directory, target) || path.extname(target).toLowerCase() !== extension) return null;
      handle = await fs.open(target, 'r');
      const stats = await handle.stat();
      if (!stats.isFile() || stats.size < 1 || stats.size > MAX_ATTACHMENT_BYTES) return null;
      const buffer = Buffer.alloc(stats.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length !== stats.size) return null;
      const content = buffer.subarray(0, length);
      if (crypto.createHash('md5').update(content).digest('hex') !== item.fileHash.toLowerCase()) return null;
      return { filename: `candidate-${index + 1}${extension}`, content, contentType: FILE_TYPES[extension] };
    } catch (_) {
      return null;
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }

  async candidateAttachments(candidates) {
    const attachments = [];
    let size = 0;
    const sourceSize = candidates.reduce((total, candidate) => total +
      Buffer.byteLength(String(candidate.originalText || candidate.content || '')), 0);
    if (sourceSize > MAX_TOTAL_ATTACHMENT_BYTES) throw new Error('邮件附件总大小不能超过 20MB，请减少发送份数');
    for (const [index, item] of candidates.entries()) {
      const original = await this.originalAttachment(item, index);
      const preserveOriginal = original && !original.filename.endsWith('.txt');
      const attachmentKind = preserveOriginal ? 'original' : item.fileHash ? 'import-text' : 'page-text';
      const presentationInput = original?.filename.endsWith('.txt')
        ? { ...item, originalText: original.content.toString('utf8') } : item;
      const markdown = preserveOriginal ? '' : presentationMarkdown(buildResumePresentation(presentationInput));
      if (markdown.length > 300000) throw new Error('单份简历内容过长，无法排版发送；请核对原始文件');
      const attachment = preserveOriginal ? original : {
        filename: `candidate-${index + 1}.docx`,
        content: await markdownToDocx(markdown),
        contentType: FILE_TYPES['.docx'],
        fingerprintHash: crypto.createHash('sha256').update(markdown).digest('hex')
      };
      size += Buffer.byteLength(attachment.content);
      if (size > MAX_TOTAL_ATTACHMENT_BYTES) throw new Error('邮件附件总大小不能超过 20MB，请减少发送份数');
      attachments.push({ ...attachment, attachmentKind });
    }
    return attachments;
  }

  transport() {
    const { configured, missing } = this.configuration();
    if (!configured) throw new Error(`请先在 backend/.env 配置 ${missing.join('、')}`);
    const port = Number(process.env.SMTP_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SMTP_PORT 无效');
    const secureSetting = String(process.env.SMTP_SECURE || 'auto').toLowerCase();
    if (!['auto', 'true', 'false'].includes(secureSetting)) throw new Error('SMTP_SECURE 无效');
    const options = {
      host: process.env.SMTP_HOST,
      port,
      secure: secureSetting === 'auto' ? port === 465 : secureSetting === 'true',
      requireTLS: String(process.env.SMTP_REQUIRE_TLS || 'false').toLowerCase() === 'true'
    };
    if (process.env.SMTP_USER) {
      options.auth = { user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS_B64
          ? Buffer.from(process.env.SMTP_PASS_B64, 'base64').toString('utf8')
          : process.env.SMTP_PASS };
    }
    return this.transportFactory(options);
  }

  async verify() {
    await this.transport().verify();
    return { connected: true };
  }

  deliveryKeys(to, selection, candidates = []) {
    const recipientJobKey = crypto.createHash('sha256').update(JSON.stringify({
      to: to.trim().toLowerCase(), jobRequirements: selection.jobRequirements
    })).digest('hex');
    const groupKey = crypto.createHash('sha256').update(JSON.stringify({
      recipientJobKey, from: process.env.SMTP_FROM,
      source: selection.source, status: selection.status,
      minScore: selection.minScore, topN: selection.topN,
      reportFormat: selection.reportFormat,
      ...(selection.newOnly ? { newOnly: true, round: selection.roundFingerprint } : {})
    })).digest('hex');
    const candidateHashes = candidates.map(item => crypto.createHash('sha256')
      .update(`${recipientJobKey}:${item.source}:${item.id}`).digest('hex'));
    return { recipientJobKey, groupKey, candidateHashes };
  }

  async deliveryReceipts() {
    if (!this.deliveryReceiptDirectory) return [];
    let files;
    try { files = await fs.readdir(this.deliveryReceiptDirectory); }
    catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const receipts = [];
    for (const file of files.filter(name => /^[a-f0-9]{64}\.json$/i.test(name))) {
      try {
        const receipt = JSON.parse(await fs.readFile(path.join(this.deliveryReceiptDirectory, file), 'utf8'));
        if (receipt.format !== 2 || !/^[a-f0-9]{64}$/i.test(receipt.groupKey || '') ||
            !/^[a-f0-9]{64}$/i.test(receipt.recipientJobKey || '') ||
            !Array.isArray(receipt.candidateHashes)) {
          throw new Error('邮件发送记录使用旧格式或已损坏，请先人工核对');
        }
        receipts.push(receipt);
      } catch (error) {
        throw new Error(`本机邮件发送记录无法安全读取：${error.message}`);
      }
    }
    return receipts;
  }

  async selectUndelivered(input) {
    const to = input?.to;
    if (!validateEmail(to)) throw new Error('请输入一个有效的收件邮箱');
    const selection = normalizeSelection(input);
    if (!selection.newOnly) throw new Error('请选择仅发送未发过的新候选人');
    const recipientJobKey = this.deliveryKeys(to, selection).recipientJobKey;
    const receipts = (await this.deliveryReceipts())
      .filter(receipt => receipt.recipientJobKey === recipientJobKey);
    if (receipts.some(receipt => receipt.state !== 'sent')) {
      throw new Error('此收件邮箱和岗位有发送结果待核对，请先核对收件箱，勿发送新批次');
    }
    const excludedHashes = new Set(receipts.flatMap(receipt => receipt.candidateHashes));
    const selected = this.select(input, { excludedHashes, recipientJobKey });
    // Bind the preview to this recipient and exact unsent pool. Each successful
    // new-only message becomes a separate, immutable round in durable receipts.
    selected.selection.recipientJobKey = recipientJobKey;
    selected.selection.roundFingerprint = selected.poolFingerprint;
    return selected;
  }

  sentPrefix(receipts, groupKey, poolFingerprint, total) {
    const group = receipts.filter(receipt => receipt.groupKey === groupKey)
      .sort((a, b) => a.offset - b.offset);
    let nextOffset = 0;
    for (const receipt of group) {
      if (receipt.poolFingerprint !== poolFingerprint || receipt.total !== total) {
        throw new Error('候选人集合已变化，请核对已发送批次后再继续');
      }
      if (receipt.state !== 'sent') {
        throw new Error('本批已有发送记录且结果待核对，请核对收件箱后再继续');
      }
      if (!Number.isSafeInteger(receipt.offset) || receipt.offset !== nextOffset ||
          !Number.isSafeInteger(receipt.nextOffset) || receipt.nextOffset <= receipt.offset ||
          receipt.nextOffset > total) {
        throw new Error('邮件发送记录不连续，请人工核对后再继续');
      }
      nextOffset = receipt.nextOffset;
    }
    return nextOffset;
  }

  async resume(input) {
    const to = input?.to;
    if (!validateEmail(to)) throw new Error('请输入一个有效的收件邮箱');
    if (input?.newOnly) {
      const { total, poolFingerprint } = await this.selectUndelivered(input);
      return { nextOffset: 0, sentCount: 0, total, poolFingerprint,
        hasMore: total > 0, newOnly: true };
    }
    const { selection, candidates, total, poolFingerprint } =
      this.select({ ...input, offset: 0, poolFingerprint: '' });
    const { recipientJobKey, groupKey, candidateHashes } = this.deliveryKeys(to, selection, candidates);
    const receipts = await this.deliveryReceipts();
    const nextOffset = this.sentPrefix(receipts, groupKey, poolFingerprint, total);
    if (!nextOffset) {
      const previouslyReserved = new Set(receipts.filter(receipt =>
        receipt.recipientJobKey === recipientJobKey).flatMap(receipt => receipt.candidateHashes));
      if (candidateHashes.some(hash => previouslyReserved.has(hash))) {
        throw new Error('首批包含其他发送轮次已发送或待核对的候选人，请核对收件箱，勿重复发送');
      }
    }
    return { nextOffset, sentCount: nextOffset, total, poolFingerprint,
      hasMore: nextOffset < total };
  }

  async reserveDelivery(to, selection, candidates, { poolFingerprint, total, nextOffset }) {
    if (!this.deliveryReceiptDirectory) return null;
    const key = crypto.createHash('sha256').update(JSON.stringify({
      to: to.trim().toLowerCase(), from: process.env.SMTP_FROM,
      jobRequirements: selection.jobRequirements,
      candidates: candidates.map(item => `${item.source}:${item.id}`).sort()
    })).digest('hex');
    await fs.mkdir(this.deliveryReceiptDirectory, { recursive: true });
    const filename = path.join(this.deliveryReceiptDirectory, `${key}.json`);
    const lockName = path.join(this.deliveryReceiptDirectory, '.reserve.lock');
    let lock;
    try {
      lock = await fs.open(lockName, 'wx', 0o600);
    } catch (error) {
      if (error.code === 'EEXIST') throw new Error('另一批邮件正在预留或上次预留未完成，请核对发送记录后重试');
      throw error;
    }
    try {
      const { recipientJobKey, groupKey, candidateHashes } = this.deliveryKeys(to, selection, candidates);
      const receipts = await this.deliveryReceipts();
      const expectedOffset = selection.newOnly ? 0
        : this.sentPrefix(receipts, groupKey, poolFingerprint, total);
      if (selection.offset !== expectedOffset) {
        throw new Error('本批简历已有发送记录或批次与已发送进度不一致，请恢复进度后继续，勿跳批或重复发送');
      }
      if (selection.newOnly && receipts.some(receipt =>
        receipt.recipientJobKey === recipientJobKey && receipt.state !== 'sent')) {
        throw new Error('此收件邮箱和岗位有发送结果待核对，请先核对收件箱，勿发送新批次');
      }
      const alreadyReserved = new Set(receipts.filter(receipt => receipt.recipientJobKey === recipientJobKey)
        .flatMap(receipt => receipt.candidateHashes));
      if (candidateHashes.some(hash => alreadyReserved.has(hash))) {
        throw new Error('本批包含已发送或待核对的候选人，请核对收件箱，勿重复发送');
      }
      let handle;
      try {
        handle = await fs.open(filename, 'wx', 0o600);
        await handle.writeFile(JSON.stringify({ format: 2, key, state: 'attempting',
          recipientJobKey, groupKey, candidateHashes, poolFingerprint,
          offset: selection.offset, nextOffset, total,
          count: candidates.length, createdAt: new Date(this.now()).toISOString() }));
        await handle.sync();
      } catch (error) {
        if (error.code === 'EEXIST') {
          throw new Error('本批简历已有发送记录或结果待核对，请先核对收件箱，勿重复发送');
        }
        throw error;
      } finally {
        if (handle) await handle.close();
      }
      return filename;
    } finally {
      await lock.close();
      await fs.unlink(lockName).catch(() => {});
    }
  }

  async updateDeliveryReceipt(filename, state) {
    if (!filename) return true;
    try {
      const handle = await fs.open(filename, 'r+');
      try {
        const receipt = JSON.parse(await handle.readFile({ encoding: 'utf8' }));
        const content = Buffer.from(JSON.stringify({ ...receipt, state,
          updatedAt: new Date(this.now()).toISOString() }));
        await handle.truncate(0);
        await handle.write(content, 0, content.length, 0);
        await handle.truncate(content.length);
        await handle.sync();
      } finally { await handle.close(); }
      return true;
    } catch (_) {
      // The exclusive reservation file still prevents an accidental resend.
      return false;
    }
  }

  async send({ to, previewToken, ...input }) {
    if (!validateEmail(to)) throw new Error('请输入一个有效的收件邮箱');
    const saved = this.previews.get(previewToken);
    if (!saved || saved.expiresAt <= this.now()) {
      this.previews.delete(previewToken);
      throw new Error('邮件预览无效或已过期，请先重新预览后再发送');
    }
    // 在异步读取附件之前消费令牌，避免并发请求复用同一预览。
    this.previews.delete(previewToken);
    const { selection, candidates, total, poolFingerprint, nextOffset } = input?.newOnly
      ? await this.selectUndelivered({ ...input, to }) : this.select(input);
    const resumeAttachments = await this.candidateAttachments(candidates);
    const screening = this.screeningSummary(selection, candidates);
    if (saved.fingerprint !== this.fingerprint(selection, candidates, resumeAttachments,
      screening, poolFingerprint)) {
      throw new Error('候选人或筛选条件已变化，请先重新预览后再发送');
    }
    const transport = this.transport();
    const platformScope = screening.sources.map(source => SOURCE_NAMES[source]).join('、');
    const evaluatedBySource = screening.sources.map(source =>
      `${SOURCE_NAMES[source]} ${screening.bySource[source].evaluated} 份`).join('；');
    const attachedBySource = screening.sources.map(source =>
      `${SOURCE_NAMES[source]} ${screening.bySource[source].attached} 份`).join('；');
    const qcwyScreened = screening.qcwy;
    const batchCount = Math.ceil(total / selection.topN);
    const batchNumber = Math.floor(selection.offset / selection.topN) + 1;
    const batchLabel = selection.newOnly
      ? `新增候选人（本封 ${candidates.length} 份；发送前共有 ${total} 份未发送）`
      : batchCount > 1
        ? `第 ${batchNumber}/${batchCount} 批（合格候选人第 ${selection.offset + 1}～${nextOffset} 位，共 ${total} 位）`
        : '';
    const report = [
      '# 候选人初筛报告',
      '',
      `生成时间：${new Date().toLocaleString('zh-CN')}`,
      ...(batchLabel ? [`邮件批次：${batchLabel}`] : []),
      `本次数据来源：${platformScope}`,
      `本次岗位已评估：${evaluatedBySource}`,
      `岗位匹配分门槛：${selection.minScore ? `${selection.minScore}/100` : '未设置，按人工初筛名单选择'}`,
      `本邮件附简历：${attachedBySource}（合计 ${candidates.length} 份）`,
      ...(qcwyScreened.evaluated ? [
        `前程无忧该岗位已评估：${qcwyScreened.evaluated} 份`,
        ...(qcwyScreened.local ? [
          `最低证据门槛已满足：${qcwyScreened.localEligible} 份；明确低于最低条件：${qcwyScreened.localBelowMinimum} 份；证据不足待核实：${qcwyScreened.localPending} 份`
        ] : []),
        ...(qcwyScreened.ai ? [
          `前程无忧 AI 辅助评分达到本次分数门槛：${qcwyScreened.aiAtOrAboveScore} 份；低于门槛：${qcwyScreened.ai - qcwyScreened.aiAtOrAboveScore} 份。评分仅供人工复核。`
        ] : []),
        '本邮件只附上进入初筛名单的候选人简历。'
      ] : []),
      '',
      '## 本次岗位要求',
      selection.jobRequirements,
      '',
      '| 序号 | 平台 | 回查入口 | 候选人 | 招聘岗位 | 求职岗位 | 匹配分 | 评估摘要 |',
      '| ---: | --- | --- | --- | --- | --- | ---: | --- |',
      ...candidates.map((item, index) => `| ${index + 1} | ${SOURCE_NAMES[item.source]} | ${reportCell(recipientLookupLine(item, this.candidateLink(item)))} | ${reportCell(candidateName(item))} | ${reportCell(hiringJobTitle(item))} | ${reportCell(candidatePosition(item) || '待核实')} | ${item.matchScore} | ${reportCell(item.matchEvaluation.summary || '')} |`),
      '',
      '各简历附件 candidate-N 对应表中同序号。前程无忧可用官方简历 ID 查询入口；智联和 BOSS 的技术标识不是普通人才关键词搜索码，报告以助手内候选人链接作为回查入口。已获授权的招聘管理员可在公司服务器浏览器尝试核对官方原卡与详情。助手链接不会把招聘平台账号登录到收件人设备，也不要向同事共享管理员账号；同事要自行进入官方平台，应使用本人获分配的企业成员账号和平台允许的候选人协作方式。',
      '',
      '## 岗位匹配评估明细',
      '',
      ...candidates.flatMap((item, index) => [
        `### 候选人 ${index + 1}`,
        '',
        `平台：${SOURCE_NAMES[item.source]}`,
        ...(item.source === 'qcwy'
          ? [`前程无忧简历 ID：${platformRecord(item).id}`]
          : []),
        ...(this.candidateLink(item) ? [`助手内候选人链接：${this.candidateLink(item)}`] : []),
        `回查方式：${recipientLookupLine(item, this.candidateLink(item))}`,
        `招聘岗位：${hiringJobTitle(item)}`,
        `求职岗位：${candidatePosition(item) || '待核实'}`,
        `评估方式：${item.matchEvaluation.method === 'local' ? '本机关键词证据评分' : 'AI 辅助岗位匹配'}`,
        `简历附件：${ATTACHMENT_LABELS[resumeAttachments[index].attachmentKind]}`,
        '',
        '相关优势：',
        ...assessmentPoints(item.matchEvaluation.strengths),
        '',
        '待核实点：',
        ...assessmentPoints(item.matchEvaluation.gaps),
        ''
      ]),
      ...(candidates.some(item => item.source === 'qcwy' && item.matchEvaluation.method === 'local')
        ? ['> 前程无忧候选人仅达到本地初筛的最低证据门槛，须人工复核全部岗位条件。', '']
        : []),
      ...(candidates.some(item => item.source === 'qcwy' && item.matchEvaluation.method === 'llm')
        ? ['> 前程无忧 AI 辅助评分仅供参考，须人工复核全部岗位条件。', '']
        : []),
      '> 岗位匹配仅供人工复核。简历内容见附件。',
      ''
    ].join('\n');
    const reportAttachment = selection.reportFormat === 'docx'
      ? { filename: 'candidate-report.docx', content: await markdownToDocx(report),
        contentType: FILE_TYPES['.docx'] }
      : { filename: 'candidate-report.md', content: report,
        contentType: 'text/markdown; charset=utf-8' };
    const attachments = [
      reportAttachment,
      ...resumeAttachments.map(({ attachmentKind: _, fingerprintHash: __, ...attachment }) => attachment)
    ];
    if (attachments.reduce((total, file) => total + Buffer.byteLength(file.content), 0) > MAX_TOTAL_ATTACHMENT_BYTES) {
      throw new Error('邮件附件总大小不能超过 20MB，请减少发送份数');
    }
    const receipt = await this.reserveDelivery(to, selection, candidates,
      { poolFingerprint, total, nextOffset });
    let sent;
    try { sent = await transport.sendMail({
      from: process.env.SMTP_FROM,
      to,
      subject: `${jobTitleFromRequirements(selection.jobRequirements) || ''}候选人初筛报告（${selection.newOnly ? '新增候选人，' : batchLabel ? `第${batchNumber}/${batchCount}批，` : ''}${candidates.length}份）`,
      text: `随信附上 ${candidates.length} 份进入本次岗位初筛名单的候选人简历材料和初筛报告。${batchLabel ? `${batchLabel}。` : ''}报告覆盖${platformScope}，其中本邮件附简历：${attachedBySource}。candidate-N 附件与报告序号对应。前程无忧请在官方简历 ID 入口查询；智联与 BOSS 请从助手链接返回对应记录，再由已获授权的招聘管理员在公司服务器浏览器尝试核对原候选人。助手链接不会在收件人设备登录招聘平台，也不应向同事共享管理员账号；同事要自行进入官方平台，须使用本人获分配的企业成员账号和平台允许的候选人协作方式。智联与 BOSS 的技术标识不能作为普通人才搜索关键词。请结合待核实事项人工复核。\n\n候选人回查索引：\n${candidates.map((item,index)=>`candidate-${index+1} · ${SOURCE_NAMES[item.source]} · ${reportCell(candidateName(item))} · ${reportCell(hiringJobTitle(item))} · ${recipientLookupLine(item,this.candidateLink(item))}`).join('\n')}\n` +
        (candidates.some(item => item.source === 'qcwy' && item.matchEvaluation.method === 'local')
          ? '前程无忧候选人仅达到本地初筛的最低证据门槛，仍须人工复核全部岗位条件。' : '') +
        (resumeAttachments.some(item => item.attachmentKind === 'page-text')
          ? '其中页面采集的 Word 简历由页面提取文本排版，非平台原版简历文件。' : ''),
      attachments
    }); } catch (error) {
      await this.updateDeliveryReceipt(receipt, 'uncertain');
      if (receipt) error.message += '；发送结果可能不确定，请核对收件箱后再处理，勿直接重试';
      throw error;
    }
    const receiptRecorded = await this.updateDeliveryReceipt(receipt, 'sent');
    return { count: candidates.length, total, nextOffset, hasMore: nextOffset < total,
      poolFingerprint, messageId: sent.messageId || null, receiptRecorded };
  }
}

module.exports = { CandidateEmailService, normalizeSelection, validateEmail, jobTitleFromRequirements };
