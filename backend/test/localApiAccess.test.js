const { test } = require('node:test');
const assert = require('node:assert/strict');
const { localApiAccess, createLocalApiAccess } = require('../src/middleware/localApiAccess');

function check({ address = '127.0.0.1', host = '127.0.0.1:5001', origin,
  site } = {}, middleware = localApiAccess) {
  let result = 'pending';
  const headers = { host, origin, 'sec-fetch-site': site };
  const req = { socket: { remoteAddress: address }, get: key => headers[key] };
  const res = { status(code) { result = code; return this; }, json() { return this; } };
  middleware(req, res, () => { result = 'allowed'; });
  return result;
}

test('local frontend and local scripts can access the recruitment API', () => {
  assert.equal(check({ origin: 'http://localhost:3000' }), 'allowed');
  assert.equal(check({ origin: 'http://127.0.0.1:3000', site: 'cross-site' }), 'allowed');
  assert.equal(check(), 'allowed');
});

test('a configured company backend port retains the loopback and origin boundary', () => {
  const middleware = createLocalApiAccess({ port: 19501 });
  assert.equal(check({ host: '127.0.0.1:19501', origin: 'http://127.0.0.1:3000' }, middleware), 'allowed');
  assert.equal(check({ host: '[::1]:19501', origin: 'http://[::1]:19501' }, middleware), 'allowed');
  assert.equal(check({ host: 'localhost:19501' }, middleware), 'allowed');
  assert.equal(check({ host: '127.0.0.1:5001' }, middleware), 403);
  assert.equal(check({ host: 'outside.example:19501' }, middleware), 403);
  assert.equal(check({ host: '127.0.0.1:19501', address: '192.168.1.3' }, middleware), 403);
  assert.equal(check({ host: '127.0.0.1:19501', origin: 'http://127.0.0.1:5001' }, middleware), 403);
  assert.equal(check({ host: '127.0.0.1:19501', site: 'cross-site' }, middleware), 403);
  assert.throws(() => createLocalApiAccess({ port: '19501/path' }), /Invalid local backend port/);
});

test('foreign origin, DNS rebinding host and remote clients cannot access resumes', () => {
  assert.equal(check({ origin: 'https://outside.example' }), 403);
  assert.equal(check({ host: 'outside.example:5001' }), 403);
  assert.equal(check({ address: '192.0.2.10' }), 403);
  assert.equal(check({ site: 'cross-site' }), 403);
});
