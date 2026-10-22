const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ResumeModel } = require('../src/models/resumeModel');

test('BOSS platform ID deduplicates changed resume text in SQLite without merging other sources', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-sqlite-id-'));
  fs.writeFileSync(path.join(directory, 'resumes.json'), JSON.stringify({
    resumes: [], positions: [], categories: []
  }));
  const model = new ResumeModel({ resumeStorageDir: directory, storageEngine: 'sqlite' });
  t.after(() => { model.sqliteStore.close(); fs.rmSync(directory, { recursive: true, force: true }); });

  const first = await model.addResume({ source: 'boss', sourceCandidateId: 'expect-123',
    sourceFingerprint: 'text-v1', name: '候选人甲' }, { returnStatus: true });
  const changedText = await model.addResume({ source: 'boss', sourceCandidateId: 'expect-123',
    sourceFingerprint: 'text-v2', name: '候选人甲' }, { returnStatus: true });
  const otherSource = await model.addResume({ source: 'qcwy', sourceCandidateId: 'expect-123',
    sourceFingerprint: 'text-v2', name: '候选人乙' }, { returnStatus: true });
  const otherBossId = await model.addResume({ source: 'boss',
    sourceCandidateId: 'expect-456', sourceFingerprint: 'text-v1', name: '候选人甲' },
  { returnStatus: true });

  assert.equal(first.created, true);
  assert.equal(changedText.created, false);
  assert.equal(changedText.resume.id, first.resume.id);
  assert.equal(otherSource.created, true);
  assert.equal(otherBossId.created, true,
    '不同官方候选人 ID 不能仅因 OCR 文本哈希相同而合并');
  assert.equal(model.getResumesPage({ limit: 10 }).total, 3);
});
