const test = require('node:test');
const assert = require('node:assert/strict');
const router = require('../src/routes/bossZhipin');

async function callRoute(path, body = {}) {
  const layer = router.stack.find(item => item.route?.path === path);
  assert.ok(layer, `missing route ${path}`);
  const response = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
  await layer.route.stack[0].handle({ body }, response);
  return response;
}

test('BOSS 未实现的候选人操作明确失败，不虚报已执行', async () => {
  const response = await callRoute('/candidate-action',
    { candidateId: 'candidate-1', action: 'like' });
  assert.equal(response.statusCode, 501);
  assert.equal(response.body.success, false);
  assert.match(response.body.message, /未执行任何操作/);
});

test('旧版 BOSS Playwright 简历和导航入口全部返回 410', async () => {
  for (const path of ['/start-resume-processing','/stop-resume-processing',
    '/resume-processing-status','/process-resume','/navigate-to-communication',
    '/navigate-to-mode']) {
    const response = await callRoute(path, {mode:'communication'});
    assert.equal(response.statusCode, 410, path);
    assert.equal(response.body.success, false);
    assert.equal(response.body.code,'BOSS_LEGACY_FLOW_DISABLED');
    assert.match(response.body.message, /旧版 BOSS/);
  }
});
