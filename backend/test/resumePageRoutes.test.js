const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createResumePageRouter } = require('../src/routes/resumePage');

test('opt-in candidate page endpoint validates filters and retains separate legacy contract', async t => {
  const calls = [];
  const store = {
    getResumeSources: () => [{ value: 'zlzp' }, { value: 'qcwy' }],
    getResumesPage: options => {
      calls.push(options);
      return { items: [{ id: 'one' }], total: 1200,
        limit: options.limit, offset: options.offset };
    }
  };
  const app = express();
  app.use('/api/resume-library/page', createResumePageRouter(store));
  app.get('/api/resume-library', (_req, res) => res.json(['legacy-contract']));
  const server = app.listen(0, '127.0.0.1');
  t.after(() => server.close());
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/api/resume-library/page?source=zlzp&status=new&keyword=网络&sortBy=experience&limit=25&offset=50`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true,
    data: { items: [{ id: 'one', hiringJobTitle: '招聘岗位待核实',
      platformRecordId: '', platformRecordKind: '',
      platformLocatorStatus: 'unavailable', platformRecordUrl: '' }],
      total: 1200, limit: 25, offset: 50 } });
  assert.deepEqual(calls[0], { source: 'zlzp', status: 'new', position: null,
    keyword: '网络', sortBy: 'experience', limit: 25, offset: 50 });
  assert.equal((await fetch(`${base}/api/resume-library/page?limit=-1`)).status, 400);
  assert.equal((await fetch(`${base}/api/resume-library/page?source=unknown`)).status, 400);
  assert.equal((await fetch(`${base}/api/resume-library/page?sortBy=invalid`)).status, 400);
  assert.equal((await fetch(`${base}/api/resume-library/page?keyword=${'x'.repeat(101)}`)).status, 400);
  assert.deepEqual(await (await fetch(`${base}/api/resume-library`)).json(), ['legacy-contract']);
});

test('resume page API projects legacy 51job labels without mutating source records', async t => {
  const record = { id: 'qcwy-1', source: 'qcwy', name: '通知', position: '通知',
    sourceRecordKey: 'e'.repeat(64),
    sourceUrl: 'https://ehire.51job.com/Revision/talent/resume/detail?resumeId=official-123',
    originalText: '通知\n工作经历：网络运维' };
  const app = express();
  app.use('/api/resume-library/page', createResumePageRouter({
    getResumeSources: () => [{ value: 'qcwy' }],
    getResumesPage: () => ({ items: [record], total: 1, limit: 10, offset: 0 })
  }));
  const server = app.listen(0, '127.0.0.1');
  t.after(() => server.close());
  await new Promise(resolve => server.once('listening', resolve));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/resume-library/page`);
  const data = (await response.json()).data.items[0];
  assert.equal(data.name, '姓名待核实');
  assert.equal(data.position, '求职岗位待核实');
  assert.equal(data.platformRecordId, 'official-123');
  assert.equal(data.originalText, undefined);
  assert.equal(record.name, '通知');
  assert.equal(record.position, '通知');
});
