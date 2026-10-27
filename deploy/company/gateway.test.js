'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { EventEmitter } = require('node:events');
const { createGateway, readConfig, boundaryError, isServerBrowser } = require('./gateway');
const { CompanyAuth } = require('./auth');

const PUBLIC_ORIGIN = 'http://192.168.1.24:4000';
const PUBLIC_HOST = '192.168.1.24:4000';

function syntheticRequest(address, headers = {}) {
  return { socket: { remoteAddress: address }, headers: { host: PUBLIC_HOST, ...headers } };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(server.address().port); });
  });
}

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'recruitment-gateway-test-'));
  const build = path.join(directory, 'build');
  await fs.mkdir(path.join(build, 'static'), { recursive: true });
  await fs.writeFile(path.join(build, 'index.html'), '<!doctype html><title>Recruitment test</title>');
  await fs.writeFile(path.join(build, 'static', 'app.js'), 'window.fixture = true;');
  const requests = [];
  const upgrades = [];
  const sockets = new Set();
  const backend = http.createServer((req, res) => {
    if (req.url === '/api/health') {
      res.writeHead(options.healthStatus ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: options.healthBody ?? 'ok' }));
      return;
    }
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const received = { headers: req.headers, method: req.method, url: req.url, body: Buffer.concat(chunks) };
      requests.push(received);
      res.writeHead(201, { 'content-type': 'application/json', 'x-fixture-response': 'proxied' });
      res.end(JSON.stringify({ size: received.body.length, url: req.url }));
    });
  });
  backend.on('upgrade', (req, socket, head) => {
    upgrades.push({ headers: req.headers, url: req.url });
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nserver-first');
    if (head.length) socket.write(head);
    socket.on('data', chunk => socket.write(chunk));
  });
  backend.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  const backendPort = await listen(backend);
  const gateway = createGateway({
    environment: {}, host: '192.168.1.24', publicOrigin: PUBLIC_ORIGIN, backendPort,
    frontendBuildDir: build, healthTimeoutMs: 100,
    authFile: options.authEnabled ? path.join(directory, 'shared', 'auth', 'users.json') : null,
    ...options.gatewayOptions
  });
  gateway.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  const port = await listen(gateway);
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all([gateway, backend].map(server => new Promise(resolve => server.close(resolve))));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { port, directory, build, requests, upgrades, backend, backendPort,
    authFile: path.join(directory, 'shared', 'auth', 'users.json') };
}

function jsonRequest(port, url, body, headers = {}) {
  return request(port, url, { method: 'POST', headers: {
    origin: PUBLIC_ORIGIN, 'content-type': 'application/json', ...headers
  }, chunks: [Buffer.from(JSON.stringify(body))] });
}

function request(port, url = '/', options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: url, method: options.method || 'GET',
      headers: { host: PUBLIC_HOST, ...options.headers }, agent: false
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, body: raw.toString(), raw });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    for (const chunk of options.chunks || []) req.write(chunk);
    req.end();
  });
}

function upgrade(port, headers = {}, url = '/socket.io/?EIO=4&transport=websocket') {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: url, agent: false,
      headers: { host: PUBLIC_HOST, origin: PUBLIC_ORIGIN, connection: 'Upgrade', upgrade: 'websocket', ...headers }
    });
    req.on('error', reject);
    req.on('response', response => {
      response.resume();
      response.on('end', () => resolve({ status: response.statusCode }));
    });
    req.on('upgrade', (response, socket, head) => resolve({ status: response.statusCode, socket, head }));
    req.end();
  });
}

test('configuration matches the company network and rejects malformed access rules', () => {
  const config = readConfig({ environment: {} });
  assert.equal(config.host, '192.168.1.24');
  assert.equal(config.port, 4000);
  assert.equal(config.backendPort, 5001);
  assert.equal(config.publicOrigin, PUBLIC_ORIGIN);
  assert.equal(config.frontendBuildDir, path.resolve(__dirname, '../../frontend/build'));
  assert.throws(() => readConfig({ environment: { LAN_ALLOW_CIDRS: '192.168.1.999/24' } }), /LAN_ALLOW_CIDRS/);
  assert.throws(() => readConfig({ environment: { COMPANY_PORT: '0' } }), /COMPANY_PORT/);
  assert.throws(() => readConfig({ environment: { PUBLIC_ORIGIN: 'https://example.test/path' } }), /PUBLIC_ORIGIN/);
});

