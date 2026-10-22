const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { RecruitmentPipelineService } = require('./recruitmentPipelineService');
const { CandidateEmailService, validateEmail } = require('./candidateEmailService');
const { markdownToDocx } = require('./candidateReportDocx');
const { candidateName, candidatePosition, isQcwyPageLabel } = require('../utils/candidateDisplay');

const SOURCE_NAMES = { boss: 'BOSS直聘', zlzp: '智联招聘', qcwy: '前程无忧' };
const WORD_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MAX_CORRECTION_BYTES = 20 * 1024 * 1024;
const DEFAULT_ORIGINAL_RECEIPTS = path.join(__dirname, '../../storage/mail_delivery_receipts');
const DEFAULT_CORRECTION_RECEIPTS = path.join(__dirname, '../../storage/mail_correction_receipts');
const DEFAULT_PACKAGE_ROOT = path.join(__dirname, '../../../.local/report-corrections');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function cell(value) {
  return String(value ?? '').replace(/[\r\n|]/g, ' ').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 500);
}

function safeFilename(index, total) {
  return `report-correction-batch-${String(index + 1).padStart(2, '0')}-of-${String(total).padStart(2, '0')}.docx`;
}

async function reviewedWordBytes(filename) {
  let content = await fs.readFile(filename);
  // Some Windows Office file providers present a 887d1c wrapper to Node and
  // the actual OOXML bytes to the system file API. Never attach that wrapper.
  if (content[0] === 0x88 && content[1] === 0x7d && content[2] === 0x1c) {
    try {
      const python = process.env.REPORT_CORRECTION_PYTHON || 'python';
      content = execFileSync(python,
        ['-c', 'import sys;sys.stdout.buffer.write(open(sys.argv[1],"rb").read())', filename],
        { timeout: 30000, maxBuffer: MAX_CORRECTION_BYTES + 1024 });
    } catch (_) {
      throw new Error('本机 Office 文件读取异常，无法安全读取已审阅的 Word 文件');
    }
  }
  return content;
}

function renderCorrectedReport(job, receipt, candidates, batchIndex, batchCount) {
  const lines = [
    '# 候选人初筛报告更正',
    '',
    `岗位：${cell(job.title)}`,
    `原邮件批次：第 ${batchIndex + 1}/${batchCount} 批`,
    `原邮件候选人顺序：第 ${receipt.offset + 1}～${receipt.nextOffset} 位（共 ${receipt.total} 位）`,
    `本批简历附件：${candidates.length} 份；原附件按本报告中的批内序号一一对应`,
    `原发送记录时间：${cell(receipt.updatedAt || receipt.createdAt)}`,
    '',
    '本报告仅更正原批次 Word 初筛报告中的候选人及求职岗位显示。岗位要求、评分和评估理由沿用原报告，需结合原简历人工复核。',
    '前程无忧旧记录中的“通知”是页面标签，不能当作姓名或岗位。无法可靠识别姓名的记录使用稳定匿名 ID；无法可靠识别求职岗位时标为待核实。',
    '',
    '| 原附件序号 | 平台 | 候选人识别 | 求职岗位 | 匹配分 |',
    '| ---: | --- | --- | --- | ---: |'
  ];
  candidates.forEach((item, index) => {
    lines.push(`| ${index + 1} | ${SOURCE_NAMES[item.source]} | ${cell(candidateName(item))} | ${cell(candidatePosition(item))} | ${item.matchScore} |`);
  });
  lines.push('',
    '表中序号对应同一原邮件中的 candidate-N 简历附件。例如第 1 行对应 candidate-1。原附件未在本次邮件重发或改写。',
    '若原 TXT 附件首部也显示“通知”，请忽略该首部字段，以完整简历正文核实身份和岗位。请保留原邮件与附件。', '');
  return lines.join('\n');
}

class SentReportCorrectionService {
  constructor({ pipeline = new RecruitmentPipelineService(), emailService = null,
    originalReceiptDirectory = DEFAULT_ORIGINAL_RECEIPTS,
    correctionReceiptDirectory = DEFAULT_CORRECTION_RECEIPTS,
    packageRoot = DEFAULT_PACKAGE_ROOT,
    now = Date.now } = {}) {
    this.pipeline = pipeline;
    this.emailService = emailService || new CandidateEmailService({ pipeline,
      deliveryReceiptDirectory: originalReceiptDirectory });
    this.correctionReceiptDirectory = path.resolve(correctionReceiptDirectory);
    this.packageRoot = path.resolve(packageRoot);
    this.now = now;
  }

