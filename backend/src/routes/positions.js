const express = require('express');
const router = express.Router();
const PositionService = require('../services/positionService');

function localPositionAccess(req, res, next) {
  const address = req.socket.remoteAddress || '';
  const origin = req.get('origin');
  const host = req.get('host') || '';
  const fetchSite = String(req.get('sec-fetch-site') || '').toLowerCase();
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address) ||
      !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(host) ||
      (origin && !['http://localhost:3000', 'http://127.0.0.1:3000'].includes(origin)) ||
      (!origin && fetchSite && !['same-origin', 'none'].includes(fetchSite))) {
    return res.status(403).json({ success: false, message: '本地岗位只能在本机招聘系统中操作' });
  }
  next();
}

router.post('/create-local', localPositionAccess, async (req, res) => {
  try {
    const result = await PositionService.createLocalPosition(req.body?.job || req.body,
      req.body?.metadata);
    res.status(result.reused ? 200 : 201).json({ success: true, ...result });
  } catch (error) {
    const validation = /岗位|关键词|工作地点|学历|经验|目标份数|无效|请填写|内容过长/.test(error.message);
    res.status(validation ? 400 : 500).json({ success: false, message: error.message });
  }
});

router.post('/draft-local', localPositionAccess, (req, res) => {
  try {
    const data = PositionService.draftLocalPosition(req.body?.description);
    res.json({ success: true, data });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.post('/:id/apply-local', localPositionAccess, (req, res) => {
  try { res.json({ success: true, ...PositionService.applyLocalPosition(req.params.id) }); }
  catch (error) { res.status(/不存在/.test(error.message) ? 404 : 400)
    .json({ success: false, message: error.message }); }
});

// 获取所有岗位
router.get('/', async (req, res) => {
  try {
    const positions = await PositionService.getPositions({ includeArchived: req.query.includeArchived === '1' });
    res.json({ success: true, data: positions });
  } catch (error) {
    console.error('获取岗位列表失败:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 根据ID获取岗位
router.get('/:id', async (req, res) => {
  try {
    const position = await PositionService.getPositionById(req.params.id);
    if (!position) {
      return res.status(404).json({ success: false, error: '岗位不存在' });
    }
    res.json({ success: true, data: position });
  } catch (error) {
    console.error('获取岗位详情失败:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 通过对话创建岗位
router.post('/create-from-dialog', async (req, res) => {
  try {
    const { userMessage } = req.body;
    
    if (!userMessage) {
      return res.status(400).json({ success: false, error: '用户消息不能为空' });
    }

    const result = await PositionService.createPositionFromDialog(userMessage);
    res.json(result);
  } catch (error) {
    console.error('通过对话创建岗位失败:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 更新岗位信息
router.put('/:id', async (req, res) => {
  try {
    const positionId = req.params.id;
    const updatedData = req.body;
    
    if (!positionId) {
      return res.status(400).json({ success: false, error: '岗位ID不能为空' });
    }

    const result = await PositionService.updatePosition(positionId, updatedData);
    if (result.success) {
      res.json(result);
    } else {
      res.status(404).json(result);
    }
  } catch (error) {
    console.error('更新岗位失败:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 删除岗位
router.delete('/:id', async (req, res) => {
  try {
    const positionId = req.params.id;
    
    if (!positionId) {
      return res.status(400).json({ success: false, error: '岗位ID不能为空' });
    }

    const result = await PositionService.deletePosition(positionId);
    if (result.success) {
      res.json(result);
    } else {
      res.status(404).json(result);
    }
  } catch (error) {
    console.error('删除岗位失败:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/:id/restore', async (req, res) => {
  try {
    const result = await PositionService.restorePosition(req.params.id);
    res.status(result.success ? 200 : 404).json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
