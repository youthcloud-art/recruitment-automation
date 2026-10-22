const test = require('node:test');
const assert = require('node:assert/strict');
const BossZhipinService = require('../src/services/bossZhipinService');

function dialogPage(events, { src = '/web/frame/c-resume/?expectId=123',
  closes = true, hasClose = true } = {}) {
  let active = true;
  const dialog = {
    isVisible: async () => active,
    locator: selector => {
      if (selector === 'iframe') return { first: () => ({
        getAttribute: async () => src
      }) };
      assert.equal(selector, '.close-btn');
      return { first: () => ({
        isVisible: async () => hasClose,
        click: async options => {
          assert.equal(options.timeout, 3000);
          events.push('close');
          if (closes) active = false;
        }
      }) };
    },
    waitFor: async options => {
      assert.equal(options.state, 'hidden');
      if (active) throw new Error('dialog still visible');
    }
  };
  return {
    url: () => 'https://www.zhipin.com/web/chat/search',
    locator: selector => {
      assert.equal(selector, 'div[data-type="boss-dialog"].active');
      return { first: () => dialog };
    },
    get active() { return active; }
  };
}

test('BOSS resumed search closes only official active resume dialog before card click', async () => {
  const service = new BossZhipinService();
  const events = [];
  const page = dialogPage(events);
  service.page = page;
  service.browsingStatus.isActive = true;
  service.assertCollectorReady = async () => { events.push('ready'); };
  const card = {
    locator: () => ({ first: () => ({ count: async () => 0 }) }),
    click: async () => {
      assert.equal(page.active, false, 'card must not be clicked through the overlay');
      events.push('card');
    }
  };
  const frame = {
    waitForTimeout: async () => {},
    locator: selector => ({
      count: async () => selector === 'li.geek-info-card' ? 1 : 0,
      nth: () => card
    })
  };
  service.getSearchCardIdentity = async () => ({ key: 'id:123', candidateId: '123' });
  service.extractAndImportResume = async () => ({ id: 'resume-123' });
  service.scrollSearchResults = async () => {};
  await service.processSearchResults(frame, 1);
  assert.equal(service.browsingStatus.processedCount, 1);
  assert.ok(events.indexOf('ready') < events.indexOf('close'));
  assert.ok(events.indexOf('close') < events.indexOf('card'));
});

test('BOSS does not dismiss verification or unknown active dialog', async () => {
  for (const [src, code] of [
    ['/web/passport/zp/verify.html', 'BOSS_VERIFICATION_REQUIRED'],
    ['/web/frame/other-dialog/', 'BOSS_RESUME_DIALOG_BLOCKED']
  ]) {
    const events = [];
    const service = new BossZhipinService();
    service.page = dialogPage(events, { src });
    service.assertCollectorReady = async () => { events.push('ready'); };
    await assert.rejects(service.ensureResumeDialogClosed(), error => error.code === code);
    assert.equal(events.includes('close'), false);
    assert.equal(service.currentStatus,
      code === 'BOSS_VERIFICATION_REQUIRED' ? 'verification_required' : 'page_unavailable');
  }
});

test('BOSS refuses to continue when official dialog cannot be verified closed', async () => {
  const service = new BossZhipinService();
  const events = [];
  service.page = dialogPage(events, { closes: false });
  service.assertCollectorReady = async () => {};
  await assert.rejects(service.ensureResumeDialogClosed(), error =>
    error.code === 'BOSS_RESUME_DIALOG_BLOCKED');
  assert.deepEqual(events, ['close']);
  assert.equal(service.currentStatus, 'page_unavailable');
});

test('BOSS candidate timeout during dialog close leaves checkpoint paused', async () => {
  const service = new BossZhipinService();
  service.candidateExtractionTimeoutMs = 15;
  service.browsingStatus.isActive = true;
  service.browsingStatus.startTime = new Date().toISOString();
  service.page = { url: () => 'https://www.zhipin.com/web/chat/search' };
  service.assertCollectorReady = async () => {};
  service.ensureResumeDialogClosed = async () => {};
  service.getSearchCardIdentity = async () => ({ key: 'id:1', candidateId: '1' });
  service.extractAndImportResume = async () => ({ id: 'resume-1' });
  service.closeResumeAndReturnToList = async () =>
    new Promise(resolve => setTimeout(resolve, 35));
  service.detachAutomation = async options => {
    service.page = null;
    service.currentStatus = options.status;
  };
  const states = [];
  service.saveCollectionProgress = state => { states.push(state); };
  const card = {
    locator: () => ({ first: () => ({ count: async () => 0 }) }),
    click: async () => {}
  };
  const frame = {
    waitForTimeout: async () => {},
    locator: selector => ({
      count: async () => selector === 'li.geek-info-card' ? 1 : 0,
      nth: () => card
    })
  };
  await assert.rejects(service.processSearchResults(frame, 1), error =>
    error.code === 'BOSS_CANDIDATE_TIMEOUT');
  assert.equal(service.browsingStatus.processedCount, 1, 'saved resume remains counted');
  assert.equal(service.currentStatus, 'candidate_timeout');
  assert.equal(states.at(-1), 'paused');
  assert.equal(states.includes('completed'), false);
});

