const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const mammoth = require('mammoth');
const { CandidateEmailService, jobTitleFromRequirements } = require('../src/services/candidateEmailService');

const jobRequirements = '招聘有项目经验的软件工程师';
const selection = { minScore: 80, topN: 10, jobRequirements, reportFormat: 'md' };
const recipient = 'reviewer@example.test';
const smtpKeys = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_PASS_B64',
  'SMTP_FROM', 'SMTP_SECURE', 'SMTP_REQUIRE_TLS'];
const currentAi = (requirements = jobRequirements, fields = {}) => ({
  jobRequirements: requirements, method: 'llm', evaluationVersion: 1,
  evaluatedAt: '2026-10-20T02:00:00.000Z', ...fields
});

function records() {
  return [
    { id: 'a', source: 'boss', matchScore: 88,
      matchEvaluation: currentAi(jobRequirements, { summary: '相关经验充分',
        strengths: ['具备相关项目证据'], gaps: ['需要核实项目职责'] }), originalText: 'BOSS 完整简历' },
    { id: 'b', source: 'zlzp', matchScore: 65,
      matchEvaluation: currentAi(jobRequirements, { summary: '部分匹配' }), originalText: '智联完整简历' },
    { id: 'c', source: 'qcwy', matchScore: 92,
      matchEvaluation: { jobRequirements, summary: '相关项目经历', method: 'local', evaluationVersion: 2,
        recommendationEligible: true }, originalText: '前程无忧完整简历' },
    { id: 'd', source: 'boss', matchScore: 100, originalText: '未经 AI 评估' },
    { id: 'e', source: 'zlzp', matchScore: 99,
      matchEvaluation: currentAi('招聘有销售经验的客户经理'), originalText: '另一岗位的完整简历' }
  ];
}

function configureSmtp(t) {
  const original = Object.fromEntries(smtpKeys.map(key => [key, process.env[key]]));
  for (const key of smtpKeys) delete process.env[key];
  Object.assign(process.env, {
    SMTP_HOST: 'smtp.example.test', SMTP_PORT: '587', SMTP_USER: 'sender@example.test',
    SMTP_PASS: 'local-test-token', SMTP_FROM: 'sender@example.test'
  });
  t.after(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test('邮件预览仅包含本次岗位已评估且达到分数的简历', async () => {
  const service = new CandidateEmailService({ pipeline: { list: records } });
  const preview = await service.preview(selection);
  assert.deepEqual(preview.candidates.map(item => item.id), ['c', 'a']);
  assert.ok(preview.previewToken);
  assert.equal(preview.selection.jobRequirements, jobRequirements);
  await assert.rejects(service.preview({ minScore: 80 }), /岗位要求/);
  const empty = await service.preview({ ...selection, minScore: 100 });
  assert.equal(empty.count, 0);
  assert.equal(empty.previewToken, null);
});

test('BOSS 邮件预览和 Word 附件排除显式不推荐的高分候选人', async t => {
  configureSmtp(t);
  const items = [
    { id: 'eligible-boss', source: 'boss', matchScore: 82,
      matchEvaluation: currentAi(jobRequirements), originalText: '符合岗位的合成简历' },
    { id: 'vetoed-boss', source: 'boss', matchScore: 99,
      matchEvaluation: currentAi(jobRequirements, { recommendationEligible: false }),
      originalText: '不应发送的合成简历' }
  ];
  let sent;
  const service = new CandidateEmailService({ pipeline: { list: () => items },
    transportFactory: () => ({ sendMail: async mail => {
      sent = mail;
      return { messageId: 'synthetic-mail' };
    } }) });
  const input = { source: 'boss', minScore: 70, topN: 10, jobRequirements,
    reportFormat: 'docx' };
  const preview = await service.preview(input);
  assert.deepEqual(preview.candidates.map(item => item.id), ['eligible-boss']);
  assert.deepEqual(preview.screening.bySource.boss, { evaluated: 1, attached: 1 });

  const result = await service.send({ ...input, to: recipient,
    previewToken: preview.previewToken });
  assert.equal(result.count, 1);
  assert.deepEqual(sent.attachments.map(item => item.filename),
    ['candidate-report.docx', 'candidate-1.txt']);
  const word = await mammoth.extractRawText({ buffer: sent.attachments[0].content });
  assert.doesNotMatch(word.value, /不应发送/);
  assert.doesNotMatch(sent.attachments[1].content, /不应发送/);
});

test('三平台邮件报告与页面 TXT 均带完整官方编号，缺号旧 BOSS 明确待核实', async t => {
  configureSmtp(t);
  const requirements = '岗位名称：磁轴销售工程师\n工作地点：惠州';
  const bossId = 'BOSS_2026_12345';
  const zhilianId = 'ZL_2026(abc)123';
  const wuyouId = 'WY202612345';
  const items = [
    { id: 'resume_boss_verified', source: 'boss', sourceCandidateId: bossId,
      sourceCandidateIdSource: 'platform_card', matchScore: 95,
      captureJobTitle: '磁轴销售工程师', position: '销售工程师',
      matchEvaluation: currentAi(requirements), originalText: 'BOSS 页面简历正文' },
    { id: 'resume_zhilian_verified', source: 'zlzp', sourceCandidateId: zhilianId,
      sourceUrl: `https://rd6.zhaopin.com/app/search?resumeNumber=${encodeURIComponent(zhilianId)}`,
      matchScore: 90, captureJobTitle: '磁轴销售工程师', position: '客户经理',
      matchEvaluation: currentAi(requirements), originalText: '智联页面简历正文' },
    { id: 'resume_wuyou_verified', source: 'qcwy', sourceCandidateId: wuyouId,
      sourceUrl: `https://ehire.51job.com/candidate/detail/${wuyouId}`,
      matchScore: 85, captureJobTitle: '磁轴销售工程师', position: '销售代表',
      matchEvaluation: currentAi(requirements), originalText: '前程无忧页面简历正文' },
    { id: 'resume_boss_legacy_local_id', source: 'boss', sourceCandidateId: 'LOCAL_99999',
      matchScore: 80, captureJobTitle: '磁轴销售工程师', position: '销售专员',
      matchEvaluation: currentAi(requirements), originalText: 'BOSS 历史页面简历正文' }
  ];
  for (const reportFormat of ['md', 'docx']) {
    let sent;
    const service = new CandidateEmailService({ pipeline: { list: () => items },
      transportFactory: () => ({ sendMail: async mail => {
        sent = mail;
        return { messageId: 'synthetic-mail' };
      } }) });
    const input = { minScore: 70, topN: 10, jobRequirements: requirements, reportFormat };
    const preview = await service.preview(input);
    assert.equal(preview.count, 4);
    assert.deepEqual(preview.candidates.map(item => item.platformRecordId),
      [bossId, zhilianId, wuyouId, '待平台核实']);
    await service.send({ ...input, to: recipient, previewToken: preview.previewToken });
    const report = reportFormat === 'docx'
      ? (await mammoth.extractRawText({ buffer: sent.attachments[0].content })).value
      : sent.attachments[0].content;
    for (const id of [bossId, zhilianId, wuyouId]) assert.ok(report.includes(id));
    assert.match(report, /平台记录号/);
    assert.match(report, /待平台核实/);
    assert.doesNotMatch(report, /LOCAL_99999|resume_boss_legacy_local_id/);
    assert.match(report, /招聘岗位/);
    assert.match(report, /求职岗位/);
    assert.match(sent.text, /完整平台记录号见报告/);
    for (const id of [bossId, zhilianId, wuyouId]) assert.ok(sent.text.includes(id));
    assert.match(sent.text, /candidate-4.*待平台核实/);
    assert.doesNotMatch(sent.text, /LOCAL_99999|resume_boss_legacy_local_id/);
    for (const [index, candidate] of preview.candidates.entries()) {
      const content = sent.attachments[index + 1].content;
      const expected = candidate.id === 'resume_boss_verified' ? bossId
        : candidate.id === 'resume_zhilian_verified' ? zhilianId
          : candidate.id === 'resume_wuyou_verified' ? wuyouId : '待平台核实';
      assert.ok(content.includes(expected));
      assert.match(content, /招聘岗位：磁轴销售工程师/);
      assert.match(content, /回查提示：/);
      assert.doesNotMatch(content, /LOCAL_99999/);
    }
  }
});

test('历史 BOSS OCR 猜测姓名在 Word 报告与简历附件头部均标为未识别', async t => {
  configureSmtp(t);
  const item = { id: 'legacy-ocr', source: 'boss', name: '工作', nameSource: 'ocr',
    matchScore: 82, matchEvaluation: currentAi(jobRequirements),
    originalText: '工作经历：在企业负责网络设备维护。\n教育经历：本科。' };
  let sent;
  const service = new CandidateEmailService({ pipeline: { list: () => [item] },
    transportFactory: () => ({ sendMail: async mail => {
      sent = mail;
      return { messageId: 'synthetic-mail' };
    } }) });
  const input = { source: 'boss', minScore: 70, topN: 1, jobRequirements,
    reportFormat: 'docx' };
  const preview = await service.preview(input);
  assert.equal(preview.candidates[0].name, '未识别姓名');
  await service.send({ ...input, to: recipient, previewToken: preview.previewToken });
  const word = await mammoth.extractRawText({ buffer: sent.attachments[0].content });
  assert.match(word.value, /未识别姓名/);
  assert.match(sent.attachments[1].content, /候选人：未识别姓名/);
  assert.equal(item.name, '工作');
});

test('三平台默认邮件排除人工淘汰者，显式淘汰筛选仍可审计', async t => {
  configureSmtp(t);
  const sources = ['boss', 'zlzp', 'qcwy'];
  const items = sources.flatMap(source => [
    { id: `${source}-active`, source, workflowStatus: 'new', matchScore: 81,
      matchEvaluation: currentAi(jobRequirements), originalText: `${source} 合格简历正文` },
    { id: `${source}-rejected`, source, workflowStatus: 'rejected', matchScore: 99,
      matchEvaluation: currentAi(jobRequirements), originalText: `${source} 人工淘汰简历正文` }
  ]);
  const pipeline = { list: ({ source = '', status = '' } = {}) => items.filter(item =>
    (!source || item.source === source) && (!status || item.workflowStatus === status)) };
  const sent = [];
  const service = new CandidateEmailService({ pipeline,
    transportFactory: () => ({ sendMail: async mail => {
      sent.push(mail);
      return { messageId: 'synthetic-mail' };
    } }) });
  const input = { minScore: 70, topN: 20, jobRequirements, reportFormat: 'docx' };
  const preview = await service.preview(input);
  assert.deepEqual(preview.candidates.map(item => item.id), ['boss-active', 'qcwy-active', 'zlzp-active']);
  assert.equal(preview.total, 3);
  assert.deepEqual(preview.screening.bySource, Object.fromEntries(sources.map(source =>
    [source, { evaluated: 1, attached: 1 }])));

  const audit = await service.preview({ ...input, status: 'rejected' });
  assert.deepEqual(audit.candidates.map(item => item.id), ['boss-rejected', 'qcwy-rejected', 'zlzp-rejected']);
  assert.equal(audit.total, 3);

  await service.send({ ...input, to: recipient, previewToken: preview.previewToken });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].attachments[0].filename, 'candidate-report.docx');
  assert.equal(sent[0].attachments.length, 4);
  assert.ok(sent[0].attachments.slice(1).every(file => !String(file.content).includes('人工淘汰')));
});

