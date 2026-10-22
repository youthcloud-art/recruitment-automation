const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { once } = require('node:events');
const WebSocket = require('ws');
const { BossRawCdpSession, connectOwnedBossPage } = require('../src/services/bossRawCdp');

const RECRUITER_URL = 'https://www.zhipin.com/web/chat/recommend';
const PAGE_SOCKET = 'ws://127.0.0.1:19222/devtools/page/owned-page-123';

class FakeWebSocket extends EventTarget {
  static instances = [];

  constructor(url) {
    super();
    this.url = url;
    this.readyState = 0;
    this.commands = [];
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.dispatchEvent(new Event('open'));
    });
  }

  send(payload) {
    const command = JSON.parse(payload);
    this.commands.push(command);
    queueMicrotask(() => {
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
        id: command.id,
        result: command.method === 'Runtime.evaluate'
          ? { result: { type: 'number', value: 2 } }
          : {}
      }) }));
    });
  }

  close() {
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }
}

function connections(endpoint = PAGE_SOCKET) {
  return {
    readTabs: async () => [{ url: RECRUITER_URL, title: 'BOSS' }],
    fetchImpl: async () => ({ ok: true, json: async () => [{
      type: 'page', url: RECRUITER_URL, webSocketDebuggerUrl: endpoint
    }] }),
    WebSocketImpl: FakeWebSocket
  };
}

test('raw CDP verifies owned BOSS page before connecting to the page endpoint', async () => {
  FakeWebSocket.instances.length = 0;
  const session = await connectOwnedBossPage({ port: 19222 }, connections());
  assert.equal(FakeWebSocket.instances.length, 1);
  assert.equal(FakeWebSocket.instances[0].url, PAGE_SOCKET);
  assert.equal(await session.evaluate('1 + 1'), 2);
  assert.deepEqual(FakeWebSocket.instances[0].commands.map(command => command.method),
    ['Runtime.evaluate']);
  session.close();
  assert.equal(FakeWebSocket.instances[0].readyState, 3);
});

test('raw CDP refuses unowned browser, external endpoint, and ambiguous recruiter tabs', async () => {
  FakeWebSocket.instances.length = 0;
  let fetches = 0;
  await assert.rejects(connectOwnedBossPage({}, {
    ...connections(),
    readTabs: async () => { throw new Error('unowned Chrome'); },
    fetchImpl: async () => { fetches++; }
  }), /unowned Chrome/);
  assert.equal(fetches, 0);
  await assert.rejects(connectOwnedBossPage({},
    connections('ws://example.com:19222/devtools/page/owned-page-123')),
  error => error.code === 'BOSS_CDP_PAGE_UNAVAILABLE');
  await assert.rejects(connectOwnedBossPage({}, {
    ...connections(),
    readTabs: async () => [
      { url: RECRUITER_URL },
      { url: 'https://www.zhipin.com/web/chat/search' }
    ]
  }), error => error.code === 'BOSS_CDP_PAGE_UNAVAILABLE');
  assert.equal(FakeWebSocket.instances.length, 0);
});

test('raw CDP classifies official verification, rate limit, and login redirects before page mismatch', async () => {
  const session = Object.create(BossRawCdpSession.prototype);
  let state;
  session.evaluate = async () => state;
  for (const [next, expected] of [
    [{url:'https://www.zhipin.com/web/passport/zp/verify.html'},'BOSS_VERIFICATION_REQUIRED'],
    [{url:RECRUITER_URL,rateLimited:true},'BOSS_RATE_LIMITED'],
    [{url:'https://www.zhipin.com/web/user/?ka=header-login'},'BOSS_LOGIN_REQUIRED'],
    [{url:'https://www.zhipin.com/web/chat/search',verify:true},'BOSS_VERIFICATION_REQUIRED']
  ]) {
    state = next;
    await assert.rejects(session.assertRecruiterReady(),
      error => error.code === expected);
  }
  state = {url:RECRUITER_URL,login:false,verify:false,rateLimited:false};
  assert.equal(await session.assertRecruiterReady(),RECRUITER_URL);
});

