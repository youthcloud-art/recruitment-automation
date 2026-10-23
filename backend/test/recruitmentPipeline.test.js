const test = require('node:test');
const assert = require('node:assert/strict');
const { RecruitmentPipelineService } = require('../src/services/recruitmentPipelineService');

function createStore() {
  const records = [
    { id: 'a', source: 'boss', name: '候选人甲', position: '后端工程师',
      skills: ['Node.js'], originalText: 'Node.js 开发五年，负责 API 设计与数据库优化。'.repeat(5),
      createdAt: '2026-10-01' },
    { id: 'b', source: 'zlzp', name: '候选人乙', position: '测试工程师',
      skills: ['自动化测试'], originalText: '有自动化测试经验。'.repeat(10), createdAt: '2026-10-02' },
    { id: 'c', source: 'qcwy', name: '候选人丙', position: '产品经理',
      skills: ['需求分析'], originalText: '从事需求分析。'.repeat(10), createdAt: '2026-10-03' },
    { id: 'd', source: 'manual', name: '手动简历', originalText: '其他' }
  ];
  return {
    records,
    getResumes: () => records,
    getResumeById: id => records.find(item => item.id === id) || null,
    updateCandidateMetadata: (id, changes) => Object.assign(records.find(item => item.id === id), changes)
  };
}

const noActiveJob = { current: () => ({ title: '', jobRequirements: '' }) };

test('三平台候选人可按平台、状态、关键词查询，手动简历不混入', () => {
  const store = createStore();
  const requirements = '岗位名称：后端工程师\n必需技能：Node.js';
  store.records[0].matchScore = 82;
  store.records[0].matchEvaluationStatus = 'completed';
  store.records[0].matchEvaluation = { method: 'llm', evaluationVersion: 1,
    evaluatedAt: '2026-10-20T00:00:00.000Z', jobRequirements: requirements,
    summary: '具备 Node.js 经验' };
  const service = new RecruitmentPipelineService({ store,
    activeJobService: { current: () => ({ title: '后端工程师', jobRequirements: requirements,
      updatedAt: '2026-10-20T00:00:00.000Z' }) } });
  assert.equal(service.list().length, 3);
  assert.deepEqual(service.list({ source: 'zlzp' }).map(item => item.id), ['b']);
  assert.deepEqual(service.list({ keyword: 'Node.js' }).map(item => item.id), ['a']);
  service.update('a', { status: 'shortlisted', notes: '查看项目经历' });
  assert.deepEqual(service.list({ status: 'shortlisted' }).map(item => item.id), ['a']);
  assert.equal(service.summary().boss.byStatus.shortlisted, 1);
  assert.match(service.report({ source: 'boss' }), /查看项目经历/);
  assert.match(service.report({ source: 'boss' }), /跟进清单[\s\S]*候选人详情/);
  assert.doesNotMatch(service.report({ source: 'boss' }), /候选人乙/);
  assert.throws(() => service.update('a', { status: 'unknown' }), /不支持/);
});

test('大简历库按流筛选后才截取报告上限，末尾命中的候选人仍可读取', () => {
  const store = {
    getResumes: () => { throw new Error('不应把全部简历加载进内存'); },
    forEachResume: (visit) => {
      for (let index = 0; index < 10002; index++) visit({
        id: String(index), source: 'boss', name: index === 10001 ? '目标候选人' : '其他人'
      });
    }
  };
  const service = new RecruitmentPipelineService({ store, activeJobService: noActiveJob });
  assert.deepEqual(service.list({ keyword: '目标', limit: 1 }).map(item => item.id), ['10001']);
});

test('历史简历删除入口要求明确岗位和互异 ID，不允许空选或批量越界', () => {
  const calls = [];
  const service = new RecruitmentPipelineService({ store: {
    deleteHistoricalResumes: (ids, title) => { calls.push({ ids, title });
      return { success: true, count: ids.length }; }
  }, activeJobService: noActiveJob });
  assert.throws(() => service.deleteHistoricalCandidates({ ids: [], jobTitle: '网络运维' }), /选择/);
  assert.throws(() => service.deleteHistoricalCandidates({ ids: ['a', 'a'], jobTitle: '网络运维' }), /选择/);
  assert.throws(() => service.deleteHistoricalCandidates({ ids: ['a'], jobTitle: '' }), /岗位/);
  assert.equal(service.deleteHistoricalCandidates({ ids: ['a'], jobTitle: '网络运维' }).count, 1);
  assert.deepEqual(calls, [{ ids: ['a'], title: '网络运维' }]);
});

