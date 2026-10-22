const test = require('node:test');
const assert = require('node:assert/strict');
const { RecruitmentAnalyticsService } = require('../src/services/recruitmentAnalyticsService');

const currentRequirements = '岗位名称：项目经理主管\n工作经验：至少5年';
const otherRequirements = '岗位名称：成本核算经理\n工作经验：至少3年';
const records = [
  { source: 'zlzp', name: '测试张某', phone: '13800000001', originalText: '私密简历内容',
    createdAt: '2026-10-19T10:00:00+08:00', workflowStatus: 'shortlisted', matchScore: 82,
    matchEvaluation: { jobRequirements: currentRequirements, method: 'llm', evaluationVersion: 1,
      evaluatedAt: '2026-10-20T09:00:00+08:00' } },
  { source: 'qcwy', name: '测试李某', email: 'test@example.invalid', originalText: '另一份私密简历',
    createdAt: '2026-10-19T11:00:00+08:00', workflowStatus: 'contacted', matchScore: 67,
    matchEvaluation: { jobRequirements: currentRequirements, method: 'llm', evaluationVersion: 1,
      evaluatedAt: '2026-10-20T10:00:00+08:00' } },
  { source: 'qcwy', createdAt: '2026-10-20T11:00:00+08:00', workflowStatus: 'new',
    originalText: '', matchScore: null, matchEvaluationJobTitle: '项目经理主管' },
  { source: 'boss', createdAt: '2026-09-19T10:00:00+08:00', workflowStatus: 'rejected',
    originalText: '历史简历', matchScore: 91, matchEvaluation: { jobRequirements: otherRequirements,
      method: 'llm', evaluationVersion: 1, evaluatedAt: '2026-09-19T11:00:00+08:00' } },
  { source: 'manual', createdAt: '2026-10-20T08:00:00+08:00', originalText: '手动导入' }
];
const service = new RecruitmentAnalyticsService({
  store: { getResumes: () => records },
  activeJobService: { current: () => ({ title: '项目经理主管', targetCount: 18,
    jobRequirements: currentRequirements, updatedAt: '2026-10-18T08:00:00Z' }) },
  clock: () => new Date('2026-10-20T12:00:00+08:00')
});

test('当前岗位仅统计按完全相同岗位条件完成评估的记录', () => {
  const data = service.snapshot();
  assert.equal(data.scope, 'active');
  assert.equal(data.job.title, '项目经理主管');
  assert.equal(data.metrics.total, 2);
  assert.equal(data.metrics.evaluated, 2);
  assert.equal(data.metrics.passed, 1);
  assert.equal(data.metrics.scoreAverage, 74.5);
  assert.equal(data.metrics.withOriginalText, 2);
  assert.equal(data.metrics.unevaluated, null);
  assert.equal(data.metrics.evaluationRate, null);
  assert.deepEqual(data.bySource.map(row => row.total), [0, 1, 1]);
  assert.equal(data.byStatus.find(row => row.status === 'contacted').count, 1);
  assert.equal(data.trend.reduce((sum, day) => sum + day.stored, 0), 2);
  assert.equal(data.trend.reduce((sum, day) => sum + day.evaluated, 0), 2);
});

test('历史范围包含未评估记录，分母与通过线调整正确', () => {
  const data = service.snapshot({ scope: 'all', threshold: '60' });
  assert.equal(data.metrics.total, 4);
  assert.equal(data.metrics.evaluated, 3);
  assert.equal(data.metrics.unevaluated, 1);
  assert.equal(data.metrics.passed, 3);
  assert.equal(data.metrics.withOriginalText, 3);
  assert.equal(data.metrics.passRate, 100);
  assert.equal(data.metrics.originalTextRate, 75);
  assert.equal(data.scoreBands.reduce((sum, band) => sum + band.count, 0), 3);
});

test('接口和报告只包含聚合统计，不输出候选人隐私或正文', () => {
  const aggregate = JSON.stringify(service.snapshot({ scope: 'all' }));
  const report = service.reportMarkdown({ scope: 'all' });
  const csv = service.reportCsv({ scope: 'all' });
  for (const output of [aggregate, report, csv]) {
    assert.doesNotMatch(output, /测试张某|测试李某|13800000001|test@example\.invalid|私密简历内容/);
    assert.match(output, /项目经理主管|入库|评估/);
  }
  assert.match(report, /匹配分是辅助筛选结果/);
  assert.ok(csv.startsWith('\uFEFF'));
});

test('非法范围和分数被拒绝，CSV 标题阻止电子表格公式', () => {
  assert.throws(() => service.snapshot({ scope: 'everyone' }), /不支持/);
  assert.throws(() => service.snapshot({ threshold: 101 }), /通过分数/);
  assert.throws(() => service.snapshot({ threshold: '70.5' }), /通过分数/);
  const malicious = new RecruitmentAnalyticsService({
    store: { getResumes: () => [] },
    activeJobService: { current: () => ({ title: '=SUM(A1:A9)', jobRequirements: currentRequirements }) }
  });
  assert.match(malicious.reportCsv(), /'\=SUM\(A1:A9\)/);
});

test('带小数的有效评分落入连续分数段，不会漏计', () => {
  const decimal = new RecruitmentAnalyticsService({
    store: { getResumes: () => [{ source: 'boss', matchScore: 69.5,
      matchEvaluation: { jobRequirements: currentRequirements, method: 'llm', evaluationVersion: 1,
        evaluatedAt: '2026-10-20T11:00:00+08:00' } }] },
    activeJobService: { current: () => ({ title: '项目经理主管', jobRequirements: currentRequirements }) }
  });
  const data = decimal.snapshot();
  assert.equal(data.metrics.evaluated, 1);
  assert.equal(data.scoreBands.find(row => row.key === '60-69').count, 1);
  assert.equal(data.scoreBands.reduce((sum, row) => sum + row.count, 0), 1);
});

test('失败或进行中的重评不会把旧分数计入已评估与达标', () => {
  const evaluation = { jobRequirements: currentRequirements, method: 'llm', evaluationVersion: 1,
    evaluatedAt: '2026-10-19T10:00:00+08:00' };
  const staleRecords = [
    { source: 'zlzp', matchScore: 95, matchEvaluationStatus: 'failed', matchEvaluation: evaluation },
    { source: 'boss', matchScore: 92, matchEvaluationStatus: 'pending', matchEvaluation: evaluation },
    { source: 'zlzp', matchScore: 88, matchEvaluation: { ...evaluation, evaluationVersion: 0 } },
    { source: 'qcwy', matchScore: 84, matchEvaluation: { jobRequirements: currentRequirements,
      method: 'local', evaluationVersion: 2, recommendationEligible: false } },
    { source: 'zlzp', matchScore: 78, matchEvaluationStatus: 'completed', matchEvaluation: evaluation }
  ];
  const analytics = new RecruitmentAnalyticsService({
    store: { getResumes: () => staleRecords },
    activeJobService: { current: () => ({ title: '项目经理主管', jobRequirements: currentRequirements }) }
  });
  const result = analytics.snapshot({ threshold: 70 });
  assert.equal(result.metrics.total, 5);
  assert.equal(result.metrics.evaluated, 1);
  assert.equal(result.metrics.passed, 1);
  assert.equal(result.scoreBands.reduce((sum, row) => sum + row.count, 0), 1);
  assert.equal(result.bySource.find(row => row.source === 'zlzp').evaluated, 1);
});