test('window preflight rejects minimized or clipped recruiter viewport without page mutation', async () => {
  const session = Object.create(BossRawCdpSession.prototype);
  const commands = [];
  let windowState = 'minimized';
  let geometry = {state:'ready',viewportWidth:406,viewportHeight:785,
    frameWidth:868,visibleWidth:406,visibleHeight:745,frameFullyVisible:false};
  session.assertRecruiterReady = async () => RECRUITER_URL;
  session.send = async (method) => {
    commands.push(method);
    assert.equal(method,'Browser.getWindowForTarget');
    return {bounds:{windowState}};
  };
  session.evaluate = async () => geometry;
  await assert.rejects(session.assertUsableRecruiterWindow(),
    error => error.code === 'BOSS_CDP_WINDOW_MINIMIZED');
  windowState = 'normal';
  await assert.rejects(session.assertUsableRecruiterWindow(),
    error => error.code === 'BOSS_CDP_VIEWPORT_TOO_SMALL');
  geometry = {state:'ready',viewportWidth:1824,viewportHeight:905,
    frameWidth:1656,visibleWidth:1656,visibleHeight:865,frameFullyVisible:true};
  assert.equal(await session.assertUsableRecruiterWindow(),true);
  assert.deepEqual(commands,[
    'Browser.getWindowForTarget',
    'Browser.getWindowForTarget',
    'Browser.getWindowForTarget'
  ]);
});

test('owned BOSS window restores once and observes the same window after an uncertain ACK', async () => {
  const session = Object.create(BossRawCdpSession.prototype);
  session.owned = true;
  session.verifiedWindowId = 73;
  let state = 'minimized';
  let setCalls = 0;
  session.assertRecruiterReady = async () => RECRUITER_URL;
  session.send = async (method, args) => {
    if (method === 'Browser.getWindowForTarget') {
      return {windowId:73,bounds:{windowState:state}};
    }
    assert.equal(method,'Browser.setWindowBounds');
    assert.deepEqual(args,{windowId:73,bounds:{windowState:'normal'}});
    setCalls++;
    state = 'normal';
    throw Object.assign(new Error('ACK timed out'),{code:'BOSS_CDP_TIMEOUT'});
  };
  const result=await session.restoreMinimizedOwnedWindow({expectedUrl:RECRUITER_URL});
  assert.deepEqual(result,{attempted:true,ackUncertain:true});
  assert.equal(setCalls,1,'uncertain ACK must not replay setWindowBounds');
});

test('restored BOSS window may be maximized by Windows', async () => {
  const session = Object.create(BossRawCdpSession.prototype);
  session.owned = true;
  session.verifiedWindowId = 73;
  let state = 'minimized';
  session.assertRecruiterReady = async () => RECRUITER_URL;
  session.send = async method => {
    if (method === 'Browser.getWindowForTarget') {
      return {windowId:73,bounds:{windowState:state}};
    }
    assert.equal(method,'Browser.setWindowBounds');
    state = 'maximized';
  };
  assert.deepEqual(await session.restoreMinimizedOwnedWindow({expectedUrl:RECRUITER_URL}),
    {attempted:true,ackUncertain:false});
});

test('initial minimized owned BOSS window is restored before the first candidate action', async () => {
  const session = Object.create(BossRawCdpSession.prototype);
  session.owned = true;
  session.verifiedWindowId = null;
  let state = 'minimized';
  let restoreCalls = 0;
  session.assertRecruiterReady = async () => RECRUITER_URL;
  session.evaluate = async () => ({state:'ready',viewportWidth:1824,
    viewportHeight:905,frameWidth:1656,visibleWidth:1656,
    visibleHeight:865,frameFullyVisible:true});
  session.send = async (method, args) => {
    if (method === 'Browser.getWindowForTarget') {
      return {windowId:73,bounds:{windowState:state}};
    }
    assert.equal(method,'Browser.setWindowBounds');
    assert.deepEqual(args,{windowId:73,bounds:{windowState:'normal'}});
    restoreCalls++;
    state = 'normal';
  };
  assert.equal(await session.assertOrRestoreInitialRecruiterWindow(),true);
  assert.equal(session.verifiedWindowId,73);
  assert.equal(restoreCalls,1);
});

