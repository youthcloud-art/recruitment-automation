const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { exportCompany, verifySnapshot, importLocal, dataPath } = require('../../scripts/company-data-sync');

function put(root, name, value) {
  fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
  fs.writeFileSync(path.join(root, name), value);
}
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'company-data-sync-test-'));
  t.after(() => {
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(root));
    assert.ok(relative.startsWith('company-data-sync-test-') && !relative.includes(path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const server = path.join(root, 'server'), release = path.join(server, 'releases', 'ready'), local = path.join(root, 'local');
  for (const project of [release, local]) {
    put(project, 'backend/src/index.js', '// test backend\n');
    put(project, 'backend/src/models/resumeModel.js', '// test model\n');
  }
  const config = { installRoot: server, backendPort: await freePort(), gatewayPort: await freePort() };
  put(server, 'delivery/config.json', JSON.stringify(config));
  put(server, 'control/current-release.json', JSON.stringify({ root: release, commit: 'a'.repeat(40) }));
  put(server, 'shared/backend-storage/resume_library/attachment.txt', 'server attachment');
  put(server, 'shared/backend-storage/tasks.json', '{"tasks":[]}');
  put(server, 'shared/backend-uploads/knowledge.txt', 'server knowledge');
  put(server, 'shared/local/active-job.json', '{"title":"test role"}');
  put(server, 'shared/backend-storage/model-config.json', '{"apiKey":"must-stay-on-server"}');
  put(server, 'shared/backend.env', 'MAIL_PASSWORD=must-stay-on-server');
  put(server, 'shared/local/browser-profiles/boss/Cookies', 'must-stay-on-server');
  put(server, 'shared/local/browser-sessions/boss.json', 'must-stay-on-server');
  const sqliteFile = path.join(server, 'shared/backend-storage/resume_library/resumes.sqlite');
  const database = new DatabaseSync(sqliteFile);
  database.exec("CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES ('server record');");
  database.close();
  const snapshot = path.join(server, 'backups', 'snapshot');
  return { root, server, release, local, snapshot, config };
}
const stopped = async () => {};

test('one-time export and import preserve SQLite, attachments and roles while retaining local credentials and a full previous-data backup', async t => {
  const f = await fixture(t);
  const result = await exportCompany({ installRoot: f.server, destination: f.snapshot });
  assert.equal(result.count, 5);
  assert.equal(fs.existsSync(path.join(f.snapshot, 'backend/storage/model-config.json')), false);
  assert.equal(fs.existsSync(path.join(f.snapshot, '.local/browser-profiles')), false);
  assert.equal(fs.existsSync(path.join(f.snapshot, 'shared/backend.env')), false);
  put(f.local, 'backend/storage/resume_library/old.txt', 'previous local data');
  put(f.local, 'backend/storage/model-config.json', 'local-model-secret');
  put(f.local, 'backend/.env', 'local-mail-secret');
  put(f.local, '.local/browser-profiles/boss/Cookies', 'local-login');
  const backup = path.join(f.root, 'before-import');
  await importLocal({ projectRoot: f.local, source: f.snapshot, backupRoot: backup, assertStopped: stopped });
  assert.equal(fs.readFileSync(path.join(f.local, 'backend/storage/resume_library/attachment.txt'), 'utf8'), 'server attachment');
  assert.equal(fs.readFileSync(path.join(backup, 'data/backend/storage/resume_library/old.txt'), 'utf8'), 'previous local data');
  assert.equal(fs.existsSync(path.join(f.local, 'backend/storage/resume_library/old.txt')), false);
  assert.equal(fs.readFileSync(path.join(f.local, 'backend/storage/model-config.json'), 'utf8'), 'local-model-secret');
  assert.equal(fs.readFileSync(path.join(f.local, 'backend/.env'), 'utf8'), 'local-mail-secret');
  assert.equal(fs.readFileSync(path.join(f.local, '.local/browser-profiles/boss/Cookies'), 'utf8'), 'local-login');
  const database = new DatabaseSync(path.join(f.local, 'backend/storage/resume_library/resumes.sqlite'));
  try { assert.equal(database.prepare('SELECT value FROM fixture').get().value, 'server record'); }
  finally { database.close(); }
  assert.equal(JSON.parse(fs.readFileSync(path.join(backup, 'transaction.json'), 'utf8')).state, 'complete');
  assert.equal(fs.existsSync(path.join(f.local, '.local/company-data-import.lock')), false);
});

test('mismatched application code, tampering, extra files and traversal are rejected before any local data changes', async t => {
  const f = await fixture(t);
  await exportCompany({ installRoot: f.server, destination: f.snapshot });
  put(f.local, 'backend/src/models/resumeModel.js', '// different schema\n');
  await assert.rejects(verifySnapshot(f.snapshot, f.local), /source differs/);
  put(f.local, 'backend/src/models/resumeModel.js', '// test model\r\n');
  await verifySnapshot(f.snapshot, f.local); // Windows/Git newline conversion is compatible.
  put(f.snapshot, 'backend/storage/resume_library/attachment.txt', 'tampered');
  await assert.rejects(verifySnapshot(f.snapshot, f.local), /checksum/);
  put(f.snapshot, 'backend/storage/resume_library/attachment.txt', 'server attachment');
  put(f.snapshot, 'backend/storage/model-config.json', 'unexpected secret');
  await assert.rejects(verifySnapshot(f.snapshot, f.local), /unlisted/);
  for (const name of ['../escape', 'backend/storage/resume_library/../model-config.json', 'backend/uploads/a:secret', 'backend/uploads/CON.txt', 'backend/storage/model-config.json']) assert.throws(() => dataPath(name), /Invalid/);
});

test('a partial replacement failure restores all previous local business data', async t => {
  const f = await fixture(t);
  await exportCompany({ installRoot: f.server, destination: f.snapshot });
  put(f.local, 'backend/storage/resume_library/old.txt', 'old resume');
  put(f.local, 'backend/storage/tasks.json', 'old tasks');
  const backup = path.join(f.root, 'failed-import-backup');
  let moves = 0;
  await assert.rejects(importLocal({ projectRoot: f.local, source: f.snapshot, backupRoot: backup, assertStopped: stopped,
    move: async (from, to) => { if (++moves === 4) throw new Error('simulated disk failure'); await fsp.rename(from, to); } }), /simulated disk failure/);
  assert.equal(fs.readFileSync(path.join(f.local, 'backend/storage/resume_library/old.txt'), 'utf8'), 'old resume');
  assert.equal(fs.readFileSync(path.join(f.local, 'backend/storage/tasks.json'), 'utf8'), 'old tasks');
  assert.equal(fs.existsSync(path.join(f.local, 'backend/storage/resume_library/attachment.txt')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(backup, 'transaction.json'), 'utf8')).state, 'rolled_back');
  assert.equal(fs.existsSync(path.join(f.local, '.local/company-data-import.lock')), false);
});

test('export refuses a live company backend and import refuses an active local application', async t => {
  const f = await fixture(t);
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(f.config.backendPort, '127.0.0.1', resolve));
  try { await assert.rejects(exportCompany({ installRoot: f.server, destination: f.snapshot }), /occupied/); }
  finally { await new Promise(resolve => listener.close(resolve)); }
  await exportCompany({ installRoot: f.server, destination: f.snapshot });
  await assert.rejects(importLocal({ projectRoot: f.local, source: f.snapshot, backupRoot: path.join(f.root, 'not-created'), assertStopped: async () => { throw new Error('application is active'); } }), /application is active/);
  assert.equal(fs.existsSync(path.join(f.root, 'not-created')), false);
});

