'use strict';

const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { localApiAccess } = require('../middleware/localApiAccess');
const { environmentFile } = require('../config/environmentFile');

function createCompanyMaintenanceRouter({ environment = process.env, installRoot } = {}) {
  const router = express.Router();
  router.use(localApiAccess);
  router.get('/status', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    if (environment.COMPANY_DEPLOYMENT !== 'true') return res.status(404).json({ success: false, message: '公司维护状态未启用' });
    try {
      const root = installRoot || path.dirname(path.dirname(environmentFile(environment)));
      const read = name => {
        const file = path.join(root, 'delivery', name);
        return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
      };
      const installed = read('cleanup-installation.json'), last = read('last-cleanup.json');
      const policy = installed?.policy ? Object.fromEntries([
        'keepNewestReleases','releaseMinimumAgeHours','incompleteReleaseMinimumAgeHours',
        'pressureReleaseMinimumAgeHours','pressureIncompleteReleaseMinimumAgeHours','keepRollbackReleases','keepNewestBackups',
        'backupMinimumAgeDays','orphanArchiveMinimumAgeHours','inactiveLogMinimumAgeDays'
      ].filter(key => Number.isInteger(installed.policy[key])).map(key => [key, installed.policy[key]])) : null;
      return res.json({ success: true, data: {
        installed: installed?.installed === true,
        taskName: installed?.taskName || null,
        times: installed?.times || [], timeZone: installed?.timeZone || null,
        enabledAtInstallation: installed?.enabled === true,
        installedAtUtc: installed?.installedAtUtc || null,
        policy,
        lastRun: last ? { status: last.status, apply: last.apply, startedAtUtc: last.startedAtUtc, finishedAtUtc: last.finishedAtUtc,
          removedCount: last.removedCount, removedBytes: last.removedBytes, candidateCount: last.candidateCount, candidateBytes: last.candidateBytes,
          diskFreeBefore: last.diskFreeBefore, diskFreeAfter: last.diskFreeAfter, lowDisk: last.lowDisk === true,
          pressureCleanup: last.pressureCleanup === true,
          errorCount: Array.isArray(last.errors) ? last.errors.length : 0 } : null
      } });
    } catch (_) { return res.status(500).json({ success: false, message: '公司维护状态暂不可读取' }); }
  });
  return router;
}
module.exports = { createCompanyMaintenanceRouter };