test('initial BOSS restore rejects an unowned or changed window without mutation', async () => {
  const session = Object.create(BossRawCdpSession.prototype);
  let setCalls = 0;
  session.assertRecruiterReady = async () => RECRUITER_URL;
  session.send = async method => {
    if (method === 'Browser.getWindowForTarget') {
      return {windowId:74,bounds:{windowState:'minimized'}};
    }
    setCalls++;
  };
  session.owned = false;
  session.verifiedWindowId = null;
  await assert.rejects(session.restoreInitialMinimizedOwnedWindow({expectedUrl:RECRUITER_URL}),
    error => error.code === 'BOSS_CDP_WINDOW_RESTORE_UNAVAILABLE');
  session.owned = true;
  session.assertRecruiterReady = async () => 'https://www.zhipin.com/web/chat/search';
  await assert.rejects(session.restoreInitialMinimizedOwnedWindow({expectedUrl:RECRUITER_URL}),
    error => error.code === 'BOSS_CDP_WINDOW_RESTORE_UNAVAILABLE');
  assert.equal(setCalls,0);
});

test('window restoration refuses unowned or changed BOSS window before any mutation', async () => {
  const session = Object.create(BossRawCdpSession.prototype);
  let setCalls=0;
  session.assertRecruiterReady=async()=>RECRUITER_URL;
  session.send=async method=>{
    if (method==='Browser.getWindowForTarget') {
      return {windowId:74,bounds:{windowState:'minimized'}};
    }
    setCalls++;
    throw new Error('must not restore');
  };
  session.owned=false;
  session.verifiedWindowId=73;
  await assert.rejects(session.restoreMinimizedOwnedWindow({expectedUrl:RECRUITER_URL}),
    error=>error.code==='BOSS_CDP_WINDOW_RESTORE_UNAVAILABLE');
  session.owned=true;
  await assert.rejects(session.restoreMinimizedOwnedWindow({expectedUrl:RECRUITER_URL}),
    error=>error.code==='BOSS_CDP_WINDOW_RESTORE_UNAVAILABLE');
  assert.equal(setCalls,0);
});

test('clickUnique sends exactly one mouse press and release after stable, verified target', async () => {
  const socket = new FakeWebSocket(PAGE_SOCKET);
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  const session = new BossRawCdpSession(socket);
  const calls = [];
  session.evaluate = async expression => {
    calls.push(expression);
    if (expression.includes('const url = location.href;')) {
      return { url: RECRUITER_URL, login: false, verify: false, rateLimited: false };
    }
    return { state: 'ready', x: 210, y: 330, origin: 1, frameOrigin: 2 };
  };
  await session.clickUnique({
    frameSelector: 'iframe[src*="/web/frame/recommend/"]',
    selector: 'li.job-item', identityAttribute: 'value', identityValue: 'job-123'
  });
  const clickMethods = socket.commands.map(command => command.method);
  assert.deepEqual(clickMethods, ['Input.dispatchMouseEvent', 'Input.dispatchMouseEvent']);
  assert.deepEqual(socket.commands.map(command => command.params.type),
    ['mousePressed', 'mouseReleased']);
  assert.ok(calls.some(expression => expression.includes('"identityAttribute":"value"')));
  session.close();
});

test('clickUnique fails closed when target is obscured or moves between samples', async () => {
  const socket = new FakeWebSocket(PAGE_SOCKET);
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  const session = new BossRawCdpSession(socket);
  session.evaluate = async expression => expression.includes('const url = location.href;')
    ? { url: RECRUITER_URL } : { state: 'obscured' };
  await assert.rejects(session.clickUnique({ selector: 'a[ka="menu-geek-search"]' }),
    error => error.code === 'BOSS_CDP_TARGET_UNAVAILABLE' &&
      error.stage === 'pre_click_probe' && error.targetState === 'obscured');
  assert.equal(socket.commands.length, 0);

  let targetReads = 0;
  session.evaluate = async expression => expression.includes('const url = location.href;')
    ? { url: RECRUITER_URL }
    : { state: 'ready', x: ++targetReads === 1 ? 10 : 40,
      y: 20, origin: 1, frameOrigin: 0 };
  await assert.rejects(session.clickUnique({ selector: 'a[ka="menu-geek-search"]' }),
    error => error.code === 'BOSS_CDP_TARGET_UNSTABLE' &&
      error.stage === 'pre_click_recheck' && error.reason === 'position_moved');
  assert.equal(socket.commands.length, 0);

  targetReads = 0;
  session.evaluate = async expression => expression.includes('const url = location.href;')
    ? { url: RECRUITER_URL }
    : (++targetReads === 1
      ? { state: 'ready', x: 10, y: 20, origin: 1, frameOrigin: 2 }
      : { state: 'out_of_view' });
  await assert.rejects(session.clickUnique({ selector: 'a[ka="menu-geek-search"]' }),
    error => error.code === 'BOSS_CDP_TARGET_UNSTABLE' &&
      error.stage === 'pre_click_recheck' && error.reason === 'target_not_ready' &&
      error.targetState === 'out_of_view');
  assert.equal(socket.commands.length, 0);

  targetReads = 0;
  session.evaluate = async expression => expression.includes('const url = location.href;')
    ? { url: RECRUITER_URL }
    : (++targetReads === 1
      ? { state: 'ready', x: 10, y: 20, origin: 1, frameOrigin: 2 }
      : { state: 'ready', x: 10, y: 20, origin: 1, frameOrigin: 3 });
  await assert.rejects(session.clickUnique({ selector: 'a[ka="menu-geek-search"]' }),
    error => error.code === 'BOSS_CDP_TARGET_UNSTABLE' &&
      error.reason === 'document_changed');
  assert.equal(socket.commands.length, 0);
  session.close();
});

