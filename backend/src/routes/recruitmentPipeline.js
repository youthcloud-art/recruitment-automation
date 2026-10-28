const express = require('express');
const fs = require('fs');
const path = require('path');
const { RecruitmentPipelineService } = require('../services/recruitmentPipelineService');
const { CandidateEmailService } = require('../services/candidateEmailService');
const { BatchEvaluationService } = require('../services/batchEvaluationService');
const { postCaptureEvaluationQueue } = require('../services/postCaptureEvaluationQueue');
const { SmtpConfigService } = require('../services/smtpConfigService');
const { markdownToDocx } = require('../services/candidateReportDocx');
const multer = require('multer');
const { parseJobTemplate } = require('../services/activeJobService');
const positionService = require('../services/positionService');
const { RecruitmentAnalyticsService } = require('../services/recruitmentAnalyticsService');
const { ResumeRecommendationService } = require('../services/resumeRecommendationService');
const { publicCandidate, publicCandidateSummary } = require('../utils/candidateDisplay');

const router = express.Router();
const service = new RecruitmentPipelineService();
const emailService = new CandidateEmailService({ pipeline: service,
  deliveryReceiptDirectory: path.join(__dirname, '../../storage/mail_delivery_receipts') });
const batchService = new BatchEvaluationService({ pipeline: service,
  onEvaluationSuccess: evaluation => {
    if (evaluation?.method === 'llm') postCaptureEvaluationQueue.resume();
  } });
const smtpConfig = new SmtpConfigService();
const analyticsService = new RecruitmentAnalyticsService();
const recommendationService = new ResumeRecommendationService();
const uploadJobTemplate = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1_500_000 } }).single('file');
// The bundled base64 copy is the same OOXML template exposed in frontend/public.
// It avoids Windows file-provider wrappers that can make Node read .xlsx bytes
// differently from a browser and intermittently break template downloads.
const jobTemplateBytes = Buffer.from(fs.readFileSync(
  path.join(__dirname, '../../assets/job-criteria-template.base64'), 'ascii'
).trim(), 'base64');
if (jobTemplateBytes.subarray(0, 2).toString('ascii') !== 'PK') {
  throw new Error('岗位条件模板资源无效');
}

function isTrustedLocalRequest(req) {
  const address = req.socket.remoteAddress || '';
  const origin = req.get('origin');
  const host = req.get('host') || '';
  const fetchSite = String(req.get('sec-fetch-site') || '').toLowerCase();
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address) &&
    /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(host) &&
    (!origin || ['http://localhost:3000', 'http://127.0.0.1:3000'].includes(origin)) &&
    (origin || !fetchSite || ['same-origin', 'none'].includes(fetchSite));
}

function localPipelineAccess(req, res, next) {
  // 仅本机启动时对新招聘工作流整体加来源限制，远程部署沿用原有路由行为。
  if (['127.0.0.1', '::1', 'localhost'].includes(process.env.HOST) &&
      !isTrustedLocalRequest(req)) {
    return res.status(403).json({ success: false, message: '招聘数据仅允许在本机招聘系统中操作' });
  }
  next();
}

function localEmailAccess(req, res, next) {
  if (!isTrustedLocalRequest(req)) {
    return res.status(403).json({ success: false, message: '邮件设置仅允许在本机招聘系统中操作' });
  }
  next();
}

router.use(localPipelineAccess);

function fail(res, error) {
  const status = /未找到/.test(error.message) ? 404 :
    /不支持|需为|不能超过|没有要|没有达到|内容不足|无效|请输入|请先|请填写|最多发送|正在进行中|已变化|已过期|不一致|分页|关键词过长/.test(error.message) ? 400 : 500;
  return res.status(status).json({ success: false, message: error.message });
}

router.get('/summary', (_req, res) => res.json({ success: true, data: service.summary() }));
router.get('/recommendations', (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, data: recommendationService.recommend(req.query) });
  } catch (error) { res.status(400).json({ success: false, message: error.message }); }
});
router.get('/analytics', (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, data: analyticsService.snapshot(req.query) });
  } catch (error) { fail(res, error); }
});

router.get('/analytics/report', async (req, res) => {
  try {
    const format = String(req.query.format || 'docx').toLowerCase();
    if (!['docx', 'csv'].includes(format)) throw new Error('不支持的分析报告格式');
    res.set('Cache-Control', 'no-store');
    if (format === 'docx') {
      const buffer = await markdownToDocx(analyticsService.reportMarkdown(req.query));
      res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.set('Content-Disposition', 'attachment; filename="recruitment-analytics.docx"');
      res.send(buffer);
    } else {
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', 'attachment; filename="recruitment-analytics.csv"');
      res.send(analyticsService.reportCsv(req.query));
    }
  } catch (error) { fail(res, error); }
});
router.get('/active-job', (req, res) => {
  try { res.json({ success: true, data: service.activeJob(req.query.platform) }); }
  catch (error) { fail(res, error); }
});

router.get('/active-job/template', (_req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', 'attachment; filename="job-criteria-template.xlsx"');
    res.send(jobTemplateBytes);
  } catch (error) { fail(res, error); }
});

router.put('/active-job', async (req, res) => {
  try {
    const result = await positionService.createLocalPosition(req.body, {},
      { applyTo: req.body?.applyTo });
    res.json({ success: true, data: result.job });
  }
  catch (error) { res.status(400).json({ success: false, message: error.message }); }
});