test('三平台候选人分页仅传输当前页，汇总使用按平台状态聚合', () => {
  const calls = [];
  const store = {
    getResumesPage: options => {
      calls.push(options);
      return { items: [{ id: 'page-two' }], total: 61,
        limit: options.limit, offset: options.offset };
    },
    getSourceStatusCounts: sources => {
      assert.deepEqual(sources, ['boss', 'zlzp', 'qcwy']);
      return [{ source: 'boss', status: 'new', total: 20 },
        { source: 'qcwy', status: 'shortlisted', total: 7 }];
    },
    getResumes: () => { throw new Error('分页和统计不应读取整库'); }
  };
  const service = new RecruitmentPipelineService({ store, activeJobService: noActiveJob });
  const page = service.listPage({ keyword: '网络', limit: '20', offset: '20' });
  assert.equal(page.total, 61);
  assert.deepEqual(calls[0], { source: null, sources: ['boss', 'zlzp', 'qcwy'],
    hiringJobTitle: null, jobGroup: null, status: null, keyword: '网络', keywordFields: 'pipeline',
    sortBy: 'createdAt', limit: 20, offset: 20 });
  assert.equal(service.summary().boss.total, 20);
  assert.equal(service.summary().qcwy.byStatus.shortlisted, 7);
  assert.throws(() => service.listPage({ limit: 0 }), /分页/);
  service.listPage({ source: 'boss', jobTitle: '网络运维', sortBy: 'scoreDesc', limit: 10 });
  assert.equal(calls[1].hiringJobTitle, '网络运维');
  assert.equal(calls[1].jobGroup, null);
  assert.equal(calls[1].sortBy, 'scoreDesc');
  assert.throws(() => service.listPage({ sortBy: 'scoreRandom' }), /排序/);
});

test('岗位选项跨平台汇总，同名岗位不会重复', () => {
  const service = new RecruitmentPipelineService({
    store: { getHiringJobCounts: () => [
      { title: '网络运维', source: 'boss', total: 2 },
      { title: '网络运维', source: 'zlzp', total: 3 },
      { title: '财务经理', source: 'qcwy', total: 1 }
    ] }, activeJobService: noActiveJob
  });
  assert.deepEqual(service.jobs(), [
    { title: '网络运维', jobGroup: 'current', total: 5,
      bySource: { boss: 2, zlzp: 3, qcwy: 0 } },
    { title: '财务经理', jobGroup: 'current', total: 1,
      bySource: { boss: 0, zlzp: 0, qcwy: 1 } }
  ]);
});

test('DeepSeek 岗位评估只保存可解析结果且屏蔽联系方式', async () => {
  const store = createStore();
  store.records[0].matchEvaluationStatus = 'failed';
  store.records[0].matchEvaluationError = '先前的模拟故障';
  store.records[0].originalText += ' 联系电话13812345678 邮箱 test@example.com';
  let sent;
  const requirements = '需要 Node.js 和 API 设计经验';
  const service = new RecruitmentPipelineService({ store,
    activeJobService: { current: () => ({ title: '后端工程师', jobRequirements: requirements,
      updatedAt: '2026-10-20T00:00:00.000Z' }) }, llmFactory: () => ({
    chatWithLLM: async messages => {
      sent = messages[1].content;
      return '```json\n{"score":82,"strengths":["Node.js API 项目"],"gaps":["需核实部署经验"],"summary":"岗位相关经验较强"}\n```';
    }
  }) });
  const result = await service.evaluate('a', requirements);
  assert.equal(result.score, 82);
  assert.equal(store.records[0].matchScore, 82);
  assert.equal(store.records[0].matchEvaluationStatus, 'completed');
  assert.equal(store.records[0].matchEvaluationError, null);
  assert.doesNotMatch(sent, /13812345678|test@example.com/);
  assert.match(service.report({ source: 'boss' }), /82/);
});