test('IT 岗邮件只选入当前 AI 评估，排除同岗位旧关键词、手工分和失败状态', async () => {
  const requirements = '岗位名称：IT网络运维\n必需技能：网络故障排查与服务器运维';
  const base = (id, source, matchScore, matchEvaluation, matchEvaluationStatus = 'completed') => ({
    id, source, matchScore, originalText: `合成候选人简历 ${id}`,
    matchEvaluation, matchEvaluationStatus
  });
  const current = currentAi(requirements, { summary: '已有岗位相关证据' });
  const items = [
    base('boss-ai', 'boss', 91, current),
    base('zl-ai', 'zlzp', 87, current),
    base('qcwy-ai', 'qcwy', 84, current),
    base('boss-local', 'boss', 99, { jobRequirements: requirements, method: 'local',
      evaluationVersion: 2, evaluatedAt: current.evaluatedAt }),
    base('zl-manual', 'zlzp', 98, { jobRequirements: requirements, summary: '人工写入的旧分数' }),
    base('zl-unversioned', 'zlzp', 97, { ...current, evaluationVersion: undefined }),
    base('boss-undated', 'boss', 96, { ...current, evaluatedAt: undefined }),
    base('boss-failed', 'boss', 95, current, 'failed'),
    base('zl-pending', 'zlzp', 94, current, 'pending'),
    base('other-job', 'qcwy', 100, currentAi('岗位名称：项目经理\n负责交付'))
  ];
  const service = new CandidateEmailService({ pipeline: { list: () => items } });
  const preview = await service.preview({ minScore: 70, topN: 20, jobRequirements: requirements });
  assert.deepEqual(preview.candidates.map(item => item.id), ['boss-ai', 'zl-ai', 'qcwy-ai']);
  assert.equal(preview.total, 3);
  assert.deepEqual(preview.screening.bySource, {
    boss: { evaluated: 1, attached: 1 },
    zlzp: { evaluated: 1, attached: 1 },
    qcwy: { evaluated: 1, attached: 1 }
  });
  assert.equal(preview.screening.qcwy.ai, 1);
});