test('card click rereads a transient obstruction before one stable mouse click', async () => {
  const socket = new FakeWebSocket(PAGE_SOCKET);
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  const session = new BossRawCdpSession(socket);
  let reads = 0;
  session.evaluate = async expression => expression.includes('const url = location.href;')
    ? { url: RECRUITER_URL }
    : (++reads === 1 ? { state: 'obscured' }
      : { state: 'ready', x: 510, y: 330, origin: 1, frameOrigin: 2 });
  await session.clickUnique({selector:'li.card-item',
    frameSelector:'iframe[src*="/web/frame/recommend/"]',
    identityAttribute:'textContent',identityValue:'exact unique card text'});
  assert.equal(reads,3);
  assert.deepEqual(socket.commands.map(command => command.params.type),
    ['mousePressed','mouseReleased']);
  session.close();
});

test('persistently obscured card is never clicked after bounded read-only reread', async () => {
  const socket = new FakeWebSocket(PAGE_SOCKET);
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  const session = new BossRawCdpSession(socket);
  let reads = 0;
  session.evaluate = async expression => expression.includes('const url = location.href;')
    ? { url: RECRUITER_URL } : (reads++, { state: 'obscured' });
  await assert.rejects(session.clickUnique({selector:'li.card-item',
    frameSelector:'iframe[src*="/web/frame/recommend/"]',
    identityAttribute:'textContent',identityValue:'exact unique card text'}),
  error => error.code === 'BOSS_CDP_TARGET_UNAVAILABLE' &&
    error.stage === 'pre_click_probe' && error.targetState === 'obscured');
  assert.equal(reads,2);
  assert.equal(socket.commands.length,0);
  session.close();
});

test('clickUnique releases a possibly delivered press after ack timeout without pressing again', async () => {
  const socket = new FakeWebSocket(PAGE_SOCKET);
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  const session = new BossRawCdpSession(socket);
  session.evaluate = async expression => expression.includes('const url = location.href;')
    ? { url: RECRUITER_URL }
    : { state: 'ready', x: 210, y: 330, origin: 1, frameOrigin: 2 };
  const types = [];
  session.send = async (method, params) => {
    assert.equal(method, 'Input.dispatchMouseEvent');
    types.push(params.type);
    if (params.type === 'mousePressed') {
      const error = new Error('CDP timeout');
      error.code = 'BOSS_CDP_TIMEOUT';
      throw error;
    }
    return {};
  };
  await assert.rejects(session.clickUnique({ selector: '.dialog-wrap.active .close-btn' }),
    error => error.code === 'BOSS_CDP_CLICK_UNCERTAIN');
  assert.deepEqual(types, ['mousePressed', 'mouseReleased']);
  session.close();
});

test('closing raw CDP rejects in-flight commands without touching Chrome tabs', async () => {
  const socket = new FakeWebSocket(PAGE_SOCKET);
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  socket.send = () => {};
  const session = new BossRawCdpSession(socket);
  const request = session.send('Runtime.evaluate', { expression: '1' });
  session.close();
  await assert.rejects(request, error => error.code === 'BOSS_CDP_DISCONNECTED');
  assert.equal(socket.readyState, 3);
});

