'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { createBrowserConsoleRouter } = require('../src/routes/browserConsole');

const CLIENT = 'operator-1111111111111111';
const OTHER = 'operator-2222222222222222';

function fakePage(calls, initialURL = 'https://www.zhipin.com/web/user/') {
  let url = initialURL;
  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.writeUInt32BE(1280, 16);
  png.writeUInt32BE(720, 20);
  return {
    isClosed: () => false, url: () => url, changeURL: value => { url = value; },
    screenshot: async options => { calls.push(['screenshot', options]); return png; },
    mouse: {
      click: async (x, y, options) => calls.push(['click', x, y, options]),
      move: async (x, y) => calls.push(['move', x, y]),
      wheel: async (x, y) => calls.push(['wheel', x, y])
    },
    keyboard: {
      insertText: async value => calls.push(['type', value]),
      press: async value => calls.push(['key', value])
    }
  };
}

async function fixture(t, options = {}) {
  let time = 100000;
  const calls = [];
  const page = fakePage(calls);
  const target = { service: { page }, running: false };
  const app = express();
  app.use(express.json());
  app.use('/api/browser-console', createBrowserConsoleRouter({
    environment: { COMPANY_DEPLOYMENT: 'true' }, getTargets: () => ({ boss: target }),
    now: () => time, ...options
  }));
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/browser-console`;
  async function request(endpoint, body, headers = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request(base + endpoint, {
        method: body === undefined ? 'GET' : 'POST', agent: false,
        headers: { host: '127.0.0.1:5001', origin: 'http://127.0.0.1:3000', 'content-type': 'application/json', ...headers }
      }, response => {
        let data = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { data += chunk; });
        response.on('end', () => resolve({
          status: response.statusCode, headers: new Headers(response.headers), body: JSON.parse(data)
        }));
      });
      req.on('error', reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  return { calls, page, target, request, advance: ms => { time += ms; } };
}

async function acquire(app, platform = 'boss', clientId = CLIENT) {
  return app.request('/session', { platform, clientId });
}

async function screenshot(app, platform = 'boss', clientId = CLIENT) {
  return app.request(`/screenshot?platform=${platform}&clientId=${clientId}`);
}

test('console is absent outside company deployment and retains loopback protection', async t => {
  const local = await fixture(t, { environment: {} });
  assert.equal((await local.request('/status')).status, 404);
  const company = await fixture(t);
  assert.equal((await company.request('/status', undefined, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await company.request('/status', undefined, { host: 'evil.example:5001' })).status, 403);
});

test('status is read-only, platform-scoped and does not disclose session or page URL', async t => {
  const app = await fixture(t);
  const status = await app.request('/status');
  assert.equal(status.status, 200);
  assert.equal(status.body.data.enabled, true);
  assert.deepEqual(status.body.data.platforms.map(platform => platform.id), ['boss', 'zhilian', 'wuyou']);
  assert.equal(status.body.data.platforms[0].available, true);
  assert.equal(status.body.data.lock.held, false);
  assert.doesNotMatch(JSON.stringify(status.body), /zhipin.com|operator-/);
  assert.deepEqual(app.calls, []);
});

test('single operator lease expires at 60 seconds and cannot be released by others', async t => {
  const app = await fixture(t);
  assert.equal((await acquire(app)).status, 200);
  assert.equal((await acquire(app, 'boss', OTHER)).status, 409);
  assert.equal((await app.request('/release', { clientId: OTHER })).status, 409);
  assert.equal((await screenshot(app, 'boss', OTHER)).status, 409);
  app.advance(60001);
  assert.equal((await screenshot(app)).status, 409);
  assert.equal((await acquire(app, 'boss', OTHER)).status, 200);
  assert.equal((await app.request('/release', { clientId: OTHER })).status, 200);
  assert.equal((await app.request('/status')).body.data.lock.held, false);
});

test('screenshots are uncached viewport images and validated coordinates drive only the existing page', async t => {
  const app = await fixture(t);
  await acquire(app);
  const shot = await screenshot(app);
  assert.equal(shot.status, 200);
  assert.match(shot.headers.get('cache-control'), /no-store/);
  assert.equal(shot.body.data.width, 1280);
  assert.equal(shot.body.data.height, 720);
  assert.match(shot.body.data.image, /^data:image\/png;base64,/);
  for (const payload of [
    { action: 'click', x: 200, y: 150 }, { action: 'type', text: 'fixture-input' },
    { action: 'key', key: 'Control+A' }, { action: 'scroll', deltaY: 400 }
  ]) assert.equal((await app.request('/action', { platform: 'boss', clientId: CLIENT, ...payload })).status, 200);
  assert.deepEqual(app.calls.map(call => call[0]), ['screenshot', 'click', 'type', 'key', 'move', 'wheel']);
  assert.deepEqual(app.calls[1], ['click', 200, 150, { button: 'left', clickCount: 1 }]);
});

test('rejects arbitrary URLs, scripts, shortcuts, oversized text and coordinates before input', async t => {
  const app = await fixture(t);
  await acquire(app);
  await screenshot(app);
  for (const payload of [
    { action: 'navigate', url: 'https://evil.example' }, { action: 'eval', code: '1+1' },
    { action: 'key', key: 'Control+L' }, { action: 'key', key: 'F12' },
    { action: 'type', text: 'a'.repeat(513) }, { action: 'type', text: 'line\nline' },
    { action: 'click', x: -1, y: 100 }, { action: 'click', x: 1280, y: 100 },
    { action: 'click' }, { action: 'scroll', deltaY: 801 },
    { action: 'click', x: 10, y: 10, url: 'https://evil.example' }
  ]) assert.equal((await app.request('/action', { platform: 'boss', clientId: CLIENT, ...payload })).status, 400);
  assert.equal((await acquire(app, '__proto__')).status, 400);
  assert.equal((await screenshot(app, 'https://evil.example')).status, 400);
  assert.deepEqual(app.calls.map(call => call[0]), ['screenshot']);
});

test('running collections and stale or navigated frames cannot receive manual input', async t => {
  const app = await fixture(t);
  await acquire(app);
  await screenshot(app);
  const click = () => app.request('/action', { platform: 'boss', clientId: CLIENT, action: 'click', x: 10, y: 10 });
  app.target.running = true;
  assert.equal((await click()).status, 409);
  assert.equal((await app.request('/status')).body.data.platforms[0].running, true);
  app.target.running = false;
  app.page.changeURL('https://www.zhipin.com/web/new-page/');
  assert.equal((await click()).status, 409);
  await screenshot(app);
  app.advance(15001);
  assert.equal((await click()).status, 409);
  assert.deepEqual(app.calls.map(call => call[0]), ['screenshot', 'screenshot']);
});

test('login-only Chrome is attached through owned CDP without launching or navigation', async t => {
  const calls = [];
  const page = fakePage(calls);
  const targets = { boss: { service: { page: null, chromeWindowOpened: true } } };
  let attached = 0;
  let disconnected = 0;
  const app = await fixture(t, {
    getTargets: () => targets,
    attachExisting: async options => {
      assert.equal(options.profileName, 'boss');
      assert.equal(options.port, 19222);
      attached += 1;
      return { context: { pages: () => [page] }, browser: { close: async () => { disconnected += 1; } } };
    }
  });
  await acquire(app);
  assert.equal((await screenshot(app)).status, 200);
  assert.equal(attached, 1);
  assert.equal(disconnected, 1);
  page.changeURL('https://evil.example/');
  assert.equal((await screenshot(app)).status, 409);
  assert.equal(disconnected, 2);
  assert.equal(calls.filter(call => call[0] === 'screenshot').length, 1);
});
