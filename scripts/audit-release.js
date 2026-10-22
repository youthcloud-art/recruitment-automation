#!/usr/bin/env node
'use strict';

// Print locations and classifications only. Never print a matched value.
// Usage: node scripts/audit-release.js [--index | --dir PATH] [--json]
// Exit codes: 0 clean, 1 findings, 2 invalid invocation / scan failure.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const args = process.argv.slice(2);
let mode = 'index';
let root = process.cwd();
let json = false;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--index') mode = 'index';
  else if (args[i] === '--dir' && args[i + 1]) {
    mode = 'directory';
    root = path.resolve(args[++i]);
  } else if (args[i] === '--json') json = true;
  else {
    process.stderr.write('Usage: node scripts/audit-release.js [--index | --dir PATH] [--json]\n');
    process.exit(2);
  }
}

const findings = [];
let scannedFiles = 0;
const dedupe = new Set();
const dependencyOrGenerated = /(^|\/)(?:\.git|node_modules|vendor|venv|\.venv|__pycache__|coverage|build|dist)(?:\/|$)/i;
const testCode = /(^|\/)(?:test|tests|test_files|__tests__|fixtures)(?:\/|$)|(?:\.test|\.spec)\.[^/]+$/i;
const runtimeDirectory = /(^|\/)(?:\.local|backups?|uploads|downloads|temp|test_storage|storage|logs|screenshots|\.netlify|\.vercel|browser[_-]?(?:profiles?|sessions?)|chrome[_-]?profiles?|user[_-]?data|[^/]*-qa-(?:render|tmp))$/i;
const textual = /(?:\.(?:[cm]?jsx?|tsx?|json|md|txt|ya?ml|toml|ini|conf|config|sh|ps1|cmd|bat|sql|html|css|xml|env|backup|example|template)|\/Dockerfile|\/\.npmrc|\/\.gitignore|\/\.env(?:\.[^/]*)?)$/i;
const safeTemplate = /(?:^|[/.])(?:example|template)(?:\.[^/]*)?$/i;
const placeholder = /^(?:your|replace|changeme|change[-_]?me|example|placeholder|dummy|fake|test|mock|sample|todo|xxxx|<|\$\{|process\.env|os\.environ|getenv\(|None|null|undefined|false|true|\*{3})/i;

function add(file, line, type) {
  const key = `${file}\0${line}\0${type}`;
  if (dedupe.has(key)) return;
  dedupe.add(key);
  findings.push({ path: file, line, type });
}

function inspectPath(file) {
  const lower = file.toLowerCase();
  if (/(^|\/)\.env(?:\.[^/]*)?$/.test(lower) && !safeTemplate.test(lower)) add(file, 1, 'private-environment-file');
  if (/(^|\/)[^/]*\.(?:env|pem|key|p12|pfx)$/.test(lower) && !safeTemplate.test(lower)) add(file, 1, 'private-configuration-or-key-file');
  if (/(^|\/)(?:\.jwt_secret[^/]*|id_rsa|id_ed25519|credentials(?:\.[^/]*)?)$/.test(lower)) add(file, 1, 'private-key-or-credential-file');
  if (/\.(?:sqlite3?|db)(?:[-.](?:backup|bak|wal|shm))?$/.test(lower)) add(file, 1, 'runtime-database');
  if (/(^|\/)(?:\.local|backups?|browser[_-]?(?:profiles?|sessions?)|chrome[_-]?profiles?|user[_-]?data)(?:\/|$)/.test(lower)) add(file, 1, 'local-state-or-backup');
  if (/(^|\/)(?:uploads|downloads|temp|test_storage|storage|logs|screenshots|[^/]*-qa-(?:render|tmp))(?:\/|$)/.test(lower) && !/(^|\/)\.gitkeep$/.test(lower)) add(file, 1, 'runtime-data-or-document');
  if (/(^|\/)(?:\.netlify|\.vercel)(?:\/|$)/.test(lower)) add(file, 1, 'provider-local-state-or-build-output');
  if (/\.(?:bak|backup)$/.test(lower)) add(file, 1, 'backup-copy');
  if (/^(?:boss_(?:correct|response|test)|response|upload_response|test_upload_after_fix)\.json$/.test(lower)) add(file, 1, 'raw-recruitment-capture');
}

function realValue(value, minimum = 8) {
  const cleaned = value.trim().replace(/^["'`]|["'`,;]$/g, '').trim();
  if (cleaned.length < minimum || placeholder.test(cleaned)) return false;
  if (/^\((?:\?:|\\)/.test(cleaned)) return false; // A regex token, not an access token.
  if (/^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|example\.(?:com|org)|[^/]*\.example)(?:[:/]|$)/i.test(cleaned)) return false;
  return true;
}

function inspectText(file, bytes) {
  if (!textual.test('/' + file) || bytes.length > 10 * 1024 * 1024 || bytes.subarray(0, 4096).includes(0)) return;
  const testSource = testCode.test(file) || /(^|\/)(?:test[-_][^/]*|[^/]*[-_]test)\.[^/]+$/i.test(file);
  scannedFiles += 1;
  const lines = bytes.toString('utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    const n = index + 1;
    if (/-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/.test(line)) add(file, n, 'private-key-material');
    for (const token of line.matchAll(/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[0-9A-Z]{16}|sk-(?:proj-)?[A-Za-z0-9_-]{20,})\b/g)) {
      const fixture = testSource && (/^(?:sk-(?:proj-)?(?:test|fake|dummy|example|mock)[-_]?|(?:gh[pousr]_|github_pat_)(?:test|fake|dummy|example|mock)[-_]?)/i.test(token[0]) || /^(?:sk-(?:proj-)?|gh[pousr]_|github_pat_)([A-Za-z0-9])\1{19,}$/.test(token[0]));
      if (!fixture) add(file, n, 'provider-token');
    }
    if (/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/.test(line)) add(file, n, 'jwt-or-supabase-key');
    if (/(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s/:]+:[^\s/@]+@/i.test(line)) add(file, n, 'database-connection-credential');
    if (/https?:\/\/[^\s/:@]+:[^\s/@]+@/i.test(line)) add(file, n, 'url-embedded-credential');
    // Synthetic names, addresses and generic passwords are common fixtures.
    // High-confidence credential formats above are still checked in tests.
    if (testSource) return;
    const assignment = /\b([\w.-]*(?:api[_-]?key|secret[_-]?access[_-]?key|service[_-]?role[_-]?key|token|secret|password|passwd|smtp[_-]?(?:pass|auth)|imap[_-]?(?:pass|auth))\b)["']?\s*[:=]\s*([^\r\n]+)/ig;
    let match;
    while ((match = assignment.exec(line))) {
      if (/^["']?\s*:/.test(match[0].slice(match[1].length))) {
        let prefix = line.slice(0, match.index).trimEnd();
        if (/["']$/.test(prefix)) prefix = prefix.slice(0, -1).trimEnd();
        if (prefix && !/[{[,]$/.test(prefix) && !(/\.ya?ml$/i.test(file) && /-$/.test(prefix))) continue;
      }
      const raw = match[2].trim();
      const literal = raw.match(/^["'`]([^"'`]+)["'`]/);
      const value = literal ? literal[1] : raw.split(/\s+#|\s+\/\//)[0];
      if (!literal && (!/(?:^|\/)\.?env(?:\.[^/]*)?$|\.(?:env|sh|ps1|ini|conf|toml|ya?ml)$/i.test(file) || !/^[^\s"'`(){}]+$/.test(value))) continue;
      if (realValue(value)) add(file, n, 'literal-credential-assignment');
    }
    const emails = line.matchAll(/\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/ig);
    for (const email of emails) {
      if (/^git@/i.test(email[0]) && line.includes(email[0] + ':')) continue;
      if (!/(?:^|\.)(?:example\.(?:com|org|net)|test\.(?:com|org)|localhost)$/i.test(email[1]) && !/^(?:(?:your|example|test|sample|dummy|fake)[-_.]|(?:support|info|noreply|no-reply|admin|hello|contact|security|sales|jobs)@)/i.test(email[0]) && !/(?:@(?:babel|types|eslint)|package-lock\.json$)/i.test(file)) add(file, n, 'email-address-review');
    }
    const phone = line.match(/(?:手机号|手机号码|联系电话|mobile|phone)["']?\s*[:=：]\s*["']?(?:\+?86[- ]?)?(1[3-9]\d{9})\b/i);
    if (phone && !/^(?:13800138000|13800000000|13900000000|13000000000|13600000000|18888888888)$/.test(phone[1])) add(file, n, 'personal-phone-review');
  });
}

function walk(dir, relative = '') {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = relative ? `${relative}/${entry.name}` : entry.name;
    if (dependencyOrGenerated.test(file)) continue;
    if (entry.isSymbolicLink()) {
      add(file, 1, 'symlink-review');
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // A forbidden runtime boundary is already a finding. Avoid opening live
      // browser databases, credentials, or candidate files beneath it.
      if (runtimeDirectory.test(file)) inspectPath(file + '/');
      else walk(full, file);
    }
    else if (entry.isFile()) {
      inspectPath(file);
      if (fs.statSync(full).size <= 10 * 1024 * 1024) inspectText(file, fs.readFileSync(full));
    }
  }
}

function scanIndex() {
  const listing = execFileSync('git', ['ls-files', '--stage', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const entries = [];
  for (const entry of listing.split('\0').filter(Boolean)) {
    const match = entry.match(/^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/);
    if (!match) throw new Error('Unrecognized Git index entry');
    const [, fileMode, oid, stage, file] = match;
    if (dependencyOrGenerated.test(file)) continue;
    inspectPath(file);
    if (stage !== '0') { add(file, 1, 'unmerged-index-entry'); continue; }
    if (fileMode === '120000') { add(file, 1, 'symlink-review'); continue; }
    if (textual.test('/' + file)) entries.push({ oid, file });
  }
  if (!entries.length) return;
  const data = execFileSync('git', ['cat-file', '--batch'], { cwd: root, input: entries.map(({ oid }) => oid).join('\n') + '\n', maxBuffer: 256 * 1024 * 1024 });
  let cursor = 0;
  for (const entry of entries) {
    const end = data.indexOf(10, cursor);
    if (end < 0) throw new Error('Incomplete Git object header');
    const header = data.subarray(cursor, end).toString('utf8').match(/^([a-f0-9]+) blob (\d+)$/);
    if (!header || header[1] !== entry.oid) throw new Error('Unexpected Git object');
    const size = Number(header[2]);
    const start = end + 1;
    if (start + size >= data.length) throw new Error('Incomplete Git object');
    inspectText(entry.file, data.subarray(start, start + size));
    cursor = start + size + 1;
  }
}

try {
  if (mode === 'index') scanIndex();
  else walk(root);
  findings.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.type.localeCompare(b.type));
  if (json) process.stdout.write(JSON.stringify({ mode, scannedFiles, findings }, null, 2) + '\n');
  else {
    for (const finding of findings) process.stdout.write(`${finding.path}:${finding.line}: ${finding.type}\n`);
    process.stdout.write(`Audit complete: ${scannedFiles} text files scanned; ${findings.length} findings.\n`);
  }
  process.exitCode = findings.length ? 1 : 0;
} catch (error) {
  // Do not echo process stderr: it may contain source data or credentials.
  process.stderr.write(`Release audit failed (${error && error.code ? error.code : 'scan-error'}).\n`);
  process.exitCode = 2;
}
