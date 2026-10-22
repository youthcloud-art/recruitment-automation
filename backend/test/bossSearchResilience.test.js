const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
process.env.RESUME_STORAGE_ENGINE = 'json';
const BossZhipinService = require('../src/services/bossZhipinService');
const resumeModel = require('../src/models/resumeModel');
const { postCaptureEvaluationQueue } = require('../src/services/postCaptureEvaluationQueue');
const { ActiveJobService } = require('../src/services/activeJobService');

function makeSearchFrame(cards, clicks) {
  return {
    waitForTimeout: async () => {},
    locator: selector => ({
      count: async () => selector === 'li.geek-info-card' ? cards.length : 0,
      nth: index => ({
        get key() { return cards[index]; },
        locator: () => ({ first: () => ({ count: async () => 0 }) }),
        click: async () => { clicks.push(cards[index]); }
      })
    })
  };
}

test('BOSS 登录页不会被 URL 误判为已登录，验证页会暂停采集', async () => {
  const service = new BossZhipinService();
  service.page = {
    url: () => 'https://www.zhipin.com/web/user/?ka=header-login',
    isClosed: () => false
  };
  assert.equal(await service.checkLoginStatus(), false);
  assert.equal(service.currentStatus, 'waiting_login');

  const verifyService = new BossZhipinService();
  verifyService.page = {
    url: () => 'https://www.zhipin.com/web/boss/recommend',
    isClosed: () => false,
    evaluate: async () => ({ verification: true })
  };
  await assert.rejects(verifyService.assertCollectorReady(), error =>
    error.code === 'BOSS_VERIFICATION_REQUIRED');
  assert.equal(verifyService.currentStatus, 'verification_required');
  assert.equal(verifyService.page, null, '安全验证时应断开自动化连接');

  const officialVerify = new BossZhipinService();
  officialVerify.page = {
    url: () => 'https://www.zhipin.com/web/passport/zp/verify.html?code=36',
    isClosed: () => false
  };
  assert.equal(await officialVerify.getRecruitmentPageState(), 'verification_required');
});

test('BOSS 新版搜索菜单仅点击一次，遇官方验证立即停止', async () => {
  const service = new BossZhipinService();
  let clicks = 0;
  let checks = 0;
  service.page = { waitForTimeout: async () => {} };
  service.clickSearchMenuOnce = async () => { clicks++; };
  service.getSearchContext = async () => null;
  service.assertCollectorReady = async () => {
    checks++;
    if (checks > 1) {
      const error = new Error('人工安全验证');
      error.code = 'BOSS_VERIFICATION_REQUIRED';
      throw error;
    }
  };

  await assert.rejects(service.searchCandidates({ position: 'IT网络运维' }, 1),
    error => error.code === 'BOSS_VERIFICATION_REQUIRED');
  assert.equal(clicks, 1);
  assert.equal(checks, 2);
});

test('BOSS 搜索菜单真实点击一次后使用搜索 iframe，不重复导航', async () => {
  const service = new BossZhipinService();
  let clicks = 0;
  let searchOpened = false;
  const frame = { name: 'search-frame' };
  service.page = { waitForTimeout: async () => {} };
  service.clickSearchMenuOnce = async () => {
    clicks++;
    searchOpened = true;
  };
  service.assertCollectorReady = async () => {};
  service.ensureResumeDialogClosed = async () => {};
  service.getSearchContext = async () => searchOpened ? frame : null;
  const used = [];
  service.applyFiltersInIframe = async target => { used.push(['filters', target]); };
  service.executeSearchInIframe = async target => { used.push(['search', target]); };
  service.confirmSubmittedSearch = async target => target;
  service.processSearchResults = async target => { used.push(['results', target]); };

  await service.searchCandidates({ position: 'IT网络运维' }, 1);
  await service.searchCandidates({ position: '网络安全运维' }, 1);
  assert.equal(clicks, 1);
  assert.deepEqual(used.map(([step, target]) => [step, target === frame]), [
    ['filters', true], ['search', true], ['results', true],
    ['filters', true], ['search', true], ['results', true]
  ]);
});

