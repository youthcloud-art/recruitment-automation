const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const express = require('express');
const BossZhipinService = require('../src/services/bossZhipinService');

function recruiterFixture() {
  let currentUrl = 'https://www.zhipin.com/web/chat/index';
  let navigationListener = null;
  let closes = 0;
  let navigations = 0;
  let onMenuRead = () => {};
  let menuVisibilities = [true];
  const frame = {};
  const page = {
    url: () => currentUrl,
    isClosed: () => false,
    mainFrame: () => frame,
    on: (event, listener) => {
      if (event === 'framenavigated') navigationListener = listener;
    },
    off: (event, listener) => {
      if (event === 'framenavigated' && navigationListener === listener) navigationListener = null;
    },
    locator: () => ({ evaluateAll: async callback => {
      onMenuRead();
      const evaluate = vm.runInNewContext(`(${callback.toString()})`, {
        window: { getComputedStyle: () => ({ visibility: 'visible' }) }
      });
      return evaluate(menuVisibilities.map(visible => ({
        getClientRects: () => visible ? [{}] : []
      })));
    } }),
    goto: async () => { navigations++; }
  };
  const service = new BossZhipinService();
  service.browser = { isConnected: () => true, close: async () => { closes++; } };
  service.page = page;
  service.chromeWindowOpened = true;
  service.getRecruitmentPageState = async () => 'ready';
  return {
    service,
    page,
    get closes() { return closes; },
    get navigations() { return navigations; },
    navigate() { navigationListener?.(frame); },
    setUrl(url) { currentUrl = url; },
    setMenuVisible(value) { menuVisibilities = [value]; },
    setMenuVisibilities(values) { menuVisibilities = values; },
    onMenuRead(callback) { onMenuRead = callback; }
  };
}

test('BOSS explicit login confirmation detaches CDP after two stable menu reads', async () => {
  const fixture = recruiterFixture();

  assert.equal(await fixture.service.checkLoginStatus({ allowAttach: true }), true);
  assert.equal(fixture.service.isLoggedIn, true);
  assert.equal(fixture.service.currentStatus, 'idle');
  assert.equal(fixture.service.browser, null);
  assert.equal(fixture.service.page, null);
  assert.equal(fixture.closes, 1);
  assert.equal(fixture.navigations, 0);
});

test('BOSS login confirmation accepts a visible menu after a hidden matching menu', async () => {
  const fixture = recruiterFixture();
  fixture.setMenuVisibilities([false, true]);

  assert.equal(await fixture.service.checkLoginStatus({ allowAttach: true }), true);
  assert.equal(fixture.service.currentStatus, 'idle');
  assert.equal(fixture.closes, 1);
  assert.equal(fixture.navigations, 0);
});

test('BOSS confirmed session is reused by collection without a second CDP attach', async () => {
  const fixture = recruiterFixture();
  let attaches = 0;
  fixture.service.initializeBrowser = async () => { attaches++; };
  fixture.service.browsingStatus.isActive = true;
  fixture.service.browsingStatus.keywordErrors = [];
  fixture.service.browsingStatus.stalledKeywords = [];
  fixture.service.browseRecommendedCandidates = async () => {
    fixture.service.browsingStatus.processedCount = 1;
  };

  assert.equal(await fixture.service.checkLoginStatus({
    allowAttach: true, keepAttached: true
  }), true);
  assert.equal(fixture.service.page, fixture.page);
  assert.equal(fixture.closes, 0);

  await fixture.service.executeBrowsingTask('recommended', {}, 1);
  assert.equal(attaches, 0);
  assert.equal(fixture.service.browsingStatus.processedCount, 1);
  assert.equal(fixture.service.currentStatus, 'idle');
  assert.equal(fixture.closes, 1);
  assert.equal(fixture.navigations, 0);
});

test('BOSS reused session still fails closed if verification appears before collection', async () => {
  const fixture = recruiterFixture();
  let browsed = false;
  fixture.service.browsingStatus.isActive = true;
  fixture.service.browseRecommendedCandidates = async () => { browsed = true; };

  assert.equal(await fixture.service.checkLoginStatus({
    allowAttach: true, keepAttached: true
  }), true);
  fixture.setUrl('https://www.zhipin.com/web/passport/zp/verify.html');

  await fixture.service.executeBrowsingTask('recommended', {}, 1);
  assert.equal(browsed, false);
  assert.equal(fixture.service.currentStatus, 'verification_required');
  assert.equal(fixture.service.attachSuspended, true);
  assert.equal(fixture.service.isLoggedIn, false);
  assert.equal(fixture.closes, 1);
  assert.equal(fixture.navigations, 0);
});