  async buildPlan({ to, minScore = 70, topN = 20, expectedTotal = 124,
    expectedBatches = 7 } = {}) {
    if (!validateEmail(to)) throw new Error('请提供一个有效的原收件邮箱');
    if (!Number.isInteger(expectedTotal) || expectedTotal < 1 || expectedTotal > 10000 ||
        !Number.isInteger(expectedBatches) || expectedBatches < 1 || expectedBatches > 100) {
      throw new Error('预期批次数或候选人数无效');
    }
    const job = this.pipeline.activeJob();
    if (!job?.updatedAt || !job.title || String(job.jobRequirements || '').trim().length < 5) {
      throw new Error('当前岗位未保存，不能核对原邮件分组');
    }
    const selection = { source: '', status: '', minScore, topN,
      jobRequirements: job.jobRequirements, reportFormat: 'docx' };
    const { recipientJobKey, groupKey } = this.emailService.deliveryKeys(to, selection);
    const receipts = (await this.emailService.deliveryReceipts())
      .filter(receipt => receipt.groupKey === groupKey)
      .sort((a, b) => a.offset - b.offset);
    if (receipts.length !== expectedBatches) {
      throw new Error('原始已发送批次数与预期不符，停止更正');
    }
    const pool = this.emailService.select(selection);
    if (pool.total !== expectedTotal) throw new Error('当前候选池总数与原邮件不符，停止更正');
    let nextOffset = 0;
    const seenHashes = new Set();
    const reports = [];
    const batches = [];
    for (const [index, receipt] of receipts.entries()) {
      if (receipt.format !== 2 || receipt.state !== 'sent' ||
          receipt.recipientJobKey !== recipientJobKey || receipt.groupKey !== groupKey ||
          receipt.poolFingerprint !== pool.poolFingerprint || receipt.total !== expectedTotal ||
          !Number.isSafeInteger(receipt.offset) || receipt.offset !== nextOffset ||
          !Number.isSafeInteger(receipt.nextOffset) || receipt.nextOffset <= receipt.offset ||
          receipt.nextOffset > expectedTotal || receipt.count !== receipt.nextOffset - receipt.offset ||
          !Array.isArray(receipt.candidateHashes) || receipt.candidateHashes.length !== receipt.count ||
          !/^[a-f0-9]{64}$/i.test(receipt.key || '')) {
        throw new Error('原始已发送回执不连续或内容不匹配，停止更正');
      }
      const page = this.emailService.select({ ...selection, offset: receipt.offset,
        poolFingerprint: pool.poolFingerprint });
      const hashes = this.emailService.deliveryKeys(to, page.selection, page.candidates).candidateHashes;
      if (page.nextOffset !== receipt.nextOffset || page.candidates.length !== receipt.count ||
          hashes.some((hash, position) => hash !== receipt.candidateHashes[position] || seenHashes.has(hash))) {
        throw new Error('候选人顺序或身份与原邮件回执不符，停止更正');
      }
      hashes.forEach(hash => seenHashes.add(hash));
      const markdown = renderCorrectedReport(job, receipt, page.candidates, index, receipts.length);
      reports.push({ filename: safeFilename(index, receipts.length), markdown });
      batches.push({ batch: index + 1, offset: receipt.offset, count: receipt.count,
        anonymousQcwy: page.candidates.filter(item => item.source === 'qcwy' &&
          isQcwyPageLabel(item.name)).length,
        reportHash: sha256(markdown) });
      nextOffset = receipt.nextOffset;
    }
    if (nextOffset !== expectedTotal || seenHashes.size !== expectedTotal) {
      throw new Error('原始发送批次未完整覆盖候选人，停止更正');
    }
    const planHash = sha256(JSON.stringify({ format: 1, layoutRevision: 2, recipientJobKey, groupKey,
      poolFingerprint: pool.poolFingerprint, total: expectedTotal,
      originals: receipts.map(receipt => sha256(JSON.stringify(receipt))),
      reports: batches.map(batch => batch.reportHash) }));
    return { planHash, recipientJobKey, groupKey, jobTitle: job.title,
      total: expectedTotal, batchCount: receipts.length, batches, reports };
  }

