const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ZhilianService = require('../src/services/zhilianService');

function readyService() {
  const service = new ZhilianService();
  service.browser = { isConnected: () => true };
  service.page = { isClosed: () => false, waitForTimeout: async () => {} };
  service.checkLoginStatus = async () => true;
  service.activeJobService.current = () => null;
  service.withErrorHandling = operation => operation();
  service.waitForPageFullyLoaded = async () => {};
  service.randomDelay = async () => {};
  return service;
}

test('智联多关键词让当前关键词采集全部剩余额度，达到目标后停止', async () => {
  const service = readyService();
  const calls = [];
  service.browseSearchCandidates = async (filters, remaining) => {
    calls.push({ keyword: filters.position, remaining });
    service.browsingStatus.collectedCount += remaining;
    service.browsingStatus.processedCount += remaining;
  };

  await service.startBrowsing('search', { position: '成本核算经理,成本经理' }, 4);
  assert.deepEqual(calls, [{ keyword: '成本核算经理', remaining: 4 }]);
  assert.equal(service.browsingStatus.collectedCount, 4);
  assert.equal(service.browsingStatus.processedCount, 4);
});

test('智联缺少请求的经验选项时向采集状态报告未应用筛选，并在新批次清除', async () => {
  const service = readyService();
  const filterPanel = { $: async () => ({ click: async () => {} }) };
  service.page.$ = async selector => selector === 'div.filter-panel-new' ? filterPanel : null;

  assert.equal(await service.configureFilterPanel({ experience: '3-5年' }), false);
  assert.deepEqual(service.getBrowsingStatus().filterWarnings,
    [{ field: 'experience', reason: 'option_unavailable' }]);
  assert.doesNotMatch(JSON.stringify(service.getBrowsingStatus().filterWarnings), /3-5年/);

  service.browseSearchCandidates = async () => {};
  await service.startBrowsing('search', { position: 'IT网络运维' }, 1);
  assert.deepEqual(service.getBrowsingStatus().filterWarnings, []);
});

test('智联多关键词以已入库数量计算下一关键词额度，不重复累计 processedCount', async () => {
  const service = readyService();
  const calls = [];
  service.browseSearchCandidates = async (filters, remaining) => {
    calls.push({ keyword: filters.position, remaining });
    const newlySaved = filters.position === '成本核算经理' ? 2 : remaining;
    service.browsingStatus.collectedCount += newlySaved;
    service.browsingStatus.processedCount += newlySaved;
  };

  await service.startBrowsing('search', { position: '成本核算经理,成本经理' }, 4);
  assert.deepEqual(calls, [
    { keyword: '成本核算经理', remaining: 4 },
    { keyword: '成本经理', remaining: 2 }
  ]);
  assert.equal(service.browsingStatus.collectedCount, 4);
  assert.equal(service.browsingStatus.processedCount, 4);
});

test('智联搜索结果不足目标时如实报告部分完成，不将单卡失败标记为整批错误', async () => {
  const service = readyService();
  service.browseSearchCandidates = async () => {
    service.browsingStatus.collectedCount = 1;
    service.browsingStatus.failedCount = 1;
  };
  await service.startBrowsing('search', { position: 'IT网络运维' }, 3);
  const status = service.getBrowsingStatus();
  assert.equal(status.collectedCount, 1);
  assert.equal(status.completionReason, 'results_exhausted');
  assert.equal(status.lastError, null);
  assert.equal(status.keywordErrors.length, 0);
});

test('智联卡片点击超时仅在原搜索页且同一卡片时重新定位重试一次', async () => {
  const service = readyService();
  let modalVisible = false;
  let freshLookups = 0;
  let firstClicks = 0;
  let freshClicks = 0;
  const modal = {
    isVisible: async () => modalVisible,
    waitFor: async () => {}
  };
  service.page.locator = () => ({ first: () => modal });
  service.page.url = () => 'https://rd6.zhaopin.com/app/search';
  service.closeVisibleResumeModal = async () => { modalVisible = false; };
  const first = {
    evaluate: async () => 'stable-card',
    scrollIntoViewIfNeeded: async () => {},
    click: async () => { firstClicks++; throw new Error('elementHandle.click: Timeout 10000ms exceeded'); }
  };
  const fresh = {
    evaluate: async () => 'stable-card',
    scrollIntoViewIfNeeded: async () => {},
    click: async () => { freshClicks++; modalVisible = true; }
  };
  service.findClickableResumeLink = async card => card;
  service.getCurrentCandidateElement = async index => { assert.equal(index, 2); freshLookups++; return fresh; };
  service.resumeCollector = {
    captureVisibleResume: async () => ({ text: 'synthetic' }),
    save: async () => ({ duplicate: false, resume: { id: 'synthetic-resume', name: 'synthetic' } })
  };
  assert.equal(await service.processResumeWithFrontend(first, 3, 2), true);
  assert.equal(firstClicks, 1);
  assert.equal(freshClicks, 1);
  assert.equal(freshLookups, 1);
  assert.equal(service.browsingStatus.failedCount, 0);
  assert.equal(service.browsingStatus.collectedCount, 1);
});