test('前程无忧通用岗位使用 DeepSeek 评估并在请求前去除个人资料', async () => {
  const store = createStore();
  store.records[2].name = '张测试';
  store.records[2].originalText = '姓名：张测试\n年龄：35岁\n性别：女\n电话：13812345678\n邮箱：person@example.test\n' +
    '工作经历：负责需求分析和原型设计，推动多个项目从立项到交付。'.repeat(5);
  store.records[2].workExperience = [{ position: '产品经理', description:
    '负责需求分析，联系号码 13912345678，邮件 team@example.test，输出项目计划。' }];
  let sent;
  const service = new RecruitmentPipelineService({ store, activeJobService: noActiveJob,
    llmFactory: () => ({ chatWithLLM: async messages => {
      sent = messages[1].content;
      return JSON.stringify({ score: 78, strengths: ['需求分析、原型设计'], gaps: ['项目预算待核实'],
        summary: '项目相关证据较充分，需人工核实预算经历' });
    } }) });
  const requirements = '需要需求分析和原型设计经验';
  const result = await service.evaluate('c', requirements);
  assert.equal(result.method, 'llm');
  assert.equal(result.evaluationVersion, 1);
  assert.equal(result.score, 78);
  assert.equal(result.jobRequirements, requirements);
  assert.ok(result.evaluatedAt);
  assert.doesNotMatch(sent, /张测试|35岁|性别|13812345678|13912345678|person@example.test|team@example.test/);
  assert.match(sent, /需求分析|原型设计/);
  assert.equal(store.records[2].matchScore, result.score);
  assert.equal(store.records[2].matchEvaluation.method, 'llm');
});

test('前程无忧成本核算经理保留本机证据评分及最低条件门槛', async () => {
  const store = createStore();
  store.records[2].matchEvaluationStatus = 'failed';
  store.records[2].matchEvaluationError = '先前的模拟故障';
  store.records[2] = { ...store.records[2], education: '本科',
    workExperience: [{ position: '成本会计', duration: '2018.01 - 2022.02',
      description: '负责制造业成本核算、制造费用分摊和 ERP 系统成本分析。' }],
    originalText: '工作经历：2018.01 - 2022.02 成本会计，负责制造业成本核算和 ERP 系统。\n教育经历：本科。' };
  const requirements = '岗位：成本核算经理\n最低条件：本科及以上学历，相关从业经验不少于 3 年。';
  const service = new RecruitmentPipelineService({ store, activeJobService: noActiveJob,
    llmFactory: () => { throw new Error('成本核算经理必须使用本机证据评分'); } });
  const result = await service.evaluate('c', requirements);
  assert.equal(result.method, 'local');
  assert.equal(result.evaluationVersion, 2);
  assert.equal(result.recommendationEligible, true);
  assert.equal(store.records[2].matchEvaluationStatus, 'completed');
  assert.equal(store.records[2].matchEvaluationError, null);
});

test('报告仅包含当前岗位评估结果，不混入旧岗位和未评估简历', () => {
  const store = createStore();
  const currentRequirements = '岗位名称：成本核算经理\n必需技能：成本核算';
  const oldRequirements = '岗位名称：后端工程师\n必需技能：Node.js';
  store.records[0].matchScore = 92;
  store.records[0].matchEvaluation = { jobRequirements: oldRequirements, summary: '旧岗位结果' };
  store.records[1].matchScore = 81;
  store.records[1].matchEvaluationStatus = 'completed';
  store.records[1].matchEvaluation = { method: 'llm', evaluationVersion: 1,
    evaluatedAt: '2026-10-20T00:00:00.000Z', jobRequirements: currentRequirements,
    summary: '当前岗位结果' };
  const service = new RecruitmentPipelineService({ store,
    activeJobService: { current: () => ({ title: '成本核算经理', jobRequirements: currentRequirements,
      updatedAt: '2026-10-20T00:00:00.000Z' }) } });
  const report = service.report();
  assert.match(report, /当前岗位：成本核算经理/);
  assert.match(report, /候选人乙/);
  assert.doesNotMatch(report, /候选人甲|候选人丙|旧岗位结果/);
  assert.throws(() => service.report({ jobRequirements: oldRequirements }), /报告岗位与当前岗位设置不一致/);
});

