const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createResumeDetailHandler } = require('../src/routes/resumeDetail');

async function serve(t, store) {
  const app = express();
  app.get('/api/resume/:id', createResumeDetailHandler(store));
  const server = app.listen(0, '127.0.0.1');
  t.after(() => server.close());
  await new Promise(resolve => server.once('listening', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

test('detail loads one ID through indexed store method without reading full library', async t => {
  const calls = [];
  const base = await serve(t, {
    getResumeById: id => {
      calls.push(id);
      return id === 'boss-1' ? { id, source: 'boss', name: '候选人甲',
        originalText: '仅甲的完整简历' } : null;
    },
    getResumes: () => { throw new Error('full library must not be loaded'); }
  });
  const response = await fetch(`${base}/api/resume/boss-1`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  const body = await response.json();
  assert.deepEqual(body, { success: true, data: { id: 'boss-1', source: 'boss',
    name: '候选人甲', originalText: '仅甲的完整简历',
    hiringJobTitle: '招聘岗位待核实' } });
  assert.deepEqual(calls, ['boss-1']);
  assert.doesNotMatch(JSON.stringify(body), /候选人乙/);
});

test('detail retains 51job anonymous display projection without changing stored evidence', async t => {
  const record = { id: 'qcwy-1', source: 'qcwy', name: '通知', position: '通知',
    sourceRecordKey: 'e'.repeat(64), originalText: '通知\n工作经历：网络运维' };
  const base = await serve(t, { getResumeById: () => record });
  const response = await fetch(`${base}/api/resume/qcwy-1`);
  assert.equal(response.status, 200);
  const body = (await response.json()).data;
  assert.equal(body.name, '姓名待核实');
  assert.equal(body.position, '求职岗位待核实');
  assert.equal(body.originalText, record.originalText);
  assert.equal(record.name, '通知');
  assert.equal(record.position, '通知');
});

test('legacy list-only stores still resolve detail, missing IDs return no-store 404', async t => {
  const base = await serve(t, { getResumes: () => [{ id: 'legacy-1', source: 'manual',
    originalText: '旧版简历正文' }] });
  const found = await fetch(`${base}/api/resume/legacy-1`);
  assert.equal(found.status, 200);
  assert.equal((await found.json()).data.originalText, '旧版简历正文');
  const missing = await fetch(`${base}/api/resume/missing`);
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(await missing.json(), { success: false, message: '简历不存在' });
});

test('storage errors never echo private record text in detail response', async t => {
  const base = await serve(t, { getResumeById: () => {
    throw new Error('private-phone-13800000000');
  } });
  const oldError = console.error;
  console.error = () => {};
  try {
    const response = await fetch(`${base}/api/resume/broken`);
    assert.equal(response.status, 500);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    const body = await response.text();
    assert.deepEqual(JSON.parse(body), { success: false, message: '获取简历详情失败' });
    assert.doesNotMatch(body, /private-phone/);
  } finally { console.error = oldError; }
});
