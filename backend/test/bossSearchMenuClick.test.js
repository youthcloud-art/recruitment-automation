const test = require('node:test');
const assert = require('node:assert/strict');
const BossZhipinService = require('../src/services/bossZhipinService');

test('BOSS 搜索菜单连续命中后只发一次鼠标点击', async () => {
  const service = new BossZhipinService();
  const samples = [
    { state: 'changing' },
    { state: 'ready', x: 84, y: 199, origin: 100 },
    { state: 'ready', x: 84, y: 199, origin: 100 }
  ];
  const clicks = [];
  service.page = {
    evaluate: async (_fn, selector) => {
      assert.match(selector, /menu-geek-search/);
      return samples.shift();
    },
    waitForTimeout: async () => {},
    mouse: { click: async (...args) => clicks.push(args) }
  };
  service.assertCollectorReady = async () => {};
  await service.clickSearchMenuOnce();
  assert.deepEqual(clicks, [[84, 199, { delay: 40 }]]);
  assert.equal(samples.length, 0);
});

test('BOSS 搜索菜单被遮挡时不点击也不换网址', async () => {
  const service = new BossZhipinService();
  let clicks = 0;
  let waits = 0;
  service.page = {
    evaluate: async () => ({ state: 'obscured' }),
    waitForTimeout: async () => { waits++; },
    mouse: { click: async () => { clicks++; } }
  };
  service.assertCollectorReady = async () => {};
  await assert.rejects(service.clickSearchMenuOnce(), error =>
    error.code === 'BOSS_SEARCH_MENU_UNAVAILABLE');
  assert.equal(clicks, 0);
  assert.equal(waits, 9);
  assert.equal(service.currentStatus, 'page_unavailable');
});

test('BOSS 验证页阻断菜单点击', async () => {
  const service = new BossZhipinService();
  let clicks = 0;
  service.page = {
    evaluate: async () => ({ state: 'ready', x: 84, y: 199, origin: 100 }),
    mouse: { click: async () => { clicks++; } }
  };
  service.assertCollectorReady = async () => {
    const error = new Error('需要人工验证');
    error.code = 'BOSS_VERIFICATION_REQUIRED';
    throw error;
  };
  await assert.rejects(service.clickSearchMenuOnce(), error =>
    error.code === 'BOSS_VERIFICATION_REQUIRED');
  assert.equal(clicks, 0);
});
