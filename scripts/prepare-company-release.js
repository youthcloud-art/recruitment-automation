#!/usr/bin/env node
'use strict';

// Export current source into a new private-repository checkout without copying
// Git history, local configuration, candidate data, browser sessions or builds.
// Usage: node scripts/prepare-company-release.js --destination PATH [--refresh]
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const SOURCE_ROOT = path.resolve(__dirname, '..');
const MANIFEST = 'company-release-manifest.json';
const TREE_ALLOWLIST = ['backend/src', 'backend/test', 'backend/assets', 'frontend/src', 'frontend/public', 'deploy/company', '.github/workflows'];
const FILE_ALLOWLIST = [
  'package.json', 'package-lock.json', '.npmrc',
  'backend/package.json', 'backend/package-lock.json', 'backend/.npmrc', 'backend/env.example', 'backend/nodemon.json',
  'frontend/package.json', 'frontend/package-lock.json', 'frontend/.npmrc', 'frontend/.env.example',
  'scripts/audit-release.js', 'scripts/prepare-company-release.js', 'scripts/local-data.js',
  'scripts/export-resumes-json.js', 'scripts/start-local.ps1', 'scripts/stop-local.ps1', 'scripts/feature-smoke.cjs',
  'start-local.cmd', 'stop-local.cmd'
];
const GENERATED = ['README.md', '.gitignore'];
const FORBIDDEN = /(^|\/)(?:\.git|\.local|node_modules|\.netlify|\.vercel|backups?|storage|uploads|downloads|temp|logs|screenshots|test_storage|build|dist|coverage|browser[_-]?(?:profiles?|sessions?))(?:\/|$)|\.(?:db|sqlite3?|bak|backup)(?:[.-](?:wal|shm|backup|bak))?$|\.(?:pem|key|pfx|p12)$|(^|\/)\.jwt_secret[^/]*$|(^|\/)\.env(?:\.(?!example$)[^/]*)?$/i;

function hash(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function canonical(value) { return path.resolve(value).toLowerCase(); }
function contains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
function relativeSafe(file) {
  return typeof file === 'string' && file.length > 0 && !file.includes('\\') && !path.posix.isAbsolute(file) && !file.split('/').some(part => part === '' || part === '.' || part === '..') && !/^[A-Za-z]:/.test(file);
}
function allowed(file) {
  return relativeSafe(file) && !FORBIDDEN.test(file) && (FILE_ALLOWLIST.includes(file) || GENERATED.includes(file) || TREE_ALLOWLIST.some(tree => file.startsWith(tree + '/')));
}
function assertOrdinaryPath(root, relative) {
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error(`Symbolic link is not allowed: ${relative}`);
  }
  return current;
}
function existingPhysicalPath(value) {
  if (fs.existsSync(value)) return fs.realpathSync(value);
  const parent = path.dirname(value);
  if (parent === value) throw new Error('Cannot resolve destination parent');
  return path.join(existingPhysicalPath(parent), path.basename(value));
}
function transformed(file, bytes) {
  const transformations = [];
  if (file === 'frontend/src/components/QcwyInboxSettings.js') {
    const original = bytes.toString('utf8');
    const result = original.replace(/(\bhost:\s*'imap\.qq\.com'[^\n]*?\buser:\s*)'[^']*'/, "$1''");
    if (result !== original) transformations.push('empty-default-mailbox');
    bytes = Buffer.from(result);
  }
  if (file === 'package.json' || file === 'backend/package.json') {
    const pkg = JSON.parse(bytes.toString('utf8'));
    for (const key of Object.keys(pkg.scripts || {})) {
      if (key.startsWith('supabase:') || (file === 'backend/package.json' && ['start:optimized', 'dev:optimized'].includes(key))) {
        delete pkg.scripts[key];
        if (!transformations.includes('remove-obsolete-launch-scripts')) transformations.push('remove-obsolete-launch-scripts');
      }
    }
    if (file === 'package.json') {
      pkg.private = true;
      pkg.scripts['audit:release'] = 'node scripts/audit-release.js --index';
      pkg.scripts['prepare:company'] = 'node scripts/prepare-company-release.js';
      transformations.push('private-company-package-and-release-commands');
    }
    bytes = Buffer.from(JSON.stringify(pkg, null, 2) + '\n');
  }
  return { bytes, transformations };
}