test('captureCanvasPng keeps candidate pixels in memory and rejects malformed data', async () => {
  const socket = new FakeWebSocket(PAGE_SOCKET);
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  const session = new BossRawCdpSession(socket);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ'
    + 'AAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64');
  session.evaluate = async expression => expression.includes('const url = location.href;')
    ? { url: RECRUITER_URL }
    : (assert.ok(expression.includes('querySelectorAll') && expression.includes('[1]')),
      { state: 'ready', dataUrl: `data:image/png;base64,${png.toString('base64')}` });
  assert.deepEqual(await session.captureCanvasPng({
    frameSelectors: ['iframe[src*="/web/frame/recommend/"]',
      'iframe[src*="/web/frame/c-resume/"]'], canvasIndex: 1
  }), png);
  session.evaluate = async expression => expression.includes('const url = location.href;')
    ? { url: RECRUITER_URL }
    : { state: 'ready', dataUrl: 'data:image/png;base64,not-a-png' };
  await assert.rejects(session.captureCanvasPng(),
    error => error.code === 'BOSS_CDP_CANVAS_INVALID');
  session.close();
});

test('target expressions safely compile with exact card text containing quotes and line breaks', () => {
  const socket = new FakeWebSocket(PAGE_SOCKET);
  const session = new BossRawCdpSession(socket);
  const expression = session.targetExpression({
    frameSelector: 'iframe[src*="/web/frame/recommend/"]',
    selector: 'li.card-item', identityAttribute: 'textContent',
    identityValue: '候选人 "A"\n经验 5 年'
  });
  assert.doesNotThrow(() => new vm.Script(expression));
  assert.ok(expression.includes('btn-greet'));
  session.close();
});

test('captureRegionPng clips only a stable official resume overlay and retains pixels in memory', async () => {
  const socket = new FakeWebSocket(PAGE_SOCKET);
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  const session = new BossRawCdpSession(socket);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ'
    + 'AAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64');
  let clip = { x: 300, y: 90, width: 1, height: 1, scale: 1 };
  const calls = [];
  session.evaluate = async expression => {
    if (expression.includes('const url = location.href;')) return { url: RECRUITER_URL };
    assert.doesNotThrow(() => new vm.Script(expression));
    return { state: 'ready', clip, origin: 1, frameOrigin: 2 };
  };
  session.send = async (method, params) => {
    calls.push([method, params]);
    return method === 'Page.captureScreenshot' ? { data: png.toString('base64') } : {};
  };
  assert.deepEqual(await session.captureRegionPng({
    frameSelector: 'iframe[src*="/web/frame/recommend/"]',
    selector: '.dialog-wrap.active .resume-body'
  }), png);
  assert.deepEqual(calls.map(([method]) => method),
    ['Page.enable', 'Page.captureScreenshot']);
  assert.deepEqual(calls[1][1].clip, clip);
  clip = { ...clip, width: 600, height: 650 };
  await assert.rejects(session.captureRegionPng({
    frameSelector: 'iframe[src*="/web/frame/recommend/"]',
    selector: '.dialog-wrap.active .resume-body'
  }), error => error.code === 'BOSS_CDP_REGION_MISMATCH');
  assert.deepEqual(calls.map(([method]) => method),
    ['Page.enable', 'Page.captureScreenshot', 'Page.captureScreenshot']);
  session.close();
});

test('OCR screenshot timeout is bounded and identifies the command without retrying a screenshot', async () => {
  const socket = new FakeWebSocket(PAGE_SOCKET);
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  const session = new BossRawCdpSession(socket);
  session.evaluate = async expression => expression.includes('const url = location.href;')
    ? {url:RECRUITER_URL}
    : {state:'ready',clip:{x:100,y:100,width:400,height:500,scale:1},
      origin:1,frameOrigin:2};
  const commands=[];
  session.send = async (method,params,options) => {
    commands.push({method,timeoutMs:options.timeoutMs});
    if (method === 'Page.captureScreenshot') {
      const error=new Error('timeout');
      error.code='BOSS_CDP_TIMEOUT';
      throw error;
    }
    return {};
  };
  await assert.rejects(session.captureRegionPng({
    frameSelector:'iframe[src*="/web/frame/recommend/"]',
    selector:'.dialog-wrap.active .resume-detail-wrap',timeoutMs:20000
  }),error => error.code === 'BOSS_CDP_TIMEOUT' &&
    error.stage === 'capture_screenshot');
  assert.deepEqual(commands,[
    {method:'Page.enable',timeoutMs:20000},
    {method:'Page.captureScreenshot',timeoutMs:20000}
  ]);
  session.close();
});

