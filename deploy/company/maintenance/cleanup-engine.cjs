'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const DEFAULTS = require('./cleanup-policy.default.json');
const RELEASE = /^\d{8}-\d{6}-[a-f0-9]{12}-[a-f0-9]{6}$/i;
const BACKUP = /^before-\d{8}-\d{6}-[a-f0-9]{6}$/i;
const DISK_RESERVE_BYTES = 16 * 1024 ** 3;
const PRESSURE_CLEANUP_BYTES = 24 * 1024 ** 3;
const ACTIVE_LOGS = new Set(['backend.stdout.log', 'backend.stderr.log', 'gateway.stdout.log', 'gateway.stderr.log']);
const canonical = value => path.resolve(value).toLowerCase();
function child(root, value) {
  const relative = path.relative(path.resolve(root), path.resolve(value));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Cleanup path is outside its reviewed parent');
  return path.resolve(value);
}
function ordinaryParents(root, target) {
  const full = child(root, target);
  let current = path.resolve(root);
  if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Cleanup root cannot be a junction');
  for (const part of path.relative(current, full).split(path.sep)) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Cleanup parent cannot be a junction');
  }
  return full;
}
function readJson(root, relative, optional = false) {
  const file = ordinaryParents(root, path.join(root, relative));
  if (!fs.existsSync(file) && optional) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function validatePolicy(input) {
  if (!input || input.format !== 1) throw new Error('Invalid cleanup policy format');
  const limits = { keepNewestReleases: [3, 100], releaseMinimumAgeHours: [24, 8760], incompleteReleaseMinimumAgeHours: [2, 168],
    pressureReleaseMinimumAgeHours: [2, 24], pressureIncompleteReleaseMinimumAgeHours: [1, 4], keepRollbackReleases: [2, 30],
    keepNewestBackups: [7, 1000], backupMinimumAgeDays: [7, 3650], orphanArchiveMinimumAgeHours: [48, 8760], inactiveLogMinimumAgeDays: [14, 3650] };
  const result = { format: 1 };
  for (const [key, [min, max]] of Object.entries(limits)) {
    // Existing server policies predate this setting. Keep them valid and use
    // the reviewed default until the operator explicitly changes the policy.
    const value = key.endsWith('MinimumAgeHours') && input[key] === undefined && Object.hasOwn(DEFAULTS, key) ? DEFAULTS[key] : input[key];
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Unsafe cleanup policy field: ${key}`);
    result[key] = value;
  }
  return result;
}
function releasePath(root, value) {
  const full = child(path.join(root, 'releases'), value);
  if (path.dirname(full).toLowerCase() !== path.join(root, 'releases').toLowerCase() || !RELEASE.test(path.basename(full))) throw new Error('Invalid referenced release path');
  ordinaryParents(root, full);
  return full;
}
function ageHours(item, now) { return (now.getTime() - item.mtimeMs) / 3600000; }
async function entries(root, folder) {
  const parent = ordinaryParents(root, path.join(root, folder));
  if (!fs.existsSync(parent)) return [];
  const result = [];
  for (const item of await fsp.readdir(parent, { withFileTypes: true })) {
    const full = path.join(parent, item.name), stat = await fsp.lstat(full);
    if (stat.isSymbolicLink()) continue;
    result.push({ name: item.name, path: full, directory: stat.isDirectory(), file: stat.isFile(), mtimeMs: stat.mtimeMs });
  }
  return result.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
}
function allowedLink(root, targetRoot, filename) {
  const relative = path.relative(targetRoot, filename).split(path.sep).join('/');
  const mapping = { '.local': 'shared/local', 'backend/storage': 'shared/backend-storage', 'backend/uploads': 'shared/backend-uploads' };
  if (!mapping[relative]) return false;
  // Only the three exact deployment junctions can be unlinked, never traversed.
  return canonical(fs.realpathSync(filename)) === canonical(path.join(root, mapping[relative]));
}
async function inspectTree(root, target, kind) {
  ordinaryParents(root, target);
  const stack = [target];
  let bytes = 0, files = 0;
  while (stack.length) {
    const full = stack.pop(), stat = await fsp.lstat(full);
    if (stat.isSymbolicLink()) {
      if (kind !== 'release' || !allowedLink(root, target, full)) throw new Error('Unreviewed junction or symbolic link in cleanup candidate');
      continue;
    }
    if (stat.isDirectory()) {
      for (const name of await fsp.readdir(full)) stack.push(path.join(full, name));
    } else if (stat.isFile()) { bytes += stat.size; files++; }
    else throw new Error('Unsupported filesystem object in cleanup candidate');
  }
  return { bytes, files };
}
async function planCleanup({ installRoot, policy = DEFAULTS, now = new Date(), processRoots = [], freeBytes = Infinity }) {
  const root = path.resolve(installRoot), rules = validatePolicy(policy);
  const pressure = freeBytes < PRESSURE_CLEANUP_BYTES;
  const current = readJson(root, 'control/current-release.json');
  const currentRoot = releasePath(root, current.root);
  if (!/^[a-f0-9]{40}$/i.test(current.commit || '')) throw new Error('Invalid active release commit');
  const manifest = readJson(root, path.relative(root, path.join(currentRoot, 'release.json')));
  if (canonical(manifest.root) !== canonical(currentRoot) || manifest.commit !== current.commit) throw new Error('Active release identity is inconsistent');
  const protectedReleases = new Set([canonical(currentRoot)]), protectedBackups = new Set();
  const prepared = readJson(root, 'delivery/prepared-release.json', true);
  if (prepared) protectedReleases.add(canonical(releasePath(root, prepared.root)));
  const processes = readJson(root, 'control/processes.json', true);
  if (processes?.release) protectedReleases.add(canonical(releasePath(root, processes.release)));
  for (const item of processRoots) protectedReleases.add(canonical(releasePath(root, item)));
  const releases = (await entries(root, 'releases')).filter(item => item.directory && RELEASE.test(item.name));
  const complete = [];
  for (const item of releases) {
    const info = readJson(root, path.relative(root, path.join(item.path, 'release.json')), true);
    if (info) {
      if (canonical(info.root) !== canonical(item.path) || !/^[a-f0-9]{40}$/i.test(info.commit || '')) throw new Error('A release manifest is inconsistent');
      complete.push(item);
    }
  }
  const completePaths = new Set(complete.map(item => canonical(item.path)));
  for (const item of complete.slice(0, rules.keepNewestReleases)) protectedReleases.add(canonical(item.path));
  const backups = (await entries(root, 'backups')).filter(item => item.directory && BACKUP.test(item.name));
  const deployment = readJson(root, 'delivery/last-deployment.json', true);
  if (deployment?.snapshot) {
    const saved = child(path.join(root, 'backups'), deployment.snapshot);
    if (path.dirname(saved).toLowerCase() !== path.join(root, 'backups').toLowerCase() || !BACKUP.test(path.basename(saved))) throw new Error('Invalid deployment backup reference');
    protectedBackups.add(canonical(saved));
  }
  for (const item of backups.slice(0, rules.keepNewestBackups)) protectedBackups.add(canonical(item.path));
  const rollback = new Set();
  for (const item of backups) {
    const previous = readJson(root, path.relative(root, path.join(item.path, 'previous.json')), true);
    if (previous?.previous?.root && rollback.size < rules.keepRollbackReleases) {
      const previousRoot = releasePath(root, previous.previous.root), key = canonical(previousRoot);
      if (key !== canonical(currentRoot) && !rollback.has(key) && fs.existsSync(previousRoot)) {
        rollback.add(key); protectedReleases.add(key); protectedBackups.add(canonical(item.path));
      }
    }
  }
  const candidates = [], skipped = [];
  async function consider(item, kind) {
    try { candidates.push({ path: item.path, relative: path.relative(root, item.path).split(path.sep).join('/'), kind, ...await inspectTree(root, item.path, kind) }); }
    catch (error) { skipped.push({ relative: path.relative(root, item.path).split(path.sep).join('/'), reason: error.message }); }
  }
  for (const item of releases) {
    const key = canonical(item.path);
    const minimumAge = completePaths.has(key)
      ? pressure ? Math.min(rules.releaseMinimumAgeHours, rules.pressureReleaseMinimumAgeHours) : rules.releaseMinimumAgeHours
      : pressure ? Math.min(rules.incompleteReleaseMinimumAgeHours, rules.pressureIncompleteReleaseMinimumAgeHours) : rules.incompleteReleaseMinimumAgeHours;
    if (!protectedReleases.has(key) && ageHours(item, now) >= minimumAge) await consider(item, 'release');
  }
  for (const item of backups) if (!protectedBackups.has(canonical(item.path)) && ageHours(item, now) >= rules.backupMinimumAgeDays * 24) await consider(item, 'backup');
  for (const item of await entries(root, 'releases')) {
    if (item.file && item.name.endsWith('.zip') && RELEASE.test(item.name.slice(0, -4)) &&
        !protectedReleases.has(canonical(item.path.slice(0, -4))) && ageHours(item, now) >= rules.orphanArchiveMinimumAgeHours) await consider(item, 'archive');
  }
  for (const item of await entries(root, 'logs')) {
    if (item.file && /^[a-z0-9._-]+\.log$/i.test(item.name) && !ACTIVE_LOGS.has(item.name.toLowerCase()) && ageHours(item, now) >= rules.inactiveLogMinimumAgeDays * 24) await consider(item, 'log');
  }
  return { format: 1, createdAtUtc: now.toISOString(), policy: rules, pressure, protectedReleases: [...protectedReleases], protectedBackupCount: protectedBackups.size,
    candidates, skipped, candidateBytes: candidates.reduce((sum, item) => sum + item.bytes, 0) };
}
function healthy(config) {
  return new Promise(resolve => {
    const req = http.get({ host: config.companyHost, port: config.gatewayPort || 4000, path: '/healthz', timeout: 4000 }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; if (body.length > 4096) res.destroy(); });
      res.on('end', () => { try { const value = JSON.parse(body); resolve(res.statusCode === 200 && value.status === 'ok' && value.frontend === 'ok' && value.backend === 'ok'); } catch (_) { resolve(false); } });
      res.on('error', () => resolve(false));
    });
    req.on('timeout', () => req.destroy()); req.on('error', () => resolve(false));
  });
}
async function writeReport(root, report) {
  const target = ordinaryParents(root, path.join(root, 'delivery/last-cleanup.json'));
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(temporary, JSON.stringify(report, null, 2) + '\n');
  await fsp.rename(temporary, target);
}
async function executeCleanup({ installRoot, apply = false, processRoots = [], checkHealth = healthy, removeArtifact, availableBytes } = {}) {
  const root = path.resolve(installRoot), config = readJson(root, 'delivery/config.json');
  if (canonical(config.installRoot) !== canonical(root)) throw new Error('Cleanup configuration belongs to another installation');
  const policyFile = path.join(root, 'delivery/cleanup-policy.json');
  const policy = fs.existsSync(policyFile) ? readJson(root, 'delivery/cleanup-policy.json') : DEFAULTS;
  const space = availableBytes || (() => { const s = fs.statfsSync(root); return Number(s.bavail) * Number(s.bsize); });
  const report = { format: 1, runId: crypto.randomUUID(), startedAtUtc: new Date().toISOString(), apply, status: 'checking', removedCount: 0, removedBytes: 0, diskFreeBefore: space(), errors: [] };
  try {
    if (!await checkHealth(config)) { report.status = 'skipped_unhealthy'; return report; }
    const plan = await planCleanup({ installRoot: root, policy, processRoots, freeBytes: report.diskFreeBefore });
    report.candidateCount = plan.candidates.length; report.candidateBytes = plan.candidateBytes; report.skippedCount = plan.skipped.length;
    report.pressureCleanup = plan.pressure;
    report.protectedReleaseCount = plan.protectedReleases.length;
    report.status = apply ? 'running' : 'preview';
    await writeReport(root, report);
    if (apply) {
      for (const item of plan.candidates) {
        if (!await checkHealth(config)) { report.status = 'stopped_unhealthy'; break; }
        try {
          if (removeArtifact) await removeArtifact(item);
          else {
            if (process.platform !== 'win32') throw new Error('Apply requires the reviewed Windows filesystem deleter');
            const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
            const result = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'Remove-CompanyArtifact.ps1'), '-InstallRoot', root, '-Kind', item.kind, '-Target', item.path], { encoding: 'utf8', windowsHide: true, timeout: 45 * 60 * 1000, maxBuffer: 1024 * 1024 });
            if (result.error || result.status !== 0) {
              // The PowerShell deleter prints only a stage and Win32 error code.
              // Never place raw stderr (which can include full local paths) in
              // the emailed report.
              const detail = /CLEANUP_FAILURE code=([A-Z_]+) stage=([a-z_]+) win32=(\d+)/.exec(result.stderr || '');
              const reason = detail ? `${detail[1]} at ${detail[2]} (Win32 ${detail[3]})` : result.error?.code === 'ETIMEDOUT' ? 'DELETION_TIMEOUT' : 'DELETION_FAILED';
              throw new Error(reason);
            }
          }
          report.removedCount++; report.removedBytes += item.bytes;
        } catch (error) { report.errors.push({ relative: item.relative, message: error.message }); }
        await writeReport(root, report);
      }
      if (report.status === 'running') report.status = report.errors.length ? 'completed_with_skips' : 'complete';
      if (!await checkHealth(config)) report.status = 'stopped_unhealthy';
    }
    return report;
  } catch (error) { report.status = 'failed'; report.errors.push({ message: error.message }); return report; }
  finally {
    report.finishedAtUtc = new Date().toISOString();
    report.diskFreeAfter = space();
    report.lowDisk = report.diskFreeAfter < DISK_RESERVE_BYTES;
    if (apply && report.status === 'complete' && report.lowDisk) report.status = 'low_space';
    await writeReport(root, report);
  }
}
async function main() {
  const args = process.argv.slice(2), root = args[0];
  if (root === '--validate-policy' && args[1]) {
    validatePolicy(JSON.parse(fs.readFileSync(args[1], 'utf8')));
    process.stdout.write('CLEANUP_POLICY_VALID\n');
    return;
  }
  if (!root) throw new Error('Expected reviewed installation root');
  const processRoots = args[2] ? JSON.parse(Buffer.from(args[2], 'base64').toString('utf8')) : [];
  const result = await executeCleanup({ installRoot: root, apply: args[1] === '--apply', processRoots });
  process.stdout.write(JSON.stringify({ status: result.status, removedCount: result.removedCount, removedBytes: result.removedBytes, candidateBytes: result.candidateBytes || 0 }) + '\n');
  if (['failed', 'stopped_unhealthy'].includes(result.status)) process.exitCode = 1;
}
if (require.main === module) main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
module.exports = { DEFAULTS, DISK_RESERVE_BYTES, PRESSURE_CLEANUP_BYTES, validatePolicy, planCleanup, executeCleanup, inspectTree };
