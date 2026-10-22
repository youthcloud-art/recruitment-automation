const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
process.env.RESUME_STORAGE_ENGINE = 'json';
const resumeModel = require('../src/models/resumeModel');

function isolatedDatabase(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-model-persistence-'));
  const previousFile = resumeModel.dbFile;
  resumeModel.dbFile = path.join(directory, 'resumes.json');
  fs.writeJsonSync(resumeModel.dbFile, { resumes: [], positions: [], categories: [] });
  t.after(() => {
    resumeModel.dbFile = previousFile;
    fs.removeSync(directory);
  });
  return { directory, file: resumeModel.dbFile };
}

test('successful addResume replaces the JSON file and leaves no temporary file', async t => {
  const { directory, file } = isolatedDatabase(t);
  const saved = await resumeModel.addResume({ source: 'qcwy', name: '测试候选人',
    sourceFingerprint: 'unique-test-1' }, { returnStatus: true });

  assert.equal(saved.created, true);
  assert.equal(fs.readJsonSync(file).resumes[0].id, saved.resume.id);
  assert.equal(fs.readdirSync(directory).filter(name => name.endsWith('.tmp')).length, 0);
});

test('51job collection never copies a candidate name or page label into the position', async t => {
  isolatedDatabase(t);
  const first = await resumeModel.addResume({ source: 'qcwy', name: '未识别姓名',
    sourceFingerprint: 'qcwy-unknown-position' });
  const second = await resumeModel.addResume({ source: 'qcwy', name: '通知', position: '通知',
    sourceFingerprint: 'qcwy-navigation-position' });
  assert.equal(first.position, '');
  assert.equal(second.position, '');
});

test('concurrent in-process addResume calls retain every distinct record', async t => {
  const { file } = isolatedDatabase(t);
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) =>
    resumeModel.addResume({ source: 'qcwy', name: `测试候选人${index}`,
      sourceFingerprint: `unique-concurrent-${index}` }, { returnStatus: true })));

  assert.equal(results.filter(result => result.created).length, 8);
  assert.equal(fs.readJsonSync(file).resumes.length, 8);
});

test('failed atomic replace rejects addResume and keeps both original file and cache intact', async t => {
  const { directory, file } = isolatedDatabase(t);
  assert.equal(resumeModel.readDatabase().resumes.length, 0);
  const originalRename = fs.renameSync;
  fs.renameSync = () => {
    const error = new Error('target file is busy');
    error.code = 'EPERM';
    throw error;
  };
  try {
    await assert.rejects(
      resumeModel.addResume({ source: 'qcwy', name: '测试候选人',
        sourceFingerprint: 'unique-test-2' }, { returnStatus: true }),
      /target file is busy/
    );
  } finally {
    fs.renameSync = originalRename;
  }

  assert.deepEqual(fs.readJsonSync(file).resumes, []);
  assert.deepEqual(resumeModel.readDatabase().resumes, []);
  assert.equal(fs.readdirSync(directory).filter(name => name.endsWith('.tmp')).length, 0);

  const retry = await resumeModel.addResume({ source: 'qcwy', name: '测试候选人',
    sourceFingerprint: 'unique-test-2' }, { returnStatus: true });
  assert.equal(retry.created, true);
  assert.equal(fs.readJsonSync(file).resumes.length, 1);
});

test('an unreadable database rejects addResume instead of overwriting existing bytes', async t => {
  const { file } = isolatedDatabase(t);
  const damagedContents = '{"resumes": [incomplete';
  fs.writeFileSync(file, damagedContents, 'utf8');

  await assert.rejects(resumeModel.addResume({ source: 'qcwy', name: '测试候选人' }));
  assert.equal(fs.readFileSync(file, 'utf8'), damagedContents);
});
