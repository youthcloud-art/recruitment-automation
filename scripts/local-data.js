#!/usr/bin/env node
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const net = require('net');

const DATA_PATHS = ['backend/storage', 'backend/uploads', '.local/active-job.json',
  '.local/boss-collection-checkpoint.json', '.local/boss-card-quarantine.json',
  '.local/qcwy-imap-checkpoint.json'];

function configuredPorts(root) {
  const ports = new Set();
  const envFile = path.join(root, 'backend/.env');
  if (fs.existsSync(envFile)) {
    const match = fs.readFileSync(envFile, 'utf8').match(/^\s*PORT\s*=\s*["']?(\d+)["']?\s*(?:#.*)?$/m);
    if (match) ports.add(Number(match[1]));
  }
  if (process.env.PORT) ports.add(Number(process.env.PORT));
  // A freshly restored data-only directory has no server to probe. In a full
  // checkout, 5001 is the backend's fallback when PORT is not configured.
  if (fs.existsSync(path.join(root, 'backend/src/index.js'))) ports.add(5001);
  for (const port of ports) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('后端端口配置无效，无法确认服务是否已停止');
    }
  }
  return ports;
}

function assertPortAvailable(port, host) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', error => {
      // IPv6 may be unavailable on a host. The IPv4 probe still runs.
      if (host === '::' && ['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code)) resolve();
      else reject(new Error(`端口 ${port} (${host}) 已被占用或无法检查；请先关闭后端服务：${error.code}`));
    });
    server.listen({ port, host, exclusive: true }, () => {
      server.close(error => error ? reject(error) : resolve());
    });
  });
}

function assertNoListener(port, host) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ port, host });
    socket.setTimeout(1000);
    socket.once('connect', () => {
      socket.destroy();
      reject(new Error(`端口 ${port} (${host}) 已被占用；请先关闭后端服务`));
    });
    socket.once('error', error => {
      if (['ECONNREFUSED', 'EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code)) resolve();
      else reject(new Error(`无法确认端口 ${port} (${host}) 是否空闲：${error.code}`));
    });
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error(`无法确认端口 ${port} (${host}) 是否空闲：连接超时`));
    });
  });
}

async function assertBackendStopped(root) {
  const state = path.join(root, '.local/processes.json');
  if (fs.existsSync(state)) {
    let data;
    try { data = JSON.parse(fs.readFileSync(state, 'utf8')); }
    catch (_) { throw new Error('本机服务状态文件无法读取，请先检查并停止服务'); }
    const pid = Number(data?.services?.backend?.pid);
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        throw new Error('后端仍在运行；请先运行 stop-local.cmd，再备份或恢复');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
  }
  // The PID file only covers start-local.cmd. A manually started backend or
  // server deployment must also be caught before copying a live SQLite file.
  for (const port of configuredPorts(root)) {
    // Connecting to each interface includes link-local IPv6 addresses, which
    // often time out without a scope ID even when no service is listening.
    // Check loopback directly and reserve both wildcard families instead:
    // a listener bound to any local interface prevents the matching bind.
    for (const host of ['127.0.0.1', '::1']) await assertNoListener(port, host);
    await assertPortAvailable(port, '0.0.0.0');
    await assertPortAvailable(port, '::');
  }
}

async function filesUnder(root, relative) {
  const full = path.join(root, relative);
  if (!fs.existsSync(full)) return [];
  const stat = await fsp.lstat(full);
  if (stat.isSymbolicLink()) throw new Error(`数据目录包含符号链接：${relative}`);
  if (stat.isFile()) return [relative];
  if (!stat.isDirectory()) throw new Error(`不支持的数据类型：${relative}`);
  const result = [];
  for (const entry of await fsp.readdir(full, { withFileTypes: true })) {
    const nested = path.posix.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`数据目录包含符号链接：${nested}`);
    if (entry.isDirectory()) result.push(...await filesUnder(root, nested));
    else if (entry.isFile()) result.push(nested);
  }
  return result;
}

function safeRelative(relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') ||
      path.posix.isAbsolute(relative) || relative.split('/').includes('..') ||
      !DATA_PATHS.some(base => relative === base || relative.startsWith(`${base}/`))) {
    throw new Error('备份清单包含无效路径');
  }
  return relative;
}