test('BOSS Enter 后搜索 iframe 重绘时只重取一次并核验关键词和结果', async () => {
  const service = new BossZhipinService();
  let detached = false;
  const searchFrame = (name, value) => ({
    name,
    isDetached: () => name === 'old' && detached,
    locator: () => ({ first: () => ({
      isVisible: async () => true,
      inputValue: async () => value
    }) }),
    evaluate: async () => ({ cards: 3, empty: false, loading: false })
  });
  const oldFrame = searchFrame('old', 'IT网络运维');
  const newFrame = searchFrame('new', '成本核算经理');
  service.page = { waitForTimeout: async () => {} };
  service.assertCollectorReady = async () => {};
  let reacquisitions = 0;
  service.getSearchContext = async () => { reacquisitions++; return newFrame; };
  detached = true;
  const result = await service.confirmSubmittedSearch(oldFrame, '成本核算经理',
    { used: false });
  assert.equal(result, newFrame);
  assert.equal(reacquisitions, 1);
});

test('BOSS 搜索框关键词或结果状态未确认时停止，不能沿用旧列表', async () => {
  const service = new BossZhipinService();
  service.page = { waitForTimeout: async () => {} };
  service.assertCollectorReady = async () => {};
  const frame = value => ({
    locator: () => ({ first: () => ({
      isVisible: async () => true,
      inputValue: async () => value
    }) }),
    evaluate: async () => ({ cards: 0, empty: false, loading: false })
  });
  await assert.rejects(service.confirmSubmittedSearch(frame('IT网络运维'),
    '成本核算经理'), error => error.code === 'BOSS_SEARCH_KEYWORD_MISMATCH');
  await assert.rejects(service.confirmSubmittedSearch(frame('成本核算经理'),
    '成本核算经理'), error => error.code === 'BOSS_SEARCH_STATE_UNCONFIRMED');
  assert.equal(service.currentStatus, 'page_unavailable');
});

test('BOSS 卡片重排后按 data-expect 重新定位原候选人再打开', async () => {
  const service = new BossZhipinService();
  const cards = ['expect-a', 'expect-b'];
  const clicked = [];
  const cardFor = readKey => ({
    get key() { return readKey(); },
    locator: () => ({ first: () => ({ count: async () => 0 }) }),
    click: async () => { clicked.push(readKey()); }
  });
  const frame = {
    waitForTimeout: async () => {},
    locator: selector => selector === 'li.geek-info-card'
      ? { count: async () => cards.length, nth: index => cardFor(() => cards[index]) }
      : { count: async () => selector.includes('expect-a') ? 1 : 0,
        first: () => cardFor(() => 'expect-a') }
  };
  service.browsingStatus.isActive = true;
  service.assertCollectorReady = async () => {};
  service.ensureResumeDialogClosed = async () => {};
  let identityReads = 0;
  service.getSearchCardIdentity = async card => {
    const key = card.key;
    if (++identityReads === 1) cards.splice(0, 2, 'expect-b', 'expect-a');
    return { key: `id:${key}`, candidateId: key };
  };
  const savedIds = [];
  service.extractAndImportResume = async (_frame, _index, id) => {
    savedIds.push(id);
    return { id };
  };
  service.closeResumeAndReturnToList = async () => {};
  await service.processSearchResults(frame, 1);
  assert.deepEqual(clicked, ['expect-a']);
  assert.deepEqual(savedIds, ['expect-a']);
});

test('BOSS 卡片重排且原身份消失时暂停，不保存其他人的简历', async () => {
  const service = new BossZhipinService();
  let current = 'expect-a';
  let clicked = false;
  const card = {
    get key() { return current; },
    locator: () => ({ first: () => ({ count: async () => 0 }) }),
    click: async () => { clicked = true; }
  };
  const frame = {
    waitForTimeout: async () => {},
    locator: selector => selector === 'li.geek-info-card'
      ? { count: async () => 1, nth: () => card }
      : { count: async () => 0 }
  };
  service.browsingStatus.isActive = true;
  service.assertCollectorReady = async () => {};
  service.ensureResumeDialogClosed = async () => {};
  let reads = 0;
  service.getSearchCardIdentity = async c => {
    const key = c.key;
    if (++reads === 1) current = 'expect-b';
    return { key: `id:${key}`, candidateId: key };
  };
  service.extractAndImportResume = async () => { throw new Error('不得入库'); };
  await assert.rejects(service.processSearchResults(frame, 1), error =>
    error.code === 'BOSS_CARD_IDENTITY_CHANGED');
  assert.equal(clicked, false);
  assert.equal(service.currentStatus, 'unstable_page');
});