test('LAN source check uses the socket and refuses spoofed forwarding headers', () => {
  const config = readConfig({ environment: {} });
  for (const address of ['192.168.1.10', '192.168.11.20', '::ffff:192.168.1.100', '127.0.0.1', '::1']) {
    assert.equal(boundaryError(syntheticRequest(address), config, '/api/positions'), null, address);
  }
  const outsider = syntheticRequest('203.0.113.10', {
    'x-forwarded-for': '192.168.1.10', 'x-real-ip': '127.0.0.1', forwarded: 'for=192.168.11.20'
  });
  assert.match(boundaryError(outsider, config, '/api/positions'), /公司网段/);
  const expanded = readConfig({ environment: { LAN_ALLOW_CIDRS: '10.20.0.0/16' } });
  assert.equal(boundaryError(syntheticRequest('10.20.1.22'), expanded, '/api/positions'), null);
  assert.match(boundaryError(syntheticRequest('192.168.1.22'), expanded, '/api/positions'), /公司网段/);
});

test('company network list reloads from the installed config without restarting the gateway', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'recruitment-network-config-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const configFile = path.join(directory, 'config.json');
  await fs.writeFile(configFile, JSON.stringify({ allowedNetworks: ['192.168.1.0/24'] }));
  const config = readConfig({ environment: {}, networkConfigFile: configFile, networkCheckIntervalMs: 0 });
  assert.match(boundaryError(syntheticRequest('192.168.69.230'), config, '/healthz'), /公司网段/);
  await fs.writeFile(configFile, JSON.stringify({ allowedNetworks: ['192.168.1.0/24', '192.168.69.0/24'] }));
  assert.equal(boundaryError(syntheticRequest('192.168.69.230'), config, '/healthz'), null);
  await fs.writeFile(configFile, '{broken');
  assert.equal(boundaryError(syntheticRequest('192.168.69.230'), config, '/healthz'), null);
  assert.ok(config.networkReloadError);
  assert.throws(() => readConfig({ environment: {}, networkConfigFile: path.join(directory, 'missing.json') }));

  await fs.writeFile(configFile, JSON.stringify({ allowedNetworks: ['192.168.1.0/24', '192.168.69.0/24'] }));
  const local = await fixture(t, { gatewayOptions: { networkConfigFile: configFile, networkCheckIntervalMs: 0 } });
  const response = await request(local.port, '/__company/network-access');
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body).data.allowedNetworks, ['192.168.1.0/24', '192.168.69.0/24']);
  await fs.writeFile(configFile, JSON.stringify({ allowedNetworks: ['192.168.1.0/24'] }));
  const reloaded = await request(local.port, '/__company/network-access');
  assert.deepEqual(JSON.parse(reloaded.body).data.allowedNetworks, ['192.168.1.0/24']);
  const remote = await fixture(t, { gatewayOptions: {
    networkConfigFile: configFile, networkCheckIntervalMs: 0, isServerBrowser: () => false
  } });
  assert.equal((await request(remote.port, '/__company/network-access')).status, 403);
});

test('installed release locates the shared deployment network config', async t => {
  const install = await fs.mkdtemp(path.join(os.tmpdir(), 'recruitment-installed-gateway-test-'));
  t.after(() => fs.rm(install, { recursive: true, force: true }));
  const code = path.join(install, 'releases', 'example', 'deploy', 'company', 'gateway.js');
  await fs.mkdir(path.dirname(code), { recursive: true });
  await fs.mkdir(path.join(install, 'delivery'), { recursive: true });
  await fs.copyFile(path.join(__dirname, 'gateway.js'), code);
  await fs.copyFile(path.join(__dirname, 'auth.js'), path.join(path.dirname(code), 'auth.js'));
  await fs.writeFile(path.join(install, 'delivery', 'config.json'),
    JSON.stringify({ allowedNetworks: ['192.168.1.0/24', '192.168.69.0/24'] }));
  const installed = require(code).readConfig({ environment: {} });
  assert.equal(boundaryError(syntheticRequest('192.168.69.230'), installed, '/healthz'), null);
  assert.equal(installed.networkConfigFile, path.join(install, 'delivery', 'config.json'));
  assert.equal(installed.authFile, path.join(install, 'shared', 'auth', 'users.json'));
});