test('智联安全验证页出现时卡片点击超时不会重试或掩盖批次状态', async () => {
  const service = readyService();
  const modal = { isVisible: async () => false };
  service.page.locator = () => ({ first: () => modal });
  service.page.url = () => 'https://passport.zhaopin.com/org/login';
  let freshLookups = 0;
  service.getCurrentCandidateElement = async () => { freshLookups++; return null; };
  service.findClickableResumeLink = async card => card;
  const card = {
    evaluate: async () => 'stable-card',
    scrollIntoViewIfNeeded: async () => {},
    click: async () => { throw new Error('elementHandle.click: Timeout 10000ms exceeded'); }
  };
  assert.equal(await service.processResumeWithFrontend(card, 1, 0), false);
  assert.equal(freshLookups, 0);
  assert.equal(service.browsingStatus.failedCount, 1);
  assert.equal(service.browsingStatus.lastError, undefined);
});

test('智联逐页搜索的进度在下一关键词上延续', async () => {
  const service = readyService();
  service.browsingStatus = { ...service.browsingStatus,
    isActive: true, processedCount: 2, collectedCount: 2, targetCount: 4 };
  service.getCandidateCount = async () => 1;
  service.getCurrentCandidateElement = async () => ({});
  service.processResumeWithFrontend = async () => {
    service.browsingStatus.collectedCount++;
    return true;
  };
  await service.processSearchResultsSequentially(1);
  assert.equal(service.browsingStatus.processedCount, 3);
  assert.equal(service.browsingStatus.collectedCount, 3);
});

test('智联连续无法打开简历详情时提前停止并保留可见诊断', async () => {
  const service = readyService();
  service.browsingStatus.isActive = true;
  service.getCandidateCount = async () => 20;
  service.getSearchResultPageFingerprint = async () => 'first-page';
  service.getCurrentCandidateElement = async () => ({});
  let attempts = 0;
  let nextClicks = 0;
  service.processResumeWithFrontend = async () => {
    attempts++;
    service.browsingStatus.failedCount++;
    service.browsingStatus.lastCandidateFailureCode = 'detail_unavailable';
    return false;
  };
  service.goToNextPage = async () => { nextClicks++; return true; };

  await service.processSearchResultsSequentially(18);
  assert.equal(attempts, 3);
  assert.equal(nextClicks, 0);
  assert.equal(service.browsingStatus.collectedCount, 0);
  assert.equal(service.browsingStatus.completionReason, 'detail_unavailable');
  assert.match(service.browsingStatus.lastError, /连续 3 份简历详情未打开/);
});

test('智联翻页后仍是相同结果时停止，不会反复处理第一张卡片', async () => {
  const service = readyService();
  service.browsingStatus.isActive = true;
  service.getCandidateCount = async () => 1;
  service.getSearchResultPageFingerprint = async () => 'unchanged-page';
  service.getCurrentCandidateElement = async () => ({});
  let attempts = 0;
  let nextClicks = 0;
  service.processResumeWithFrontend = async () => { attempts++; return false; };
  service.goToNextPage = async () => { nextClicks++; return true; };

  await service.processSearchResultsSequentially(15);
  assert.equal(attempts, 1);
  assert.equal(nextClicks, 1);
  assert.equal(service.browsingStatus.processedCount, 1);
  assert.equal(service.browsingStatus.collectedCount, 0);
  assert.equal(service.browsingStatus.completionReason, 'no_progress');
});

test('智联结果指纹不可用时，连续无新增也有扫描上限', async () => {
  const service = readyService();
  service.browsingStatus.isActive = true;
  service.getCandidateCount = async () => 1;
  service.getSearchResultPageFingerprint = async () => null;
  service.getCurrentCandidateElement = async () => ({});
  const indices = [];
  let nextClicks = 0;
  service.processResumeWithFrontend = async (_, index) => { indices.push(index); return false; };
  service.goToNextPage = async () => { nextClicks++; return true; };

  await service.processSearchResultsSequentially(15);
  assert.deepEqual(indices, [1, 2, 3, 4, 5]);
  assert.equal(nextClicks, 4);
  assert.equal(service.browsingStatus.processedCount, 5);
  assert.equal(service.browsingStatus.completionReason, 'no_progress');
});

test('智联结束状态保留无新增原因，不误报搜索正常遍历完成', async () => {
  const service = readyService();
  service.browseSearchCandidates = async () => {
    service.browsingStatus.processedCount = 5;
    service.browsingStatus.completionReason = 'no_progress';
  };
  await service.startBrowsing('search', { position: 'IT网络运维' }, 15);
  const status = service.getBrowsingStatus();
  assert.equal(status.processedCount, 5);
  assert.equal(status.collectedCount, 0);
  assert.equal(status.completionReason, 'no_progress');
});

