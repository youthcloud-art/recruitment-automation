const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { backupData, restoreData } = require('../../scripts/local-data');
const { exportResumesJson } = require('../../scripts/export-resumes-json');
const { ResumeModel } = require('../src/models/resumeModel');
const DocumentService = require('../src/services/documentService');

test('offline backup and restore preserve data and exclude credentials/session cookies', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-data-portability-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = path.join(root, 'original');
  const restored = path.join(root, 'restored');
  const backup = path.join(root, 'backup');
  fs.mkdirSync(path.join(original, 'backend/storage/resume_library'), { recursive: true });
  fs.mkdirSync(path.join(original, 'backend/uploads'), { recursive: true });
  fs.mkdirSync(path.join(original, '.local/browser-sessions'), { recursive: true });
  fs.writeFileSync(path.join(original, 'backend/storage/resume_library/resumes.json'),
    JSON.stringify({ resumes: [{ id: 'one' }], positions: [], categories: [] }));
  fs.writeFileSync(path.join(original, 'backend/uploads/test.txt'), 'knowledge');
  fs.writeFileSync(path.join(original, 'backend/.env'), 'SECRET=never-copy');
  fs.writeFileSync(path.join(original, '.local/browser-sessions/boss.json'), 'cookie');
  fs.writeFileSync(path.join(original, '.local/active-job.json'), '{"title":"运维"}');
  fs.writeFileSync(path.join(original, '.local/qcwy-imap-checkpoint.json'),
    '{"lastUid":42}');
  fs.writeFileSync(path.join(original, '.local/boss-card-quarantine.json'),
    '{"version":1,"entries":[]}');

  const saved = await backupData({ projectRoot: original, destination: backup });
  assert.equal(saved.count, 5);
  assert.equal(fs.existsSync(path.join(backup, 'backend/.env')), false);
  assert.equal(fs.existsSync(path.join(backup, '.local/browser-sessions/boss.json')), false);
  const loaded = await restoreData({ projectRoot: restored, source: backup });
  assert.equal(loaded.count, 5);
  assert.equal(fs.readFileSync(path.join(restored, 'backend/uploads/test.txt'), 'utf8'), 'knowledge');
  assert.equal(fs.readFileSync(path.join(restored, '.local/qcwy-imap-checkpoint.json'), 'utf8'),
    '{"lastUid":42}');
  assert.equal(fs.readFileSync(path.join(restored, '.local/boss-card-quarantine.json'), 'utf8'),
    '{"version":1,"entries":[]}');
  await assert.rejects(restoreData({ projectRoot: restored, source: backup }), /目标文件已存在/);
  fs.appendFileSync(path.join(backup, 'backend/uploads/test.txt'), 'tamper');
  await assert.rejects(restoreData({ projectRoot: path.join(root, 'third'), source: backup }),
    /备份文件校验失败/);
});

test('backup refuses WAL files and never publishes a partial destination', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-wal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  const library = path.join(project, 'backend/storage/resume_library');
  fs.mkdirSync(library, { recursive: true });
  fs.writeFileSync(path.join(library, 'resumes.json'), '{}');
  fs.writeFileSync(path.join(library, 'resumes.sqlite-wal'), 'pending');
  const out = path.join(root, 'backup');
  await assert.rejects(backupData({ projectRoot: project, destination: out }),
    /SQLite 主数据库不存在|WAL\/SHM/);
  fs.unlinkSync(path.join(library, 'resumes.sqlite-wal'));
  await assert.rejects(backupData({ projectRoot: project, destination: out,
    copyFile: async () => { throw new Error('disk full'); } }), /disk full/);
  assert.equal(fs.existsSync(out), false);
  assert.equal(fs.existsSync(`${out}.incomplete`), false);
});