test('company login guards APIs and sockets, persists Mark, and invalidates logout', async t => {
  const app = await fixture(t, { authEnabled: true });
  assert.equal((await request(app.port, '/healthz')).status, 200);
  assert.equal((await request(app.port, '/api/positions')).status, 401);
  assert.equal((await request(app.port, '/socket.io/?EIO=4&transport=polling')).status, 401);
  assert.equal((await upgrade(app.port)).status, 401);
  assert.equal((await request(app.port, '/api/auth/session')).status, 200);
  const setupState = JSON.parse((await request(app.port, '/api/auth/session')).body).data;
  assert.equal(setupState.setupRequired, true);
  assert.equal(setupState.canSetup, true);
  const password = 'Test-only-password-2026!';
  const setup = await jsonRequest(app.port, '/api/auth/setup', { adminPassword: password });
  assert.equal(setup.status, 200);
  assert.match(setup.headers['set-cookie'][0], /HttpOnly; Path=\/; SameSite=Strict/);
  assert.doesNotMatch(await fs.readFile(app.authFile, 'utf8'), /Test-only-password/);
  const cookie = setup.headers['set-cookie'][0].split(';')[0];
  const current = JSON.parse((await request(app.port, '/api/auth/session', { headers: { cookie } })).body).data;
  assert.equal(current.user.name, 'Mark');
  assert.equal(current.user.role, 'admin');
  assert.equal(current.authenticated, true);
  const proxied = await request(app.port, '/api/positions', { headers: { cookie } });
  assert.equal(proxied.status, 201);
  assert.equal(app.requests.at(-1).headers.cookie, undefined);
  for (const route of ['/api/boss-zhipin/start-browsing', '/api/zhilian/start-browsing',
    '/api/wuyou/collect-batch']) {
    const started = await jsonRequest(app.port, route, { fixture: true }, { cookie });
    assert.equal(started.status, 201, route);
    assert.equal(app.requests.at(-1).url, route);
  }
  const model = await request(app.port, '/api/model-config', { method: 'PUT',
    headers: { cookie, origin: PUBLIC_ORIGIN, 'content-type': 'application/json' },
    chunks: [Buffer.from('{"model":"deepseek-chat"}')] });
  assert.equal(model.status, 201);
  const upload = await request(app.port, '/api/resume-library/delete-all', {
    method: 'DELETE', headers: { cookie, origin: PUBLIC_ORIGIN }
  });
  assert.equal(upload.status, 201);
  const upgraded = await upgrade(app.port, { cookie });
  assert.equal(upgraded.status, 101);
  upgraded.socket.on('error', () => {});
  upgraded.socket.destroy();
  const logout = await jsonRequest(app.port, '/api/auth/logout', {}, { cookie });
  assert.equal(logout.status, 200);
  assert.equal((await request(app.port, '/api/positions', { headers: { cookie } })).status, 401);
  assert.equal((await upgrade(app.port, { cookie })).status, 401);
  assert.equal((await jsonRequest(app.port, '/api/auth/login', {
    username: 'HRwang', password
  })).status, 401);
  const login = await jsonRequest(app.port, '/api/auth/login', { username: 'Mark', password });
  assert.equal(login.status, 200);
  assert.equal((await request(app.port, '/api/positions', {
    headers: { cookie: login.headers['set-cookie'][0].split(';')[0] }
  })).status, 201);
});