test('智联下一页点击后列表不变，最多点击一次并报告无进展', async () => {
  const service = readyService();
  let clicks = 0;
  let polls = 0;
  const nextButton = {
    getAttribute: async () => null,
    isEnabled: async () => true,
    click: async () => { clicks++; }
  };
  service.page.$ = async () => nextButton;
  service.getSearchResultPageFingerprint = async () => { polls++; return 'same-page'; };
  service.smartRandomDelay = async () => {};
  service.simulateHumanBehavior = async () => {};

  assert.equal(await service.goToNextPage(), false);
  assert.equal(clicks, 1);
  assert.equal(polls, 9);
  assert.equal(service.browsingStatus.completionReason, 'no_progress');
});

test('智联下一页列表确实变化后继续采集', async () => {
  const service = readyService();
  let clicks = 0;
  let polls = 0;
  service.page.$ = async () => ({
    getAttribute: async () => null,
    isEnabled: async () => true,
    click: async () => { clicks++; }
  });
  service.getSearchResultPageFingerprint = async () => ++polls < 3 ? 'old-page' : 'new-page';
  service.smartRandomDelay = async () => {};
  service.simulateHumanBehavior = async () => {};

  assert.equal(await service.goToNextPage(), true);
  assert.equal(clicks, 1);
  assert.equal(polls, 3);
  assert.equal(service.browsingStatus.completionReason, undefined);
});

test('智联潜在人才只把真正新增的在线简历计入采集数', async () => {
  const service = readyService();
  service.browsingStatus.isActive = true;
  service.getCandidateElements = async () => [{ id: 'duplicate' }, { id: 'new' }];
  service.processResumeWithFrontend = async candidate => {
    if (candidate.id === 'duplicate') return false;
    service.browsingStatus.collectedCount++;
    return true;
  };
  await service.processFavoriteCandidates(1);
  assert.equal(service.browsingStatus.collectedCount, 1);
  assert.equal(service.browsingStatus.processedCount, 2);
});

test('智联互动模式附件失败与重复记录不计入采集数', async () => {
  const service = readyService();
  service.browsingStatus.isActive = true;
  service.validateCommunicationPageNavigation = async () => true;
  service.getCommunicationCandidateList = async () => ({});
  service.getCommunicationCandidateCards = async () => [{}, {}, {}];
  service.clickCandidateCard = async () => {};
  const outcomes = [
    { success: false, error: '上传失败' },
    { success: true, created: false, duplicate: true },
    { success: true, created: true }
  ];
  service.processCandidateResume = async () => outcomes.shift();
  await service.processCommunicationCandidates(1);
  assert.equal(service.browsingStatus.collectedCount, 1);
  assert.equal(service.browsingStatus.processedCount, 3);
  assert.equal(service.browsingStatus.failedCount, 1);
});

test('智联附件下载失败时向互动模式传递失败结果', async () => {
  const service = readyService();
  service.checkAttachmentResume = async () => true;
  service.downloadAttachmentResume = async () => ({ success: false, error: '附件上传失败' });
  assert.deepEqual(await service.processCandidateResume(1),
    { success: false, error: '附件上传失败' });
});

test('智联附件上传需确认本地新记录与解析成功才算采集', async t => {
  const service = readyService();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'zhilian-attachment-test-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const resumes = [{ id: 'existing', source: 'zlzp' }];
  service.resumeImportService = {
    store: { getResumes: () => resumes },
    importFile: async () => ({ duplicate: true, resume: resumes[0] })
  };
  service.downloadFileFromURL = async () => {
    const file = path.join(temp, `resume-${Date.now()}-${Math.random()}.pdf`);
    fs.writeFileSync(file, '%PDF-test');
    return file;
  };
  const duplicate = await service.processAttachmentURL('https://rd.zhaopin.com/attachment', service.page);
  assert.equal(duplicate.success, true);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.duplicate, true);

  service.resumeImportService.importFile = async () =>
    ({ duplicate: false, resume: { id: 'missing' } });
  const missing = await service.processAttachmentURL('https://rd.zhaopin.com/attachment', service.page);
  assert.equal(missing.success, false);

  service.resumeImportService.importFile = async () => {
    const resume = { id: 'new', source: 'zlzp' };
    resumes.push(resume);
    return { duplicate: false, resume };
  };
  const created = await service.processAttachmentURL('https://rd.zhaopin.com/attachment', service.page);
  assert.equal(created.success, true);
  assert.equal(created.created, true);
});

test('智联附件下载依据文件头识别 DOCX，拒绝登录 HTML 页面', async () => {
  const service = readyService();
  const body = Buffer.from('PK\x03\x04docx-body', 'latin1');
  const response = buffer => ({
    status: () => 200, statusText: () => 'OK', ok: () => true,
    headers: () => ({ 'content-type': 'application/octet-stream' }),
    body: async () => buffer
  });
  let current = body;
  const page = { context: () => ({ request: { get: async () => response(current) } }) };
  const file = await service.downloadFileFromURL('https://rd.zhaopin.com/attachment', page, 1);
  assert.match(file, /\.docx$/);
  assert.deepEqual(fs.readFileSync(file), body);
  fs.unlinkSync(file);

  current = Buffer.from('<html><body>请重新登录</body></html>');
  assert.equal(await service.downloadFileFromURL('https://rd.zhaopin.com/login', page, 1), null);
});
