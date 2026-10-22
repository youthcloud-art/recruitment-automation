'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { createGateway, readConfig, boundaryError } = require('./gateway');

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
    frontendBuildDir: build, healthTimeoutMs: 100, ...options.gatewayOptions
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
  return { port, directory, build, requests, upgrades, backend, backendPort };
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