test('超过单封上限时按固定候选人池逐批预览确认，三封 Word 邮件无重复或遗漏', async t => {
  configureSmtp(t);
  const items = Array.from({ length: 48 }, (_, index) => ({
    id: `batch-${String(index).padStart(2, '0')}`,
    source: index % 2 ? 'boss' : 'qcwy',
    matchScore: 99 - index,
    originalText: `合成候选人简历 batch-${index}`,
    matchEvaluation: { jobRequirements, summary: '人工复核', method: 'llm',
      evaluationVersion: 1, evaluatedAt: '2026-10-20T02:00:00.000Z' }
  }));
  const sent = [];
  const service = new CandidateEmailService({ pipeline: { list: () => items },
    transportFactory: () => ({ sendMail: async options => {
      sent.push(options);
      return { messageId: `mock-${sent.length}` };
    } }) });
  const input = { minScore: 50, topN: 20, jobRequirements, reportFormat: 'docx' };
  const allIds = [];
  let offset = 0;
  let poolFingerprint;
  for (const count of [20, 20, 8]) {
    const page = offset ? { offset, poolFingerprint } : {};
    const preview = await service.preview({ ...input, ...page });
    assert.equal(preview.count, count);
    assert.equal(preview.total, 48);
    assert.equal(preview.offset, offset);
    assert.equal(preview.nextOffset, offset + count);
    if (poolFingerprint) assert.equal(preview.poolFingerprint, poolFingerprint);
    else poolFingerprint = preview.poolFingerprint;
    allIds.push(...preview.candidates.map(item => item.id));
    const result = await service.send({ to: recipient, ...input, ...page,
      previewToken: preview.previewToken });
    assert.equal(result.count, count);
    assert.equal(result.nextOffset, offset + count);
    assert.equal(result.hasMore, offset + count < 48);
    offset = result.nextOffset;
  }
  assert.equal(offset, 48);
  assert.equal(new Set(allIds).size, 48);
  assert.deepEqual(allIds, items.map(item => item.id));
  assert.deepEqual(sent.map(mail => mail.attachments.length), [21, 21, 9]);
  assert.deepEqual(sent.map(mail => mail.subject.match(/第\d\/3批/)?.[0]),
    ['第1/3批', '第2/3批', '第3/3批']);
  assert.ok(sent.every(mail => mail.attachments[0].filename === 'candidate-report.docx'));
  assert.ok(sent.every(mail => mail.attachments[0].content.subarray(0, 2).toString() === 'PK'));
  await assert.rejects(service.preview({ ...input, offset: 20 }), /首批指纹/);
});

test('首批后新增、移除或修改候选人会阻止下一批，已有预览也不能继续发送', async t => {
  configureSmtp(t);
  const items = Array.from({ length: 23 }, (_, index) => ({
    id: `stable-${index}`, source: 'boss', matchScore: 90 - index,
    originalText: `合成简历 ${index}`,
    matchEvaluation: currentAi(jobRequirements, { summary: '待复核' })
  }));
  let calls = 0;
  const service = new CandidateEmailService({ pipeline: { list: () => items },
    transportFactory: () => ({ sendMail: async () => { calls++; return {}; } }) });
  const input = { minScore: 0, topN: 20, jobRequirements, reportFormat: 'md' };
  const first = await service.preview(input);
  await service.send({ to: recipient, ...input, previewToken: first.previewToken });
  const page = { offset: first.nextOffset, poolFingerprint: first.poolFingerprint };
  const second = await service.preview({ ...input, ...page });
  items[21].originalText += ' 已更新';
  await assert.rejects(service.send({ to: recipient, ...input, ...page,
    previewToken: second.previewToken }), /候选人集合已变化/);
  assert.equal(calls, 1);
  await assert.rejects(service.preview({ ...input, ...page }), /候选人集合已变化/);
  items[21].originalText = '合成简历 21';
  items.unshift({ ...items[0], id: 'new-top', matchScore: 100 });
  await assert.rejects(service.preview({ ...input, ...page }), /候选人集合已变化/);
});

