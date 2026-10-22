#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { assertBackendStopped } = require('./local-data');
const { SqliteResumeStore } = require('../backend/src/models/sqliteResumeStore');

async function exportResumesJson({ projectRoot, destination }) {
  const root = path.resolve(projectRoot);
  const output = path.resolve(destination);
  await assertBackendStopped(root);
  const libraryDir = path.join(root, 'backend/storage/resume_library');
  const sqliteFile = path.join(libraryDir, 'resumes.sqlite');
  if (!fs.existsSync(sqliteFile)) throw new Error('未找到 SQLite 简历库');
  if (fs.existsSync(output)) throw new Error('导出目标已存在，拒绝覆盖');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const store = new SqliteResumeStore(path.join(libraryDir, 'resumes.json'), sqliteFile);
  try {
    const library = store.readDatabase();
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(descriptor, `${JSON.stringify(library, null, 2)}\n`, 'utf8');
      fs.fsyncSync(descriptor);
    } finally { fs.closeSync(descriptor); }
    if (fs.existsSync(output)) throw new Error('导出目标已存在，拒绝覆盖');
    fs.renameSync(temporary, output);
    return { output, count: library.resumes.length };
  } finally {
    store.close();
    try { fs.unlinkSync(temporary); } catch (_) { /* moved or absent */ }
  }
}

if (require.main === module) {
  (async () => {
    const destination = process.argv[2];
    if (!destination) throw new Error('用法：node scripts/export-resumes-json.js <新文件路径>');
    const result = await exportResumesJson({ projectRoot: path.resolve(__dirname, '..'), destination });
    console.log(`已导出 ${result.count} 份简历到 ${result.output}`);
  })().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { exportResumesJson };