test('failed logins are limited and an active browser renews its persistent login', async t => {
  let time = 1_800_000_000_000;
  const day = 24 * 60 * 60 * 1000;
  const app = await fixture(t, { authEnabled: true, gatewayOptions: { authNow: () => time } });
  const password = 'Example-password-2026!';
  const setup = await jsonRequest(app.port, '/api/auth/setup', { adminPassword: password });
  const cookie = setup.headers['set-cookie'][0].split(';')[0];
  for (let attempt = 0; attempt < 5; attempt++) {
    assert.equal((await jsonRequest(app.port, '/api/auth/login', {
      username: 'Mark', password: 'incorrect-password'
    })).status, 401);
  }
  assert.equal((await jsonRequest(app.port, '/api/auth/login', {
    username: 'Mark', password
  })).status, 429);
  time += 16 * 60 * 1000;
  assert.equal((await jsonRequest(app.port, '/api/auth/login', {
    username: 'Mark', password
  })).status, 200);
  time += 13 * 60 * 60 * 1000;
  assert.equal((await request(app.port, '/api/recruitment-pipeline/candidates', {
    headers: { cookie }
  })).status, 201);
  assert.equal((await request(app.port, '/api/auth/session', { headers: { cookie } })).headers['set-cookie'], undefined);
  time += 336 * day;
  const renewal = await request(app.port, '/api/auth/session', { headers: { cookie } });
  assert.equal(renewal.status, 200);
  const renewedCookie = renewal.headers['set-cookie'][0].split(';')[0];
  assert.match(renewal.headers['set-cookie'][0], /Max-Age=31536000/);
  time += 30 * day;
  assert.equal((await request(app.port, '/api/recruitment-pipeline/candidates', {
    headers: { cookie }
  })).status, 401);
  assert.equal((await request(app.port, '/api/recruitment-pipeline/candidates', {
    headers: { cookie: renewedCookie }
  })).status, 201);
});

test('a year-long session does not overflow the socket expiry timer', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'recruitment-auth-timer-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const time = 1_800_000_000_000;
  const auth = new CompanyAuth(path.join(directory, 'users.json'), { now: () => time });
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.destroy = () => { socket.destroyed = true; socket.emit('close'); };
  auth.trackSocket({ name: 'Mark', expiresAt: time + 365 * 24 * 60 * 60 * 1000 }, socket);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(socket.destroyed, false);
  socket.destroy();
});

test('an existing twelve-hour login is renewed without asking for a password', async t => {
  const time = 1_800_000_000_000;
  const app = await fixture(t, { authEnabled: true, gatewayOptions: { authNow: () => time } });
  assert.equal((await jsonRequest(app.port, '/api/auth/setup', {
    adminPassword: 'Migration-test-password-2026!'
  })).status, 200);
  const state = JSON.parse(await fs.readFile(app.authFile, 'utf8'));
  const payload = Buffer.from(JSON.stringify({ name: 'Mark', version: 1,
    issuedAt: time - 60 * 60 * 1000, expiresAt: time + 11 * 60 * 60 * 1000,
    nonce: 'existing-browser' })).toString('base64url');
  const signature = crypto.createHmac('sha256', Buffer.from(state.secret, 'base64'))
    .update(payload).digest('base64url');
  const oldCookie = `hiresmart_session=${payload}.${signature}`;
  const response = await request(app.port, '/api/auth/session', { headers: { cookie: oldCookie } });
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body).data.authenticated, true);
  assert.match(response.headers['set-cookie'][0], /Max-Age=31536000/);
});

test('setup is server-local and password change revokes the old session', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'recruitment-auth-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const authFile = path.join(directory, 'users.json');
  const remote = await fixture(t, { gatewayOptions: { authFile, isServerBrowser: () => false } });
  assert.equal((await jsonRequest(remote.port, '/api/auth/setup', {
    adminPassword: 'Example-password-2026!'
  })).status, 403);
  assert.equal(JSON.parse((await request(remote.port, '/api/auth/session')).body).data.canSetup, false);
  const local = await fixture(t, { gatewayOptions: { authFile, isServerBrowser: () => true } });
  const setup = await jsonRequest(local.port, '/api/auth/setup', { adminPassword: 'Example-password-2026!' });
  assert.equal(setup.status, 200);
  const cookie = setup.headers['set-cookie'][0].split(';')[0];
  assert.equal((await jsonRequest(local.port, '/api/auth/password', {
    currentPassword: 'wrong', newPassword: 'Another-password-2026!'
  }, { cookie })).status, 400);
  assert.equal((await jsonRequest(local.port, '/api/auth/password', {
    currentPassword: 'Example-password-2026!', newPassword: 'Another-password-2026!'
  }, { cookie })).status, 200);
  assert.equal((await request(local.port, '/api/positions', { headers: { cookie } })).status, 401);
  assert.equal((await jsonRequest(local.port, '/api/auth/login', {
    username: 'Mark', password: 'Example-password-2026!'
  })).status, 401);
  const renewed = await jsonRequest(local.port, '/api/auth/login', {
    username: 'Mark', password: 'Another-password-2026!'
  });
  assert.equal(renewed.status, 200);
  // A new gateway process reads the shared account file and accepts its session.
  const restarted = await fixture(t, { gatewayOptions: { authFile } });
  assert.equal((await request(restarted.port, '/api/positions', {
    headers: { cookie: renewed.headers['set-cookie'][0].split(';')[0] }
  })).status, 201);
  const remoteAfterSetup = await fixture(t, { gatewayOptions: {
    authFile, isServerBrowser: () => false
  } });
  const renewedCookie = renewed.headers['set-cookie'][0].split(';')[0];
  assert.equal((await request(remoteAfterSetup.port, '/api/positions', {
    headers: { cookie: renewedCookie }
  })).status, 201);
  assert.equal((await request(remoteAfterSetup.port, '/api/model-config', { method: 'PUT',
    headers: { cookie: renewedCookie, origin: PUBLIC_ORIGIN }
  })).status, 403);
});

