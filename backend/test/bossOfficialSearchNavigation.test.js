const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureOfficialSearchPage, isSearchPage } = require('../src/services/bossOfficialSearchNavigation');

test('BOSS search page recognition allows only the official URL', () => {
  assert.equal(isSearchPage('https://www.zhipin.com/web/chat/search'), true);
  assert.equal(isSearchPage('https://www.zhipin.com/web/chat/search?_security_check=1'), true);
  assert.equal(isSearchPage('https://www.zhipin.com/web/chat/search?jobId=other'), false);
  assert.equal(isSearchPage('https://evil.example/web/chat/search'), false);
});

test('BOSS search navigation clicks the official menu once from recommendations', async () => {
  let url = 'https://www.zhipin.com/web/chat/recommend';
  let clicks = 0;
  let closes = 0;
  const session = {
    assertRecruiterReady: async () => url,
    assertUsableRecruiterWindow: async options => {
      assert.match(options.frameSelector, /recommend/);
    },
    clickUnique: async options => {
      assert.equal(options.selector, 'a[ka="menu-geek-search"]');
      clicks++;
      url = 'https://www.zhipin.com/web/chat/search';
    },
    evaluate: async () => true,
    close: () => { closes++; }
  };
  const result = await ensureOfficialSearchPage({ connect: async () => session,
    wait: async () => {} });
  assert.deepEqual(result, { navigated: true, url });
  assert.equal(clicks, 1);
  assert.equal(closes, 1);
});

test('BOSS search navigation leaves an existing search page untouched', async () => {
  let clicks = 0;
  const session = {
    assertRecruiterReady: async () => 'https://www.zhipin.com/web/chat/search',
    clickUnique: async () => { clicks++; },
    close: () => {}
  };
  const result = await ensureOfficialSearchPage({ connect: async () => session });
  assert.equal(result.navigated, false);
  assert.equal(clicks, 0);
});

test('BOSS search navigation refuses other pages and does not click repeatedly', async () => {
  let clicks = 0;
  const session = {
    assertRecruiterReady: async () => 'https://www.zhipin.com/web/boss/job/list',
    clickUnique: async () => { clicks++; },
    close: () => {}
  };
  await assert.rejects(ensureOfficialSearchPage({ connect: async () => session }),
    error => error.code === 'BOSS_SEARCH_PAGE_REQUIRED');
  assert.equal(clicks, 0);
});