async function assertNoSymlinkParents(root, relative) {
  let current = root;
  for (const part of relative.split('/').slice(0, -1)) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) continue;
    if ((await fsp.lstat(current)).isSymbolicLink()) {
      throw new Error(`恢复目标包含符号链接：${relative}`);
    }
  }
}

async function digest(file) {
  const hash = crypto.createHash('sha256');
  for await (const block of fs.createReadStream(file)) hash.update(block);
  return hash.digest('hex');
}

async function assertNoLiveWal(root) {
  const files = await filesUnder(root, 'backend/storage');
  const active = files.find(relative => /(?:-wal|-shm)$/i.test(relative));
  if (active) {
    throw new Error(`检测到 SQLite WAL/SHM 文件 ${active}；请先关闭所有数据库连接并完成检查点，再备份或恢复`);
  }
}

async function checkpointClosedDatabases(root) {
  const files = await filesUnder(root, 'backend/storage');
  const databases = new Set(files.filter(relative => /(?:-wal|-shm)$/i.test(relative))
    .map(relative => relative.replace(/(?:-wal|-shm)$/i, '')));
  if (!databases.size) return;
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); }
  catch (_) { throw new Error('检测到 SQLite WAL/SHM；需要 Node.js 24+ 完成安全检查点'); }
  for (const relative of databases) {
    const file = path.join(root, relative);
    if (!fs.existsSync(file)) throw new Error(`SQLite 主数据库不存在：${relative}；请人工检查`);
    const header = Buffer.alloc(16);
    const descriptor = fs.openSync(file, 'r');
    try { fs.readSync(descriptor, header, 0, header.length, 0); }
    finally { fs.closeSync(descriptor); }
    if (header.toString('utf8') !== 'SQLite format 3\0') {
      throw new Error(`SQLite 数据库文件头无效：${relative}；请人工检查`);
    }
    let database;
    try {
      database = new DatabaseSync(file);
      database.exec('PRAGMA busy_timeout=1000');
      const result = database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
      if (!result || result.busy !== 0) {
        throw new Error(`SQLite 检查点仍有活动连接：${relative}`);
      }
      if (database.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') {
        throw new Error(`SQLite 完整性检查失败：${relative}`);
      }
    } catch (error) {
      throw new Error(`无法安全完成 SQLite 检查点 ${relative}：${error.message}`);
    } finally {
      if (database) database.close();
    }
  }
}

