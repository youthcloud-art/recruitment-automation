const express = require('express');
const { WuyouService } = require('../services/wuyouService');

const router = express.Router();
const service = new WuyouService();
let batchStarting = false;
const MAX_TARGET_COUNT = 30;
const MAX_KEYWORDS = 10;

function handleError(res, error) {
  const message = error.message || '操作失败';
  const status = /请先|请在|请输入|没有可识别|不像简历|AI 未返回|格式不正确|正在进行|验证/.test(message) ? 400 : 500;
  return res.status(status).json({ success: false, message });
}

function parseTargetCount(value, defaultValue = MAX_TARGET_COUNT) {
  if (value === undefined) return defaultValue;
  if (value === null || value === '' || typeof value === 'boolean') return null;
  const count = Number(value);
  return Number.isInteger(count) && count >= 1 && count <= MAX_TARGET_COUNT ? count : null;
}

function parseKeywords(value) {
  if (typeof value !== 'string' && !Array.isArray(value)) return null;
  const raw = typeof value === 'string' ? value.split(/[,，、\n]/) : value;
  if (raw.some(item => typeof item !== 'string')) return null;
  const terms = [...new Set(raw.map(item => item.trim()).filter(Boolean))];
  if (!terms.length || terms.length > MAX_KEYWORDS || terms.some(term => term.length > 30)) return null;
  return terms;
}

router.get('/status', async (req, res) => {
  try {
    res.json({ success: true, data: await service.getStatus({ persistSession: req.query.readOnly !== '1' }) });
  } catch (error) {
    handleError(res, error);
  }
});

router.get('/diagnostics', async (_req, res) => {
  try {
    res.json({ success: true, data: await service.getPageDiagnostics() });
  } catch (error) {
    handleError(res, error);
  }
});

router.get('/diagnostics/filter-options', async (req, res) => {
  try {
    res.json({ success: true, data: await service.inspectFilterOptions(req.query.kind) });
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/filters/education', async (req, res) => {
  if (!['不限', '大专及以上', '本科及以上', '硕士及以上'].includes(req.body?.value)) {
    return res.status(400).json({ success: false, message: '前程无忧学历筛选值无效' });
  }
  try {
    res.json({ success: true, data: await service.selectEducationFilter(req.body?.value) });
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/start', async (_req, res) => {
  try {
    const data = await service.start();
    res.json({ success: true, data, message: data.isLoggedIn
      ? '已恢复前程无忧企业账号登录' : '浏览器已打开，请在需要时完成企业账号登录' });
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/stop', async (_req, res) => {
  try {
    res.json({ success: true, data: await service.stop() });
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/search', async (req, res) => {
  try {
    res.json({ success: true, data: await service.search(req.body.keyword) });
  } catch (error) {
    handleError(res, error);
  }
});

router.get('/candidate-links', async (_req, res) => {
  try {
    const links = await service.scanCandidateLinks();
    res.json({ success: true, data: { count: links.length } });
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/collect-current', async (_req, res) => {
  try {
    const result = await service.collectCurrent();
    res.json({ success: true, data: {
      saved: result.saved,
      duplicate: result.duplicate,
      resumeId: result.resume?.id || null
    } });
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/collect-batch', async (req, res) => {
  const targetCount = parseTargetCount(req.body?.targetCount);
  if (targetCount === null) {
    return res.status(400).json({ success: false, message: `目标简历数量需为 1～${MAX_TARGET_COUNT} 份` });
  }
  if (batchStarting) return res.status(409).json({ success: false, message: '前程无忧采集正在启动' });
  batchStarting = true;
  try {
    res.json({ success: true, data: await service.startBatch({ targetCount }) });
  } catch (error) {
    handleError(res, error);
  } finally { batchStarting = false; }
});

router.post('/keyword-batch', async (req, res) => {
  const targetCount = parseTargetCount(req.body?.targetCount);
  const keywords = parseKeywords(req.body?.keywords);
  if (targetCount === null) {
    return res.status(400).json({ success: false, message: `目标简历数量需为 1～${MAX_TARGET_COUNT} 份` });
  }
  if (!keywords) {
    return res.status(400).json({ success: false, message: `请输入 1～${MAX_KEYWORDS} 个关键词，每个不超过 30 字` });
  }
  if (req.body?.jobRequirements !== undefined &&
      (typeof req.body.jobRequirements !== 'string' || req.body.jobRequirements.length > 5000)) {
    return res.status(400).json({ success: false, message: '岗位要求不能超过 5000 字' });
  }
  if (req.body?.education !== undefined &&
      !['不限', '大专及以上', '本科及以上', '硕士及以上'].includes(req.body.education)) {
    return res.status(400).json({ success: false, message: '前程无忧学历筛选值无效' });
  }
  if (batchStarting) return res.status(409).json({ success: false, message: '前程无忧采集正在启动' });
  batchStarting = true;
  try {
    res.json({ success: true, data: await service.startKeywordBatch({ keywords, targetCount,
      ...(req.body.jobRequirements === undefined ? {} : { jobRequirements: req.body.jobRequirements }),
      ...(req.body.education === undefined ? {} : { education: req.body.education }) }) });
  } catch (error) {
    handleError(res, error);
  } finally { batchStarting = false; }
});

router.post('/stop-batch', async (_req, res) => {
  try {
    res.json({ success: true, data: await service.stopBatch() });
  } catch (error) {
    handleError(res, error);
  }
});

router.getBrowserConsoleTarget = () => ({ service });

module.exports = router;