function collect() {
  const files = new Map();
  function add(relative) {
    if (!allowed(relative)) return;
    const full = assertOrdinaryPath(SOURCE_ROOT, relative);
    if (!fs.existsSync(full)) return;
    if (!fs.statSync(full).isFile()) throw new Error(`Expected source file: ${relative}`);
    const original = fs.readFileSync(full);
    const result = transformed(relative, original);
    files.set(relative, { ...result, sourceSha256: hash(original) });
  }
  function walk(relative) {
    const full = assertOrdinaryPath(SOURCE_ROOT, relative);
    if (!fs.existsSync(full)) return;
    for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
      const name = relative + '/' + entry.name;
      if (FORBIDDEN.test(name)) continue;
      if (entry.isSymbolicLink()) throw new Error(`Symbolic link is not allowed: ${name}`);
      if (entry.isDirectory()) walk(name);
      else if (entry.isFile()) add(name);
    }
  }
  for (const file of FILE_ALLOWLIST) add(file);
  for (const tree of TREE_ALLOWLIST) walk(tree);
  const readme = '# 智能招聘助手（公司内网版）\n\n' +
    '此仓库保存可部署的最新源代码。通过私有 GitHub 仓库同步到私有 Gitee 仓库，再部署到公司服务器。\n\n' +
    '完成服务器部署并验收后，公司内网访问入口为 http://192.168.1.24:4000/ 。连接获准的公司 Wi-Fi 或有线网络的同事可在浏览器打开。\n\n' +
    '部署、运行配置、浏览器采集环境和回滚步骤见 [公司部署说明](deploy/company/README.md)。\n\n' +
    '简历、数据库、登录会话、模型密钥及邮箱密码均保存在运行环境，不进入此源代码仓库。\n\n' +
    '发布前检查：`node scripts/audit-release.js --index`。从开发项目刷新此快照：`node scripts/prepare-company-release.js --destination <公司版目录> --refresh`。\n';
  const ignore = '# Runtime dependencies and generated output\n' +
    'node_modules/\n**/node_modules/\nbuild/\ndist/\ncoverage/\n.local/\n.netlify/\n.vercel/\n' +
    '# Server-only configuration, credentials and collected personal data\n' +
    '.env\n.env.*\n!.env.example\n!**/.env.example\n*.env\n*.pem\n*.key\n*.p12\n*.pfx\n.jwt_secret*\n' +
    '*.db\n*.db-*\n*.sqlite\n*.sqlite-*\n*.sqlite3\n*.sqlite3-*\n*.backup\n*.bak\n' +
    'backups/\nbackend/storage/\nbackend/uploads/\nbackend/downloads/\nbackend/temp/\nbackend/test_storage/\ndownloads/\nlogs/\n*.log\n' +
    '# Local editor and operating-system state\n.vscode/\n.idea/\n.DS_Store\nThumbs.db\n';
  for (const [file, content] of [['README.md', readme], ['.gitignore', ignore]]) files.set(file, { bytes: Buffer.from(content), sourceSha256: null, transformations: ['generated-company-file'] });
  return files;
}

function main() {
  const args = process.argv.slice(2);
  let destination;
  let refresh = false;
  for (let i = 0; i < args.length; i += 1) {
    if ((args[i] === '--destination' || args[i] === '--dest') && args[i + 1]) destination = path.resolve(args[++i]);
    else if (args[i] === '--refresh') refresh = true;
    else throw new Error('Usage: node scripts/prepare-company-release.js --destination PATH [--refresh]');
  }
  if (!destination) throw new Error('A destination outside this project is required');
  const sourcePhysical = fs.realpathSync(SOURCE_ROOT);
  const destinationPhysical = existingPhysicalPath(destination);
  if (contains(canonical(sourcePhysical), canonical(destinationPhysical)) || contains(canonical(destinationPhysical), canonical(sourcePhysical))) throw new Error('Destination must be outside the source project and cannot contain it');
  if (fs.existsSync(destination) && (!fs.lstatSync(destination).isDirectory() || fs.lstatSync(destination).isSymbolicLink())) throw new Error('Destination must be an ordinary directory');
  const manifestFile = path.join(destination, MANIFEST);
  let previous;
  if (fs.existsSync(manifestFile)) {
    assertOrdinaryPath(destination, MANIFEST);
    previous = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    if (previous.schemaVersion !== 1 || !Array.isArray(previous.files) || previous.files.some(file => !allowed(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256))) throw new Error('Existing release manifest is invalid');
  }
  const existing = fs.existsSync(destination) ? fs.readdirSync(destination) : [];
  if (existing.length && !refresh) throw new Error('Destination is not empty; use --refresh for a previously generated release');
  if (existing.length && refresh && !previous) throw new Error('Refresh requires a previously generated release manifest');
  const files = collect();
  const previousFiles = new Map((previous?.files || []).map(file => [file.path, file]));
  // Validate every planned update before changing the destination. Preserve .git,
  // arbitrary extra files, symlinks and locally changed managed files.
  for (const file of new Set([...files.keys(), ...previousFiles.keys()])) {
    const full = assertOrdinaryPath(destination, file);
    if (!fs.existsSync(full)) continue;
    if (!fs.statSync(full).isFile()) throw new Error(`Destination path is not a file: ${file}`);
    const old = previousFiles.get(file);
    if (!old) throw new Error(`Unmanaged destination file would be overwritten: ${file}`);
    if (hash(fs.readFileSync(full)) !== old.sha256) throw new Error(`Managed destination file was modified locally: ${file}`);
  }
  fs.mkdirSync(destination, { recursive: true });
  for (const [file, data] of files) {
    const full = assertOrdinaryPath(destination, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, data.bytes);
  }
  for (const file of previousFiles.keys()) {
    if (!files.has(file)) {
      const full = assertOrdinaryPath(destination, file);
      if (fs.existsSync(full)) fs.unlinkSync(full);
    }
  }
  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: 'Auto-Recru current working tree; fresh history required',
    files: [...files.entries()].map(([file, data]) => ({ path: file, sha256: hash(data.bytes), sourceSha256: data.sourceSha256, transformations: data.transformations })).sort((a, b) => a.path.localeCompare(b.path))
  };
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
  process.stdout.write(`Company release prepared: ${files.size} source/generated files.\n`);
  const audit = spawnSync(process.execPath, [path.join(SOURCE_ROOT, 'scripts/audit-release.js'), '--dir', destination], { stdio: 'inherit', windowsHide: true });
  if (audit.error || audit.status !== 0) throw new Error('Release audit did not pass; do not push this snapshot');
  process.stdout.write(`Release audit passed. Destination: ${destination}\n`);
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    process.stderr.write(`Company release preparation failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { allowed, collect, main };
