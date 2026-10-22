const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const DatabaseManager = require('../src/database/init');
const KnowledgeService = require('../src/services/knowledgeService');

test('knowledge upload, reprocess, company-scoped retrieval and deletion', async () => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-test-'));
  const dbManager = new DatabaseManager();
  dbManager.dbPath = path.join(temporaryDirectory, 'knowledge.db');
  await dbManager.init();
  const service = new KnowledgeService(dbManager);
  await service.vectorService.initTables();

  try {
    const source = path.join(temporaryDirectory, 'policy.txt');
    await fs.writeFile(source, '', 'utf8');
    const file = { path: source, mimetype: 'text/plain', originalname: 'policy.txt', size: 0 };
    await assert.rejects(() => service.uploadDocument(file, '1', '差旅政策'), /没有可检索的文字/);

    assert.deepEqual(await service.getDocuments('1'), [], 'failed upload is rolled back');
    await assert.rejects(() => fs.access(source), /ENOENT/);

    // Reprocessing still supports failed records left by older app versions.
    await fs.writeFile(source, '员工差旅报销制度：高铁二等座可以报销。', 'utf8');
    const legacy = await service.documentService.saveDocument({ ...file, size: 52 }, '1', '差旅政策');
    await service.documentService.updateDocumentStatus(legacy.id, 'failed');
    const reprocessed = await service.reprocessFailedDocuments('1');
    assert.deepEqual(reprocessed.map(item => item.status), ['success']);
    const documents = await service.getDocuments('1');
    assert.equal(documents.length, 1, 'reprocess must not create a duplicate document');
    assert.equal(documents[0].status, 'processed');

    const results = await service.retrieveKnowledge('差旅报销', '1', 5);
    assert.equal(results.length, 1);
    assert.match(results[0].content, /高铁二等座/);
    assert.equal(results[0].metadata.document_id, documents[0].id);
    assert.equal(results[0].metadata.document_title, '差旅政策');
    assert.deepEqual(await service.retrieveKnowledge('差旅报销', '2', 5), [],
      'another company cannot receive matching document chunks');

    await service.deleteDocument(documents[0].id);
    assert.deepEqual(await service.getDocuments('1'), []);
    assert.deepEqual(await service.retrieveKnowledge('差旅报销', '1', 5), []);
  } finally {
    await new Promise(resolve => dbManager.db.close(() => resolve()));
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('knowledge search finds a requirement inside a punctuation-free document longer than one chunk', async () => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-long-test-'));
  const dbManager = new DatabaseManager();
  dbManager.dbPath = path.join(temporaryDirectory, 'knowledge.db');
  await dbManager.init();
  const service = new KnowledgeService(dbManager);
  await service.vectorService.initTables();

  try {
    const source = path.join(temporaryDirectory, 'it-requirements.txt');
    const content = '网络维护'.repeat(320) + '交换机故障排查与监控报警' + '系统运维'.repeat(320);
    await fs.writeFile(source, content, 'utf8');
    const uploaded = await service.uploadDocument({
      path: source,
      mimetype: 'text/plain',
      originalname: 'it-requirements.txt',
      size: Buffer.byteLength(content)
    }, '1', 'IT 网络运维岗位要求');

    assert.ok(uploaded.chunks > 1);
    const storedChunks = await service.documentService.getDocumentChunks(uploaded.documentId);
    assert.ok(storedChunks.every(chunk => chunk.content.length <= 1000));
    const matches = await service.retrieveKnowledge('交换机故障排查', '1', 5);
    assert.ok(matches.some(result => result.content.includes('交换机故障排查与监控报警')));

    await service.deleteDocument(uploaded.documentId);
  } finally {
    await new Promise(resolve => dbManager.db.close(() => resolve()));
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});
