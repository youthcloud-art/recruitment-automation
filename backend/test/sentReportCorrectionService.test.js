const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { SentReportCorrectionService, renderCorrectedReport } =
  require('../src/services/sentReportCorrectionService');

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const to = 'reviewer@example.test';
const requirements = '岗位名称：IT网络运维\n必需技能：网络设备维护';

function fixture(directory) {
  const candidates = [
    { id: 'one', source: 'qcwy', name: '通知', position: '通知',
      sourceRecordKey: 'a'.repeat(64), originalText: '网络设备维护经验。'.repeat(10),
      matchScore: 87, matchEvaluation: { summary: '有相关经验',
        strengths: ['设备维护'], gaps: ['夜间值班待核实'] } },
    { id: 'two', source: 'zlzp', name: '测试候选人', position: '网络运维',
      originalText: '网络设备维护经验。'.repeat(10), matchScore: 81,
      matchEvaluation: { summary: '有运维经验', strengths: [], gaps: [] } },
    { id: 'three', source: 'qcwy', name: '通知', position: '通知',
      sourceRecordKey: 'b'.repeat(64), originalText: '故障排查经验。'.repeat(10),
      matchScore: 76, matchEvaluation: { summary: '需核实深度', strengths: [], gaps: [] } }
  ];
  const job = { title: 'IT网络运维', jobRequirements: requirements,
    updatedAt: '2026-10-20T00:00:00.000Z' };
  const poolFingerprint = sha256('unchanged-candidate-pool');
  let sent = 0;
  let lastMessage;
  let failSend = false;
  const emailService = {
    deliveryKeys(recipient, selection, page = []) {
      const recipientJobKey = sha256(`${recipient}:${selection.jobRequirements}`);
      const groupKey = sha256(JSON.stringify({ recipientJobKey, source: selection.source,
        status: selection.status, minScore: selection.minScore, topN: selection.topN,
        reportFormat: selection.reportFormat }));
      return { recipientJobKey, groupKey,
        candidateHashes: page.map(item => sha256(`${recipientJobKey}:${item.source}:${item.id}`)) };
    },
    select(selection) {
      if (selection.poolFingerprint && selection.poolFingerprint !== poolFingerprint) {
        throw new Error('候选人集合已变化');
      }
      const offset = selection.offset || 0;
      const page = candidates.slice(offset, offset + selection.topN);
      return { selection: { ...selection, offset }, candidates: page,
        total: candidates.length, poolFingerprint, nextOffset: offset + page.length };
    },
    async deliveryReceipts() { return receipts; },
    transport() { return {
      verify: async () => true,
      sendMail: async message => {
        sent++;
        lastMessage = message;
        if (failSend) throw new Error('synthetic SMTP uncertainty');
        return { messageId: 'test-message-id' };
      }
    }; }
  };
  const selection = { source: '', status: '', minScore: 70, topN: 2,
    jobRequirements: requirements, reportFormat: 'docx' };
  const keys = emailService.deliveryKeys(to, selection);
  const receipts = [0, 2].map((offset, index) => {
    const page = candidates.slice(offset, offset + 2);
    return { format: 2, key: sha256(`receipt-${index}`), state: 'sent',
      recipientJobKey: keys.recipientJobKey, groupKey: keys.groupKey,
      candidateHashes: emailService.deliveryKeys(to, selection, page).candidateHashes,
      poolFingerprint, offset, nextOffset: offset + page.length,
      total: candidates.length, count: page.length,
      createdAt: '2026-10-20T00:00:00.000Z',
      updatedAt: '2026-10-20T00:01:00.000Z' };
  });
  const service = new SentReportCorrectionService({
    pipeline: { activeJob: () => job }, emailService,
    packageRoot: path.join(directory, 'packages'),
    correctionReceiptDirectory: path.join(directory, 'correction-receipts'),
    now: () => Date.UTC(2026, 9, 20, 1, 0, 0)
  });
  return { candidates, receipts, emailService, service,
    options: { to, minScore: 70, topN: 2, expectedTotal: 3, expectedBatches: 2 },
    sentCount: () => sent, lastMessage: () => lastMessage,
    failNextSend: () => { failSend = true; } };
}

