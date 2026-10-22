const test = require('node:test');
const assert = require('node:assert/strict');
const BossZhipinService = require('../src/services/bossZhipinService');

function deferred() {
  let resolve;
  const promise = new Promise(complete => { resolve = complete; });
  return { promise, resolve };
}

function searchFrame(events) {
  const card = {
    locator: () => ({ first: () => ({ count: async () => 0 }) }),
    click: async () => { events.push('open'); }
  };
  return {
    waitForTimeout: async () => {},
    locator: selector => ({
      count: async () => selector === 'li.geek-info-card' ? 1 : 0,
      nth: () => card
    })
  };
}

test('single BOSS candidate deadline pauses collection, detaches CDP and blocks late save/close', async () => {
  const service = new BossZhipinService();
  const events = [];
  const pending = deferred();
  const started = deferred();
  const frame = searchFrame(events);
  service.candidateExtractionTimeoutMs = 25;
  service.browsingStatus.isActive = true;
  service.browsingStatus.startTime = new Date().toISOString();
  service.page = { url: () => 'https://www.zhipin.com/web/chat/search' };
  service.assertCollectorReady = async () => {};
  service.ensureResumeDialogClosed = async () => {};
  service.getSearchCardIdentity = async () => ({ key: 'candidate', candidateId: 'candidate' });
  service.extractAndImportResume = async () => { started.resolve(); return pending.promise; };
  service.closeResumeAndReturnToList = async () => { events.push('close'); };
  service.detachAutomation = async options => {
    events.push(`detach:${options.status}`);
    service.page = null;
    service.currentStatus = options.status;
    service.attachSuspended = options.suspend;
  };

  const run = service.processSearchResults(frame, 1);
  await started.promise;
  await new Promise(resolve => setTimeout(resolve, 60));
  const status = service.getBrowsingStatus();
  assert.equal(status.isActive, false);
  assert.equal(status.status, 'candidate_timeout');
  assert.equal(status.currentPhase, 'candidate_timeout');
  assert.equal(status.attemptedCount, 1);
  assert.equal(status.lastFailureCode, 'BOSS_CANDIDATE_TIMEOUT');
  assert.ok(events.includes('detach:candidate_timeout'));

  pending.resolve({ id: 'late-result' });
  await assert.rejects(run, error => error.code === 'BOSS_CANDIDATE_TIMEOUT');
  assert.equal(service.browsingStatus.processedCount, 0);
  assert.equal(events.includes('close'), false);
});

test('stopping BOSS while a candidate is pending cancels the attempt without a later close', async () => {
  const service = new BossZhipinService();
  const events = [];
  const pending = deferred();
  const started = deferred();
  const frame = searchFrame(events);
  service.candidateExtractionTimeoutMs = 1000;
  service.browsingStatus.isActive = true;
  service.browsingStatus.startTime = new Date().toISOString();
  service.page = { url: () => 'https://www.zhipin.com/web/chat/search' };
  service.assertCollectorReady = async () => {};
  service.ensureResumeDialogClosed = async () => {};
  service.getSearchCardIdentity = async () => ({ key: 'candidate', candidateId: 'candidate' });
  service.extractAndImportResume = async () => { started.resolve(); return pending.promise; };
  service.closeResumeAndReturnToList = async () => { events.push('close'); };
  service.detachAutomation = async options => {
    events.push(`detach:${options.status}`);
    service.page = null;
    service.currentStatus = options.status;
  };
  const run = service.processSearchResults(frame, 1);
  await started.promise;
  await service.stopBrowsing();
  pending.resolve({ id: 'late-result' });
  await assert.rejects(run, error => error.code === 'BOSS_CANDIDATE_CANCELLED');
  assert.equal(service.browsingStatus.processedCount, 0);
  assert.deepEqual(events.filter(event => event.startsWith('detach:')), ['detach:idle']);
  assert.equal(events.includes('close'), false);
});

test('cancelled BOSS frame lookup cannot fall through to text extraction or persistence', async () => {
  const service = new BossZhipinService();
  const pending = deferred();
  const started = deferred();
  service.candidateExtractionTimeoutMs = 1000;
  service.browsingStatus.isActive = true;
  const attempt = service.beginCandidateAttempt(1);
  service.page = {};
  const frame = { waitForTimeout: async () => {}, page: () => ({}) };
  service.findResumeIframe = async () => { started.resolve(); return pending.promise; };
  let extracted = false;
  let saved = false;
  service.extractResumeContentFromPage = async () => { extracted = true; return 'resume'; };
  service.saveResumeToDatabase = async () => { saved = true; return { created: true }; };
  const run = service.extractAndImportResume(frame, 1);
  await started.promise;
  attempt.cancelled = true;
  attempt.controller.abort();
  pending.resolve(null);
  await assert.rejects(run, error => error.code === 'BOSS_CANDIDATE_CANCELLED');
  service.finishCandidateAttempt(attempt);
  assert.equal(extracted, false);
  assert.equal(saved, false);
});