async function backupData({ projectRoot, destination, copyFile = fsp.copyFile }) {
  const root = path.resolve(projectRoot);
  const out = path.resolve(destination);
  await assertBackendStopped(root);
  await checkpointClosedDatabases(root);
  await assertNoLiveWal(root);
  if (fs.existsSync(path.join(root, '.local/data-restore-journal.json'))) {
    throw new Error('存在尚未完成的数据恢复，请先用同一备份续传');
  }
  const relativeOut = path.relative(root, out);
  if (!relativeOut || (!relativeOut.startsWith('..') && !path.isAbsolute(relativeOut))) {
    throw new Error('备份目录必须位于项目目录之外，以免候选人资料被 Git 收录');
  }
  if (fs.existsSync(out)) throw new Error('备份目标已存在，请指定新的空目录');
  const staging = `${out}.incomplete`;
  if (fs.existsSync(staging)) throw new Error('上次备份的临时目录尚在，请检查后选择新目标目录');
  await fsp.mkdir(staging, { recursive: true, mode: 0o700 });
  const manifest = { format: 1, createdAt: new Date().toISOString(),
    files: [], excluded: ['backend/.env', '.local/browser-sessions', '.local/browser-profiles'] };
  try {
    for (const base of DATA_PATHS) {
      for (const relative of await filesUnder(root, base)) {
        safeRelative(relative);
        const source = path.join(root, relative);
        const target = path.join(staging, relative);
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await copyFile(source, target);
        const [sourceHash, targetHash, stat] = await Promise.all([
          digest(source), digest(target), fsp.stat(source)
        ]);
        if (sourceHash !== targetHash) throw new Error(`备份校验失败：${relative}`);
        manifest.files.push({ path: relative, size: stat.size, sha256: targetHash });
      }
    }
    await fsp.writeFile(path.join(staging, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await fsp.rename(staging, out);
    return { destination: out, count: manifest.files.length };
  } catch (error) {
    await fsp.rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function restoreData({ projectRoot, source, copyFile = fsp.copyFile }) {
  const root = path.resolve(projectRoot);
  const from = path.resolve(source);
  await assertBackendStopped(root);
  await assertNoLiveWal(root);
  const manifestBytes = await fsp.readFile(path.join(from, 'manifest.json'));
  const manifestHash = crypto.createHash('sha256').update(manifestBytes).digest('hex');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.format !== 1 || !Array.isArray(manifest.files) || !manifest.files.length) {
    throw new Error('备份清单格式无效或没有数据文件');
  }
  const seen = new Set();
  const journalPath = path.join(root, '.local/data-restore-journal.json');
  let resuming = false;
  if (fs.existsSync(journalPath)) {
    const journal = JSON.parse(await fsp.readFile(journalPath, 'utf8'));
    if (journal?.format !== 1 || journal.manifestSha256 !== manifestHash) {
      throw new Error('存在不同备份的未完成恢复记录，请先人工检查');
    }
    resuming = true;
  }
  for (const item of manifest.files) {
    const relative = safeRelative(item.path);
    if (seen.has(relative) || !Number.isSafeInteger(item.size) || item.size < 0 ||
        !/^[a-f0-9]{64}$/i.test(item.sha256) || /(?:-wal|-shm)$/i.test(relative)) {
      throw new Error('备份清单格式无效');
    }
    seen.add(relative);
    const sourceFile = path.join(from, relative);
    const sourceStat = await fsp.lstat(sourceFile);
    if (!sourceStat.isFile() || sourceStat.size !== item.size ||
        await digest(sourceFile) !== item.sha256) throw new Error(`备份文件校验失败：${relative}`);
    const target = path.join(root, relative);
    if (fs.existsSync(target)) {
      if (!resuming || (await fsp.stat(target)).size !== item.size ||
          await digest(target) !== item.sha256) {
        throw new Error(`目标文件已存在，拒绝覆盖：${relative}`);
      }
    }
    await assertNoSymlinkParents(root, relative);
  }
  if (!resuming) {
    await fsp.mkdir(path.dirname(journalPath), { recursive: true });
    const handle = await fsp.open(journalPath, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify({ format: 1, manifestSha256: manifestHash })}\n`);
      await handle.sync();
    } finally { await handle.close(); }
  }
  for (const item of manifest.files) {
    const target = path.join(root, item.path);
    if (fs.existsSync(target)) continue;
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.restore-partial`;
    await fsp.rm(temporary, { force: true });
    try {
      await copyFile(path.join(from, item.path), temporary, fs.constants.COPYFILE_EXCL);
      if (await digest(temporary) !== item.sha256) throw new Error(`恢复后校验失败：${item.path}`);
      const handle = await fsp.open(temporary, 'r+');
      try { await handle.sync(); } finally { await handle.close(); }
      // Hard-link creation is atomic and refuses to replace a target that
      // appeared between our preflight check and this commit step.
      await fsp.link(temporary, target);
    } finally { await fsp.rm(temporary, { force: true }); }
  }
  await fsp.unlink(journalPath);
  return { projectRoot: root, count: manifest.files.length };
}

async function main() {
  const [action, directory] = process.argv.slice(2);
  const root = path.resolve(__dirname, '..');
  if (action === 'backup') {
    const destination = directory || path.join(os.homedir(), 'Auto-Recru-Backups',
      `data-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    const result = await backupData({ projectRoot: root, destination });
    console.log(`备份完成：${result.destination}（${result.count} 个文件）`);
  } else if (action === 'restore' && directory) {
    const result = await restoreData({ projectRoot: root, source: directory });
    console.log(`恢复完成：${result.projectRoot}（${result.count} 个文件）`);
  } else {
    throw new Error('用法：node scripts/local-data.js backup [目标目录] | restore <备份目录>');
  }
}

if (require.main === module) main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});

module.exports = { backupData, restoreData, assertBackendStopped };