test('更正报告把前程无忧页面标签替换为稳定匿名标识，并明确原附件序号', () => {
  const { candidates } = fixture(os.tmpdir());
  const markdown = renderCorrectedReport({ title: 'IT网络运维', jobRequirements: requirements },
    { offset: 0, nextOffset: 2, total: 3, updatedAt: '2026-10-20T00:01:00.000Z' },
    candidates.slice(0, 2), 0, 2);
  assert.match(markdown, /匿名候选人（前程无忧记录 ID：aaaaaaaaaaaaaaaa）/);
  assert.match(markdown, /求职岗位待核实/);
  assert.match(markdown, /原附件序号/);
  assert.match(markdown, /第 1 行对应 candidate-1/);
  assert.doesNotMatch(markdown, /\| 通知 \|/);
});

test('dry-run 仅生成七批对应的 Word 包；发送需摘要且独立回执防重复', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'recruit-report-correction-'));
  const previousFrom = process.env.SMTP_FROM;
  process.env.SMTP_FROM = 'sender@example.test';
  try {
    const f = fixture(directory);
    const original = JSON.stringify(f.receipts);
    const summary = await f.service.prepare(f.options);
    assert.equal(summary.total, 3);
    assert.equal(summary.batchCount, 2);
    assert.equal(summary.anonymousQcwy, 2);
    assert.equal(summary.files.length, 2);
    assert.equal(f.sentCount(), 0);
    assert.ok(summary.files.every(file => file.filename.endsWith('.docx') && file.bytes > 1000));
    assert.equal((await f.service.status(f.options)).state, 'absent');
    await assert.rejects(f.service.send({ ...f.options, approval: '0'.repeat(64) }), /批准摘要/);
    assert.equal(f.sentCount(), 0);
    const sent = await f.service.send({ ...f.options, approval: summary.planHash });
    assert.equal(sent.state, 'sent');
    assert.equal(f.sentCount(), 1);
    assert.equal(f.lastMessage().attachments.length, 2);
    assert.ok(f.lastMessage().attachments.every(item => item.filename.endsWith('.docx')));
    assert.equal((await f.service.status(f.options)).state, 'sent');
    await assert.rejects(f.service.send({ ...f.options, approval: summary.planHash }), /已有发送或待核对回执/);
    assert.equal(f.sentCount(), 1);
    assert.equal(JSON.stringify(f.receipts), original);
  } finally {
    if (previousFrom === undefined) delete process.env.SMTP_FROM;
    else process.env.SMTP_FROM = previousFrom;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('原批次哈希或顺序改变时拒绝生成更正报告', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'recruit-report-correction-'));
  try {
    const f = fixture(directory);
    f.receipts[1].candidateHashes[0] = sha256('wrong-candidate');
    await assert.rejects(f.service.buildPlan(f.options), /候选人顺序或身份/);
    f.receipts[1].candidateHashes[0] = f.emailService.deliveryKeys(to,
      { jobRequirements: requirements }, [f.candidates[2]]).candidateHashes[0];
    f.receipts[1].offset = 1;
    await assert.rejects(f.service.buildPlan(f.options), /回执不连续/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('Word 包被改动或 SMTP 结果不确定时不允许盲目重发', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'recruit-report-correction-'));
  const previousFrom = process.env.SMTP_FROM;
  process.env.SMTP_FROM = 'sender@example.test';
  try {
    const f = fixture(directory);
    const summary = await f.service.prepare(f.options);
    const word = path.join(summary.packageDirectory, summary.files[0].filename);
    const original = await fs.readFile(word);
    await fs.appendFile(word, 'tampered');
    await assert.rejects(f.service.send({ ...f.options, approval: summary.planHash }), /文件与已审阅清单不一致/);
    assert.equal(f.sentCount(), 0);
    assert.equal((await f.service.status(f.options)).state, 'absent');
    await fs.writeFile(word, original);
    f.failNextSend();
    await assert.rejects(f.service.send({ ...f.options, approval: summary.planHash }), /结果不确定/);
    assert.equal((await f.service.status(f.options)).state, 'uncertain');
    await assert.rejects(f.service.send({ ...f.options, approval: summary.planHash }), /已有发送或待核对回执/);
    assert.equal(f.sentCount(), 1);
  } finally {
    if (previousFrom === undefined) delete process.env.SMTP_FROM;
    else process.env.SMTP_FROM = previousFrom;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
