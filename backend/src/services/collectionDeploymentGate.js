const fs = require('node:fs');
const path = require('node:path');

const DRAIN_FILE = path.resolve(__dirname, '../../../.local/deploy-drain.request');
const START_PATHS = new Set([
  '/api/boss-zhipin/start-browsing',
  '/api/zhilian/start',
  '/api/zhilian/start-browsing',
  '/api/wuyou/collect-batch',
  '/api/wuyou/keyword-batch',
  '/api/recruitment-pipeline/evaluate-batch/start'
]);

function collectionDeploymentGate({ deployment = process.env.COMPANY_DEPLOYMENT,
  file = DRAIN_FILE, exists = fs.existsSync } = {}) {
  return (req, res, next) => {
    if (deployment === 'true' && req.method === 'POST' &&
        START_PATHS.has(req.path) && exists(file)) {
      return res.status(503).json({ success:false, code:'DEPLOY_DRAINING',
        message:'服务器正在等待当前采集完成并切换版本；本次启动未执行，请稍后在页面重试' });
    }
    next();
  };
}

module.exports = { collectionDeploymentGate, DRAIN_FILE };