test('BOSS 推荐 iframe 不会被错认成搜索 iframe', async () => {
  const service = new BossZhipinService();
  let checkedRecommendContent = false;
  service.page = {
    $: async () => null,
    $$: async () => [{
      getAttribute: async () => '/web/frame/recommend/?jobid=null&filterParams=search',
      contentFrame: async () => {
        checkedRecommendContent = true;
        return {};
      }
    }]
  };
  assert.equal(await service.getSearchIframe(), null);
  assert.equal(checkedRecommendContent, false);
});

test('BOSS 只接受带可见输入框的搜索容器 iframe', async () => {
  const service = new BossZhipinService();
  const frame = {
    locator: () => ({ first: () => ({ isVisible: async () => true }) })
  };
  service.page = {
    $: async () => ({
      getAttribute: async () => '/web/frame/search/',
      contentFrame: async () => frame
    }),
    $$: async () => []
  };
  assert.equal(await service.getSearchIframe(), frame);
  service.page.$ = async () => ({
    getAttribute: async () => '/web/frame/recommend/?filterParams=search',
    contentFrame: async () => frame
  });
  assert.equal(await service.getSearchIframe(), null);
});

test('BOSS 主文档搜索页有可见搜索框时可直接采集', async () => {
  const service = new BossZhipinService();
  service.getSearchIframe = async () => null;
  const page = {
    url: () => 'https://www.zhipin.com/web/chat/search',
    locator: selector => ({ first: () => ({
      isVisible: async () => selector !== '#searchContent'
    }) })
  };
  service.page = page;
  assert.equal(await service.getSearchContext(), page);
  service.page.url = () => 'https://www.zhipin.com/web/chat/recommend';
  assert.equal(await service.getSearchContext(), null);
});

test('BOSS 搜索菜单未打开搜索视图时单次失败并保留浏览器', async () => {
  const service = new BossZhipinService();
  let clicks = 0;
  let polls = 0;
  service.page = { waitForTimeout: async () => {} };
  service.clickSearchMenuOnce = async () => { clicks++; };
  service.assertCollectorReady = async () => {};
  service.getSearchContext = async () => { polls++; return null; };
  await assert.rejects(service.searchCandidates({ position: 'IT网络运维' }, 1), error =>
    error.code === 'BOSS_SEARCH_PAGE_UNAVAILABLE' && /搜索输入框/.test(error.message));
  assert.equal(clicks, 1);
  assert.equal(polls, 9);
  assert.equal(service.currentStatus, 'page_unavailable');
});

test('BOSS 搜索菜单被弹窗挡住时不尝试第二个关键词', async () => {
  const service = new BossZhipinService();
  let clicks = 0;
  service.page = {};
  service.clickSearchMenuOnce = async () => { clicks++; throw new Error('intercepted'); };
  service.assertCollectorReady = async () => {};
  service.getSearchContext = async () => null;
  await assert.rejects(service.searchCandidates({ position: 'IT网络运维' }, 1), error =>
    error.code === 'BOSS_SEARCH_MENU_UNAVAILABLE' && /不可点击/.test(error.message));
  assert.equal(clicks, 1);
  assert.equal(service.currentStatus, 'page_unavailable');
});

test('BOSS 无已保存会话时直接打开登录页一次，保留页面供人工验证', async () => {
  const service = new BossZhipinService();
  let opens = 0;
  service.openBossLoginWindow = async () => {
    opens++;
    return { tabs: [{
      url: 'https://www.zhipin.com/web/user/?ka=header-login',
      title: 'BOSS直聘注册登录'
    }] };
  };
  await service.initializeFullProcess();
  await service.initializeFullProcess();
  assert.equal(opens, 2, '重复启动只检查同一个 Chrome 窗口，不再导航页面');
  assert.equal(service.currentStatus, 'waiting_login');
  assert.equal(service.isLoggedIn, false);
});

