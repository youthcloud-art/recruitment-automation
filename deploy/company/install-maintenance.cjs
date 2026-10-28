'use strict';

// The existing SYSTEM mirror task runs backend npm ci for each server release.
// Install maintenance there; developer npm installs never create scheduled tasks.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
function eligible({ platform = process.platform, releaseRoot = path.resolve(__dirname, '../..'), environment = process.env } = {}) {
  if (platform !== 'win32' || environment.npm_lifecycle_event !== 'postinstall') return false;
  const expected = 'D:\\App\\SXF\\Smart-Recruitment-Agent';
  const parsed = path.win32.parse(releaseRoot);
  return path.win32.dirname(releaseRoot).toLowerCase() === path.win32.join(expected, 'releases').toLowerCase() &&
    /^\d{8}-\d{6}-[a-f0-9]{12}-[a-f0-9]{6}$/i.test(parsed.base);
}
function main() {
  if (!eligible()) { process.stdout.write('Company cleanup bootstrap skipped outside the reviewed server deployment.\n'); return; }
  const root = 'D:\\App\\SXF\\Smart-Recruitment-Agent';
  const configFile = path.join(root, 'delivery/config.json');
  if (!fs.existsSync(configFile) || !fs.existsSync(path.join(root, 'control/current-release.json'))) return;
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  if (config.installRoot.toLowerCase() !== root.toLowerCase() || config.companyHost !== '192.168.1.24' || config.repositoryUrl !== 'git@gitee.com:felixshe/auto-recru-company.git') throw new Error('Unexpected company cleanup bootstrap configuration');
  const windows = process.env.SystemRoot || 'C:\\Windows';
  const identity = spawnSync(path.join(windows, 'System32/whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
  if (identity.status !== 0 || !/S-1-5-18(?:"|,|\s|$)/.test(identity.stdout || '')) { process.stdout.write('Cleanup task installation requires the existing SYSTEM mirror deployment.\n'); return; }
  const result = spawnSync(path.join(windows, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'Install-CompanyCleanup.ps1'), '-InstallRoot', root], { stdio: 'inherit', windowsHide: true, timeout: 120000 });
  if (result.error || result.status !== 0) throw new Error('Company cleanup task installation failed; the existing running release was preserved');
}
if (require.main === module) { try { main(); } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; } }
module.exports = { eligible };
