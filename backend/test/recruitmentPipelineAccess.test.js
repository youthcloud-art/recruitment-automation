const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cors = require('cors');
const http = require('node:http');
const router = require('../src/routes/recruitmentPipeline');

test('招聘简历与邮件路由拒绝恶意来源、缺少 Origin 的跨站请求和 DNS 重绑定 Host', async () => {
  const previousHost = process.env.HOST;
  process.env.HOST = '127.0.0.1';
  const app = express();
  app.use(cors());
  app.use('/api/recruitment-pipeline', router);
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const request = (path, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
    const call = http.request({ hostname: '127.0.0.1', port, path, method, headers }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body,
        headers: response.headers }));
    });
    call.on('error', reject);
    call.end();
  });
  try {
    const path = '/api/recruitment-pipeline';
    assert.equal((await request(`${path}/candidates`, { Origin: 'https://malicious.example' })).status, 403);
    assert.equal((await request(`${path}/candidates/resume_abcdefgh`,
      { Origin: 'https://malicious.example' })).status, 403);
    assert.equal((await request(`${path}/report`, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await request(`${path}/report?format=docx`, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await request(`${path}/active-job/template`, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await request(`${path}/candidates`, {
      Host: `rebound.example:${port}`, 'Sec-Fetch-Site': 'same-origin'
    })).status, 403);
    assert.equal((await request(`${path}/candidates/no-such-id`, {
      Origin: 'https://malicious.example'
    }, 'PATCH')).status, 403);
    assert.equal((await request(`${path}/email/config`, {
      Origin: 'https://malicious.example'
    })).status, 403);

    const allowedBrowser = await request(`${path}/summary`, { Origin: 'http://localhost:3000',
      'Sec-Fetch-Site': 'same-origin' });
    assert.equal(allowedBrowser.status, 200);
    assert.equal(JSON.parse(allowedBrowser.body).success, true);
    const allowedLocalCli = await request(`${path}/summary`);
    assert.equal(allowedLocalCli.status, 200);
    assert.equal(JSON.parse(allowedLocalCli.body).success, true);
    assert.equal((await request(`${path}/candidates/not-a-candidate`)).status, 400);
    assert.equal((await request(`${path}/candidates/resume_abcdefgh`)).status, 404);
    const template = await request(`${path}/active-job/template`);
    assert.equal(template.status, 200, template.body.slice(0, 300));
    assert.match(template.headers['content-type'], /spreadsheetml\.sheet/);
    assert.equal(template.body.slice(0, 2), 'PK');
    const markdown = await request(`${path}/report?format=md&topN=1`);
    const activeJob = JSON.parse((await request(`${path}/active-job`)).body).data;
    if (activeJob.updatedAt && activeJob.title && activeJob.jobRequirements?.length >= 5) {
      assert.equal(markdown.status, 200, markdown.body.slice(0, 300));
      assert.match(markdown.headers['content-type'], /^text\/markdown/);
      assert.match(markdown.headers['content-disposition'], /candidate-report\.md/);
      assert.match(markdown.body, /最低岗位匹配分：70\/100/);
    } else {
      assert.equal(markdown.status, 400);
      assert.match(markdown.body, /请先保存并应用当前岗位条件/);
    }
    const word = await request(`${path}/report?format=docx&topN=1`);
    if (markdown.status === 200) {
      assert.equal(word.status, 200, word.body.slice(0, 300));
      assert.match(word.headers['content-type'], /wordprocessingml\.document/);
      assert.match(word.headers['content-disposition'], /candidate-report\.docx/);
      assert.equal(word.body.slice(0, 2), 'PK');
    } else {
      assert.equal(word.status, 400);
    }
    assert.equal((await request(`${path}/report?format=pdf`)).status, 400);
    assert.equal((await request(`${path}/report?format=md&minScore=101`)).status, 400);
    assert.equal((await request(`${path}/report?format=md&topN=101`)).status, 400);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (previousHost === undefined) delete process.env.HOST;
    else process.env.HOST = previousHost;
  }
});