test('BOSS 空白 Chrome 窗口不会被报告为登录页已打开', async () => {
  const service = new BossZhipinService();
  service.openBossLoginWindow = async () => ({ tabs: [{ url: 'about:blank', title: '' }] });
  await assert.rejects(service.initializeFullProcess(), /登录页未正常显示/);
});

test('BOSS 滚动结果卡片数保持不变时仍处理新卡片并按身份去重', async () => {
  const service = new BossZhipinService();
  const cards = ['a', 'b'];
  const clicks = [];
  const frame = makeSearchFrame(cards, clicks);
  service.browsingStatus.isActive = true;
  service.assertCollectorReady = async () => {};
  service.ensureResumeDialogClosed = async () => {};
  service.getSearchCardIdentity = async card => ({ key: card.key, candidateId: card.key });
  service.extractAndImportResume = async (_frame, _index, id) => ({ id });
  service.closeResumeAndReturnToList = async () => {};
  let scrolls = 0;
  service.scrollSearchResults = async () => {
    scrolls++;
    cards.splice(0, cards.length, ...(scrolls === 1 ? ['b', 'c'] : ['c', 'd']));
  };

  await service.processSearchResults(frame, 4);
  assert.deepEqual(clicks, ['a', 'b', 'c', 'd']);
  assert.equal(service.browsingStatus.processedCount, 4);
  assert.equal(scrolls, 2);
});

test('BOSS 前一个关键词有足够新简历时直接补足总目标', async () => {
  const service = new BossZhipinService();
  service.browser = {};
  service.page = {};
  service.checkLoginStatus = async () => true;
  service.browsingStatus.isActive = true;
  service.browsingStatus.processedCount = 0;
  service.browsingStatus.keywordErrors = [];
  service.browsingStatus.keywordsCompleted = 0;
  const calls = [];
  service.searchCandidates = async (filters, count) => {
    calls.push({ keyword: filters.position, count });
    if (filters.position === '成本核算经理') {
      service.browsingStatus.processedCount += Math.min(3, count);
    }
  };

  await service.executeBrowsingTask('search',
    { position: '成本核算经理，财务经理' }, 3);
  assert.deepEqual(calls, [{ keyword: '成本核算经理', count: 3 }]);
  assert.equal(service.browsingStatus.processedCount, 3);
  assert.equal(service.browsingStatus.completionReason, '已达到目标新增简历份数');
});

test('BOSS 推荐 iframe 只在岗位核验后入库，只有 created 才增加进度', async () => {
  const service = new BossZhipinService();
  const cards = ['already-saved', 'new-candidate'];
  let opened = '';
  const frame = makeSearchFrame(cards, []);
  frame.locator = selector => ({
    count: async () => selector === 'li.card-item' ? cards.length : 0,
    nth: index => ({
      get key() { return cards[index]; },
      locator: () => ({ first: () => ({ count: async () => 0 }) }),
      click: async () => { opened = cards[index]; }
    })
  });
  frame.isDetached = () => false;
  frame.url = () => 'https://www.zhipin.com/web/frame/recommend/?jobid=job-1';
  const page = {};
  page.url = () => 'https://www.zhipin.com/web/boss/recommend';
  frame.page = () => page;
  service.page = page;
  service.browsingStatus.isActive = true;
  service.assertCollectorReady = async () => {};
  service.assertRecommendedJob = async (_frame, title, jobId) => {
    assert.equal(_frame, frame);
    assert.equal(title, '成本核算经理');
    assert.equal(jobId, 'job-1');
  };
  service.ensureResumeDialogClosed = async () => {};
  service.getSearchCardIdentity = async card => ({ key: card.key, candidateId: card.key });
  service.findResumeIframe = async () => null;
  service.extractResumeContentFromPage = async () =>
    `姓名：${opened}。工作经历：负责招聘岗位对应的专业工作。`.repeat(5);
  service.closeResumeAndReturnToList = async () => {};
  service.scrollSearchResults = async () => {};
  service.uploadResumeToApp = async () => { throw new Error('不得模拟本地网页上传'); };
  const saves = [];
  service.saveResumeToDatabase = async (candidate, _content, _score, options) => {
    saves.push({ id: candidate.sourceCandidateId, returnStatus: options.returnStatus });
    return { resume: { id: candidate.sourceCandidateId },
      created: candidate.sourceCandidateId === 'new-candidate' };
  };

  await service.browseRecommendedCandidateList(1, frame,
    { title: '成本核算经理', jobId: 'job-1' });
  assert.deepEqual(saves, [
    { id: 'already-saved', returnStatus: true },
    { id: 'new-candidate', returnStatus: true }
  ]);
  assert.equal(service.browsingStatus.processedCount, 1);
});