router.post('/active-job/import', (req, res) => {
  uploadJobTemplate(req, res, async error => {
    if (error) return res.status(400).json({ success: false,
      message: error.code === 'LIMIT_FILE_SIZE' ? '模板文件不能超过 1.5 MB' : '模板上传失败：' + error.message });
    if (!req.file || !/\.xlsx$/i.test(req.file.originalname || '')) {
      return res.status(400).json({ success: false, message: '请选择 .xlsx 岗位条件模板' });
    }
    try {
      const result = await positionService.createLocalPosition(parseJobTemplate(req.file.buffer), {},
        { applyTo: req.body?.applyTo });
      res.json({ success: true, data: result.job });
    }
    catch (importError) { res.status(400).json({ success: false, message: importError.message }); }
  });
});

// The creation dialog must be able to read an Excel template without
// replacing the active job before the user confirms the new position.
router.post('/active-job/preview-import', (req, res) => {
  uploadJobTemplate(req, res, error => {
    if (error) return res.status(400).json({ success: false,
      message: error.code === 'LIMIT_FILE_SIZE' ? '模板文件不能超过 1.5 MB' : '模板上传失败：' + error.message });
    if (!req.file || !/\.xlsx$/i.test(req.file.originalname || '')) {
      return res.status(400).json({ success: false, message: '请选择 .xlsx 岗位条件模板' });
    }
    try { res.json({ success: true, data: { ...parseJobTemplate(req.file.buffer), updatedAt: null } }); }
    catch (importError) { res.status(400).json({ success: false, message: importError.message }); }
  });
});

router.get('/candidates', (req, res) => {
  try { res.json({ success: true, data: service.list(req.query).map(publicCandidate) }); }
  catch (error) { fail(res, error); }
});

router.get('/candidates/jobs', (_req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, data: service.jobs() });
  } catch (error) { fail(res, error); }
});

router.get('/candidates/page', (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const data = service.listPage(req.query);
    res.json({ success: true, data: { ...data, items: data.items.map(publicCandidateSummary) } });
  } catch (error) { fail(res, error); }
});

router.post('/candidates/historical/delete', (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, data: service.deleteHistoricalCandidates(req.body) });
  } catch (error) { fail(res, error); }
});

router.patch('/candidates/:id', (req, res) => {
  try { res.json({ success: true, data: publicCandidate(service.update(req.params.id, req.body)) }); }
  catch (error) { fail(res, error); }
});

router.post('/candidates/:id/evaluate', async (req, res) => {
  try {
    const evaluation = await service.evaluate(req.params.id, req.body.jobRequirements);
    if (evaluation.method === 'llm') postCaptureEvaluationQueue.resume();
    res.json({ success: true, data: evaluation });
  }
  catch (error) { fail(res, error); }
});

router.get('/evaluate-batch/status', (_req, res) =>
  res.json({ success: true, data: batchService.status() }));

router.get('/evaluation-queue/status', (_req, res) =>
  res.json({ success: true, data: postCaptureEvaluationQueue.status() }));

router.post('/evaluate-batch/start', (req, res) => {
  try { res.json({ success: true, data: batchService.start(req.body) }); }
  catch (error) { fail(res, error); }
});

router.post('/evaluate-batch/stop', (_req, res) =>
  res.json({ success: true, data: batchService.stop() }));

router.get('/report/preview', (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, data: service.reportPreview(req.query) });
  } catch (error) { fail(res, error); }
});

router.get('/report', async (req, res) => {
  try {
    const format = String(req.query.format || 'md').toLowerCase();
    if (!['md', 'docx'].includes(format)) throw new Error('不支持的报告格式');
    const report = service.report(req.query);
    res.set('Cache-Control', 'no-store');
    if (format === 'docx') {
      res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.set('Content-Disposition', 'attachment; filename="candidate-report.docx"');
      res.send(await markdownToDocx(report));
    } else {
      res.set('Content-Type', 'text/markdown; charset=utf-8');
      res.set('Content-Disposition', 'attachment; filename="candidate-report.md"');
      res.send(report);
    }
  } catch (error) { fail(res, error); }
});

router.use('/email', localEmailAccess);

router.get('/email/config', (_req, res) =>
  res.json({ success: true, data: { ...emailService.configuration(), ...smtpConfig.current() } }));

router.put('/email/config', async (req, res) => {
  try { res.json({ success: true, data: await smtpConfig.save(req.body) }); }
  catch (error) { fail(res, error); }
});

router.post('/email/verify', async (_req, res) => {
  try { res.json({ success: true, data: await emailService.verify() }); }
  catch (error) { fail(res, error); }
});

router.post('/email/preview', async (req, res) => {
  try { res.json({ success: true, data: await emailService.preview(req.body) }); }
  catch (error) { fail(res, error); }
});

router.post('/email/resume', async (req, res) => {
  try { res.json({ success: true, data: await emailService.resume(req.body) }); }
  catch (error) { fail(res, error); }
});

router.post('/email/send', async (req, res) => {
  try { res.json({ success: true, data: await emailService.send(req.body) }); }
  catch (error) { fail(res, error); }
});

module.exports = router;