test('独立初筛报告用前程无忧稳定记录 ID 代替误采的通知标签', () => {
  const store = createStore();
  const requirements = '岗位名称：IT网络运维\n必需技能：网络故障排查';
  const item = store.records[2];
  Object.assign(item, { name: '通知', position: '通知', sourceRecordKey: 'c'.repeat(64),
    originalText: '通知\n工作经历：网络故障排查', matchScore: 80,
    matchEvaluation: { jobRequirements: requirements, method: 'llm', evaluationVersion: 1,
      evaluatedAt: '2026-10-20T00:00:00.000Z', summary: '有相关证据' } });
  const service = new RecruitmentPipelineService({ store,
    activeJobService: { current: () => ({ title: 'IT网络运维', jobRequirements: requirements,
      updatedAt: '2026-10-20T00:00:00.000Z' }) } });
  const report = service.report({ source: 'qcwy', minScore: 70 });
  assert.match(report, /匿名候选人（前程无忧记录 ID：cccccccccccccccc）/);
  assert.match(report, /求职岗位待核实/);
  assert.doesNotMatch(report, /通知/);
  assert.equal(item.originalText, '通知\n工作经历：网络故障排查');
});

test('初筛报告只选当前岗位已完成的有效评估，并按最低分、平台和智联身份去重', () => {
  const requirements = '岗位名称：IT网络运维\n必需技能：网络设备维护';
  const oldRequirements = '岗位名称：成本核算经理\n必需技能：成本核算';
  const evaluated = (id, source, score, options = {}) => ({
    id, source, name: `候选人${id}`, position: 'IT网络运维',
    originalText: '网络设备维护与故障排查。'.repeat(10), matchScore: score,
    matchEvaluationStatus: 'completed', matchEvaluation: {
      method: 'llm', evaluationVersion: 1,
      evaluatedAt: '2026-10-20T00:00:00.000Z', jobRequirements: requirements,
      summary: `评估摘要${id}`
    }, ...options
  });
  const records = [
    evaluated('高分', 'zlzp', 93, { sourceFingerprint: 'same-person' }),
    evaluated('重复', 'zlzp', 91, { sourceFingerprint: 'same-person' }),
    evaluated('前程', 'qcwy', 88),
    evaluated('早期有效', 'boss', 75, { matchEvaluationStatus: undefined }),
    evaluated('显式不推荐', 'boss', 99, { matchEvaluation: {
      method: 'llm', evaluationVersion: 1, evaluatedAt: '2026-10-20T00:00:00.000Z',
      jobRequirements: requirements, recommendationEligible: false,
      summary: '高分但不进入推荐名单'
    } }),
    evaluated('低分', 'boss', 69),
    evaluated('旧岗位', 'boss', 99, { matchEvaluation: {
      method: 'llm', evaluationVersion: 1, evaluatedAt: '2026-10-20T00:00:00.000Z',
      jobRequirements: oldRequirements, summary: '旧岗位评估'
    } }),
    evaluated('评估失败', 'boss', 98, { matchEvaluationStatus: 'failed' }),
    evaluated('等待评估', 'boss', 99, { matchEvaluationStatus: 'pending' }),
    evaluated('旧版评分', 'boss', 97, { matchEvaluation: {
      method: 'local', evaluationVersion: 1, jobRequirements: requirements,
      summary: '旧版关键词评分'
    } }),
    evaluated('缺少内容', 'boss', 96, { originalText: '', content: '' }),
    evaluated('本机未达门槛', 'qcwy', 95, { matchEvaluation: {
      method: 'local', evaluationVersion: 2, recommendationEligible: false,
      jobRequirements: requirements, summary: '证据不足'
    } }),
    evaluated('本机通过', 'qcwy', 82, { matchEvaluation: {
      method: 'local', evaluationVersion: 2, recommendationEligible: true,
      jobRequirements: requirements, summary: '证据满足'
    } })
  ];
  const service = new RecruitmentPipelineService({
    store: { getResumes: () => records },
    activeJobService: { current: () => ({ title: 'IT网络运维', jobRequirements: requirements,
      updatedAt: '2026-10-20T00:00:00.000Z' }) }
  });
  const report = service.report({ minScore: 70, topN: 2, jobRequirements: requirements });
  assert.match(report, /当前岗位：IT网络运维/);
  assert.match(report, /最低岗位匹配分：70\/100/);
  assert.match(report, /符合条件：4 份；本报告展示：2 份/);
  assert.match(report, /候选人高分/);
  assert.match(report, /候选人前程/);
  for (const excluded of ['重复', '早期有效', '显式不推荐', '低分', '旧岗位', '评估失败', '等待评估', '旧版评分',
    '缺少内容', '本机未达门槛', '本机通过']) {
    assert.doesNotMatch(report, new RegExp(`候选人${excluded}`));
  }
  const qcwy = service.report({ source: 'qcwy', minScore: 70, topN: 10 });
  assert.match(qcwy, /候选人前程|候选人本机通过/);
  assert.match(qcwy, /符合条件：2 份/);
  assert.doesNotMatch(qcwy, /候选人高分/);
  assert.match(service.report({ source: 'boss', minScore: 70 }), /候选人早期有效/);
  assert.doesNotMatch(service.report({ source: 'boss', minScore: 70 }), /候选人显式不推荐/);
  assert.doesNotMatch(service.report({ source: 'boss', minScore: 70 }), /候选人等待评估/);
  assert.throws(() => service.report({ minScore: -1 }), /最低匹配分/);
  assert.throws(() => service.report({ minScore: 70.5 }), /最低匹配分/);
  assert.throws(() => service.report({ topN: 101 }), /报告候选人份数/);
  assert.throws(() => new RecruitmentPipelineService({ store: { getResumes: () => records },
    activeJobService: noActiveJob }).report(), /请先保存并应用/);
});

