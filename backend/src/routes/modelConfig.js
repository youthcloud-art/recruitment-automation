const express = require('express');

function createModelConfigRouter(configService, onChange = () => {}) {
  const router = express.Router();
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.get('/', (_req, res) => res.json({ success: true, data: configService.status() }));
  router.put('/', (req, res) => {
    try {
      const data = configService.save(req.body || {});
      onChange();
      res.json({ success: true, data });
    } catch (error) {
      res.status(400).json({ success: false, message: error.message });
    }
  });
  router.post('/test', async (_req, res) => {
    try { res.json({ success: true, data: await configService.test() }); }
    catch (error) { res.status(400).json({ success: false, message: error.message }); }
  });
  return router;
}

module.exports = { createModelConfigRouter };
