const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { planCleanup, executeCleanup, validatePolicy, DEFAULTS } = require('../../deploy/company/maintenance/cleanup-engine.cjs');
const { eligible } = require('../../deploy/company/install-maintenance.cjs');

function write(root, name, value) {
  const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}
function old(file, day = 1) { const date = new Date(`2026-01-${String(day).padStart(2, '0')}T00:00:00Z`); fs.utimesSync(file, date, date); }
function removeTestRoot(root) {
  const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(root));
  assert.ok(relative.startsWith('company-cleanup-test-') && !relative.includes(path.sep));
  function unlinkJunctions(folder) {
    for (const name of fs.readdirSync(folder)) {
      const full = path.join(folder, name), info = fs.lstatSync(full);
      if (info.isSymbolicLink()) fs.unlinkSync(full);
      else if (info.isDirectory()) unlinkJunctions(full);
    }
  }
  unlinkJunctions(root); fs.rmSync(root, { recursive: true, force: true });
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'company-cleanup-test-'));
  t.after(() => removeTestRoot(root));
  for (const folder of ['delivery', 'control', 'releases', 'backups', 'logs', 'shared/local', 'shared/backend-storage', 'shared/backend-uploads', 'source/.git']) fs.mkdirSync(path.join(root, folder), { recursive: true });
  write(root, 'shared/backend-storage/resumes.sqlite', 'BUSINESS-DATABASE-SENTINEL');
  write(root, 'shared/local/browser-profiles/Cookies', 'LOGIN-SENTINEL');
  write(root, 'shared/backend.env', 'CONFIGURATION-SENTINEL');
  write(root, 'source/.git/objects-sentinel', 'GIT-SENTINEL');
  const releases = [];
  for (let index = 0; index < 12; index++) {
    const name = `202601${String(index + 1).padStart(2, '0')}-120000-${'a'.repeat(12)}-${index.toString(16).padStart(6, '0')}`;
    const full = path.join(root, 'releases', name); releases.push(full);
    write(full, 'release.json', { root: full, commit: 'a'.repeat(40) });
    write(full, 'backend/node_modules/fake-module.txt', 'dependency bytes');
    write(full, 'frontend/build/index.html', '<html>current build</html>');
    fs.symlinkSync(path.join(root, 'shared/local'), path.join(full, '.local'), 'junction');
    fs.symlinkSync(path.join(root, 'shared/backend-storage'), path.join(full, 'backend/storage'), 'junction');
    fs.symlinkSync(path.join(root, 'shared/backend-uploads'), path.join(full, 'backend/uploads'), 'junction');
    old(full, index + 1);
  }
  const backups = [];
  for (let index = 0; index < 10; index++) {
    const full = path.join(root, 'backups', `before-202601${String(index + 1).padStart(2, '0')}-120000-${index.toString(16).padStart(6, '0')}`);
    backups.push(full);
    write(full, 'previous.json', { previous: { root: index === 9 ? releases[3] : index === 8 ? releases[4] : releases[0], commit: 'a'.repeat(40) } });
    write(full, 'shared/data.txt', 'old automatic backup'); old(full, index + 1);
  }
  write(root, 'backups/data-export-20260101-120000-abcdef/precious.zip', 'MANUAL-EXPORT-SENTINEL');
  write(root, 'backups/setup-20260101-120000-abcdef/config.json', 'SETUP-SENTINEL');
  write(root, 'control/current-release.json', { root: releases[0], commit: 'a'.repeat(40) });
  write(root, 'control/processes.json', { release: releases[0], children: [] });
  write(root, 'delivery/prepared-release.json', { root: releases[1], commit: 'a'.repeat(40) });
  write(root, 'delivery/last-deployment.json', { snapshot: backups[0], release: releases[0] });
  write(root, 'delivery/config.json', { installRoot: root, companyHost: '127.0.0.1', gatewayPort: 4001 });
  write(root, 'logs/backend.stdout.log', 'active log'); old(path.join(root, 'logs/backend.stdout.log'));
  write(root, 'logs/preflight-backend.stdout.log', 'old inactive log'); old(path.join(root, 'logs/preflight-backend.stdout.log'));
  write(root, `releases/${path.basename(releases[0])}.zip`, 'protected archive'); old(path.join(root, `releases/${path.basename(releases[0])}.zip`));
  write(root, `releases/${path.basename(releases[5])}.zip`, 'orphan archive'); old(path.join(root, `releases/${path.basename(releases[5])}.zip`));
  return { root, releases, backups };
}
const now = new Date('2026-10-28T00:00:00Z');

test('cleanup protects current, prepared, real process roots, rollback releases, recent versions and business data', async t => {
  const f = fixture(t), plan = await planCleanup({ installRoot: f.root, now, processRoots: [f.releases[2]] });
  const paths = new Set(plan.candidates.map(item => item.path));
  for (const index of [0, 1, 2, 3, 4, 9, 10, 11]) assert.equal(paths.has(f.releases[index]), false);
  for (const index of [5, 6, 7, 8]) assert.equal(paths.has(f.releases[index]), true);
  assert.equal(paths.has(f.backups[0]), false);
  for (const file of ['shared/backend.env','shared/backend-storage/resumes.sqlite','logs/backend.stdout.log','source/.git/objects-sentinel']) assert.equal(paths.has(path.join(f.root, file)), false);
  assert.ok(plan.candidates.some(item => item.kind === 'archive'));
  assert.ok(plan.candidates.some(item => item.kind === 'log'));
  assert.ok(plan.candidateBytes > 0 && plan.candidateBytes < 100000);
});

