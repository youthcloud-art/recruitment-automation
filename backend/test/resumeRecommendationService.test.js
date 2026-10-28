const test = require('node:test');
const assert = require('node:assert/strict');
const { ResumeRecommendationService } = require('../src/services/resumeRecommendationService');

const REQUIREMENTS = '岗位名称：IT网络运维\n必需技能：网络故障排查';
const job = { title: 'IT网络运维', updatedAt: '2026-10-20T00:00:00.000Z',
  jobRequirements: REQUIREMENTS, recommendationTargetCount: 100 };

function candidate(id, source, score, changes = {}) {
  return { id, source, name: id, position: 'IT网络运维', originalText: '工作经历：网络故障排查',
    matchScore: score, matchEvaluation: { jobRequirements: REQUIREMENTS,
      method: 'llm', evaluationVersion: 1, evaluatedAt: '2026-10-20T01:00:00.000Z',
      summary: '有相关网络运维经历', strengths: ['故障排查'], gaps: ['待核实值班经验'] },
    ...changes };
}

function service(records, activeJob = job) {
  return new ResumeRecommendationService({
    store: { getResumes: () => records },
    activeJobService: { current: () => activeJob }
  });
}

test('推荐只包含当前岗位同版已评估、可复核且达线的真实候选人', () => {
  const records = [
    candidate('qualified-zl', 'zlzp', 85),
    candidate('qualified-qcwy', 'qcwy', 81),
    candidate('old-job', 'boss', 98, { matchEvaluation: { jobRequirements: '旧岗位', evaluatedAt: 'x' } }),
    candidate('below', 'zlzp', 69),
    candidate('unscored', 'zlzp', null),
    candidate('no-text', 'boss', 95, { originalText: '' }),
    candidate('rejected', 'boss', 93, { workflowStatus: 'rejected' }),
    candidate('gated', 'zlzp', 90, { matchEvaluation: {
      jobRequirements: REQUIREMENTS, recommendationEligible: false } }),
    candidate('legacy-zl', 'zlzp', 91, { matchEvaluation: {
      jobRequirements: REQUIREMENTS, method: 'local', evaluationVersion: 1,
      evaluatedAt: '2026-10-20T01:00:00.000Z' } }),
    candidate('failed-boss', 'boss', 94, { matchEvaluationStatus: 'failed' }),
    candidate('unvetted-qcwy', 'qcwy', 92, { matchEvaluation: {
      jobRequirements: REQUIREMENTS, method: 'local', evaluationVersion: 1 } })
  ];
  const result = service(records).recommend();
  assert.equal(result.job.title, 'IT网络运维');
  assert.equal(result.limit, 100);
  assert.equal(result.evaluatedCount, 5);
  assert.equal(result.qualifiedCount, 2);
  assert.equal(result.targetShortfall, 98);
  assert.deepEqual(result.recommendations.map(item => item.id), ['qualified-zl', 'qualified-qcwy']);
  assert.equal(result.recommendations[0].summary, '有相关网络运维经历');
  assert.equal(Object.hasOwn(result.recommendations[0], 'originalText'), false);
});

test('平台、最低分和展示上限生效，智联相同简历不会重复推荐', () => {
  const records = [
    candidate('first', 'zlzp', 90, { sourceFingerprint: 'same' }),
    candidate('duplicate', 'zlzp', 89, { sourceFingerprint: 'same' }),
    candidate('second', 'zlzp', 80),
    candidate('other', 'qcwy', 96)
  ];
  const result = service(records).recommend({ source: 'zlzp', minScore: 80, limit: 1 });
  assert.equal(result.evaluatedCount, 3);
  assert.equal(result.qualifiedCount, 2);
  assert.deepEqual(result.recommendations.map(item => item.id), ['first']);
});

test('按单个平台推荐时使用该平台当前岗位，不误用最近应用到其他平台的岗位', () => {
  const requests = [];
  const target = new ResumeRecommendationService({
    store: { getResumes: () => [candidate('zl', 'zlzp', 85)] },
    activeJobService: { current: platform => {
      requests.push(platform);
      return platform === 'zlzp' ? job : { ...job, title: '其他岗位',
        jobRequirements: '其他岗位要求' };
    } }
  });
  assert.equal(target.recommend({ source: 'zlzp' }).qualifiedCount, 1);
  assert.deepEqual(requests, ['zlzp']);
});

test('岗位尚未应用时返回清楚的空状态，不推荐历史岗位候选人', () => {
  const result = service([candidate('old', 'boss', 99)], { ...job, updatedAt: null }).recommend();
  assert.equal(result.evaluatedCount, 0);
  assert.equal(result.qualifiedCount, 0);
  assert.deepEqual(result.recommendations, []);
});

test('错误的分数、份数或平台参数会被拒绝', () => {
  const target = service([]);
  assert.throws(() => target.recommend({ minScore: '70.5' }), /最低匹配分/);
  assert.throws(() => target.recommend({ limit: 201 }), /推荐份数/);
  assert.throws(() => target.recommend({ source: 'unknown' }), /招聘平台/);
});

test('历史前程无忧页面导航文字不会显示成候选人姓名或求职岗位', () => {
  const key = 'b'.repeat(64);
  const item = candidate('qcwy-ui', 'qcwy', 82, {
    name: '通知', position: '通知', sourceRecordKey: key,
    sourceUrl: 'https://ehire.51job.com/Revision/talent/resume/detail?resumeId=official-123'
  });
  const result = service([item]).recommend();
  assert.equal(result.qualifiedCount, 1);
  assert.equal(result.recommendations[0].name,
    '匿名候选人（前程无忧记录 ID：official-123）');
  assert.equal(result.recommendations[0].position, '求职岗位待核实');
  assert.equal(item.name, '通知');
});

test('BOSS 推荐卡不把未核实 OCR 行首词语显示为姓名', () => {
  const item = candidate('boss-ui', 'boss', 82, {
    name: '工作', nameSource: 'ocr',
    originalText: '工作经历：在企业负责网络设备维护。\n教育经历：本科。'
  });
  const result = service([item]).recommend({ source: 'boss' });
  assert.equal(result.qualifiedCount, 1);
  assert.equal(result.recommendations[0].name, '未识别姓名');
  assert.equal(item.name, '工作');
});