test('初筛报告默认以 Word 附件发送，简历附件保持原有内容', async t => {
  configureSmtp(t);
  let sent;
  const service = new CandidateEmailService({ pipeline: { list: records },
    transportFactory: () => ({ sendMail: async options => { sent = options; return { messageId: 'mock-word' }; } }) });
  const input = { minScore: 80, topN: 10, jobRequirements };
  const preview = await service.preview(input);
  assert.equal(preview.selection.reportFormat, 'docx');
  const result = await service.send({ to: recipient, ...input, previewToken: preview.previewToken });
  assert.equal(result.count, 2);
  assert.equal(sent.attachments[0].filename, 'candidate-report.docx');
  assert.equal(sent.attachments[0].contentType,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.ok(Buffer.isBuffer(sent.attachments[0].content));
  assert.equal(sent.attachments[0].content.subarray(0, 2).toString('ascii'), 'PK');
  assert.match(sent.attachments[1].content, /前程无忧完整简历/);
});

test('前程无忧误采通知的 Word 报告、预览与 TXT 首部使用匿名来源标识', async t => {
  configureSmtp(t);
  const item = { id: 'qcwy-ui', source: 'qcwy', name: '通知', position: '通知',
    sourceRecordKey: 'd'.repeat(64),
    sourceUrl: 'https://ehire.51job.com/Revision/talent/resume/detail?resumeId=official-d',
    originalText: '通知\n工作经历：网络故障排查',
    matchScore: 82, matchEvaluation: currentAi(jobRequirements, { summary: '具备相关工作经历' }) };
  let sent;
  const service = new CandidateEmailService({ pipeline: { list: () => [item] },
    transportFactory: () => ({ sendMail: async options => {
      sent = options;
      return { messageId: 'mock-anonymous' };
    } }) });
  const input = { minScore: 70, topN: 1, jobRequirements, reportFormat: 'docx' };
  const preview = await service.preview(input);
  assert.match(preview.candidates[0].name, /匿名候选人（前程无忧记录 ID：official-d）/);
  assert.equal(preview.candidates[0].position, '求职岗位待核实');
  await service.send({ ...input, to: recipient, previewToken: preview.previewToken });
  const word = (await mammoth.extractRawText({ buffer: sent.attachments[0].content })).value;
  assert.match(word, /匿名候选人（前程无忧记录 ID：official-d）/);
  assert.match(word, /求职岗位待核实/);
  assert.doesNotMatch(word, /通知/);
  assert.equal(sent.attachments[1].filename, 'candidate-1.txt');
  assert.match(sent.attachments[1].content.split('\n').slice(0, 4).join('\n'),
    /候选人：匿名候选人（前程无忧记录 ID：official-d）/);
  assert.equal(item.name, '通知');
});

test('预览时选择的报告格式不能在发送时悄悄更换', async () => {
  let transportCalls = 0;
  const service = new CandidateEmailService({ pipeline: { list: records },
    transportFactory: () => { transportCalls++; throw new Error('SMTP must not be reached'); } });
  const wordPreview = await service.preview({ ...selection, reportFormat: 'docx' });
  await assert.rejects(service.send({ to: recipient, ...selection,
    previewToken: wordPreview.previewToken }), /已变化.*重新预览/);
  const mdPreview = await service.preview(selection);
  await assert.rejects(service.send({ to: recipient, ...selection, reportFormat: 'docx',
    previewToken: mdPreview.previewToken }), /已变化.*重新预览/);
  assert.equal(transportCalls, 0);
  await assert.rejects(service.preview({ ...selection, reportFormat: 'pdf' }), /不支持的初筛报告格式/);
});

test('智联跨会话近重复只进入一次邮件，页面提取 TXT 与岗位主题如实标注', async t => {
  configureSmtp(t);
  const requirements = '岗位：成本核算经理（依据岗位筛选条件）\n负责月度成本核算';
  const body = ('工作经历：负责成本核算、库存分析与月度结账。教育经历：财务专业本科。').repeat(20);
  const base = { source: 'zlzp', sourceUrl: 'https://rd.zhaopin.com/search',
    name: '测试候选人', age: '35', education: '本科',
    matchEvaluation: currentAi(requirements, { summary: '需要人工核实' }) };
  const items = [
    { ...base, id: 'newer', matchScore: 94, originalText: `测试候选人\n浏览标识：13\n${body}` },
    { ...base, id: 'older', matchScore: 90, originalText: `测试候选人\n浏览标识：12\n${body}` },
    { ...base, id: 'distinct', name: '另一位候选人', matchScore: 88,
      originalText: `另一位候选人\n浏览标识：13\n${body}` }
  ];
  let sent;
  const service = new CandidateEmailService({ pipeline: { list: () => items },
    transportFactory: () => ({ sendMail: async options => { sent = options; return {}; } }) });
  const input = { ...selection, jobRequirements: requirements, source: 'zlzp' };
  const preview = await service.preview(input);
  assert.deepEqual(preview.candidates.map(item => item.id), ['newer', 'distinct']);
  assert.equal(preview.candidates[0].attachmentType, '页面提取文本（非平台原版简历文件）');
  const result = await service.send({ to: recipient, ...input, previewToken: preview.previewToken });
  assert.equal(result.count, 2);
  assert.equal(sent.attachments.length, 3);
  assert.equal(sent.attachments[0].filename, 'candidate-report.md');
  assert.match(sent.attachments[0].content, /简历附件：页面提取文本（非平台原版简历文件）/);
  assert.match(sent.attachments[1].content, /附件类型：页面提取文本（非平台原版简历文件）/);
  assert.match(sent.text, /非平台原版简历文件/);
  assert.equal(sent.subject, '成本核算经理候选人初筛报告（2份）');
  assert.match(sent.text, /进入本次岗位初筛名单/);
  assert.doesNotMatch(sent.text, /符合当前岗位匹配条件/);
  assert.match(sent.attachments[0].content, /^# 候选人初筛报告/m);
});

test('邮件主题只采用安全、有限长度的岗位首行', () => {
  assert.equal(jobTitleFromRequirements('岗位：成本核算经理（依据表格）\n其他要求'), '成本核算经理');
  assert.equal(jobTitleFromRequirements('岗位：成本核算经理\r\nBcc: hidden@example.test'), '成本核算经理');
  assert.equal(jobTitleFromRequirements('条件：成本核算经理'), '');
  assert.equal(jobTitleFromRequirements(`岗位：${'超'.repeat(41)}`), '');
});

test('前程无忧只发送本地评估明确达到最低证据门槛的简历', async t => {
  configureSmtp(t);
  const items = [...records(),
    { id: 'legacy-qcwy', source: 'qcwy', matchScore: 100,
      matchEvaluation: { jobRequirements }, originalText: 'legacy-never-attach' },
    { id: 'remote-qcwy', source: 'qcwy', matchScore: 99,
      matchEvaluation: { jobRequirements, method: 'llm', recommendationEligible: true },
      originalText: 'remote-never-attach' },
    { id: 'old-local-qcwy', source: 'qcwy', matchScore: 98,
      matchEvaluation: { jobRequirements, method: 'local' }, originalText: 'old-local-never-attach' },
    { id: 'not-eligible-qcwy', source: 'qcwy', matchScore: 97,
      matchEvaluation: { jobRequirements, method: 'local', recommendationEligible: false },
      originalText: 'not-eligible-never-attach' },
    { id: 'truthy-qcwy', source: 'qcwy', matchScore: 96,
      matchEvaluation: { jobRequirements, method: 'local', recommendationEligible: 'true' },
      originalText: 'truthy-never-attach' }
  ];
  let sent;
  const service = new CandidateEmailService({ pipeline: { list: () => items },
    transportFactory: () => ({ sendMail: async options => { sent = options; return {}; } }) });
  const preview = await service.preview(selection);
  assert.deepEqual(preview.candidates.map(item => item.id), ['c', 'a']);
  const result = await service.send({ to: recipient, ...selection, previewToken: preview.previewToken });
  assert.equal(result.count, 2);
  assert.equal(sent.attachments.length, 3);
  assert.match(sent.attachments[1].content, /前程无忧完整简历/);
  assert.match(sent.text, /前程无忧候选人仅达到本地初筛的最低证据门槛/);
  assert.match(sent.attachments[0].content, /须人工复核全部岗位条件/);
  assert.doesNotMatch(sent.attachments.map(item => String(item.content)).join('\n'),
    /legacy-never-attach|remote-never-attach|old-local-never-attach|not-eligible-never-attach|truthy-never-attach/);
});

test('前程无忧邮件报告汇总全部已评估简历，仅附初筛名单', async t => {
  configureSmtp(t);
  const make = (id, status, eligible) => ({
    id, source: 'qcwy', matchScore: eligible ? 85 : 40,
    originalText: `候选人简历 ${id}`,
    matchEvaluation: { jobRequirements, method: 'local', evaluationVersion: 2,
      recommendationEligible: eligible, summary: status,
      requiredEvidence: { education: { status } } }
  });
  const items = [make('selected', 'met', true), make('below', 'not_met', false),
    make('pending', 'unknown', false)];
  let sent;
  const service = new CandidateEmailService({ pipeline: { list: () => items },
    transportFactory: () => ({ sendMail: async options => { sent = options; return {}; } }) });
  const input = { source: 'qcwy', minScore: 0, topN: 18, jobRequirements, reportFormat: 'md' };
  const preview = await service.preview(input);
  assert.equal(preview.count, 1);
  await service.send({ to: recipient, ...input, previewToken: preview.previewToken });
  assert.equal(sent.attachments.length, 2);
  assert.match(sent.attachments[0].content, /前程无忧该岗位已评估：3 份/);
  assert.match(sent.attachments[0].content,
    /最低证据门槛已满足：1 份；明确低于最低条件：1 份；证据不足待核实：1 份/);
  assert.doesNotMatch(sent.attachments[1].content, /below|pending/);
});

test('跨平台 Word 报告记录前程无忧零入选，简历附件只含智联入选者', async t => {
  configureSmtp(t);
  const requirements = '岗位：项目经理主管\n负责项目计划、交付和跨部门协作';
  const items = [
    ...Array.from({ length: 5 }, (_, index) => ({
      id: `zl-${index}`, source: 'zlzp', matchScore: 90 - index,
      originalText: `智联测试简历 ${index}`,
      matchEvaluation: currentAi(requirements, { summary: '项目经验待复核' })
    })),
    ...Array.from({ length: 18 }, (_, index) => ({
      id: `qcwy-${index}`, source: 'qcwy', matchScore: 60 - index,
      originalText: `前程无忧测试简历 ${index}`,
      matchEvaluation: { jobRequirements: requirements, method: 'llm', evaluationVersion: 1,
        evaluatedAt: '2026-10-20T02:00:00.000Z', summary: '未达本次分数门槛' }
    }))
  ];
  let sent;
  const service = new CandidateEmailService({ pipeline: { list: () => items },
    transportFactory: () => ({ sendMail: async options => { sent = options; return {}; } }) });
  const input = { jobRequirements: requirements, minScore: 70, topN: 20, reportFormat: 'docx' };
  const preview = await service.preview(input);
  assert.equal(preview.count, 5);
  assert.deepEqual(preview.screening.sources, ['zlzp', 'qcwy']);
  assert.deepEqual(preview.screening.bySource, {
    zlzp: { evaluated: 5, attached: 5 }, qcwy: { evaluated: 18, attached: 0 }
  });
  await service.send({ ...input, to: recipient, previewToken: preview.previewToken });
  assert.equal(sent.attachments.length, 6);
  assert.ok(sent.attachments.slice(1).every(file => file.content.includes('智联测试简历')));
  assert.doesNotMatch(sent.attachments.slice(1).map(file => file.content).join('\n'), /前程无忧测试简历/);
  assert.match(sent.text, /智联招聘 5 份；前程无忧 0 份/);
  const word = await mammoth.extractRawText({ buffer: sent.attachments[0].content });
  assert.match(word.value, /本次数据来源：智联招聘、前程无忧/);
  assert.match(word.value, /本次岗位已评估：智联招聘 5 份；前程无忧 18 份/);
  assert.match(word.value, /本邮件附简历：智联招聘 5 份；前程无忧 0 份/);
  assert.match(word.value, /前程无忧该岗位已评估：18 份/);
  assert.match(word.value, /前程无忧 AI 辅助评分达到本次分数门槛：0 份；低于门槛：18 份/);
});

test('前程无忧通用岗位 AI 评估达标可入选，未标记版本的旧评估不能入选', async t => {
  configureSmtp(t);
  const requirements = '岗位：项目经理主管\n负责项目交付与客户协调';
  const current = { id: 'current-ai', source: 'qcwy', matchScore: 86,
    originalText: '项目交付与客户协调测试简历',
    matchEvaluation: { jobRequirements: requirements, method: 'llm', evaluationVersion: 1,
      evaluatedAt: '2026-10-20T02:00:00.000Z', summary: '相关经验需复核' } };
  const items = [current,
    { ...current, id: 'old-ai', matchScore: 99,
      matchEvaluation: { jobRequirements: requirements, method: 'llm', summary: '旧版评估' } },
    { ...current, id: 'old-local', matchScore: 98,
      matchEvaluation: { jobRequirements: requirements, method: 'local', summary: '旧版关键词评估' } }];
  let sent;
  const service = new CandidateEmailService({ pipeline: { list: () => items },
    transportFactory: () => ({ sendMail: async options => { sent = options; return {}; } }) });
  const input = { jobRequirements: requirements, minScore: 80, topN: 20, reportFormat: 'md' };
  const preview = await service.preview(input);
  assert.deepEqual(preview.candidates.map(item => item.id), ['current-ai']);
  await service.send({ ...input, to: recipient, previewToken: preview.previewToken });
  assert.equal(sent.attachments.length, 2);
  assert.match(sent.attachments[0].content, /前程无忧该岗位已评估：1 份/);
  assert.match(sent.attachments[1].content, /项目交付与客户协调测试简历/);
});

test('前程无忧预览后失去推荐资格时拒绝发送，不连接 SMTP', async () => {
  const items = [records()[2]];
  let transportCalls = 0;
  const service = new CandidateEmailService({ pipeline: { list: () => items },
    transportFactory: () => { transportCalls++; throw new Error('SMTP must not be reached'); } });
  const preview = await service.preview({ ...selection, source: 'qcwy' });
  assert.deepEqual(preview.candidates.map(item => item.id), ['c']);
  items[0].matchEvaluation.recommendationEligible = false;
  await assert.rejects(service.send({ to: recipient, ...selection, source: 'qcwy',
    previewToken: preview.previewToken }), /已变化.*重新预览/);
  assert.equal(transportCalls, 0);
  assert.equal((await service.preview({ ...selection, source: 'qcwy' })).count, 0);
});

test('最低分为零时仍排除前程无忧旧评估和不推荐者，修改筛选条件不能绕过预览', async () => {
  const qualified = { ...records()[2], matchScore: 72 };
  const items = [
    { ...qualified, id: 'old', matchScore: 100,
      matchEvaluation: { jobRequirements, method: 'local' }, originalText: '旧评估简历' },
    { ...qualified, id: 'rejected', matchScore: 99,
      matchEvaluation: { jobRequirements, method: 'local', recommendationEligible: false },
      originalText: '不推荐简历' },
    qualified
  ];
  let transportCalls = 0;
  const service = new CandidateEmailService({ pipeline: { list: () => items },
    transportFactory: () => { transportCalls++; throw new Error('SMTP must not be reached'); } });
  const input = { source: 'qcwy', status: '', minScore: 0, topN: 10, jobRequirements };
  const preview = await service.preview(input);
  assert.deepEqual(preview.candidates.map(item => item.id), ['c']);
  await assert.rejects(service.send({ to: recipient, ...input, topN: 20,
    previewToken: preview.previewToken }), /已变化.*重新预览/);
  await assert.rejects(service.send({ to: recipient, ...input, previewToken: preview.previewToken }),
    /重新预览/);
  assert.equal(transportCalls, 0);
});

test('假 SMTP 仅发送预览附件，令牌不可重复使用且兼容不同 SMTP 配置', async t => {
  configureSmtp(t);
  let sent;
  let transportConfig;
  const service = new CandidateEmailService({
    pipeline: { list: records },
    transportFactory: config => {
      transportConfig = config;
      return { sendMail: async options => { sent = options; return { messageId: 'mock-id' }; } };
    }
  });
  const preview = await service.preview(selection);
  await assert.rejects(service.send({ to: 'a@example.test,b@example.test', ...selection,
    previewToken: preview.previewToken }), /有效/);
  const result = await service.send({ to: recipient, ...selection, previewToken: preview.previewToken });
  assert.equal(result.count, 2);
  assert.equal(sent.attachments.length, 3);
  assert.equal(sent.to, recipient);
  assert.match(sent.attachments[0].content, new RegExp(jobRequirements));
  assert.match(sent.attachments[0].content, /相关优势：[\s\S]*具备相关项目证据/);
  assert.match(sent.attachments[0].content, /待核实点：[\s\S]*需要核实项目职责/);
  assert.doesNotMatch(sent.attachments[0].content, /BOSS 完整简历|前程无忧完整简历/);
  assert.match(sent.attachments[1].content, /前程无忧完整简历/);
  assert.equal(transportConfig.host, 'smtp.example.test');
  assert.equal(transportConfig.secure, false);
  await assert.rejects(service.send({ to: recipient, ...selection,
    previewToken: preview.previewToken }), /重新预览/);

  process.env.SMTP_PASS_B64 = Buffer.from('web-form-token').toString('base64');
  await service.send({ to: recipient, ...selection, previewToken: (await service.preview(selection)).previewToken });
  assert.equal(transportConfig.auth.pass, 'web-form-token');
  delete process.env.SMTP_PASS_B64;
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;
  process.env.SMTP_PORT = '2525';
  process.env.SMTP_SECURE = 'false';
  process.env.SMTP_REQUIRE_TLS = 'true';
  assert.equal(service.configuration().configured, true);
  await service.send({ to: recipient, ...selection, previewToken: (await service.preview(selection)).previewToken });
  assert.equal(transportConfig.port, 2525);
  assert.equal(transportConfig.requireTLS, true);
  assert.equal(Object.hasOwn(transportConfig, 'auth'), false);
});

test('预览后评分、简历内容、评估版本、候选人集合或筛选条件变化均拒绝发送', async t => {
  const changes = [
    ['score', items => { items[0].matchScore++; }],
    ['text', items => { items[0].originalText += ' 更新'; }],
    ['evaluation', items => { items[0].matchEvaluation.evaluatedAt = 'new-version'; }],
    ['metadata', items => { items[0].workflowStatus = 'contacted'; }],
    ['new candidate', items => { items.push({ ...items[0], id: 'new', matchScore: 95 }); }],
    ['removed candidate', items => { items.splice(0, 1); }],
    ['selection', () => {}, { ...selection, topN: 1 }],
    ['job requirements', () => {}, { ...selection, jobRequirements: '招聘有销售经验的客户经理' }]
  ];
  for (const [name, change, changedSelection = selection] of changes) {
    await t.test(name, async () => {
      const items = records();
      let transportCalls = 0;
      const service = new CandidateEmailService({
        pipeline: { list: () => items },
        transportFactory: () => { transportCalls++; throw new Error('SMTP must not be reached'); }
      });
      const preview = await service.preview(selection);
      change(items);
      await assert.rejects(service.send({ to: recipient, ...changedSelection,
        previewToken: preview.previewToken }), /已变化.*重新预览/);
      assert.equal(transportCalls, 0);
    });
  }
});

test('发送拒绝缺失、未知及过期的预览令牌', async () => {
  let now = 1000;
  const service = new CandidateEmailService({ pipeline: { list: records }, now: () => now,
    transportFactory: () => { throw new Error('SMTP must not be reached'); } });
  await assert.rejects(service.send({ to: recipient, ...selection }), /重新预览/);
  await assert.rejects(service.send({ to: recipient, ...selection, previewToken: 'unknown' }), /重新预览/);
  const preview = await service.preview(selection);
  now += 10 * 60 * 1000;
  await assert.rejects(service.send({ to: recipient, ...selection,
    previewToken: preview.previewToken }), /已过期.*重新预览/);
});

test('同一个预览的并发发送仅调用一次假 SMTP', async t => {
  configureSmtp(t);
  let calls = 0;
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const service = new CandidateEmailService({ pipeline: { list: records },
    transportFactory: () => ({ sendMail: async () => { calls++; await pending; return {}; } }) });
  const input = { to: recipient, ...selection, previewToken: (await service.preview(selection)).previewToken };
  const first = service.send(input);
  await assert.rejects(service.send(input), /重新预览/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  finish();
  await first;
});

test('SMTP 返回错误后也要求重新预览，避免不确定状态下复用旧请求', async t => {
  configureSmtp(t);
  const service = new CandidateEmailService({ pipeline: { list: records },
    transportFactory: () => ({ sendMail: async () => { throw new Error('mock SMTP error'); } }) });
  const input = { to: recipient, ...selection, previewToken: (await service.preview(selection)).previewToken };
  await assert.rejects(service.send(input), /mock SMTP error/);
  await assert.rejects(service.send(input), /重新预览/);
});

test('本机发送记录阻止 HTTP 响应丢失后的重新预览重发，且不保存简历正文', async t => {
  configureSmtp(t);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'candidate-mail-receipts-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('candidate-mail-receipts-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  let sendCalls = 0;
  const createService = () => new CandidateEmailService({ pipeline: { list: records },
    deliveryReceiptDirectory: directory,
    transportFactory: () => ({ sendMail: async () => { sendCalls++; return { messageId: 'mock' }; } }) });
  const first = createService();
  const preview = await first.preview(selection);
  const result = await first.send({ to: recipient, ...selection, previewToken: preview.previewToken });
  assert.equal(result.receiptRecorded, true);
  assert.equal(sendCalls, 1);
  const files = await fs.readdir(directory);
  assert.equal(files.length, 1);
  const receipt = await fs.readFile(path.join(directory, files[0]), 'utf8');
  assert.equal(JSON.parse(receipt).state, 'sent');
  assert.doesNotMatch(receipt, /前程无忧完整简历|BOSS 完整简历|reviewer@example\.test/);
  const afterHttpTimeout = createService();
  const secondPreview = await afterHttpTimeout.preview(selection);
  await assert.rejects(afterHttpTimeout.send({ to: recipient, ...selection,
    previewToken: secondPreview.previewToken }), /已有发送记录/);
  assert.equal(sendCalls, 1);
});

test('SMTP 超时的批次保留待核对记录，重启后不盲目重试', async t => {
  configureSmtp(t);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'candidate-mail-receipts-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('candidate-mail-receipts-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  let sendCalls = 0;
  const createService = () => new CandidateEmailService({ pipeline: { list: records },
    deliveryReceiptDirectory: directory,
    transportFactory: () => ({ sendMail: async () => { sendCalls++; throw new Error('mock SMTP timeout'); } }) });
  const first = createService();
  const preview = await first.preview(selection);
  await assert.rejects(first.send({ to: recipient, ...selection,
    previewToken: preview.previewToken }), /结果可能不确定/);
  const files = await fs.readdir(directory);
  assert.equal(files.length, 1);
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, files[0]), 'utf8')).state, 'uncertain');
  const afterRestart = createService();
  const nextPreview = await afterRestart.preview(selection);
  await assert.rejects(afterRestart.send({ to: recipient, ...selection,
    previewToken: nextPreview.previewToken }), /已有发送记录/);
  await assert.rejects(afterRestart.resume({ to: recipient, ...selection, newOnly: true }),
    /发送结果待核对/);
  assert.equal(sendCalls, 1);
});