test('BOSS recruiter navigation during login confirmation suspends and never auto-reattaches', async () => {
  const fixture = recruiterFixture();
  fixture.onMenuRead(() => fixture.navigate());
  fixture.service.initializeBrowser = async () => { throw new Error('unexpected attach'); };

  assert.equal(await fixture.service.checkLoginStatus({ allowAttach: true }), false);
  assert.equal(fixture.service.currentStatus, 'unstable_page');
  assert.equal(fixture.service.attachSuspended, true);
  assert.equal(fixture.service.browser, null);
  assert.equal(fixture.closes, 1);
  assert.equal(await fixture.service.checkLoginStatus({ allowAttach: true }), false);
  assert.equal(fixture.closes, 1);
  assert.equal(fixture.navigations, 0);
});

test('BOSS recruiter page without a stable hiring menu detaches after bounded checks', async () => {
  const fixture = recruiterFixture();
  fixture.setMenuVisible(false);

  assert.equal(await fixture.service.checkLoginStatus({ allowAttach: true }), false);
  assert.equal(fixture.service.currentStatus, 'unstable_page');
  assert.equal(fixture.service.attachSuspended, true);
  assert.equal(fixture.service.page, null);
  assert.equal(fixture.closes, 1);
  assert.equal(fixture.navigations, 0);
});

test('BOSS verification redirect detaches CDP and preserves the visible Chrome page', async () => {
  const fixture = recruiterFixture();
  fixture.setUrl('https://www.zhipin.com/web/passport/zp/verify.html?code=36');

  assert.equal(await fixture.service.checkLoginStatus({ allowAttach: true }), false);
  assert.equal(fixture.service.currentStatus, 'verification_required');
  assert.equal(fixture.service.attachSuspended, true);
  assert.equal(fixture.service.page, null);
  assert.equal(fixture.closes, 1);
  assert.equal(fixture.navigations, 0);
});

test('BOSS passive login polling reads tab URLs without attaching or DOM probing', async () => {
  const service = new BossZhipinService();
  service.chromeWindowOpened = true;
  service.readVisibleTabs = async () => [{ url: 'https://www.zhipin.com/web/chat/index' }];
  service.initializeBrowser = async () => { throw new Error('unexpected attach'); };
  service.getRecruitmentPageState = async () => { throw new Error('unexpected DOM probe'); };

  assert.equal(await service.checkLoginStatus(), false);
  assert.equal(service.currentStatus, 'idle');
  assert.equal(service.browser, null);
});

test('BOSS accepts an owned recruiter tab even when its page title lacks brand words', async () => {
  const service = new BossZhipinService();
  service.openBossLoginWindow = async () => ({ tabs: [
    { url: 'https://www.zhipin.com/web/chat/recommend', title: '推荐牛人' }
  ] });

  assert.equal(await service.initializeFullProcess(), true);
  assert.equal(service.chromeTabUrl, 'https://www.zhipin.com/web/chat/recommend');
  assert.equal(service.currentStatus, 'waiting_login');
  assert.equal(service.browser, null);
});

test('BOSS stop during an in-flight login check prevents a late CDP attach', async () => {
  const service = new BossZhipinService();
  service.chromeWindowOpened = true;
  let releaseTabs;
  service.readVisibleTabs = () => new Promise(resolve => { releaseTabs = resolve; });
  service.initializeBrowser = async () => { throw new Error('unexpected late attach'); };
  service.canvasOcrService = { destroy: async () => {} };
  service.dragSelectionService = { cleanup: async () => {} };

  const check = service.checkLoginStatus({ allowAttach: true });
  await service.closeBrowser();
  releaseTabs([{ url: 'https://www.zhipin.com/web/chat/index' }]);
  assert.equal(await check, false);
  assert.equal(service.shutdownRequested, true);
  assert.equal(service.browser, null);
  assert.equal(service.page, null);
});