test('BOSS 搜索连续无新卡片时有界结束', async () => {
  const service = new BossZhipinService();
  const cards = ['a'];
  const frame = makeSearchFrame(cards, []);
  service.browsingStatus.isActive = true;
  service.assertCollectorReady = async () => {};
  service.ensureResumeDialogClosed = async () => {};
  service.getSearchCardIdentity = async card => ({ key: card.key, candidateId: card.key });
  service.extractAndImportResume = async () => null;
  service.closeResumeAndReturnToList = async () => {};
  let scrolls = 0;
  service.scrollSearchResults = async () => { scrolls++; };

  await service.processSearchResults(frame, 10);
  assert.equal(scrolls, 3);
  assert.equal(service.browsingStatus.processedCount, 0);
});

test('BOSS 卡片身份不断变化但简历无新增时停止当前关键词滚动', async () => {
  const service = new BossZhipinService();
  const cards = ['changing-0'];
  const clicks = [];
  const frame = makeSearchFrame(cards, clicks);
  service.browsingStatus.isActive = true;
  service.browsingStatus.currentKeyword = 'IT网络运维';
  service.assertCollectorReady = async () => {};
  service.ensureResumeDialogClosed = async () => {};
  service.getSearchCardIdentity = async card => ({ key: card.key, candidateId: card.key });
  service.extractAndImportResume = async () => null;
  service.closeResumeAndReturnToList = async () => {};
  let scrolls = 0;
  service.scrollSearchResults = async () => {
    scrolls++;
    cards[0] = `changing-${scrolls}`;
  };

  await service.processSearchResults(frame, 1);
  assert.equal(service.browsingStatus.processedCount, 0);
  assert.equal(clicks.length, 12);
  assert.equal(scrolls, 11);
  assert.deepEqual(service.browsingStatus.stalledKeywords, ['IT网络运维']);
});

test('BOSS 单张卡片的暂时提取失败最多重试一次', async () => {
  const service = new BossZhipinService();
  const cards = ['a'];
  const clicks = [];
  const frame = makeSearchFrame(cards, clicks);
  service.browsingStatus.isActive = true;
  service.assertCollectorReady = async () => {};
  service.ensureResumeDialogClosed = async () => {};
  service.getSearchCardIdentity = async card => ({ key: card.key, candidateId: card.key });
  service.closeResumeAndReturnToList = async () => {};
  service.scrollSearchResults = async () => {};
  let attempts = 0;
  service.extractAndImportResume = async () => {
    attempts++;
    if (attempts === 1) throw new Error('页面短暂重绘');
    return { id: 'resume-a' };
  };

  await service.processSearchResults(frame, 1);
  assert.equal(attempts, 2);
  assert.deepEqual(clicks, ['a', 'a']);
  assert.equal(service.browsingStatus.processedCount, 1);
});

test('BOSS 停止采集后不再保存正在提取的简历', async () => {
  const service = new BossZhipinService();
  const page = { url: () => 'https://www.zhipin.com/web/boss/recommend' };
  service.page = page;
  service.browsingStatus.isActive = true;
  service.findResumeIframe = async () => null;
  service.extractResumeContentFromPage = async () => '候选人有效简历内容'.repeat(20);
  service.saveResumeToDatabase = async () => { throw new Error('停止后不应入库'); };
  const frame = { page: () => page, waitForTimeout: async () => {} };
  await service.stopBrowsing();
  assert.equal(await service.extractAndImportResume(frame, 1), false);
  assert.equal(service.browsingStatus.completionReason, '用户已停止采集');
});