test('captureRegionPng never screenshots outside the active resume overlay', async () => {
  const socket = new FakeWebSocket(PAGE_SOCKET);
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  const session = new BossRawCdpSession(socket);
  session.evaluate = async expression => expression.includes('const url = location.href;')
    ? { url: RECRUITER_URL } : { state: 'not_resume_overlay' };
  let screenshotCalls = 0;
  session.send = async () => { screenshotCalls++; return {}; };
  await assert.rejects(session.captureRegionPng({
    frameSelector: 'iframe[src*="/web/frame/recommend/"]',
    selector: 'body'
  }), error => error.code === 'BOSS_CDP_REGION_UNAVAILABLE');
  assert.equal(screenshotCalls, 0);
  session.close();
});

test('scrollOfficialResume changes only the official resume scroll container and checks frame identity', async () => {
  const socket = new FakeWebSocket(PAGE_SOCKET);
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  const session = new BossRawCdpSession(socket);
  const state = { outerUrl: '/web/frame/recommend/',
    resumeUrl: '/web/frame/c-resume/?source=recommend',
    url: RECRUITER_URL, origin: 1, frameOrigin: 2, resumeOrigin: 3 };
  let inspected = 0;
  session.evaluate = async expression => {
    if (expression.includes('const url = location.href;')) return { url: RECRUITER_URL };
    assert.doesNotThrow(() => new vm.Script(expression));
    inspected++;
    return { state: 'ready', x: 250, y: 400,
      before: inspected === 1 ? 0 : 600, max: 1700, ...state };
  };
  const commands = [];
  session.send = async (method, params) => { commands.push([method, params]); return {}; };
  assert.deepEqual(await session.scrollOfficialResume({
    frameSelector: 'iframe[src*="/web/frame/recommend/"]', deltaY: 600
  }), { before: 0, after: 600, max: 1700, ackTimedOut: false });
  assert.deepEqual(commands.map(([method]) => method), ['Input.dispatchMouseEvent']);
  assert.equal(commands[0][1].type, 'mouseWheel');
  assert.equal(commands[0][1].deltaY, 600);
  session.close();
});

test('scrollOfficialResume refuses missing official dialog and excessive scroll', async () => {
  const socket = new FakeWebSocket(PAGE_SOCKET);
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  const session = new BossRawCdpSession(socket);
  session.evaluate = async expression => expression.includes('const url = location.href;')
    ? { url: RECRUITER_URL } : { state: 'not_resume_overlay' };
  await assert.rejects(session.scrollOfficialResume({
    frameSelector: 'iframe[src*="/web/frame/recommend/"]', deltaY: 600
  }), error => error.code === 'BOSS_CDP_SCROLL_UNAVAILABLE');
  await assert.rejects(session.scrollOfficialResume({
    frameSelector: 'iframe[src*="/web/frame/recommend/"]', deltaY: 10000
  }), error => error.code === 'BOSS_CDP_INVALID_TARGET');
  session.close();
});

test('scrollOfficialResume recovers a timed-out wheel only by observing scroll position', async () => {
  const socket = new FakeWebSocket(PAGE_SOCKET);
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  const session = new BossRawCdpSession(socket);
  let reads = 0;
  session.evaluate = async expression => {
    if (expression.includes('const url = location.href;')) return { url: RECRUITER_URL };
    reads++;
    return { state: 'ready', url: RECRUITER_URL, x: 250, y: 400,
      before: reads === 1 ? 700 : 100, max: 1700,
      origin: 1, frameOrigin: 2, resumeOrigin: 3,
      outerUrl: '/web/frame/recommend/', resumeUrl: '/web/frame/c-resume/' };
  };
  let wheels = 0;
  session.send = async method => {
    if (method === 'Input.dispatchMouseEvent') wheels++;
    const error = new Error('CDP timeout');
    error.code = 'BOSS_CDP_TIMEOUT';
    throw error;
  };
  assert.deepEqual(await session.scrollOfficialResume({
    frameSelector: 'iframe[src*="/web/frame/recommend/"]', deltaY: -900
  }), { before: 700, after: 100, max: 1700, ackTimedOut: true });
  assert.equal(wheels, 1);
  session.close();
});

