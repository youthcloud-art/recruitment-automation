const express = require('express');
const { localApiAccess } = require('../middleware/localApiAccess');
const { QcwyImapConfigService } = require('../services/qcwyImapConfigService');
const { QcwyImapSyncService } = require('../services/qcwyImapSyncService');

function createQcwyInboxRouter({ config = new QcwyImapConfigService(), sync = null } = {}) {
  const service = sync || new QcwyImapSyncService({ config });
  const router = express.Router();
  router.use(localApiAccess);

  function fail(res, error) {
    const message = error?.message || '操作失败';
    const isInput = /请|无效|需为|过多|过长|正在进行中/.test(message);
    return res.status(isInput ? 400 : 500).json({ success: false, message: isInput ? message : '操作失败，请检查设置后重试' });
  }

  router.get('/config', (_req, res) =>
    res.json({ success: true, data: config.current() }));

  router.put('/config', async (req, res) => {
    try {
      const saved = await config.save(req.body || {});
      service.configureSchedule();
      res.json({ success: true, data: saved });
    } catch (error) { fail(res, error); }
  });

  router.post('/verify', async (_req, res) => {
    try { res.json({ success: true, data: await service.verify() }); }
    catch (error) { fail(res, error); }
  });

  router.get('/status', (_req, res) =>
    res.json({ success: true, data: service.status() }));

  router.post('/sync', (_req, res) => {
    try { res.json({ success: true, data: service.syncNow() }); }
    catch (error) { fail(res, error); }
  });

  router.post('/stop', async (_req, res) => {
    try {
      service.stop();
      const current = config.current();
      if (current.configured && current.enabled) await config.save({ ...current, enabled: false });
      res.json({ success: true, data: service.status() });
    } catch (error) { fail(res, error); }
  });

  if (config.current().enabled && config.current().configured) {
    setImmediate(() => service.configureSchedule());
  }
  return router;
}

module.exports = createQcwyInboxRouter();
module.exports.createQcwyInboxRouter = createQcwyInboxRouter;