test('模型配置只认本机 TCP 连接，转发头和 Host 不能伪装为服务器', async t => {
  assert.equal(isServerBrowser({ socket: { remoteAddress: '192.168.1.24',
    localAddress: '192.168.1.24' } }), true);
  assert.equal(isServerBrowser({ socket: { remoteAddress: '::ffff:192.168.1.24',
    localAddress: '::ffff:192.168.1.24' } }), true);
  assert.equal(isServerBrowser({ socket: { remoteAddress: '192.168.1.58',
    localAddress: '192.168.1.24' }, headers: { 'x-forwarded-for': '192.168.1.24' } }), false);
  const app = await fixture(t);
  const access = await request(app.port, '/api/model-config/access');
  assert.equal(JSON.parse(access.body).data.canEdit, true);
  const save = await request(app.port, '/api/model-config', { method: 'PUT',
    headers: { origin: PUBLIC_ORIGIN, 'content-type': 'application/json' },
    chunks: [Buffer.from('{"model":"deepseek-chat"}')] });
  assert.equal(save.status, 201);
  assert.equal(app.requests.at(-1).url, '/api/model-config');
  const remote = await fixture(t, { gatewayOptions: { isServerBrowser: () => false } });
  const remoteAccess = await request(remote.port, '/api/model-config/access');
  assert.equal(JSON.parse(remoteAccess.body).data.canEdit, false);
  for (const [url, method] of [['/api/model-config', 'PUT'], ['/api/model-config/test', 'POST']]) {
    const denied = await request(remote.port, url, { method, headers: {
      origin: PUBLIC_ORIGIN, 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '192.168.1.24'
    } });
    assert.equal(denied.status, 403);
  }
  assert.equal(remote.requests.length, 0);
});

test('Host, Origin and fetch metadata prevent rebinding and cross-site access', () => {
  const config = readConfig({ environment: {} });
  assert.equal(boundaryError(syntheticRequest('192.168.1.10', { origin: PUBLIC_ORIGIN }), config, '/'), null);
  for (const headers of [
    { host: 'evil.example:4000' }, { origin: 'https://evil.example' },
    { origin: 'http://192.168.1.24:4001' }, { origin: 'null' },
    { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }
  ]) assert.ok(boundaryError(syntheticRequest('192.168.1.10', headers), config, '/api/positions'));
  assert.equal(boundaryError(syntheticRequest('127.0.0.1', { host: '127.0.0.1:4000' }), config, '/healthz'), null);
  assert.ok(boundaryError(syntheticRequest('127.0.0.1', { host: '127.0.0.1:4000' }), config, '/api/positions'));
  assert.ok(boundaryError(syntheticRequest('192.168.1.10', { host: '127.0.0.1:4000' }), config, '/healthz'));
  const custom = readConfig({ environment: { PUBLIC_ORIGIN: 'https://recruitment.example.test' } });
  assert.equal(boundaryError(syntheticRequest('192.168.1.10', {
    host: 'recruitment.example.test', origin: 'https://recruitment.example.test'
  }), custom, '/'), null);
});