test('刷新或重启后从本机回执恢复第二批，且筛选变化不能重发首批候选人', async t => {
  configureSmtp(t);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'candidate-mail-receipts-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('candidate-mail-receipts-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const items = Array.from({ length: 27 }, (_, index) => ({
    id: `resume-${index}`, source: 'boss', matchScore: 90,
    originalText: `合成简历 ${index}`,
    matchEvaluation: currentAi(jobRequirements, { summary: '待复核' })
  }));
  let sendCalls = 0;
  const createService = () => new CandidateEmailService({ pipeline: { list: () => items },
    deliveryReceiptDirectory: directory,
    transportFactory: () => ({ sendMail: async () => {
      sendCalls++;
      return { messageId: `mock-${sendCalls}` };
    } }) });
  const input = { to: recipient, minScore: 70, topN: 20, jobRequirements, reportFormat: 'docx' };
  const firstService = createService();
  const firstPreview = await firstService.preview(input);
  await firstService.send({ ...input, previewToken: firstPreview.previewToken });
  assert.equal(sendCalls, 1);

  const afterRestart = createService();
  const progress = await afterRestart.resume(input);
  assert.deepEqual({ nextOffset: progress.nextOffset, total: progress.total, hasMore: progress.hasMore },
    { nextOffset: 20, total: 27, hasMore: true });
  const second = { ...input, offset: progress.nextOffset, poolFingerprint: progress.poolFingerprint };
  const secondPreview = await afterRestart.preview(second);
  assert.deepEqual(secondPreview.candidates.map(item => item.id),
    items.slice().sort((a, b) => a.id.localeCompare(b.id)).slice(20).map(item => item.id));
  await afterRestart.send({ ...second, previewToken: secondPreview.previewToken });
  assert.equal(sendCalls, 2);
  assert.equal((await createService().resume(input)).nextOffset, 27);
  await assert.rejects(createService().resume({ ...input, topN: 10 }), /已发送或待核对/);
  const changedService = createService();
  const changedPreview = await changedService.preview({ ...input, topN: 10 });
  await assert.rejects(changedService.send({ ...input, topN: 10,
    previewToken: changedPreview.previewToken }), /已发送或待核对/);
  assert.equal(sendCalls, 2);
  const receipts = await Promise.all((await fs.readdir(directory)).map(file =>
    fs.readFile(path.join(directory, file), 'utf8')));
  assert.equal(receipts.length, 2);
  assert.ok(receipts.every(content => JSON.parse(content).format === 2));
  assert.ok(receipts.every(content => !content.includes(recipient) && !content.includes('合成简历')));
  items.unshift({ ...items[0], id: 'newly-qualified' });
  await assert.rejects(createService().resume(input), /候选人集合已变化/);
});