test('unreviewed junctions, age grace periods and malformed references prevent unsafe deletion', async t => {
  const f = fixture(t);
  fs.symlinkSync(path.join(f.root, 'shared'), path.join(f.releases[5], 'foreign-junction'), 'junction');
  old(f.releases[5], 6);
  fs.utimesSync(f.releases[6], now, now);
  const plan = await planCleanup({ installRoot: f.root, now });
  assert.equal(plan.candidates.some(item => item.path === f.releases[5]), false);
  assert.ok(plan.skipped.some(item => item.relative.endsWith(path.basename(f.releases[5]))));
  assert.equal(plan.candidates.some(item => item.path === f.releases[6]), false);
  write(f.root, 'control/current-release.json', { root: path.join(f.root, 'shared'), commit: 'a'.repeat(40) });
  await assert.rejects(planCleanup({ installRoot: f.root, now }), /outside|Invalid/);
  assert.throws(() => validatePolicy({ ...DEFAULTS, keepNewestReleases: 0 }), /Unsafe/);
  assert.throws(() => validatePolicy({ ...DEFAULTS, backupMinimumAgeDays: 0 }), /Unsafe/);
});

test('preview never invokes deletion; health failure skips or stops actual cleanup', async t => {
  const f = fixture(t); let calls = 0;
  const preview = await executeCleanup({ installRoot: f.root, apply: false, checkHealth: async () => true, removeArtifact: async () => calls++ });
  assert.equal(preview.status, 'preview'); assert.equal(calls, 0); assert.ok(preview.candidateCount > 0);
  const unhealthy = await executeCleanup({ installRoot: f.root, apply: true, checkHealth: async () => false, removeArtifact: async () => calls++ });
  assert.equal(unhealthy.status, 'skipped_unhealthy'); assert.equal(calls, 0);
  let healthCalls = 0;
  const interrupted = await executeCleanup({ installRoot: f.root, apply: true, checkHealth: async () => ++healthCalls < 3, removeArtifact: async () => calls++ });
  assert.equal(interrupted.status, 'stopped_unhealthy'); assert.equal(calls, 1);
});

test('Windows PowerShell removes only a stale release and unlinks shared-data junctions without following them', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t), target = f.releases[5];
  const ps = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const script = path.resolve(__dirname, '../../deploy/company/maintenance/Remove-CompanyArtifact.ps1');
  const result = spawnSync(ps, ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-InstallRoot',f.root,'-Kind','release','-Target',target], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.readFileSync(path.join(f.root, 'shared/backend-storage/resumes.sqlite'), 'utf8'), 'BUSINESS-DATABASE-SENTINEL');
  assert.equal(fs.readFileSync(path.join(f.root, 'shared/local/browser-profiles/Cookies'), 'utf8'), 'LOGIN-SENTINEL');
  assert.equal(fs.existsSync(f.releases[0]), true);
  const refused = spawnSync(ps, ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-InstallRoot',f.root,'-Kind','release','-Target',f.releases[0]], { encoding:'utf8', windowsHide:true });
  assert.notEqual(refused.status, 0); assert.equal(fs.existsSync(f.releases[0]), true);
});

test('Windows deleter refuses unknown reparse points before changing any files', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t), target = f.releases[5];
  fs.symlinkSync(path.join(f.root, 'shared'), path.join(target, 'foreign'), 'junction');
  const ps = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const result = spawnSync(ps, ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.resolve(__dirname, '../../deploy/company/maintenance/Remove-CompanyArtifact.ps1'),'-InstallRoot',f.root,'-Kind','release','-Target',target], { encoding:'utf8', windowsHide:true });
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(path.join(target, 'release.json')), true);
  assert.equal(fs.readFileSync(path.join(f.root, 'shared/backend-storage/resumes.sqlite'), 'utf8'), 'BUSINESS-DATABASE-SENTINEL');
});

test('npm maintenance bootstrap is limited to SYSTEM release installation context, never developer directories', () => {
  const releaseRoot = path.win32.join('D:', 'App', 'SXF', 'Smart-Recruitment-Agent', 'releases', '20261028-120000-aaaaaaaaaaaa-abcdef');
  assert.equal(eligible({ platform:'win32',releaseRoot,environment:{npm_lifecycle_event:'postinstall'} }), true);
  assert.equal(eligible({ platform:'win32',releaseRoot:'C:\\work\\Auto-Recru',environment:{npm_lifecycle_event:'postinstall'} }), false);
  assert.equal(eligible({ platform:'win32',releaseRoot,environment:{} }), false);
  assert.equal(eligible({ platform:'linux',releaseRoot,environment:{npm_lifecycle_event:'postinstall'} }), false);
});