test('offline backup checkpoints WAL left by a force-stopped backend', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-wal-checkpoint-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  const storage = path.join(project, 'backend/storage');
  fs.mkdirSync(storage, { recursive: true });
  const database = path.join(storage, 'sample.db');
  const ready = path.join(root, 'ready');
  const script = `const fs=require('fs'); const {DatabaseSync}=require('node:sqlite');
    const db=new DatabaseSync(${JSON.stringify(database)});
    db.exec(${JSON.stringify("PRAGMA journal_mode=WAL; CREATE TABLE sample(value TEXT); INSERT INTO sample VALUES ('survived')")});
    fs.writeFileSync(${JSON.stringify(ready)}, 'ready'); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'ignore', 'pipe'] });
  let childError = '';
  child.stderr.on('data', chunk => { childError += chunk.toString(); });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(ready) && child.exitCode === null && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(fs.existsSync(ready), true, `SQLite worker did not initialize: ${childError}`);
  child.kill('SIGKILL');
  await new Promise(resolve => child.once('exit', resolve));
  assert.equal(fs.existsSync(`${database}-wal`), true);
  const backup = path.join(root, 'backup');
  await backupData({ projectRoot: project, destination: backup });
  assert.equal(fs.existsSync(path.join(backup, 'backend/storage/sample.db-wal')), false);
  const restored = path.join(root, 'restored');
  await restoreData({ projectRoot: restored, source: backup });
  const { DatabaseSync } = require('node:sqlite');
  const copy = new DatabaseSync(path.join(restored, 'backend/storage/sample.db'));
  try { assert.equal(copy.prepare('SELECT value FROM sample').get().value, 'survived'); }
  finally { copy.close(); }
});

test('offline backup and restore reject a manually started server without a PID file', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-live-port-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  const library = path.join(project, 'backend/storage/resume_library');
  fs.mkdirSync(library, { recursive: true });
  fs.writeFileSync(path.join(library, 'resumes.json'), '{"resumes":[]}');
  const listener = net.createServer();
  await new Promise((resolve, reject) => listener.once('error', reject).listen(0, '127.0.0.1', resolve));
  t.after(() => listener.close());
  const port = listener.address().port;
  fs.writeFileSync(path.join(project, 'backend/.env'), `PORT=${port}\n`);
  const out = path.join(root, 'backup');
  await assert.rejects(backupData({ projectRoot: project, destination: out }), /端口 .*已被占用/);
  assert.equal(fs.existsSync(out), false);
  const snapshot = path.join(root, 'snapshot');
  fs.mkdirSync(snapshot);
  fs.writeFileSync(path.join(snapshot, 'manifest.json'),
    JSON.stringify({ format: 1, files: [{ path: 'backend/storage/resume_library/resumes.json',
      size: 0, sha256: '0'.repeat(64) }] }));
  await assert.rejects(restoreData({ projectRoot: project, source: snapshot }), /端口 .*已被占用/);
});

test('interrupted restore resumes only files matching the same verified backup', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-resume-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'original');
  const library = path.join(project, 'backend/storage/resume_library');
  fs.mkdirSync(library, { recursive: true });
  fs.writeFileSync(path.join(library, 'resumes.json'), '{"resumes":[]}');
  fs.writeFileSync(path.join(library, 'sample.txt'), 'candidate data');
  const backup = path.join(root, 'backup');
  await backupData({ projectRoot: project, destination: backup });
  const target = path.join(root, 'restored');
  let calls = 0;
  await assert.rejects(restoreData({ projectRoot: target, source: backup,
    copyFile: async (...args) => {
      calls++;
      if (calls === 2) throw new Error('copy interrupted');
      return fs.promises.copyFile(...args);
    } }), /copy interrupted/);
  assert.equal(fs.existsSync(path.join(target, '.local/data-restore-journal.json')), true);
  const completed = await restoreData({ projectRoot: target, source: backup });
  assert.equal(completed.count, 2);
  assert.equal(fs.existsSync(path.join(target, '.local/data-restore-journal.json')), false);
  assert.equal(fs.readFileSync(path.join(target, 'backend/storage/resume_library/sample.txt'), 'utf8'),
    'candidate data');
});

test('SQLite data can be exported to JSON for rollback without overwriting old snapshot', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-json-export-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const libraryDir = path.join(root, 'backend/storage/resume_library');
  fs.mkdirSync(libraryDir, { recursive: true });
  const legacy = path.join(libraryDir, 'resumes.json');
  fs.writeFileSync(legacy, JSON.stringify({ resumes: [], positions: [], categories: [] }));
  const model = new ResumeModel({ resumeStorageDir: libraryDir, storageEngine: 'sqlite' });
  await model.addResume({ source: 'qcwy', name: 'synthetic', sourceFingerprint: 'one' });
  model.sqliteStore.close();
  const output = path.join(root, 'export.json');
  const result = await exportResumesJson({ projectRoot: root, destination: output });
  assert.equal(result.count, 1);
  assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).resumes.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(legacy, 'utf8')).resumes.length, 0);
  await assert.rejects(exportResumesJson({ projectRoot: root, destination: output }), /已存在/);

  const listener = net.createServer();
  await new Promise((resolve, reject) => listener.once('error', reject).listen(0, '127.0.0.1', resolve));
  t.after(() => listener.close());
  fs.writeFileSync(path.join(root, 'backend/.env'), `PORT=${listener.address().port}\n`);
  const blockedOutput = path.join(root, 'blocked-export.json');
  await assert.rejects(exportResumesJson({ projectRoot: root, destination: blockedOutput }),
    /端口 .*已被占用/);
  assert.equal(fs.existsSync(blockedOutput), false);
});

test('knowledge document filenames resolve after moving Windows data to another host', () => {
  const service = new DocumentService({});
  const filename = 'test-upload.txt';
  const oldWindowsPath = `C:\\old-pc\\app\\backend\\uploads\\${filename}`;
  assert.equal(service.resolveDocumentPath(oldWindowsPath), path.join(service.uploadDir, filename));
  assert.equal(service.resolveDocumentPath(filename), path.join(service.uploadDir, filename));
});