test('BOSS outer task never completes a candidate timeout checkpoint', async () => {
  const service = new BossZhipinService();
  service.browser = {};
  service.page = {};
  service.browsingStatus.isActive = true;
  service.browsingStatus.filters = { position: 'IT网络运维' };
  service.browsingStatus.targetCount = 1;
  service.browsingStatus.keywordErrors = [];
  service.browsingStatus.keywordsCompleted = 0;
  service.checkLoginStatus = async () => true;
  service.searchCandidates = async () => {
    service.currentStatus = 'candidate_timeout';
    service.browsingStatus.lastFailureCode = 'BOSS_CANDIDATE_TIMEOUT';
    service.browsingStatus.completionReason = 'BOSS 单份简历提取超时';
    service.browsingStatus.isActive = false;
  };
  service.detachAutomation = async () => {};
  const states = [];
  service.saveCollectionProgress = state => { states.push(state); };
  await service.executeBrowsingTask('search', { position: 'IT网络运维' }, 1);
  assert.equal(states.at(-1), 'paused');
  assert.equal(service.currentStatus, 'candidate_timeout');
});

test('BOSS safely reacquires the current search list once after iframe detaches', async () => {
  const service = new BossZhipinService();
  let firstDetached = false;
  const frameFor = key => ({
    key,
    waitForTimeout: async () => {},
    isDetached: () => key === 'first' && firstDetached,
    locator: selector => ({
      count: async () => selector === 'li.geek-info-card' ? 1 : 0,
      nth: () => ({
        key,
        locator: () => ({ first: () => ({ count: async () => 0 }) }),
        click: async () => {}
      })
    })
  });
  const first = frameFor('first');
  const restored = frameFor('restored');
  service.page = {
    url: () => 'https://www.zhipin.com/web/chat/search',
    waitForTimeout: async () => {}
  };
  service.browsingStatus.isActive = true;
  service.assertCollectorReady = async () => {};
  service.ensureResumeDialogClosed = async () => {};
  service.getSearchCardIdentity = async card => ({ key: card.key, candidateId: card.key });
  service.extractAndImportResume = async (_frame, _index, id) =>
    id === 'restored' ? { id: 'saved' } : null;
  service.closeResumeAndReturnToList = async () => {};
  let reacquisitions = 0;
  service.getSearchContext = async () => { reacquisitions++; return restored; };
  service.scrollSearchResults = async frame => {
    if (frame === first) {
      firstDetached = true;
      throw new Error('frame.evaluate: Frame was detached');
    }
  };
  await service.processSearchResults(first, 1);
  assert.equal(reacquisitions, 1);
  assert.equal(service.browsingStatus.processedCount, 1);
});

test('BOSS repeated search iframe detach pauses without another menu navigation', async () => {
  const service = new BossZhipinService();
  const frameFor = key => ({
    key,
    waitForTimeout: async () => {},
    isDetached: () => false,
    locator: selector => ({
      count: async () => selector === 'li.geek-info-card' ? 1 : 0,
      nth: () => ({
        key,
        locator: () => ({ first: () => ({ count: async () => 0 }) }),
        click: async () => {}
      })
    })
  });
  const first = frameFor('first');
  const restored = frameFor('restored');
  service.page = {
    url: () => 'https://www.zhipin.com/web/chat/search',
    waitForTimeout: async () => {}
  };
  service.browsingStatus.isActive = true;
  service.assertCollectorReady = async () => {};
  service.ensureResumeDialogClosed = async () => {};
  service.getSearchCardIdentity = async card => ({ key: card.key, candidateId: card.key });
  service.extractAndImportResume = async () => null;
  service.closeResumeAndReturnToList = async () => {};
  let reacquisitions = 0;
  service.getSearchContext = async () => { reacquisitions++; return restored; };
  service.scrollSearchResults = async () => {
    throw new Error('frame.evaluate: Frame was detached');
  };
  await assert.rejects(service.processSearchResults(first, 1), error =>
    error.code === 'BOSS_SEARCH_FRAME_UNAVAILABLE');
  assert.equal(reacquisitions, 1);
  assert.equal(service.currentStatus, 'page_unavailable');
});
