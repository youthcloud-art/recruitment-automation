#!/usr/bin/env node
'use strict';

// Offline, one-time company -> local business data transfer. No network API,
// credentials, browser sessions or automatic schedule is added by this tool.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { assertBackendStopped } = require('./local-data');

const FORMAT = 'auto-recru-company-data/v1';
const ROOTS = [
  'backend/storage/resume_library', 'backend/storage/resumes',
  'backend/storage/knowledge.db', 'backend/storage/tasks.json',
  'backend/storage/mail_delivery_receipts', 'backend/storage/mail_correction_receipts',
  'backend/uploads', '.local/active-job.json', '.local/report-corrections'
];
const EXCLUDED = ['backend/.env', 'backend/storage/model-config.json',
  'shared/backend.env', 'delivery', '.local/browser-profiles', '.local/browser-sessions',
  '.local/processes.json', '.local/*checkpoint*', 'code', 'logs'];
const hashBytes = value => crypto.createHash('sha256').update(value).digest('hex');
const inside = (base, target) => {
  const relative = path.relative(path.resolve(base), path.resolve(target));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
function dataPath(relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') ||
      /[\x00-\x1f:]/.test(relative) || path.posix.isAbsolute(relative) ||
      relative.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) ||
      !ROOTS.some(base => relative === base || relative.startsWith(`${base}/`))) {
    throw new Error('Invalid business data path in snapshot');
  }
  return relative;
}
function ordinary(root, relative = '') {
  const resolved = path.resolve(root);
  if (fs.existsSync(resolved) && fs.lstatSync(resolved).isSymbolicLink()) throw new Error('A data root cannot be a junction or symbolic link');
  let current = resolved;
  for (const part of relative.split('/').filter(Boolean)) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('A data path contains a junction or symbolic link');
  }
  return current;
}
async function files(root, relative = '') {
  const full = ordinary(root, relative);
  if (!fs.existsSync(full)) return [];
  const stat = await fsp.lstat(full);
  if (stat.isFile()) return [relative];
  if (!stat.isDirectory()) throw new Error('Unsupported filesystem entry in data snapshot');
  const result = [];
  for (const entry of await fsp.readdir(full, { withFileTypes: true })) {
    const nested = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error('A snapshot cannot contain junctions or symbolic links');
    result.push(...await files(root, nested));
  }
  return result.sort();
}
async function digest(file) {
  const hash = crypto.createHash('sha256');
  for await (const block of fs.createReadStream(file)) hash.update(block);
  return hash.digest('hex');
}
async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  const handle = await fsp.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await fsp.rename(temporary, file);
}
async function codeFingerprint(root) {
  const source = ordinary(root, 'backend/src');
  const names = (await files(source)).filter(name => /\.(?:js|json|ps1)$/i.test(name));
  if (!names.includes('index.js') || !names.includes('models/resumeModel.js')) throw new Error('Cannot verify backend code compatibility');
  const hash = crypto.createHash('sha256');
  for (const name of names) {
    // Git/Windows newline conversion must not make the same source incompatible.
    const bytes = await fsp.readFile(path.join(source, name));
    const normalized = /\.(?:js|json|ps1)$/.test(name) ? Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n')) : bytes;
    hash.update(name + '\0' + hashBytes(normalized) + '\n');
  }
  return hash.digest('hex');
}
async function portsIdle(ports) {
  for (const port of ports) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid deployment port');
    // On Windows, a wildcard probe alone can coexist with a listener bound to
    // a specific address. Check loopback connections before probing both binds.
    for (const host of ['127.0.0.1', '::1']) await new Promise((resolve, reject) => {
      const socket = net.createConnection({ port, host });
      socket.setTimeout(1000);
      socket.once('connect', () => { socket.destroy(); reject(new Error(`Application port ${port} is occupied; export was stopped`)); });
      socket.once('error', error => {
        if (['ECONNREFUSED', 'EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code)) resolve();
        else reject(new Error(`Application port ${port} cannot be checked (${error.code})`));
      });
      socket.once('timeout', () => { socket.destroy(); reject(new Error(`Application port ${port} check timed out`)); });
    });
    for (const host of ['0.0.0.0', '::']) await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once('error', error => {
        if (host === '::' && ['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code)) resolve();
        else reject(new Error(`Application port ${port} is occupied or cannot be checked (${error.code}); export was stopped`));
      });
      server.listen({ port, host, exclusive: true }, () => server.close(error => error ? reject(error) : resolve()));
    });
  }
}
async function normalizeDatabases(root) {
  const names = await files(root);
  const databases = new Set(names.filter(name => /\.(?:sqlite3?|db)(?:-wal|-shm)?$/i.test(name)).map(name => name.replace(/-(?:wal|shm)$/i, '')));
  if (!databases.size) return;
  const { DatabaseSync } = require('node:sqlite');
  for (const name of databases) {
    const filename = path.join(root, name);
    if (!fs.existsSync(filename)) throw new Error('SQLite main database is missing from snapshot');
    const database = new DatabaseSync(filename);
    try {
      database.exec('PRAGMA busy_timeout=1000');
      const checkpoint = database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
      if (checkpoint.busy !== 0 || database.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('SQLite snapshot integrity check failed');
    } finally { database.close(); }
  }
  for (const name of await files(root)) if (/-wal$|-shm$/i.test(name)) throw new Error('SQLite sidecar remained after checkpoint');
}
function companySource(shared, relative) {
  if (relative.startsWith('backend/storage/')) return { root: path.join(shared, 'backend-storage'), relative: relative.slice('backend/storage/'.length) };
  if (relative === 'backend/uploads') return { root: path.join(shared, 'backend-uploads'), relative: '' };
  return { root: path.join(shared, 'local'), relative: relative.slice('.local/'.length) };
}
async function exportCompany({ installRoot, destination }) {
  const root = path.resolve(installRoot), output = path.resolve(destination);
  const config = JSON.parse(await fsp.readFile(ordinary(root, 'delivery/config.json'), 'utf8'));
  const pointer = JSON.parse(await fsp.readFile(ordinary(root, 'control/current-release.json'), 'utf8'));
  if (path.resolve(config.installRoot) !== root || !/^[a-f0-9]{40}$/.test(pointer.commit) || !inside(path.join(root, 'releases'), pointer.root)) throw new Error('Invalid active company installation');
  if (!inside(path.join(root, 'backups'), output)) throw new Error('Company exports must remain inside the installation backups directory');
  if (fs.existsSync(output)) throw new Error('Export destination already exists');
  ordinary(root, path.relative(root, output).split(path.sep).join('/'));
  await portsIdle([Number(config.gatewayPort || 4000), Number(config.backendPort || 5001)]);
  await fsp.mkdir(output, { recursive: true, mode: 0o700 });
  // An incomplete directory has no manifest, so an interrupted copy cannot be imported.
  for (const base of ROOTS) {
    const source = companySource(path.join(root, 'shared'), base);
    for (const name of await files(source.root, source.relative)) {
      if (/(?:\.lock|\.tmp|\.temp)$/i.test(name)) continue;
      const suffix = source.relative ? name.slice(source.relative.length) : `/${name}`;
      const relative = dataPath(base + suffix);
      const from = path.join(source.root, name), to = ordinary(output, relative);
      await fsp.mkdir(path.dirname(to), { recursive: true });
      await fsp.copyFile(from, to, fs.constants.COPYFILE_EXCL);
      if (await digest(from) !== await digest(to)) throw new Error('Export copy checksum mismatch');
    }
  }
  await portsIdle([Number(config.gatewayPort || 4000), Number(config.backendPort || 5001)]);
  await normalizeDatabases(output);
  const entries = [];
  for (const name of await files(output)) entries.push({ path: dataPath(name), size: (await fsp.stat(path.join(output, name))).size, sha256: await digest(path.join(output, name)) });
  const manifest = { format: FORMAT, createdAtUtc: new Date().toISOString(), serverCommit: pointer.commit,
    backendFingerprint: await codeFingerprint(pointer.root), roots: ROOTS, excluded: EXCLUDED, files: entries };
  await writeJson(path.join(output, 'manifest.json'), manifest);
  return { count: entries.length, bytes: entries.reduce((sum, item) => sum + item.size, 0), serverCommit: pointer.commit, destination: output };
}
async function verifySnapshot(source, projectRoot) {
  const root = path.resolve(source);
  const manifest = JSON.parse(await fsp.readFile(ordinary(root, 'manifest.json'), 'utf8'));
  if (manifest.format !== FORMAT || !/^[a-f0-9]{40}$/.test(manifest.serverCommit || '') ||
      !Array.isArray(manifest.files) || !manifest.files.length || JSON.stringify(manifest.roots) !== JSON.stringify(ROOTS)) throw new Error('Invalid or empty company snapshot');
  if (manifest.backendFingerprint !== await codeFingerprint(projectRoot)) throw new Error('Backend source differs from the server snapshot. Match application versions before importing data');
  const seen = new Set();
  for (const item of manifest.files) {
    const name = dataPath(item.path);
    if (seen.has(name) || /-(?:wal|shm)$/i.test(name) || !Number.isSafeInteger(item.size) || item.size < 0 || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('Invalid snapshot file entry');
    seen.add(name);
    const full = ordinary(root, name), stat = await fsp.lstat(full);
    if (!stat.isFile() || stat.size !== item.size || await digest(full) !== item.sha256) throw new Error('Snapshot file checksum mismatch');
  }
  const actual = (await files(root)).filter(name => name !== 'manifest.json');
  if (actual.length !== seen.size || actual.some(name => !seen.has(name))) throw new Error('Snapshot contains unlisted files');
  return manifest;
}
async function importLocal({ projectRoot, source, backupRoot, move = fsp.rename, assertStopped = assertBackendStopped }) {
  const root = path.resolve(projectRoot), from = path.resolve(source), backup = path.resolve(backupRoot);
  if (root === backup || inside(root, backup) || inside(backup, root) || inside(from, backup) || inside(backup, from)) throw new Error('Local backup must be separate from the project and incoming snapshot');
  ordinary(root); ordinary(backup);
  if (fs.existsSync(backup)) throw new Error('Local backup destination already exists');
  await assertStopped(root);
  const manifest = await verifySnapshot(from, root);
  for (const base of ROOTS) ordinary(root, base);
  // Validate every target before changing any business data.
  for (const base of ROOTS) await files(root, base);
  const id = crypto.randomUUID();
  const stage = path.join(root, '.local', `company-data-stage-${id}`);
  ordinary(root, '.local');
  const marker = path.join(root, '.local/company-data-import.lock');
  await fsp.mkdir(path.dirname(marker), { recursive: true });
  const lock = await fsp.open(marker, 'wx', 0o600);
  const journal = { format: 1, state: 'preparing', projectRoot: root, backupRoot: backup, stage,
    serverCommit: manifest.serverCommit, operations: [], createdAtUtc: new Date().toISOString() };
  let committed = false, rollbackFailed = false;
  try {
    await lock.writeFile(JSON.stringify({ backupRoot: backup, createdAtUtc: journal.createdAtUtc })); await lock.sync();
    await fsp.mkdir(stage, { recursive: true });
    for (const item of manifest.files) {
      const to = path.join(stage, item.path);
      await fsp.mkdir(path.dirname(to), { recursive: true });
      await fsp.copyFile(path.join(from, item.path), to, fs.constants.COPYFILE_EXCL);
      if (await digest(to) !== item.sha256) throw new Error('Local staging checksum mismatch');
    }
    await normalizeDatabases(stage);
    await assertStopped(root);
    await fsp.mkdir(backup, { recursive: true, mode: 0o700 });
    journal.state = 'replacing';
    await writeJson(path.join(backup, 'transaction.json'), journal);
    for (const base of ROOTS) {
      const target = path.join(root, base), old = path.join(backup, 'data', base), incoming = path.join(stage, base);
      const operation = { path: base, oldMoved: false, newMoved: false };
      journal.operations.push(operation);
      if (fs.existsSync(target)) {
        await fsp.mkdir(path.dirname(old), { recursive: true });
        await move(target, old); operation.oldMoved = true;
      }
      await writeJson(path.join(backup, 'transaction.json'), journal);
      if (fs.existsSync(incoming)) {
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await move(incoming, target); operation.newMoved = true;
      }
      await writeJson(path.join(backup, 'transaction.json'), journal);
    }
    journal.state = 'complete';
    await writeJson(path.join(backup, 'transaction.json'), journal);
    await writeJson(path.join(root, '.local/last-company-data-import.json'), { serverCommit: manifest.serverCommit, backupRoot: backup, importedAtUtc: new Date().toISOString(), count: manifest.files.length });
    committed = true;
    return { count: manifest.files.length, backupRoot: backup, projectRoot: root, serverCommit: manifest.serverCommit };
  } catch (error) {
    // Reverse only our recorded moves. No existing directory is deleted.
    try {
      for (const operation of [...journal.operations].reverse()) {
        const target = path.join(root, operation.path), old = path.join(backup, 'data', operation.path), incoming = path.join(stage, operation.path);
        if (operation.newMoved) { await fsp.mkdir(path.dirname(incoming), { recursive: true }); await fsp.rename(target, incoming); }
        if (operation.oldMoved) { await fsp.mkdir(path.dirname(target), { recursive: true }); await fsp.rename(old, target); }
      }
      journal.state = 'rolled_back';
      if (fs.existsSync(backup)) await writeJson(path.join(backup, 'transaction.json'), journal);
    } catch (_) { rollbackFailed = true; throw new Error('Import recovery needs attention. Preserve the project, import lock and backup transaction; no further import was attempted'); }
    throw error;
  } finally {
    await lock.close();
    if (!rollbackFailed) await fsp.unlink(marker);
    // Keep staging on failure for inspection; completed staging is empty except
    // empty directories, and is retained rather than recursively deleting paths.
    if (!committed && rollbackFailed) process.stderr.write('Local import lock preserved for recovery.\n');
  }
}
async function main() {
  const [action, first, second] = process.argv.slice(2);
  let result;
  if (action === 'export' && first && second) result = await exportCompany({ installRoot: first, destination: second });
  else if (action === 'inspect' && first) {
    const manifest = await verifySnapshot(first, path.resolve(__dirname, '..'));
    result = { count: manifest.files.length, serverCommit: manifest.serverCommit, compatible: true };
  } else if (action === 'import' && first && second) result = await importLocal({ projectRoot: path.resolve(__dirname, '..'), source: first, backupRoot: second });
  else throw new Error('Usage: company-data-sync.js export <installation> <new snapshot directory> | inspect <snapshot> | import <snapshot> <new backup directory>');
  process.stdout.write(JSON.stringify(result) + '\n');
}
if (require.main === module) main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
module.exports = { exportCompany, verifySnapshot, importLocal, codeFingerprint, ROOTS, dataPath };
