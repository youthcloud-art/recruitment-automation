const test = require('node:test');
const assert = require('node:assert/strict');
const { BatchEvaluationService } = require('../src/services/batchEvaluationService');
const { RecruitmentPipelineService } = require('../src/services/recruitmentPipelineService');

test('批量评估跳过同岗位已评估简历，并逐份保存新结果', async () => {
  const evaluated = [];
  const records = [
    { id: 'a', name: '甲', originalText: '完整简历', matchScore: 86,
      matchEvaluation: { method: 'llm', evaluationVersion: 1,
        jobRequirements: '招聘有项目经验的工程师' } },
    { id: 'b', name: '乙', originalText: '另一份完整简历' },
    { id: 'c', name: '丙', originalText: '第三份完整简历' }
  ];
  const service = new BatchEvaluationService({
    pipeline: {
      list: () => records,
      evaluate: async id => { evaluated.push(id); }
    },
    delay: async () => {}
  });
  service.start({ jobRequirements: '招聘有项目经验的工程师', limit: 3 });
  for (let attempt = 0; service.status().running && attempt < 20; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.equal(service.status().running, false);
  assert.equal(service.status().processed, 2);
  assert.equal(service.status().skipped, 1);
  assert.equal(service.status().evaluated, 2);
  assert.deepEqual(evaluated, ['b', 'c']);
});

test('通用岗位旧前程无忧关键词评分迁移为 AI 评估，当前 AI 版本才跳过', async () => {
  const requirements = '需要需求分析和原型设计经验';
  const records = [
    { id: 'legacy', source: 'qcwy', matchScore: 99,
      matchEvaluation: { jobRequirements: requirements } },
    { id: 'remote-old', source: 'qcwy', matchScore: 99,
      matchEvaluation: { jobRequirements: requirements, method: 'llm' } },
    { id: 'local', source: 'qcwy', matchScore: 88,
      matchEvaluation: { jobRequirements: requirements, method: 'local' } },
    { id: 'remote-current', source: 'qcwy', matchScore: 89,
      matchEvaluation: { jobRequirements: requirements, method: 'llm', evaluationVersion: 1 } },
    { id: 'other-platform', source: 'boss', matchScore: 90,
      matchEvaluation: { jobRequirements: requirements, method: 'llm' } }
  ].map(item => ({ ...item, originalText:
    '工作经历：负责需求分析，整理业务需求文档并跟进项目交付。项目中参与多个业务模块的设计与维护。' }));
  const pipeline = new RecruitmentPipelineService({
    store: {
      getResumes: () => records,
      getResumeById: id => records.find(item => item.id === id),
      updateCandidateMetadata: (id, changes) => Object.assign(records.find(item => item.id === id), changes)
    },
    llmFactory: () => ({ chatWithLLM: async () => JSON.stringify({ score: 76,
      strengths: ['原文具备需求分析证据'], gaps: ['原型设计待核实'], summary: '需人工复核' }) })
  });
  const service = new BatchEvaluationService({ pipeline, delay: async () => {} });
  service.start({ jobRequirements: requirements, limit: 5, pendingOnly: false });
  for (let attempt = 0; service.status().running && attempt < 100; attempt++) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(service.status().running, false);
  assert.equal(service.status().processed, 4);
  assert.equal(service.status().evaluated, 4);
  assert.equal(service.status().skipped, 1);
  assert.equal(service.status().failed, 0);
  for (const record of records.slice(0, 3)) {
    assert.equal(record.matchEvaluation.method, 'llm');
    assert.equal(record.matchEvaluation.evaluationVersion, 1);
    assert.equal(record.matchEvaluation.jobRequirements, requirements);
    assert.equal(record.matchScore, 76);
  }
  assert.equal(records[3].matchScore, 89);
  assert.equal(records[4].matchScore, 76);
});

test('成本核算经理旧关键词评分重新计算为含推荐门槛的新版评估', async () => {
  const requirements = '岗位：成本核算经理\n最低条件：本科及以上学历，相关从业经验不少于 3 年。';
  const resume = '工作经历：2018.01 - 2022.02 任成本会计，负责制造业成本核算与制造费用分摊。\n教育经历：会计学本科。';
  const records = [
    { id: 'legacy', source: 'qcwy', education: '本科', originalText: resume,
      workExperience: [{ position: '成本会计', duration: '2018.01 - 2022.02', description: '负责制造业成本核算' }],
      matchScore: 23, matchEvaluation: { method: 'local', jobRequirements: requirements } },
    { id: 'current', source: 'qcwy', originalText: resume, matchScore: 90,
      matchEvaluation: { method: 'local', evaluationVersion: 2,
        recommendationEligible: true, jobRequirements: requirements } }
  ];
  const pipeline = new RecruitmentPipelineService({
    store: { getResumes: () => records,
      getResumeById: id => records.find(item => item.id === id),
      updateCandidateMetadata: (id, changes) => Object.assign(records.find(item => item.id === id), changes) },
    llmFactory: () => { throw new Error('QCWY local evaluation must not call LLM'); }
  });
  const service = new BatchEvaluationService({ pipeline, delay: async () => {} });
  service.start({ source: 'qcwy', jobRequirements: requirements, limit: 2, pendingOnly: false });
  for (let attempt = 0; service.status().running && attempt < 100; attempt++) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(service.status().evaluated, 1);
  assert.equal(service.status().skipped, 1);
  assert.equal(records[0].matchEvaluation.evaluationVersion, 2);
  assert.equal(records[0].matchEvaluation.recommendationEligible, true);
});

test('先跳过同岗位当前版本，再按份数选取待补评简历；402 只尝试一次', async () => {
  const requirements = 'IT 网络运维岗位需要三年网络设备和故障处理经验';
  const records = Array.from({ length: 105 }, (_, index) => ({
    id: `done-${index}`, source: 'zlzp', originalText: '已有完整简历', matchScore: 81,
    matchEvaluation: { method: 'llm', evaluationVersion: 1, jobRequirements: requirements }
  })).concat(Array.from({ length: 3 }, (_, index) => ({
    id: `pending-${index}`, source: 'zlzp', originalText: '待评估完整简历'
  })));
  const calls = [];
  let available = false;
  let recoverySignals = 0;
  const service = new BatchEvaluationService({
    pipeline: {
      list: () => records,
      evaluate: async id => {
        calls.push(id);
        if (!available) throw Object.assign(new Error('Payment Required'), { httpStatus: 402 });
        const item = records.find(record => record.id === id);
        item.matchScore = 80;
        item.matchEvaluation = { method: 'llm', evaluationVersion: 1, jobRequirements: requirements };
        return item.matchEvaluation;
      }
    },
    delay: async () => {},
    onEvaluationSuccess: evaluation => { if (evaluation.method === 'llm') recoverySignals++; }
  });
  service.start({ jobRequirements: requirements, limit: 2 });
  for (let attempt = 0; service.status().running && attempt < 100; attempt++) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.deepEqual(calls, ['pending-0']);
  assert.equal(service.status().skipped, 105);
  assert.equal(service.status().total, 2);
  assert.equal(service.status().processed, 1);
  assert.equal(service.status().paused, true);
  assert.equal(service.status().pauseCode, 'LLM_BILLING_REQUIRED');
  assert.match(service.status().pauseReason, /需检查余额\/计费/);
  assert.equal(records[105].matchEvaluation, undefined);
  assert.equal(recoverySignals, 0);

  available = true;
  service.start({ jobRequirements: requirements, limit: 2 });
  for (let attempt = 0; service.status().running && attempt < 100; attempt++) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.deepEqual(calls, ['pending-0', 'pending-0', 'pending-1']);
  assert.equal(service.status().evaluated, 2);
  assert.equal(service.status().paused, false);
  assert.equal(recoverySignals, 2);
  assert.equal(records[107].matchEvaluation, undefined);
});

test('默认只补评未评分简历：154 份旧岗位评分在前，也不会覆盖旧岗位结果', async () => {
  const oldRequirements = '项目经理岗位需要三年项目交付经验';
  const requirements = 'IT 网络运维岗位需要三年网络设备和故障处理经验';
  const old = Array.from({ length: 154 }, (_, index) => ({
    id: `old-${index}`, source: 'zlzp', originalText: '历史岗位的完整简历', matchScore: 88,
    matchEvaluation: { method: 'llm', evaluationVersion: 1, jobRequirements: oldRequirements }
  }));
  const unscored = Array.from({ length: 9 }, (_, index) => ({
    id: `new-${index}`, source: 'qcwy', originalText: 'IT 网络运维完整简历'
  }));
  const records = [...old, ...unscored,
    { id: 'legacy-score', source: 'boss', originalText: '历史简历', matchScore: 70 }];
  const calls = [];
  const service = new BatchEvaluationService({ pipeline: {
    list: () => records,
    evaluate: async id => {
      calls.push(id);
      const item = records.find(record => record.id === id);
      item.matchScore = 75;
      item.matchEvaluation = { method: 'llm', evaluationVersion: 1, jobRequirements: requirements };
      return item.matchEvaluation;
    }
  }, delay: async () => {} });
  const initial = service.start({ jobRequirements: requirements, limit: 100 });
  assert.equal(initial.pendingOnly, true);
  assert.equal(initial.total, 9);
  assert.equal(initial.skipped, 155);
  for (let attempt = 0; service.status().running && attempt < 100; attempt++) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.deepEqual(calls, unscored.map(item => item.id));
  assert.equal(service.status().evaluated, 9);
  assert.equal(old[0].matchScore, 88);
  assert.equal(old[0].matchEvaluation.jobRequirements, oldRequirements);
  assert.equal(records.at(-1).matchScore, 70);
  assert.equal(service.start({ jobRequirements: requirements, limit: 100 }).total, 0);
});
