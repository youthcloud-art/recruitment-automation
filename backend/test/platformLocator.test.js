const test = require('node:test');
const assert = require('node:assert/strict');
const { idFromOfficialUrl, bossCardId, platformLocator } =
  require('../src/utils/platformLocator');

test('only complete identifiers in official platform URLs become locators', () => {
  const zl = { source: 'zlzp', sourceUrl:
    'https://rd6.zhaopin.com/app/search?resumeNumber=ZL_2026-abc123' };
  const wy = { source: 'qcwy', sourceUrl:
    'https://ehire.51job.com/Revision/talent/resume/detail?resumeId=1042857719' };
  assert.equal(platformLocator(zl).id, 'ZL_2026-abc123');
  assert.equal(platformLocator(wy).id, '1042857719');
  assert.equal(platformLocator(zl).status, 'official_url');
  assert.equal(idFromOfficialUrl('boss',
    'https://www.zhipin.com/web/frame/c-resume/?source=search'), '');
  assert.equal(idFromOfficialUrl('zlzp',
    'https://rd.zhaopin.com/app/search?resumeNumber='), '');
  assert.equal(idFromOfficialUrl('qcwy',
    'https://evil.example/Revision/talent/resume/detail?resumeId=123'), '');
});

test('local IDs and hashes never masquerade as platform IDs', () => {
  const item = { id: 'resume-local-123', source: 'qcwy',
    sourceRecordKey: 'f'.repeat(64), sourceUrl:
      'https://ehire.51job.com/Revision/talent/resume/detail' };
  assert.deepEqual(platformLocator(item),
    { id: '', kind: '', status: 'unavailable', url: '' });
  assert.equal(platformLocator({ source: 'boss', sourceCandidateId: 'expect-123',
    sourceCandidateIdSource: 'platform_card',
    sourceUrl: 'https://www.zhipin.com/web/frame/c-resume/?source=search' }).status,
  'platform_card');
  assert.equal(platformLocator({ source: 'boss', sourceCandidateId: 'expect-123',
    sourceUrl: 'https://www.zhipin.com/web/frame/c-resume/?source=search' }).status,
  'unavailable');
  assert.equal(platformLocator({ source: 'boss', sourceCandidateId: 'expect-123',
    sourceUrl: 'https://www.zhipin.com/web/frame/c-resume/?expectId=another' }).status,
  'conflict');
});

test('BOSS card identity accepts a scalar or one explicit ID, never arbitrary JSON', () => {
  assert.equal(bossCardId('expect-A_123'), 'expect-A_123');
  assert.equal(bossCardId('{"encryptExpectId":"encrypted_123"}'), 'encrypted_123');
  assert.equal(bossCardId('{"name":"李先生","city":"上海"}'), '');
  assert.equal(bossCardId('{"expectId":"one","geekId":"two"}'), '');
  assert.equal(bossCardId('true'), '');
});
