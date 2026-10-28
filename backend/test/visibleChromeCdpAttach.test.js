const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { attachExistingVisibleChromeCdp, installedChromePath,
  startChrome } = require('../src/services/visibleChromeCdp');

const OWNED_URL = 'ws://127.0.0.1:19222/devtools/browser/owned-test-session';
const TABS = [{ url: 'https://www.zhipin.com/web/chat/recommend', title: 'BOSS直聘' }];

test('Windows Chrome launcher does not block HTTP while waiting for its PID', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.unref = () => {};
  child.kill = () => {};
  let ticked = false;
  setTimeout(() => { ticked = true; child.stdout.write('4512\n'); }, 20);
  const result = await startChrome({chromePath:'C:\\chrome.exe',profileDir:'C:\\profile',
    initialUrl:'https://ehire.51job.com/',port:19224},
  {platform:'win32',spawnProcess:() => child,timeoutMs:1000});
  assert.equal(ticked,true);
  assert.deepEqual(result,{pid:4512});
});

test('Windows Chrome launcher bounds a stalled PowerShell without blocking the event loop', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let killed = false;
  child.kill = () => { killed = true; };
  await assert.rejects(startChrome({chromePath:'C:\\chrome.exe',
    profileDir:'C:\\profile',initialUrl:'https://ehire.51job.com/',port:19224},
  {platform:'win32',spawnProcess:() => child,timeoutMs:20}),/启动超时/);
  assert.equal(killed,true);
});

test('Windows Chrome detection accepts 32-bit Program Files installs after moving computers', () => {
  const x86Chrome = path.win32.join('D:\\Apps (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe');
  const examined = [];
  const found = installedChromePath({
    platform: 'win32',
    environment: { PROGRAMFILES: 'D:\\Apps', 'PROGRAMFILES(X86)': 'D:\\Apps (x86)' },
    fileExists: candidate => {
      examined.push(candidate);
      return candidate === x86Chrome;
    }
  });
  assert.equal(found, x86Chrome);
  assert.equal(examined[0], path.win32.join('D:\\Apps', 'Google', 'Chrome', 'Application', 'chrome.exe'));
  assert.equal(examined[1], x86Chrome);
});

test('explicit Chrome executable path is preferred without probing machine defaults', () => {
  const examined = [];
  const found = installedChromePath({
    platform: 'win32',
    environment: { CHROME_EXECUTABLE_PATH: 'E:\\Chrome\\chrome.exe' },
    fileExists: candidate => {
      examined.push(candidate);
      return true;
    }
  });
  assert.equal(found, 'E:\\Chrome\\chrome.exe');
  assert.deepEqual(examined, ['E:\\Chrome\\chrome.exe']);
});

test('CDP attach uses the verified browser WebSocket directly, without launching or fetching HTTP again', async () => {
  const calls = [];
  const context = { pages: () => [] };
  const browser = { contexts: () => [context] };
  const session = await attachExistingVisibleChromeCdp(
    { profileName: 'boss', port: 19222 },
    {
      readSession: async options => {
        calls.push(['read', options]);
        return { webSocketDebuggerUrl: OWNED_URL, tabs: TABS };
      },
      browserType: {
        connectOverCDP: async (url, options) => {
          calls.push(['connect', url, options]);
          return browser;
        }
      }
    }
  );

  assert.equal(session.browser, browser);
  assert.equal(session.context, context);
  assert.equal(session.tabs, TABS);
  assert.deepEqual(calls, [
    ['read', { profileName: 'boss', port: 19222 }],
    ['connect', OWNED_URL, { timeout: 15000 }]
  ]);
});

test('CDP attach fails closed when ownership preflight fails and never opens a connection', async () => {
  let attempts = 0;
  await assert.rejects(attachExistingVisibleChromeCdp(
    { profileName: 'boss', port: 19222 },
    {
      readSession: async () => { throw new Error('unowned Chrome'); },
      browserType: { connectOverCDP: async () => { attempts++; } }
    }
  ), /unowned Chrome/);
  assert.equal(attempts, 0);
});

test('CDP attach timeout is propagated without retry or navigation', async () => {
  let attempts = 0;
  await assert.rejects(attachExistingVisibleChromeCdp(
    { profileName: 'boss', port: 19222 },
    {
      readSession: async () => ({ webSocketDebuggerUrl: OWNED_URL, tabs: TABS }),
      browserType: { connectOverCDP: async () => {
        attempts++;
        throw new Error('connectOverCDP timed out');
      } }
    }
  ), /timed out/);
  assert.equal(attempts, 1);
});

test('CDP attach disconnects its transport if Playwright returns no default context', async () => {
  let disconnects = 0;
  await assert.rejects(attachExistingVisibleChromeCdp(
    { profileName: 'boss', port: 19222 },
    {
      readSession: async () => ({ webSocketDebuggerUrl: OWNED_URL, tabs: TABS }),
      browserType: { connectOverCDP: async () => ({
        contexts: () => [],
        close: async () => { disconnects++; }
      }) }
    }
  ), /默认浏览器会话/);
  assert.equal(disconnects, 1);
});
