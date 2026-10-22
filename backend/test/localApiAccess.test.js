const { test } = require('node:test');
const assert = require('node:assert/strict');
const { localApiAccess } = require('../src/middleware/localApiAccess');

function check({ address = '127.0.0.1', host = '127.0.0.1:5001', origin,
  site } = {}) {
  let result = 'pending';
  const headers = { host, origin, 'sec-fetch-site': site };
  const req = { socket: { remoteAddress: address }, get: key => headers[key] };
  const res = { status(code) { result = code; return this; }, json() { return this; } };
  localApiAccess(req, res, () => { result = 'allowed'; });
  return result;
}

test('local frontend and local scripts can access the recruitment API', () => {
  assert.equal(check({ origin: 'http://localhost:3000' }), 'allowed');
  assert.equal(check({ origin: 'http://127.0.0.1:3000', site: 'cross-site' }), 'allowed');
  assert.equal(check(), 'allowed');
});

test('foreign origin, DNS rebinding host and remote clients cannot access resumes', () => {
  assert.equal(check({ origin: 'https://outside.example' }), 403);
  assert.equal(check({ host: 'outside.example:5001' }), 403);
  assert.equal(check({ address: '192.0.2.10' }), 403);
  assert.equal(check({ site: 'cross-site' }), 403);
});