  packageDirectory(plan) {
    return path.join(this.packageRoot, plan.planHash);
  }

  async loadPackage(plan) {
    const directory = this.packageDirectory(plan);
    let manifest;
    try { manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8')); }
    catch (_) { throw new Error('更正报告包不存在或未完成，请先运行 dry-run 并审阅七份 Word'); }
    if (manifest.format !== 1 || manifest.planHash !== plan.planHash ||
        manifest.groupKey !== plan.groupKey || manifest.total !== plan.total ||
        !Array.isArray(manifest.files) || manifest.files.length !== plan.batchCount) {
      throw new Error('更正报告清单与当前已发送回执不一致，停止发送');
    }
    const attachments = [];
    let totalBytes = 0;
    for (const [index, file] of manifest.files.entries()) {
      if (file.filename !== safeFilename(index, plan.batchCount) ||
          !/^[a-f0-9]{64}$/i.test(file.sha256 || '')) {
        throw new Error('更正 Word 文件名或摘要无效，停止发送');
      }
      const content = await reviewedWordBytes(path.join(directory, file.filename));
      if (content.subarray(0, 2).toString() !== 'PK' || content.length !== file.bytes ||
          sha256(content) !== file.sha256) {
        throw new Error('更正 Word 文件与已审阅清单不一致，停止发送');
      }
      totalBytes += content.length;
      attachments.push({ filename: file.filename, content, contentType: WORD_CONTENT_TYPE });
    }
    if (totalBytes > MAX_CORRECTION_BYTES) throw new Error('更正报告附件总大小超过 20MB');
    return { directory, manifest, attachments };
  }

  async prepare(input) {
    const plan = await this.buildPlan(input);
    const directory = this.packageDirectory(plan);
    try {
      const existing = await this.loadPackage(plan);
      return this.safeSummary(plan, existing.directory, existing.manifest);
    } catch (error) {
      if (!/报告包不存在或未完成/.test(error.message)) throw error;
    }
    await fs.mkdir(this.packageRoot, { recursive: true, mode: 0o700 });
    try { await fs.mkdir(directory, { mode: 0o700 }); }
    catch (error) {
      if (error.code === 'EEXIST') throw new Error('更正报告包目录已存在但未完成，请人工核对后处理');
      throw error;
    }
    const files = [];
    let totalBytes = 0;
    for (const report of plan.reports) {
      const content = await markdownToDocx(report.markdown);
      totalBytes += content.length;
      if (totalBytes > MAX_CORRECTION_BYTES) throw new Error('更正报告附件总大小超过 20MB');
      await fs.writeFile(path.join(directory, report.filename), content,
        { flag: 'wx', mode: 0o600 });
      files.push({ filename: report.filename, bytes: content.length, sha256: sha256(content) });
    }
    const manifest = { format: 1, planHash: plan.planHash, groupKey: plan.groupKey,
      recipientJobKey: plan.recipientJobKey, total: plan.total,
      batchCount: plan.batchCount, batches: plan.batches,
      files, createdAt: new Date(this.now()).toISOString() };
    await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2),
      { flag: 'wx', mode: 0o600 });
    // Verify the exact bytes that will be attached later, including the
    // Windows Office-provider case, before offering the package for review.
    await this.loadPackage(plan);
    return this.safeSummary(plan, directory, manifest);
  }

  safeSummary(plan, directory, manifest) {
    return { planHash: plan.planHash, packageDirectory: directory,
      total: plan.total, batchCount: plan.batchCount,
      anonymousQcwy: plan.batches.reduce((sum, batch) => sum + batch.anonymousQcwy, 0),
      batches: plan.batches.map(batch => ({ batch: batch.batch, offset: batch.offset,
        count: batch.count, anonymousQcwy: batch.anonymousQcwy })),
      files: manifest.files.map(file => ({ filename: file.filename, bytes: file.bytes,
        sha256: file.sha256 })) };
  }

  correctionReceiptPath(plan) {
    const key = sha256(`report-correction-v1:${plan.groupKey}`);
    return path.join(this.correctionReceiptDirectory, `${key}.json`);
  }

  async status(input) {
    const plan = await this.buildPlan(input);
    try {
      const receipt = JSON.parse(await fs.readFile(this.correctionReceiptPath(plan), 'utf8'));
      return { state: receipt.state || 'unknown', planHash: receipt.planHash || null,
        batchCount: receipt.batchCount || null, total: receipt.total || null };
    } catch (error) {
      if (error.code === 'ENOENT') return { state: 'absent', planHash: plan.planHash };
      throw new Error('更正邮件回执无法安全读取，请人工核对');
    }
  }

  async updateCorrectionReceipt(filename, state, messageId = null) {
    try {
      const handle = await fs.open(filename, 'r+');
      try {
        const receipt = JSON.parse(await handle.readFile({ encoding: 'utf8' }));
        const content = Buffer.from(JSON.stringify({ ...receipt, state,
          ...(messageId ? { messageId } : {}),
          updatedAt: new Date(this.now()).toISOString() }));
        await handle.truncate(0);
        await handle.write(content, 0, content.length, 0);
        await handle.truncate(content.length);
        await handle.sync();
      } finally { await handle.close(); }
      return true;
    } catch (_) { return false; }
  }

  async send({ approval, ...input }) {
    const plan = await this.buildPlan(input);
    if (!/^[a-f0-9]{64}$/i.test(approval || '') || approval !== plan.planHash) {
      throw new Error('批准摘要与当前 dry-run 不一致，停止发送');
    }
    const { attachments } = await this.loadPackage(plan);
    if (attachments.length !== plan.batchCount ||
        attachments.some(file => !file.filename.endsWith('.docx'))) {
      throw new Error('更正邮件只能附上已审阅的 Word 报告');
    }
    // Confirm credentials and connection before reserving an irreversible send.
    const transport = this.emailService.transport();
    await transport.verify();
    await fs.mkdir(this.correctionReceiptDirectory, { recursive: true, mode: 0o700 });
    const receiptPath = this.correctionReceiptPath(plan);
    let handle;
    try { handle = await fs.open(receiptPath, 'wx', 0o600); }
    catch (error) {
      if (error.code === 'EEXIST') throw new Error('本组更正邮件已有发送或待核对回执，不能再次发送');
      throw error;
    }
    try {
      await handle.writeFile(JSON.stringify({ format: 1, state: 'attempting',
        planHash: plan.planHash, groupKey: plan.groupKey,
        recipientJobKey: plan.recipientJobKey,
        batchCount: plan.batchCount, total: plan.total,
        createdAt: new Date(this.now()).toISOString() }));
      await handle.sync();
    } finally { await handle.close(); }
    let sent;
    try {
      sent = await transport.sendMail({ from: process.env.SMTP_FROM, to: input.to,
        subject: `${cell(plan.jobTitle)}候选人初筛报告更正（${plan.batchCount}批，仅报告）`,
        text: `此前 ${plan.batchCount} 批候选人初筛报告中，部分前程无忧候选人的姓名和求职岗位误显示为页面标签“通知”。本邮件仅附 ${plan.batchCount} 份更正 Word 报告，逐批对应原邮件，批内序号对应原 candidate-N 简历附件。原简历附件没有重发或改写；若 TXT 首部同样显示“通知”，请以完整简历正文核对。原报告的相关显示栏请以更正报告为准。评分仅供人工复核。`,
        attachments });
    } catch (_) {
      await this.updateCorrectionReceipt(receiptPath, 'uncertain');
      throw new Error('更正邮件发送结果不确定，请核对收件箱及独立更正回执，勿直接重试');
    }
    const recorded = await this.updateCorrectionReceipt(receiptPath, 'sent', sent.messageId || null);
    if (!recorded) throw new Error('更正邮件已提交但回执更新失败，请核对收件箱，勿再次发送');
    return { state: 'sent', batchCount: plan.batchCount, total: plan.total,
      planHash: plan.planHash, receiptRecorded: true };
  }
}

module.exports = { SentReportCorrectionService, renderCorrectedReport, safeFilename };