test('三平台初筛报告默认排除人工淘汰者，指定淘汰状态仍可审计', () => {
  const requirements = '岗位名称：成本核算经理\n必需技能：成本核算';
  const records = ['boss', 'zlzp', 'qcwy'].flatMap(source => [
    { id: `${source}-active`, source, name: `${source}正常候选人`,
      workflowStatus: 'new', position: '成本核算经理', originalText: '具备成本核算经验。',
      matchScore: 80, matchEvaluationStatus: 'completed', matchEvaluation: {
        method: 'llm', evaluationVersion: 1, evaluatedAt: '2026-10-20T00:00:00.000Z',
        jobRequirements: requirements, summary: '符合岗位条件' } },
    { id: `${source}-rejected`, source, name: `${source}淘汰候选人`,
      workflowStatus: 'rejected', position: '成本核算经理', originalText: '具备成本核算经验。',
      matchScore: 99, matchEvaluationStatus: 'completed', matchEvaluation: {
        method: 'llm', evaluationVersion: 1, evaluatedAt: '2026-10-20T00:00:00.000Z',
        jobRequirements: requirements, summary: '人工已淘汰' } }
  ]);
  const service = new RecruitmentPipelineService({ store: { getResumes: () => records },
    activeJobService: { current: () => ({ title: '成本核算经理', jobRequirements: requirements,
      updatedAt: '2026-10-20T00:00:00.000Z' }) } });
  const report = service.report({ minScore: 70 });
  assert.match(report, /符合条件：3 份；本报告展示：3 份/);
  assert.doesNotMatch(report, /淘汰候选人|人工已淘汰/);
  for (const source of ['boss', 'zlzp', 'qcwy']) {
    assert.match(report, new RegExp(`${source}正常候选人`));
  }
  const audit = service.report({ source: 'boss', status: 'rejected', minScore: 70 });
  assert.match(audit, /符合条件：1 份；本报告展示：1 份/);
  assert.match(audit, /boss淘汰候选人/);
  assert.doesNotMatch(audit, /正常候选人|zlzp淘汰候选人|qcwy淘汰候选人/);
});