test('已发送的 BOSS 候选池变化后，仅预览、发送新增合格者，保留 Word 和防重发回执', async t => {
  configureSmtp(t);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'candidate-mail-receipts-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('candidate-mail-receipts-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const item = (id, score = 80, eligible = true) => ({ id, source: 'boss', matchScore: score,
    originalText: `合成简历 ${id}`,
    matchEvaluation: currentAi(jobRequirements, { recommendationEligible: eligible }) });
  const items = [item('already-sent', 70)];
  const mailed = [];
  const createService = () => new CandidateEmailService({ pipeline: { list: () => items },
    deliveryReceiptDirectory: directory,
    transportFactory: () => ({ sendMail: async mail => {
      mailed.push(mail);
      return { messageId: `mock-${mailed.length}` };
    } }) });
  const input = { to: recipient, source: 'boss', minScore: 70, topN: 2,
    jobRequirements, reportFormat: 'docx' };
  const oldService = createService();
  const oldPreview = await oldService.preview(input);
  await oldService.send({ ...input, previewToken: oldPreview.previewToken });
  assert.equal(mailed.length, 1);

  items.push(item('new-high', 92), item('new-mid', 80), item('new-low', 75), item('vetoed', 99, false),
    item('below-score', 69), item('wrong-job', 90));
  items[items.length - 1].matchEvaluation.jobRequirements = '其他岗位要求';
  await assert.rejects(createService().resume(input), /候选人集合已变化/);

  const newInput = { ...input, newOnly: true };
  const first = createService();
  assert.deepEqual(await first.resume(newInput).then(progress =>
    ({ total: progress.total, hasMore: progress.hasMore })),
  { total: 3, hasMore: true });
  const newPreview = await first.preview(newInput);
  assert.deepEqual(newPreview.candidates.map(candidate => candidate.id),
    ['new-high', 'new-mid']);
  assert.ok(newPreview.selection.roundFingerprint);
  await assert.rejects(first.send({ ...newInput, to: 'different@example.test',
    previewToken: newPreview.previewToken }), /候选人或筛选条件已变化/);
  const secondPreview = await first.preview(newInput);
  const result = await first.send({ ...newInput, previewToken: secondPreview.previewToken });
  assert.equal(result.count, 2);
  assert.equal(mailed.length, 2);
  assert.deepEqual(mailed[1].attachments.map(attachment => attachment.filename),
    ['candidate-report.docx', 'candidate-1.txt', 'candidate-2.txt']);
  assert.ok(mailed[1].attachments[0].content.subarray(0, 2).equals(Buffer.from('PK')));
  assert.doesNotMatch(mailed[1].attachments[1].content, /already-sent/);
  assert.equal((await createService().resume(newInput)).total, 1);
  const nextService = createService();
  const nextPreview = await nextService.preview(newInput);
  assert.deepEqual(nextPreview.candidates.map(candidate => candidate.id), ['new-low']);
  await nextService.send({ ...newInput, previewToken: nextPreview.previewToken });
  assert.equal((await createService().resume(newInput)).total, 0);

  items.push(item('later-new', 85));
  const laterService = createService();
  const laterPreview = await laterService.preview(newInput);
  assert.deepEqual(laterPreview.candidates.map(candidate => candidate.id), ['later-new']);
  await laterService.send({ ...newInput, previewToken: laterPreview.previewToken });
  assert.equal(mailed.length, 4);
  assert.equal((await createService().resume(newInput)).total, 0);
  const receipts = await createService().deliveryReceipts();
  assert.equal(receipts.length, 4);
  assert.equal(new Set(receipts.flatMap(receipt => receipt.candidateHashes)).size, 5);
  assert.ok(receipts.every(receipt => receipt.state === 'sent'));
});