test('scrollOfficialResume never retries an uncertain wheel when observation also times out', async () => {
  const socket = new FakeWebSocket(PAGE_SOCKET);
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  const session = new BossRawCdpSession(socket);
  let reads = 0;
  session.evaluate = async expression => {
    if (expression.includes('const url = location.href;')) return { url: RECRUITER_URL };
    if (++reads === 1) return { state: 'ready', url: RECRUITER_URL,
      x: 250, y: 400, before: 0, max: 1700,
      origin: 1, frameOrigin: 2, resumeOrigin: 3,
      outerUrl: '/web/frame/recommend/', resumeUrl: '/web/frame/c-resume/' };
    const error = new Error('CDP timeout');
    error.code = 'BOSS_CDP_TIMEOUT';
    throw error;
  };
  let wheels = 0;
  session.send = async method => {
    if (method === 'Input.dispatchMouseEvent') wheels++;
    const error = new Error('CDP timeout');
    error.code = 'BOSS_CDP_TIMEOUT';
    throw error;
  };
  await assert.rejects(session.scrollOfficialResume({
    frameSelector: 'iframe[src*="/web/frame/recommend/"]', deltaY: 700
  }), error => error.code === 'BOSS_CDP_SCROLL_UNCERTAIN' &&
    error.stage === 'post_wheel_observation');
  assert.equal(wheels, 1);
  session.close();
});

test('raw CDP session works with the production ws client on an isolated local server', async () => {
  const server = new WebSocket.WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  server.on('connection', peer => {
    peer.on('message', bytes => {
      const request = JSON.parse(bytes.toString());
      peer.send(JSON.stringify({ id: request.id,
        result: { result: { type: 'number', value: 2 } } }));
    });
  });
  const client = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
  try {
    await once(client, 'open');
    const session = new BossRawCdpSession(client);
    assert.equal(await session.evaluate('1 + 1'), 2);
    session.close();
  } finally {
    try { client.close(); } catch {}
    await new Promise(resolve => server.close(resolve));
  }
});

test('setOfficialResumeScrollTop sets only a verified official pane once and confirms target', async () => {
  const socket = new FakeWebSocket(PAGE_SOCKET);
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  const session = new BossRawCdpSession(socket);
  const state = { state: 'ready', url: RECRUITER_URL, top: 700, max: 1701,
    origin: 1, frameOrigin: 2, resumeOrigin: 3,
    outerSrc: '/web/frame/recommend/', resumeSrc: '/web/frame/c-resume/' };
  let sets = 0;
  session.evaluate = async expression => {
    if (expression.includes('const url = location.href;')) return { url: RECRUITER_URL };
    assert.doesNotThrow(() => new vm.Script(expression));
    if (expression.includes("behavior: 'instant'")) {
      sets++;
      return { state: 'ready', before: 700, after: 0, max: 1701 };
    }
    return sets ? { ...state, top: 0 } : state;
  };
  assert.deepEqual(await session.setOfficialResumeScrollTop({
    frameSelector: 'iframe[src*="/web/frame/recommend/"]', targetTop: 0
  }), { before: 700, after: 0, max: 1701, ackTimedOut: false });
  assert.equal(sets, 1);
  session.close();
});

test('setOfficialResumeScrollTop recovers timed-out assignment with one read-only check', async () => {
  const socket = new FakeWebSocket(PAGE_SOCKET);
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  const session = new BossRawCdpSession(socket);
  const state = { state: 'ready', url: RECRUITER_URL, top: 700, max: 1701,
    origin: 1, frameOrigin: 2, resumeOrigin: 3,
    outerSrc: '/web/frame/recommend/', resumeSrc: '/web/frame/c-resume/' };
  let sets = 0;
  session.evaluate = async expression => {
    if (expression.includes('const url = location.href;')) return { url: RECRUITER_URL };
    if (expression.includes("behavior: 'instant'")) {
      sets++;
      const error = new Error('CDP timeout');
      error.code = 'BOSS_CDP_TIMEOUT';
      throw error;
    }
    return sets ? { ...state, top: 0 } : state;
  };
  assert.deepEqual(await session.setOfficialResumeScrollTop({
    frameSelector: 'iframe[src*="/web/frame/recommend/"]', targetTop: 0
  }), { before: 700, after: 0, max: 1701, ackTimedOut: true });
  assert.equal(sets, 1);
  session.close();
});

