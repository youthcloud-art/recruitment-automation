const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const DatabaseManager = require('../src/database/init');

test('knowledge HTTP upload, search, preview, download and delete', async () => {
  const originalInit = DatabaseManager.prototype.init;
  DatabaseManager.prototype.init = function initInMemory() {
    this.dbPath = ':memory:';
    return originalInit.call(this);
  };

  const app = express();
  app.use(express.json());
  app.use('/api/knowledge', require('../src/routes/knowledge'));
  const server = await new Promise(resolve => {
    const running = app.listen(0, '127.0.0.1', () => resolve(running));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/knowledge`;
  let documentId;

  try {
    const form = new FormData();
    form.append('companyId', '1');
    form.append('title', '测试差旅制度');
    form.append('document', new Blob(['差旅报销标准：高铁二等座。'], { type: 'text/plain' }), 'policy.txt');
    const uploaded = await fetch(`${baseUrl}/upload`, { method: 'POST', body: form });
    assert.equal(uploaded.status, 200);
    const uploadData = await uploaded.json();
    documentId = uploadData.data.documentId;
    assert.ok(documentId);

    const listed = await (await fetch(`${baseUrl}/documents?companyId=1`)).json();
    assert.equal(listed.data.length, 1);
    assert.equal(listed.data[0].status, 'processed');

    const searched = await (await fetch(`${baseUrl}/retrieve`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '差旅报销', companyId: '1' })
    })).json();
    assert.equal(searched.data.total, 1);
    assert.equal(searched.data.results[0].metadata.document_id, documentId);

    const otherCompany = await (await fetch(`${baseUrl}/retrieve`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '差旅报销', companyId: '2' })
    })).json();
    assert.equal(otherCompany.data.total, 0);

    const inaccessible = await fetch(`${baseUrl}/documents/${documentId}?companyId=2`);
    assert.equal(inaccessible.status, 404);
    const inaccessibleDelete = await fetch(`${baseUrl}/documents/${documentId}?companyId=2`, { method: 'DELETE' });
    assert.equal(inaccessibleDelete.status, 404);

    const detail = await (await fetch(`${baseUrl}/documents/${documentId}?companyId=1`)).json();
    assert.equal(detail.data.title, '测试差旅制度');
    const chunks = await (await fetch(`${baseUrl}/documents/${documentId}/chunks?companyId=1`)).json();
    assert.equal(chunks.data.length, 1);
    const downloaded = await fetch(`${baseUrl}/documents/${documentId}/download?companyId=1`);
    assert.equal(downloaded.status, 200);
    assert.match(await downloaded.text(), /高铁二等座/);

    const deleted = await fetch(`${baseUrl}/documents/${documentId}?companyId=1`, { method: 'DELETE' });
    assert.equal(deleted.status, 200);
    documentId = null;
    const afterDelete = await (await fetch(`${baseUrl}/documents?companyId=1`)).json();
    assert.equal(afterDelete.data.length, 0);
  } finally {
    if (documentId) await fetch(`${baseUrl}/documents/${documentId}?companyId=1`, { method: 'DELETE' });
    await new Promise(resolve => server.close(resolve));
    DatabaseManager.prototype.init = originalInit;
  }
});