test('a force-stopped SQLite writer is recovered from WAL in the exported copy', async t => {
  const f = await fixture(t);
  const databaseFile = path.join(f.server, 'shared/backend-storage/resume_library/resumes.sqlite');
  const ready = path.join(f.root, 'writer-ready');
  const child = spawn(process.execPath, ['--no-warnings', '-e', `
    const {DatabaseSync}=require('node:sqlite');const fs=require('node:fs');
    const db=new DatabaseSync(${JSON.stringify(databaseFile)});
    db.exec("PRAGMA journal_mode=WAL; INSERT INTO fixture VALUES ('WAL record');");
    fs.writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000);`], { stdio: 'ignore' });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(ready) && child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(fs.existsSync(ready));
  child.kill('SIGKILL');
  await new Promise(resolve => child.once('exit', resolve));
  assert.ok(fs.existsSync(databaseFile + '-wal'));
  await exportCompany({ installRoot: f.server, destination: f.snapshot });
  await verifySnapshot(f.snapshot, f.local);
  const restored = new DatabaseSync(path.join(f.snapshot, 'backend/storage/resume_library/resumes.sqlite'));
  try { assert.equal(restored.prepare('SELECT count(*) AS count FROM fixture').get().count, 2); }
  finally { restored.close(); }
  assert.equal(fs.existsSync(path.join(f.snapshot, 'backend/storage/resume_library/resumes.sqlite-wal')), false);
});
