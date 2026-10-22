const test = require('node:test');
const assert = require('node:assert/strict');
const DocumentService = require('../src/services/documentService');

test('long punctuation-free documents are split into bounded searchable chunks', () => {
  const service = new DocumentService(null);
  const content = '项目交付'.repeat(250) + '😀' + 'cost-center'.repeat(180);
  const chunks = service.chunkDocument(content, 1000);

  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => chunk.length > 0 && chunk.length <= 1000));
  assert.equal(chunks.join(''), content);
  assert.ok(chunks.every(chunk => !/[\uD800-\uDBFF]$/.test(chunk)));
});

test('punctuation-only content is not truncated', () => {
  const service = new DocumentService(null);
  const content = '。'.repeat(2300);
  const chunks = service.chunkDocument(content, 1000);

  assert.ok(chunks.every(chunk => chunk.length <= 1000));
  assert.equal(chunks.join(''), content);
});

test('mixed sentences and Excel line breaks retain searchable text without oversized chunks', () => {
  const service = new DocumentService(null);
  const content = 'IT网络运维岗位要求：' + '网络故障排查与监控'.repeat(140) +
    '。\n熟悉交换机、路由器和防火墙配置。\n' + 'A'.repeat(1600) + '！';
  const chunks = service.chunkDocument(content, 1000);

  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every(chunk => chunk.length > 0 && chunk.length <= 1000));
  assert.equal(chunks.join(''), content);
  assert.ok(chunks.some(chunk => chunk.includes('交换机、路由器和防火墙配置')));
});

test('blank input produces no searchable chunks', () => {
  const service = new DocumentService(null);
  assert.deepEqual(service.chunkDocument('  \n\t  '), []);
});