test('HTTP upload and Socket.IO polling preserve streams, URL and backend-safe headers', async t => {
  const app = await fixture(t);
  const chunks = [Buffer.alloc(131072, 'a'), Buffer.alloc(131072, 'b')];
  const response = await request(app.port, '/api/resume-library/upload?source=manual', {
    method: 'POST', chunks,
    headers: {
      origin: PUBLIC_ORIGIN, 'content-type': 'multipart/form-data; boundary=fixture',
      'x-forwarded-for': '203.0.113.2', forwarded: 'for=203.0.113.2',
      'x-real-ip': '203.0.113.2', 'sec-fetch-site': 'same-origin'
    }
  });
  assert.equal(response.status, 201);
  assert.equal(response.headers['x-fixture-response'], 'proxied');
  assert.deepEqual(app.requests[0].body, Buffer.concat(chunks));
  assert.equal(app.requests[0].headers.host, `127.0.0.1:${app.backendPort}`);
  assert.equal(app.requests[0].headers.origin, 'http://127.0.0.1:3000');
  assert.equal(app.requests[0].headers['sec-fetch-site'], 'same-origin');
  assert.equal(app.requests[0].headers['content-type'], 'multipart/form-data; boundary=fixture');
  assert.equal(app.requests[0].headers['x-forwarded-for'], undefined);
  assert.equal(app.requests[0].headers.forwarded, undefined);
  assert.equal(app.requests[0].headers['x-real-ip'], undefined);
  const polling = await request(app.port, '/socket.io/?EIO=4&transport=polling&t=123');
  assert.equal(polling.status, 201);
  assert.equal(JSON.parse(polling.body).url, '/socket.io/?EIO=4&transport=polling&t=123');
});

test('HTTP boundary rejects unsafe origins before they reach the backend', async t => {
  const app = await fixture(t);
  for (const headers of [{ origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }, { host: 'evil.example' }]) {
    assert.equal((await request(app.port, '/api/positions', { headers })).status, 403);
  }
  assert.equal(app.requests.length, 0);
});

test('SPA navigation works while missing assets, traversal and hidden files stay inaccessible', async t => {
  const app = await fixture(t);
  const home = await request(app.port);
  const navigation = await request(app.port, '/recruitment/current');
  assert.equal(home.status, 200);
  assert.equal(navigation.body, home.body);
  assert.equal(home.headers['cache-control'], 'no-store');
  const asset = await request(app.port, '/static/app.js');
  assert.equal(asset.status, 200);
  assert.match(asset.headers['content-type'], /javascript/);
  assert.equal((await request(app.port, '/static/missing.js')).status, 404);
  assert.equal((await request(app.port, '/%2e%2e/package.json')).status, 400);
  assert.equal((await request(app.port, '/..%5cpackage.json')).status, 400);
  assert.equal((await request(app.port, '/.env')).status, 403);
  assert.equal((await request(app.port, '/%invalid')).status, 400);
  assert.equal((await request(app.port, '/', { method: 'HEAD' })).body, '');
});

test('large static assets use negotiated compression without changing API or identity responses', async t => {
  const app = await fixture(t);
  const source = 'window.fixture = "' + 'a'.repeat(20000) + '";';
  await fs.writeFile(path.join(app.build, 'static', 'large.js'), source);
  const br = await request(app.port, '/static/large.js', { headers: { 'accept-encoding': 'gzip, br' } });
  assert.equal(br.status, 200);
  assert.equal(br.headers['content-encoding'], 'br');
  assert.equal(br.headers.vary, 'Accept-Encoding');
  assert.equal(zlib.brotliDecompressSync(br.raw).toString(), source);
  assert.ok(br.raw.length < Buffer.byteLength(source) / 2);
  const brAgain = await request(app.port, '/static/large.js', { headers: { 'accept-encoding': 'gzip, br' } });
  assert.deepEqual(brAgain.raw, br.raw);
  const gzip = await request(app.port, '/static/large.js', { headers: { 'accept-encoding': 'br;q=0, gzip' } });
  assert.equal(gzip.headers['content-encoding'], 'gzip');
  assert.equal(zlib.gunzipSync(gzip.raw).toString(), source);
  const identity = await request(app.port, '/static/large.js', { headers: { 'accept-encoding': 'br;q=0, gzip;q=0' } });
  assert.equal(identity.headers['content-encoding'], undefined);
  assert.equal(identity.body, source);
  const head = await request(app.port, '/static/large.js', { method: 'HEAD', headers: { 'accept-encoding': 'br' } });
  assert.equal(head.headers['content-encoding'], 'br');
  assert.equal(head.raw.length, 0);
  const changed = source + 'window.updated = true;';
  await fs.writeFile(path.join(app.build, 'static', 'large.js'), changed);
  const updated = await request(app.port, '/static/large.js', { headers: { 'accept-encoding': 'br' } });
  assert.equal(zlib.brotliDecompressSync(updated.raw).toString(), changed);
});

