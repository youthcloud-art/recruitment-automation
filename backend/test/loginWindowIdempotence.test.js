const test = require('node:test');
const assert = require('node:assert/strict');
const BossZhipinService = require('../src/services/bossZhipinService');
const ZhilianService = require('../src/services/zhilianService');

test('智联 recognizes employer tabs by official URL even when the title changes', () => {
  const { isZhilianEmployerTab, preferredZhilianEmployerTab } = ZhilianService;
  const login = { url: 'https://passport.zhaopin.com/org/login', title: '' };
  const dashboard = { url: 'https://rd6.zhaopin.com/', title: '工作台' };
  assert.equal(isZhilianEmployerTab(login), true);
  assert.equal(isZhilianEmployerTab(dashboard), true);
  assert.equal(preferredZhilianEmployerTab([login, dashboard]), dashboard);
  assert.equal(isZhilianEmployerTab({ url: 'https://rd6.zhaopin.com.evil.example/' }), false);
  assert.equal(isZhilianEmployerTab({ url: 'about:blank' }), false);
});

test('BOSS start preserves a visible login page without navigating again', async () => {
  const service = new BossZhipinService();
  let navigations = 0;
  service.browser = { isConnected: () => true };
  service.page = {
    isClosed: () => false,
    url: () => 'https://www.zhipin.com/web/user/?ka=header-login',
    goto: async () => { navigations++; }
  };
  service.initializeBrowser = async () => { throw new Error('browser replaced'); };

  assert.equal(await service.initializeFullProcess(), true);
  assert.equal(await service.initializeFullProcess(), true);
  assert.equal(navigations, 0);
});

test('BOSS login check discards a stale Chrome page without navigating', async () => {
  const service = new BossZhipinService();
  let navigations = 0;
  service.browser = { isConnected: () => false };
  service.page = {
    isClosed: () => false,
    url: () => 'https://www.zhipin.com/web/chat/index',
    goto: async () => { navigations++; }
  };
  service.chromeWindowOpened = false;

  assert.equal(await service.checkLoginStatus({ allowAttach: true }), false);
  assert.equal(service.browser, null);
  assert.equal(service.page, null);
  assert.equal(navigations, 0);
  assert.equal(service.getCurrentStatus().hasBrowser, false);
});

test('BOSS stop disconnects automation without closing visible tabs', async () => {
  const service = new BossZhipinService();
  let disconnected = 0;
  let closedTabs = 0;
  service.browser = { close: async () => { disconnected++; } };
  service.page = { isClosed: () => false, close: async () => { closedTabs++; } };
  service.appPage = { isClosed: () => false, close: async () => { closedTabs++; } };
  service.canvasOcrService = { destroy: async () => {} };
  service.dragSelectionService = { cleanup: async () => {} };

  await service.closeBrowser();

  assert.equal(disconnected, 1);
  assert.equal(closedTabs, 0);
  assert.equal(service.browser, null);
  assert.equal(service.page, null);
});

test('智联 init preserves an existing employer page', async () => {
  const service = new ZhilianService();
  let navigations = 0;
  service.browser = { isConnected: () => true };
  service.page = {
    isClosed: () => false,
    url: () => 'https://passport.zhaopin.com/org/login?bkurl=secret',
    goto: async () => { navigations++; }
  };

  assert.equal(await service.initializeBrowser(), true);
  assert.equal(await service.openEmployerLoginPage(), true);
  assert.equal(await service.openEmployerLoginPage(), true);
  assert.equal(navigations, 0);
  assert.equal(service.getCurrentStatus().browser.currentUrl, 'https://passport.zhaopin.com/org/login');
});

test('智联 keeps official login page when DOM loading times out', async () => {
  const service = new ZhilianService();
  let url = 'about:blank';
  service.page = {
    isClosed: () => false,
    url: () => url,
    goto: async () => {
      url = 'https://passport.zhaopin.com/org/login';
      const error = new Error('page.goto: Timeout 45000ms exceeded');
      error.name = 'TimeoutError';
      throw error;
    }
  };

  assert.equal(await service.openEmployerLoginPage(), true);
  assert.equal(service.currentStatus, 'logging_in');
});

test('智联 does not treat a blank or nonofficial page as successful login navigation', async () => {
  for (const badUrl of ['about:blank', 'https://example.com/login']) {
    const service = new ZhilianService();
    service.page = {
      isClosed: () => false,
      url: () => badUrl,
      goto: async () => {
        const error = new Error('page.goto: Timeout 45000ms exceeded');
        error.name = 'TimeoutError';
        throw error;
      }
    };
    await assert.rejects(service.openEmployerLoginPage(), /Timeout/);
  }
});