test('BOSS 相同平台候选人 ID 去重，但不同 ID 不因相同 OCR 文本误合并', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-dedup-test-'));
  const oldFile = resumeModel.dbFile;
  resumeModel.dbFile = path.join(directory, 'resumes.json');
  fs.writeJsonSync(resumeModel.dbFile, { resumes: [], positions: [], categories: [] });
  const service = new BossZhipinService();
  service.page = { url: () => 'https://www.zhipin.com/web/boss/recommend' };
  const content = '姓名：张某。 工作经历：负责财务核算、成本分析和年度预算，熟练使用企业管理系统。 教育经历：财经大学会计专业本科。 '.repeat(4);
  try {
    const first = await service.saveResumeToDatabase({ sourceCandidateId: 'expect-1' }, content);
    const sameId = await service.saveResumeToDatabase({ sourceCandidateId: 'expect-1' }, `${content} 新增经历`);
    const sameContent = await service.saveResumeToDatabase({ sourceCandidateId: 'expect-2' }, content.replace(/。 /g, '。    '));
    assert.equal(first.id, sameId.id);
    assert.notEqual(first.id, sameContent.id);
    assert.equal(fs.readJsonSync(resumeModel.dbFile).resumes.length, 2);
  } finally {
    resumeModel.dbFile = oldFile;
    resumeModel.clearRelatedCache();
    fs.removeSync(directory);
  }
});

test('BOSS 仅将新入库简历加入当前岗位的自动评估队列', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-eval-test-'));
  const oldFile = resumeModel.dbFile;
  const oldEnqueue = postCaptureEvaluationQueue.enqueue;
  resumeModel.dbFile = path.join(directory, 'resumes.json');
  fs.writeJsonSync(resumeModel.dbFile, { resumes: [], positions: [], categories: [] });
  const service = new BossZhipinService();
  service.page = { url: () => 'https://www.zhipin.com/web/boss/recommend' };
  service.activeJobSnapshot = { title: '成本核算经理', jobRequirements: '至少五年成本核算经验' };
  const calls = [];
  postCaptureEvaluationQueue.enqueue = (resume, job) => { calls.push({ resume, job }); return { queued: true }; };
  const content = '姓名：候选人。工作经历：五年成本核算、制造业财务分析、预算管理和财务团队管理。教育经历：财经大学会计专业本科。'.repeat(4);
  try {
    const first = await service.saveResumeToDatabase(
      { sourceCandidateId: 'expect-77' }, content, undefined, { returnStatus: true });
    const duplicate = await service.saveResumeToDatabase(
      { sourceCandidateId: 'expect-77' }, content, undefined, { returnStatus: true });
    assert.equal(first.created, true);
    assert.equal(duplicate.created, false);
    assert.equal(first.resume.id, duplicate.resume.id);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].resume.id, first.resume.id);
    assert.equal(calls[0].job.title, '成本核算经理');
  } finally {
    postCaptureEvaluationQueue.enqueue = oldEnqueue;
    resumeModel.dbFile = oldFile;
    resumeModel.clearRelatedCache();
    fs.removeSync(directory);
  }
});

test('BOSS 独立收藏简历任务会刷新岗位快照，且不能覆盖正在采集的任务', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-task-test-'));
  const oldCurrent = ActiveJobService.prototype.current;
  let job = { title: '成本核算经理', jobRequirements: '五年以上成本核算经历' };
  ActiveJobService.prototype.current = () => ({ ...job });
  const service = new BossZhipinService();
  service.collectionCheckpoint.file = path.join(directory, 'checkpoint.json');
  service.executeBrowsingTask = async () => {};
  service.executeResumeProcessingTask = async () => {};
  try {
    await service.startBrowsing('search', { position: '成本核算经理' }, 1);
    assert.equal(service.activeJobSnapshot.title, '成本核算经理');
    job = { title: '财务总监', jobRequirements: '十年以上财务管理经历' };
    await assert.rejects(service.startResumeProcessing(), /已有采集或简历处理任务/);
    assert.equal(service.activeJobSnapshot.title, '成本核算经理');
    assert.equal(service.browsingStatus.isActive, true);

    await service.stopBrowsing();
    await service.startResumeProcessing();
    assert.equal(service.activeJobSnapshot.title, '财务总监');
    assert.equal(service.resumeProcessingStatus.isActive, true);
  } finally {
    ActiveJobService.prototype.current = oldCurrent;
    fs.removeSync(directory);
  }
});