test('static files cannot escape the build directory through a junction or symlink', async t => {
  const app = await fixture(t);
  const outside = path.join(app.directory, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'private.txt'), 'fixture outside build');
  try { await fs.symlink(outside, path.join(app.build, 'escape'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('host does not allow test symlinks'); return; }
    throw error;
  }
  assert.equal((await request(app.port, '/escape/private.txt')).status, 403);
});

test('deployment health checks both frontend and the backend JSON result', async t => {
  const app = await fixture(t);
  const healthy = await request(app.port, '/healthz', { headers: { host: '127.0.0.1:4000' } });
  assert.equal(healthy.status, 200);
  assert.deepEqual(JSON.parse(healthy.body), { status: 'ok', frontend: 'ok', backend: 'ok' });
  await fs.rename(path.join(app.build, 'index.html'), path.join(app.build, 'index.saved'));
  assert.equal((await request(app.port, '/healthz')).status, 503);
  await fs.rename(path.join(app.build, 'index.saved'), path.join(app.build, 'index.html'));
  await new Promise(resolve => app.backend.close(resolve));
  const unavailable = await request(app.port, '/healthz');
  assert.equal(unavailable.status, 503);
  assert.equal(JSON.parse(unavailable.body).backend, 'unavailable');
  assert.equal((await request(app.port, '/api/positions')).status, 502);
  assert.equal((await upgrade(app.port)).status, 502);
});

test('health never treats an HTTP-200 backend error payload as ready', async t => {
  const app = await fixture(t, { healthBody: 'error' });
  assert.equal((await request(app.port, '/healthz')).status, 503);
});

test('a rejected async health probe returns an error without killing the gateway', async t => {
  const app = await fixture(t, { gatewayOptions: {
    backendHealthy: async () => { throw new Error('simulated probe failure'); }
  } });
  assert.equal((await request(app.port, '/healthz')).status, 500);
  assert.equal((await request(app.port, '/')).status, 200);
});

test('WebSocket upgrade shares the HTTP boundary and tunnels both directions', async t => {
  const app = await fixture(t);
  for (const headers of [
    { origin: 'https://evil.example' }, { host: 'evil.example' }, { 'sec-fetch-site': 'cross-site' }
  ]) assert.equal((await upgrade(app.port, headers)).status, 403);
  assert.equal((await upgrade(app.port, {}, '/api/positions')).status, 404);
  assert.equal(app.upgrades.length, 0);
  const connection = await upgrade(app.port, { 'x-forwarded-for': '203.0.113.2' });
  assert.equal(connection.status, 101);
  const payload = await new Promise((resolve, reject) => {
    let received = connection.head.toString();
    const timeout = setTimeout(() => reject(new Error('WebSocket tunnel timed out')), 2000);
    connection.socket.on('data', chunk => {
      received += chunk.toString();
      if (received.includes('server-first') && received.includes('client-message')) {
        clearTimeout(timeout);
        resolve(received);
      }
    });
    connection.socket.on('error', reject);
    connection.socket.write('client-message');
  });
  connection.socket.destroy();
  assert.match(payload, /server-first/);
  assert.match(payload, /client-message/);
  assert.equal(app.upgrades[0].url, '/socket.io/?EIO=4&transport=websocket');
  assert.equal(app.upgrades[0].headers.host, `127.0.0.1:${app.backendPort}`);
  assert.equal(app.upgrades[0].headers.origin, 'http://127.0.0.1:3000');
  assert.equal(app.upgrades[0].headers['sec-fetch-site'], 'same-origin');
  assert.equal(app.upgrades[0].headers['x-forwarded-for'], undefined);
});
