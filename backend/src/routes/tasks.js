const express = require('express');
const TaskModel = require('../models/taskModel');

const router = express.Router();
const taskModel = new TaskModel();
let mutationQueue = Promise.resolve();
function mutate(work) {
  const result = mutationQueue.then(work, work);
  mutationQueue = result.catch(() => {});
  return result;
}
router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

function fail(res, error) {
  const missing = error.message === '任务不存在' || error.message.startsWith('候选人不存在');
  res.status(missing ? 404 : 400).json({ success: false, message: error.message });
}

router.get('/stats', async (_req, res) => {
  try { res.json({ success: true, data: await taskModel.getTaskStatsOptimized() }); }
  catch (error) { fail(res, error); }
});

router.get('/', async (req, res) => {
  try {
    const data = await taskModel.getAllTasksOptimized({
      ...req.query,
      page: Math.max(1, Number(req.query.page) || 1),
      limit: Math.min(100, Math.max(1, Number(req.query.limit) || 10))
    });
    res.json({ success: true, ...data });
  } catch (error) { fail(res, error); }
});

router.post('/', async (req, res) => {
  try {
    if (!String(req.body?.title || '').trim()) throw new Error('请填写任务名称');
    res.status(201).json({ success: true, data: await mutate(() => taskModel.createTask(req.body)) });
  } catch (error) { fail(res, error); }
});

router.delete('/', async (req, res) => {
  try {
    if (!Array.isArray(req.body?.ids)) throw new Error('请选择要删除的任务');
    await mutate(() => taskModel.deleteTasks(req.body.ids));
    res.json({ success: true, message: '任务已删除' });
  } catch (error) { fail(res, error); }
});

router.get('/:id', async (req, res) => {
  try {
    const task = await taskModel.getTaskByIdOptimized(req.params.id);
    if (!task) throw new Error('任务不存在');
    res.json({ success: true, data: task });
  } catch (error) { fail(res, error); }
});

router.put('/:id', async (req, res) => {
  try { res.json({ success: true, data: await mutate(() => taskModel.updateTask(req.params.id, req.body)) }); }
  catch (error) { fail(res, error); }
});

router.patch('/:id', async (req, res) => {
  try { res.json({ success: true, data: await mutate(() => taskModel.updateTask(req.params.id, req.body)) }); }
  catch (error) { fail(res, error); }
});

router.delete('/:id', async (req, res) => {
  try {
    await mutate(() => taskModel.deleteTask(req.params.id));
    res.json({ success: true });
  } catch (error) { fail(res, error); }
});

router.put('/:id/candidates/:candidateId/status', async (req, res) => {
  try {
    if (!['待联系', '已联系', '面试中', '已录用', '已拒绝'].includes(req.body?.status)) {
      throw new Error('候选人状态无效');
    }
    res.json({ success: true, data: await mutate(() => taskModel.updateCandidateStatus(
      req.params.id, req.params.candidateId, req.body.status
    )) });
  } catch (error) { fail(res, error); }
});

router.post('/:id/comments', async (req, res) => {
  try {
    if (!String(req.body?.content || '').trim()) throw new Error('请填写评论内容');
    res.json({ success: true, data: await mutate(() => taskModel.addComment(req.params.id, req.body)) });
  } catch (error) { fail(res, error); }
});

module.exports = router;
