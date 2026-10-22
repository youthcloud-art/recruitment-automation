const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveBindHost } = require('../src/config/localBind');

test('recruitment API binds to loopback by default', () => {
  assert.equal(resolveBindHost(), '127.0.0.1');
  assert.equal(resolveBindHost('localhost'), 'localhost');
  assert.equal(resolveBindHost('::1'), '::1');
});

test('unauthenticated public binding is rejected', () => {
  assert.throws(() => resolveBindHost('0.0.0.0'), /远程访问认证/);
  assert.throws(() => resolveBindHost('192.0.2.12'), /远程访问认证/);
});