test('BOSS CDP attach timeout preserves Chrome knowledge and blocks further start or login attempts', async () => {
  const service = new BossZhipinService();
  service.chromeWindowOpened = true;
  let attachAttempts = 0;
  service.readVisibleTabs = async () => [{ url: 'https://www.zhipin.com/web/chat/recommend' }];
  service.initializeBrowser = async () => {
    attachAttempts++;
    throw new Error('connectOverCDP timed out');
  };
  service.openBossLoginWindow = async () => { throw new Error('unexpected login navigation'); };

  assert.equal(await service.checkLoginStatus({ allowAttach: true }), false);
  assert.equal(service.currentStatus, 'disconnected');
  assert.equal(service.attachSuspended, true);
  assert.equal(service.chromeWindowOpened, true);
  assert.equal(service.isLoggedIn, false);
  assert.equal(await service.checkLoginStatus({ allowAttach: true }), false);
  await assert.rejects(service.initializeFullProcess(), /连接已暂停/);
  assert.equal(attachAttempts, 1);
});

test('BOSS collection with no recruiter tab pauses without opening the login page', async () => {
  const service = new BossZhipinService();
  service.browsingStatus.isActive = true;
  service.isLoggedIn = true;
  service.readVisibleTabs = async () => [];
  service.initializeBrowser = async () => { throw new Error('unexpected attach'); };
  service.openBossZhipinWebsite = async () => { throw new Error('unexpected navigation'); };

  await service.executeBrowsingTask('search', { position: 'IT网络运维' }, 1);
  assert.equal(service.currentStatus, 'disconnected');
  assert.equal(service.isLoggedIn, false);
  assert.equal(service.browsingStatus.isActive, false);
});

test('BOSS collection reuses an existing recruiter tab after detached login confirmation', async () => {
  const service = new BossZhipinService();
  let closes = 0;
  let attaches = 0;
  let loginOptions;
  service.browsingStatus.isActive = true;
  service.isLoggedIn = true;
  service.readVisibleTabs = async () => [{ url: 'https://www.zhipin.com/web/chat/index' }];
  service.initializeBrowser = async () => {
    attaches++;
    service.browser = { isConnected: () => true, close: async () => { closes++; } };
    service.page = { url: () => 'https://www.zhipin.com/web/chat/index', isClosed: () => false };
  };
  service.checkLoginStatus = async options => {
    loginOptions = options;
    return true;
  };
  service.browseRecommendedCandidates = async () => { service.browsingStatus.processedCount = 1; };
  service.openBossZhipinWebsite = async () => { throw new Error('unexpected navigation'); };

  await service.executeBrowsingTask('recommended', {}, 1);
  assert.equal(attaches, 1);
  assert.deepEqual(loginOptions, { allowAttach: true, keepAttached: true });
  assert.equal(service.browsingStatus.processedCount, 1);
  assert.equal(service.isLoggedIn, true);
  assert.equal(service.currentStatus, 'idle');
  assert.equal(service.browser, null);
  assert.equal(closes, 1);
});

test('BOSS legacy debug endpoint cannot navigate or create a tab', async t => {
  const app = express();
  app.use(express.json());
  app.use('/api/boss-zhipin', require('../src/routes/bossZhipin'));
  const server = await new Promise(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  for (const step of ['initialize_browser', 'open_website', 'navigate_recruitment', 'select_app_login']) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/boss-zhipin/execute-step`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ step })
    });
    assert.equal(response.status, 410);
    assert.equal((await response.json()).success, false);
  }
});

test('BOSS legacy page recovery detaches instead of reloading or creating a visible tab', async () => {
  const service = new BossZhipinService();
  let closes = 0;
  let navigations = 0;
  service.browser = { isConnected: () => true, close: async () => { closes++; },
    newPage: async () => { navigations++; throw new Error('unexpected new tab'); } };
  service.page = { url: () => 'https://www.zhipin.com/web/chat/index', isClosed: () => false,
    reload: async () => { navigations++; throw new Error('unexpected reload'); } };
  service.assertCollectorReady = async () => {};
  await service.retryPageAnalysis();
  assert.equal(navigations, 0);
  await service.reinitializeBossZhipinPage();
  assert.equal(service.browser, null);
  assert.equal(service.currentStatus, 'disconnected');
  assert.equal(closes, 1);
  assert.equal(navigations, 0);
});
