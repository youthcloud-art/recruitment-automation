const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

// The route tests never start a browser, read stored resumes, or contact 51Job.
function loadRouter(calls, failures = {}) {
  const servicePath = require.resolve('../src/services/wuyouService');
  const routePath = require.resolve('../src/routes/wuyou');
  const previousService = require.cache[servicePath];
  const previousRoute = require.cache[routePath];
  class FakeWuyouService {
    run(action, data, result) {
      calls.push({ action, data });
      if (failures[action]) throw new Error(failures[action]);
      return result;
    }
    async getStatus() { return this.run('status', null, { status: 'ready' }); }
    async start() { return this.run('start', null, { hasBrowser: true }); }
    async stop() { return this.run('stop', null, { hasBrowser: false }); }
    async search(keyword) { return this.run('search', keyword, { submitted: true }); }
    async selectEducationFilter(value) {
      return this.run('education-filter', value, { value, applied: true, changed: true });
    }
    async scanCandidateLinks() {
      return this.run('candidate-links', null, [
        { title: '候选人甲', url: 'https://ehire.51job.com/candidate/1' },
        { title: '候选人乙', url: 'https://ehire.51job.com/candidate/2' }
      ]);
    }
    async collectCurrent() {
      return this.run('collect-current', null, {
        saved: true, duplicate: false, resume: { id: 'resume-1', name: '候选人甲' }
      });
    }
    async startBatch(options) {
      return this.run('collect-batch', options, { running: true, targetCount: options.targetCount });
    }
    async startKeywordBatch(options) {
      return this.run('keyword-batch', options, { running: true, targetCount: options.targetCount });
    }
    async stopBatch() { return this.run('stop-batch', null, { running: false }); }
  }
  try {
    require.cache[servicePath] = { id: servicePath, filename: servicePath, loaded: true,
      exports: { WuyouService: FakeWuyouService } };
    delete require.cache[routePath];
    return require(routePath);
  } finally {
    if (previousService) require.cache[servicePath] = previousService;
    else delete require.cache[servicePath];
    if (previousRoute) require.cache[routePath] = previousRoute;
    else delete require.cache[routePath];
  }
}

async function withServer(t, calls, failures = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api/wuyou', loadRouter(calls, failures));
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  return `http://127.0.0.1:${server.address().port}/api/wuyou`;
}

async function request(baseUrl, endpoint, body, method = 'POST') {
  const response = await fetch(baseUrl + endpoint, {
    method,
    ...(method === 'POST' ? {
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
    } : {})
  });
  return { status: response.status, body: await response.json() };
}

test('51Job collection routes invoke the browser service and omit candidate identity from link scan', async t => {
  const calls = [];
  const baseUrl = await withServer(t, calls);

  const links = await request(baseUrl, '/candidate-links', null, 'GET');
  assert.equal(links.status, 200);
  assert.deepEqual(links.body.data, { count: 2 });
  assert.doesNotMatch(JSON.stringify(links.body), /候选人甲|candidate\/1/);

  const current = await request(baseUrl, '/collect-current', {});
  assert.equal(current.status, 200);
  assert.deepEqual(current.body.data, { saved: true, duplicate: false, resumeId: 'resume-1' });
  assert.doesNotMatch(JSON.stringify(current.body), /候选人甲/);

  const batch = await request(baseUrl, '/collect-batch', { targetCount: 5 });
  assert.equal(batch.status, 200);
  assert.equal(batch.body.data.targetCount, 5);
  assert.deepEqual(calls.at(-1), { action: 'collect-batch', data: { targetCount: 5 } });

  const defaultBatch = await request(baseUrl, '/collect-batch', {});
  assert.equal(defaultBatch.body.data.targetCount, 30);

  const keywordBatch = await request(baseUrl, '/keyword-batch', {
    keywords: ' 成本核算经理，成本核算主管,成本核算经理 ', targetCount: 18
  });
  assert.equal(keywordBatch.status, 200);
  assert.deepEqual(calls.at(-1), { action: 'keyword-batch', data: {
    keywords: ['成本核算经理', '成本核算主管'], targetCount: 18
  } });

  const filteredBatch = await request(baseUrl, '/keyword-batch', {
    keywords: '成本核算经理', targetCount: 2, education: '本科及以上'
  });
  assert.equal(filteredBatch.status, 200);
  assert.deepEqual(calls.at(-1), { action: 'keyword-batch', data: {
    keywords: ['成本核算经理'], targetCount: 2, education: '本科及以上'
  } });

  const education = await request(baseUrl, '/filters/education', { value: '本科及以上' });
  assert.equal(education.status, 200);
  assert.deepEqual(calls.at(-1), { action: 'education-filter', data: '本科及以上' });

  const stopped = await request(baseUrl, '/stop-batch', {});
  assert.equal(stopped.body.data.running, false);
});

test('51Job batch request validation rejects excessive counts and malformed keywords before service calls', async t => {
  const calls = [];
  const baseUrl = await withServer(t, calls);
  for (const value of [0, 31, 1.5, null, '', false, 'not-a-number']) {
    const result = await request(baseUrl, '/collect-batch', { targetCount: value });
    assert.equal(result.status, 400, `targetCount=${String(value)}`);
  }
  for (const keywords of [null, '', [], ['valid', 42], 'x'.repeat(31),
    Array.from({ length: 11 }, (_, i) => `term-${i}`)]) {
    const result = await request(baseUrl, '/keyword-batch', { keywords, targetCount: 2 });
    assert.equal(result.status, 400, `keywords=${String(keywords)}`);
  }
  for (const education of [null, '', 42, '高中', '本科', '博士及以上']) {
    const batch = await request(baseUrl, '/keyword-batch', {
      keywords: '成本核算经理', targetCount: 2, education
    });
    assert.equal(batch.status, 400, `keyword-batch education=${String(education)}`);
    const filter = await request(baseUrl, '/filters/education', { value: education });
    assert.equal(filter.status, 400, `filters/education value=${String(education)}`);
  }
  assert.deepEqual(calls, []);
});

test('51Job route errors report missing login as a client error', async t => {
  const calls = [];
  const baseUrl = await withServer(t, calls, { 'candidate-links': '请先在浏览器中完成登录' });
  const result = await request(baseUrl, '/candidate-links', null, 'GET');
  assert.equal(result.status, 400);
  assert.equal(result.body.success, false);
  assert.match(result.body.message, /请先/);
});
