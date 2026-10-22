const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const BossZhipinService = require('../src/services/bossZhipinService');
const { BossCollectionCheckpoint, taskSignature } =
  require('../src/services/bossCollectionCheckpoint');
const { ActiveJobService } = require('../src/services/activeJobService');

function tempCheckpoint(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-checkpoint-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return new BossCollectionCheckpoint(path.join(directory, 'checkpoint.json'));
}

test('BOSS checkpoint is atomic, scoped to job criteria and rejects corruption', t => {
  const store = tempCheckpoint(t);
  const job = { title: 'IT网络运维', jobRequirements: '交换机、防火墙与 Linux 运维' };
  const signature = taskSignature({ mode: 'search', filters: { position: 'IT运维', city: '北京' },
    targetCount: 20, job });
  assert.equal(signature, taskSignature({ mode: 'search',
    filters: { city: '北京', position: 'IT运维' }, targetCount: 20, job }));
  assert.notEqual(signature, taskSignature({ mode: 'search',
    filters: { city: '北京', position: 'IT运维' }, targetCount: 20,
    job: { ...job, jobRequirements: '仅桌面支持' } }));
  store.save({ signature, state: 'paused', mode: 'search', filters: { position: 'IT运维' },
    targetCount: 20, processedCount: 7, nextKeywordIndex: 1 });
  assert.equal(store.load().processedCount, 7);
  assert.deepEqual(fs.readdirSync(path.dirname(store.file)), ['checkpoint.json']);
  fs.writeFileSync(store.file, '{invalid');
  assert.throws(() => store.load(), /无法读取/);
});

test('BOSS only resumes the exact interrupted job and retains previous count', async t => {
  const store = tempCheckpoint(t);
  const oldCurrent = ActiveJobService.prototype.current;
  let job = { title: 'IT网络运维', jobRequirements: '交换机、防火墙与 Linux 运维' };
  ActiveJobService.prototype.current = () => ({ ...job });
  t.after(() => { ActiveJobService.prototype.current = oldCurrent; });
  const filters = { position: 'IT网络运维，网络工程师' };
  const first = new BossZhipinService();
  first.collectionCheckpoint = store;
  first.executeBrowsingTask = async () => {};
  await first.startBrowsing('search', filters, 20);
  first.browsingStatus.processedCount = 7;
  first.browsingStatus.nextKeywordIndex = 1;
  first.browsingStatus.isActive = false;
  first.saveCollectionProgress('paused');

  const restarted = new BossZhipinService();
  restarted.collectionCheckpoint = store;
  restarted.executeBrowsingTask = async () => {};
  assert.equal(restarted.getBrowsingStatus().resumeAvailable, true);
  assert.equal(restarted.getBrowsingStatus().processedCount, 7);
  await restarted.startBrowsing('search', filters, 20, { resume: true });
  assert.equal(restarted.browsingStatus.processedCount, 7);
  assert.equal(restarted.browsingStatus.nextKeywordIndex, 1);

  const changed = new BossZhipinService();
  changed.collectionCheckpoint = store;
  changed.executeBrowsingTask = async () => {};
  job = { ...job, jobRequirements: '仅桌面支持' };
  await assert.rejects(changed.startBrowsing('search', filters, 20, { resume: true }),
    /不一致/);
  assert.equal(store.load().processedCount, 7);
});

test('BOSS virtual scrolling identity does not depend on the current row index', async () => {
  const service = new BossZhipinService();
  const card = {
    getAttribute: async () => null,
    locator: () => ({ first: () => ({ getAttribute: async () => null }) }),
    innerText: async () => '五年网络运维，熟悉防火墙和交换机'
  };
  const first = await service.getSearchCardIdentity(card, 0);
  const shifted = await service.getSearchCardIdentity(card, 47);
  assert.equal(first.key, shifted.key);
  assert.equal(first.candidateId, '');
});

test('BOSS search submit failure is reported instead of silently collecting old results', async () => {
  const service = new BossZhipinService();
  const frame = { $: async () => null };
  await assert.rejects(service.executeSearchInIframe(frame), /搜索未提交/);
});

test('BOSS reuses the open search frame across keywords without resetting the page', async () => {
  const service = new BossZhipinService();
  const calls = [];
  const frame = { locator: () => ({ first: () => ({ isVisible: async () => true }) }) };
  service.page = { click: async () => { throw new Error('不应重新点击搜索菜单'); } };
  service.getSearchIframe = async () => frame;
  service.assertCollectorReady = async () => {};
  service.ensureResumeDialogClosed = async () => {};
  service.applyFiltersInIframe = async (_frame, filters) => calls.push(filters.position);
  service.executeSearchInIframe = async () => {};
  service.confirmSubmittedSearch = async target => target;
  service.processSearchResults = async () => {};
  await service.searchCandidates({ position: '网络工程师' }, 3);
  assert.deepEqual(calls, ['网络工程师']);
});

test('BOSS rate-limit state pauses without attempting to bypass verification', async () => {
  const service = new BossZhipinService();
  service.getRecruitmentPageState = async () => 'rate_limited';
  await assert.rejects(service.assertCollectorReady(), error =>
    error.code === 'BOSS_RATE_LIMITED');
  assert.equal(service.currentStatus, 'rate_limited');
});

test('BOSS storage-full error stops collection instead of silently skipping the candidate', async () => {
  const service = new BossZhipinService();
  service.browsingStatus.isActive = true;
  service.page = { url: () => 'https://www.zhipin.com/web/boss/recommend' };
  service.assertCollectorReady = async () => {};
  service.ensureResumeDialogClosed = async () => {};
  service.getSearchCardIdentity = async () => ({ key: 'id:123', candidateId: '123' });
  service.extractAndImportResume = async () => {
    const error = new Error('disk full');
    error.code = 'ENOSPC';
    throw error;
  };
  const frame = {
    locator: selector => ({ count: async () => selector === 'li.geek-info-card' ? 1 : 0,
      nth: () => ({
      locator: () => ({ first: () => ({ count: async () => 0 }) }),
      click: async () => {}
    }) }),
    waitForTimeout: async () => {}
  };
  service.page = { ...service.page, ...frame };
  await assert.rejects(service.processSearchResults(service.page, 1), error =>
    error.code === 'BOSS_STORAGE_ERROR');
});

test('BOSS cannot start a second collection while the stopped worker is still exiting', async t => {
  const store = tempCheckpoint(t);
  const oldCurrent = ActiveJobService.prototype.current;
  ActiveJobService.prototype.current = () => ({
    title: 'IT网络运维', jobRequirements: '交换机与 Linux 运维'
  });
  t.after(() => { ActiveJobService.prototype.current = oldCurrent; });
  const service = new BossZhipinService();
  service.collectionCheckpoint = store;
  let release;
  service.executeBrowsingTask = () => new Promise(resolve => { release = resolve; });
  await service.startBrowsing('recommended', {}, 2);
  await service.stopBrowsing();
  await assert.rejects(service.startBrowsing('recommended', {}, 2), /仍在退出中/);
  release();
  await new Promise(resolve => setImmediate(resolve));
  service.executeBrowsingTask = async () => {};
  await service.startBrowsing('recommended', {}, 2, { resume: true });
  assert.equal(service.browsingStatus.processedCount, 0);
});
