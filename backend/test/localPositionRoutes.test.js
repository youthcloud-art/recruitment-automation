const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const positionService = require('../src/services/positionService');
const router = require('../src/routes/positions');

test('本地岗位创建接口可用，跨站请求被拒绝', async () => {
  const previous = positionService.createLocalPosition;
  positionService.createLocalPosition = async job => ({
    position: { id: 'position_test', title: job.title },
    job: { ...job, updatedAt: '2026-01-01T00:00:00Z' }, reused: false
  });
  const app = express();
  app.use(express.json());
  app.use('/api/positions', router);
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/positions/create-local`;
    const response = await fetch(url, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3000' },
      body: JSON.stringify({ job: { title: '项目经理主管', jobRequirements: '项目交付经验' } }) });
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.success, true);
    assert.equal(body.position.title, '项目经理主管');
    const denied = await fetch(url, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://another.example' },
      body: JSON.stringify({ job: { title: '恶意请求' } }) });
    assert.equal(denied.status, 403);
  } finally {
    positionService.createLocalPosition = previous;
    await new Promise(resolve => server.close(resolve));
  }
});