test('两个服务实例并发预留重叠批次时至多一封进入假 SMTP', async t => {
  configureSmtp(t);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'candidate-mail-receipts-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('candidate-mail-receipts-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const items = Array.from({ length: 23 }, (_, index) => ({
    id: `parallel-${index}`, source: 'boss', matchScore: 90,
    originalText: `合成简历 ${index}`,
    matchEvaluation: currentAi(jobRequirements, { summary: '待复核' })
  }));
  let sendCalls = 0;
  const createService = () => new CandidateEmailService({ pipeline: { list: () => items },
    deliveryReceiptDirectory: directory,
    transportFactory: () => ({ sendMail: async () => { sendCalls++; return {}; } }) });
  const first = createService();
  const second = createService();
  const firstInput = { to: recipient, minScore: 70, topN: 20, jobRequirements };
  const secondInput = { ...firstInput, topN: 10 };
  const firstPreview = await first.preview(firstInput);
  const secondPreview = await second.preview(secondInput);
  const outcomes = await Promise.allSettled([
    first.send({ ...firstInput, previewToken: firstPreview.previewToken }),
    second.send({ ...secondInput, previewToken: secondPreview.previewToken })
  ]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(sendCalls, 1);
});

async function syntheticStorage(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'candidate-mail-files-'));
  const storage = path.join(directory, 'resume_library');
  await fs.mkdir(storage);
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('candidate-mail-files-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, storage };
}

