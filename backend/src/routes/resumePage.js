const express = require('express');
const resumeModel = require('../models/resumeModel');
const { publicCandidateSummary } = require('../utils/candidateDisplay');

function integerParameter(value, fallback, min, max) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error('分页参数无效');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error('分页参数无效');
  }
  return parsed;
}

function createResumePageRouter(store = resumeModel) {
  const router = express.Router();
  router.get('/', (req, res) => {
    try {
      const source = String(req.query.source || '');
      const status = String(req.query.status || '');
      const position = String(req.query.position || '');
      const keyword = String(req.query.keyword || '').trim();
      const sortBy = String(req.query.sortBy || 'createdAt');
      if (source && !store.getResumeSources().some(item => item.value === source)) {
        throw new Error('招聘平台无效');
      }
      if (status && !['new', 'shortlisted', 'viewed', 'contacted', 'rejected'].includes(status)) {
        throw new Error('跟进状态无效');
      }
      if (position.length > 100) throw new Error('岗位筛选条件过长');
      if (keyword.length > 100) throw new Error('搜索关键词过长');
      if (!['createdAt', 'name', 'experience', 'education', 'age'].includes(sortBy)) {
        throw new Error('排序方式无效');
      }
      const limit = integerParameter(req.query.limit, 100, 1, 500);
      const offset = integerParameter(req.query.offset, 0, 0, 10_000_000);
      const data = store.getResumesPage({ source: source || null, status: status || null,
        position: position || null, keyword, sortBy, limit, offset });
      res.set('Cache-Control', 'no-store');
      res.json({ success: true, data: { ...data,
        items: data.items.map(item => publicCandidateSummary(item, { view: 'library' })) } });
    } catch (error) {
      res.status(400).json({ success: false, message: error.message });
    }
  });
  return router;
}

module.exports = createResumePageRouter();
module.exports.createResumePageRouter = createResumePageRouter;