test('setOfficialResumeScrollTop fails before mutation for out-of-range target', async () => {
  const socket = new FakeWebSocket(PAGE_SOCKET);
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  const session = new BossRawCdpSession(socket);
  let sets = 0;
  session.evaluate = async expression => {
    if (expression.includes('const url = location.href;')) return { url: RECRUITER_URL };
    if (expression.includes("behavior: 'instant'")) sets++;
    return { state: 'ready', url: RECRUITER_URL, top: 700, max: 1701,
      origin: 1, frameOrigin: 2, resumeOrigin: 3,
      outerSrc: '/web/frame/recommend/', resumeSrc: '/web/frame/c-resume/' };
  };
  await assert.rejects(session.setOfficialResumeScrollTop({
    frameSelector: 'iframe[src*="/web/frame/recommend/"]', targetTop: 5000
  }), error => error.code === 'BOSS_CDP_INVALID_TARGET');
  assert.equal(sets, 0);
  session.close();
});

test('setOfficialResumeScrollTop reports numeric diagnostics if the site restores scrollTop', async () => {
  const socket = new FakeWebSocket(PAGE_SOCKET);
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  const session = new BossRawCdpSession(socket);
  const state = { state: 'ready', url: RECRUITER_URL, top: 100, max: 1701,
    scrollBehavior: 'smooth', scrollSnapType: 'none',
    clientHeight: 885, scrollHeight: 2586,
    origin: 1, frameOrigin: 2, resumeOrigin: 3,
    outerSrc: '/web/frame/recommend/', resumeSrc: '/web/frame/c-resume/' };
  session.evaluate = async expression => {
    if (expression.includes('const url = location.href;')) return { url: RECRUITER_URL };
    if (expression.includes("behavior: 'instant'")) {
      return { state: 'ready', before: 100, after: 0, max: 1701 };
    }
    return state;
  };
  await assert.rejects(session.setOfficialResumeScrollTop({
    frameSelector: 'iframe[src*="/web/frame/recommend/"]', targetTop: 0
  }), error => error.code === 'BOSS_CDP_SCROLL_UNCERTAIN' &&
    error.stage === 'post_scroll_observation' &&
    error.diagnostic.immediateTop === 0 &&
    error.diagnostic.observedTop === 100 &&
    error.diagnostic.scrollBehavior === 'smooth');
  session.close();
});

test('revealOfficialResumeClose scrolls only the main horizontal root to show official close', async () => {
  const socket = new FakeWebSocket(PAGE_SOCKET);
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  const session = new BossRawCdpSession(socket);
  const base = { state: 'ready', url: RECRUITER_URL, y: 100,
    viewportWidth: 929, viewportHeight: 768, max: 111,
    origin: 1, frameOrigin: 2, resumeOrigin: 3,
    outerSrc: '/web/frame/recommend/', resumeSrc: '/web/frame/c-resume/' };
  let mutations = 0;
  session.evaluate = async expression => {
    if (expression.includes('const url = location.href;')) return { url: RECRUITER_URL };
    assert.doesNotThrow(() => new vm.Script(expression));
    if (expression.includes('root.scrollLeft = ')) {
      mutations++;
      assert.ok(expression.includes('root.scrollLeft = 111'));
      return { state: 'ready', after: 111 };
    }
    return mutations ? { ...base, x: 911, before: 111, visible: true }
      : { ...base, x: 1022, before: 0, visible: false };
  };
  assert.deepEqual(await session.revealOfficialResumeClose({
    frameSelector: 'iframe[src*="/web/frame/recommend/"]'
  }), { before: 0, after: 111, max: 111, visible: true, ackTimedOut: false });
  assert.equal(mutations, 1);
  session.close();
});

test('revealOfficialResumeClose refuses unknown dialog without horizontal mutation', async () => {
  const socket = new FakeWebSocket(PAGE_SOCKET);
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  const session = new BossRawCdpSession(socket);
  let mutations = 0;
  session.evaluate = async expression => {
    if (expression.includes('const url = location.href;')) return { url: RECRUITER_URL };
    if (expression.includes('root.scrollLeft = ')) mutations++;
    return { state: 'resume_dialog_unavailable' };
  };
  await assert.rejects(session.revealOfficialResumeClose({
    frameSelector: 'iframe[src*="/web/frame/recommend/"]'
  }), error => error.code === 'BOSS_CDP_TARGET_UNAVAILABLE');
  assert.equal(mutations, 0);
  session.close();
});