function importedRecord(filePath, buffer) {
  const record = records()[2];
  record.filePath = filePath;
  record.fileHash = crypto.createHash('md5').update(buffer).digest('hex');
  record.matchEvaluation.method = 'local';
  return record;
}

test('官方导入的合成 PDF、DOCX、TXT 保留原格式作为附件', async t => {
  configureSmtp(t);
  const { storage } = await syntheticStorage(t);
  for (const extension of ['.pdf', '.docx', '.txt']) {
    await t.test(extension, async () => {
      const buffer = Buffer.from(`synthetic exported resume ${extension}`);
      const file = path.join(storage, `official${extension}`);
      await fs.writeFile(file, buffer);
      let sent;
      const service = new CandidateEmailService({ resumeDirectory: storage,
        pipeline: { list: () => [importedRecord(file, buffer)] },
        transportFactory: () => ({ sendMail: async options => { sent = options; return {}; } }) });
      const preview = await service.preview(selection);
      await service.send({ to: recipient, ...selection, previewToken: preview.previewToken });
      assert.equal(sent.attachments[1].filename, `candidate-1${extension}`);
      assert.deepEqual(sent.attachments[1].content, buffer);
      assert.match(sent.attachments[0].content, /评估方式：本机关键词证据评分/);
      assert.match(sent.attachments[0].content, /简历附件：导入的原文件/);
      assert.doesNotMatch(sent.attachments[0].content, /AI 摘要|AI 匹配仅供/);
    });
  }
});

test('路径越界、缺失、格式不支持、哈希不符或过大的文件退回原文 TXT', async t => {
  configureSmtp(t);
  const { directory, storage } = await syntheticStorage(t);
  const buffer = Buffer.from('synthetic attachment only');
  const inside = path.join(storage, 'inside.pdf');
  const outside = path.join(directory, 'outside.pdf');
  const unsupported = path.join(storage, 'unsupported.env');
  const oversized = path.join(storage, 'oversized.pdf');
  await Promise.all([fs.writeFile(inside, buffer), fs.writeFile(outside, buffer),
    fs.writeFile(unsupported, buffer), fs.writeFile(oversized, '')]);
  await fs.truncate(oversized, 10 * 1024 * 1024 + 1);
  const cases = [
    ['outside', importedRecord(outside, buffer)],
    ['traversal', importedRecord('../outside.pdf', buffer)],
    ['missing', importedRecord(path.join(storage, 'missing.pdf'), buffer)],
    ['unsupported', importedRecord(unsupported, buffer)],
    ['oversized', importedRecord(oversized, buffer)],
    ['wrong hash', { ...importedRecord(inside, buffer), fileHash: '0'.repeat(32) }],
    ['not imported', { ...importedRecord(inside, buffer), fileHash: undefined }]
  ];
  for (const [name, record] of cases) {
    await t.test(name, async () => {
      let sent;
      const service = new CandidateEmailService({ resumeDirectory: storage, pipeline: { list: () => [record] },
        transportFactory: () => ({ sendMail: async options => { sent = options; return {}; } }) });
      const preview = await service.preview(selection);
      await service.send({ to: recipient, ...selection, previewToken: preview.previewToken });
      assert.equal(sent.attachments[1].filename, 'candidate-1.txt');
      assert.equal(typeof sent.attachments[1].content, 'string');
      assert.match(sent.attachments[1].content, /前程无忧完整简历/);
      assert.doesNotMatch(sent.attachments[1].content, /synthetic attachment only/);
    });
  }
});

test('目录链接不能把存储目录之外的合成文件变成附件', async t => {
  configureSmtp(t);
  const { directory, storage } = await syntheticStorage(t);
  const outside = path.join(directory, 'outside');
  await fs.mkdir(outside);
  const buffer = Buffer.from('synthetic outside file');
  await fs.writeFile(path.join(outside, 'export.pdf'), buffer);
  const link = path.join(storage, 'linked');
  try { await fs.symlink(outside, link, 'junction'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('系统不允许创建测试目录链接');
    throw error;
  }
  let sent;
  const service = new CandidateEmailService({ resumeDirectory: storage,
    pipeline: { list: () => [importedRecord(path.join(link, 'export.pdf'), buffer)] },
    transportFactory: () => ({ sendMail: async options => { sent = options; return {}; } }) });
  const preview = await service.preview(selection);
  await service.send({ to: recipient, ...selection, previewToken: preview.previewToken });
  assert.equal(typeof sent.attachments[1].content, 'string');
  assert.match(sent.attachments[1].content, /前程无忧完整简历/);
});

test('预览后的官方原文件变动拒绝发送，并且不会调用 SMTP', async t => {
  const { storage } = await syntheticStorage(t);
  const file = path.join(storage, 'export.pdf');
  const buffer = Buffer.from('synthetic original');
  await fs.writeFile(file, buffer);
  const record = importedRecord(file, buffer);
  let calls = 0;
  const service = new CandidateEmailService({ resumeDirectory: storage, pipeline: { list: () => [record] },
    transportFactory: () => { calls++; throw new Error('SMTP must not be reached'); } });
  const preview = await service.preview(selection);
  await fs.writeFile(file, 'synthetic modified');
  await assert.rejects(service.send({ to: recipient, ...selection, previewToken: preview.previewToken }), /已变化.*重新预览/);
  assert.equal(calls, 0);
});

test('附件总大小超过限制时预览拒绝，不调用 SMTP', async () => {
  const record = { ...records()[2], originalText: 'x'.repeat(7 * 1024 * 1024) };
  const service = new CandidateEmailService({ pipeline: { list: () => [record, { ...record, id: 'x' }, { ...record, id: 'y' }] },
    transportFactory: () => { throw new Error('SMTP must not be reached'); } });
  await assert.rejects(service.preview(selection), /总大小不能超过/);
});
