const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateLocally } = require('../src/services/localResumeEvaluationService');

test('本机评分按原文关键词覆盖计分，并给出证据和待核实项', () => {
  const result = evaluateLocally({ originalText:
    '工作经历：负责 Java 后端系统，使用 MySQL 存储业务数据并维护接口。\n项目经历：参与服务上线及日常维护。' },
  '熟悉 Java、MySQL、Python');
  assert.equal(result.method, 'local');
  assert.equal(result.score, 67);
  assert.equal(result.matchedKeywords, 2);
  assert.equal(result.totalKeywords, 3);
  assert.match(result.strengths.join('\n'), /Java.*原文/);
  assert.match(result.gaps.join('\n'), /Python.*人工核实/);
});

test('拉丁技能采用完整词匹配，不把 JavaScript 当作 Java', () => {
  const result = evaluateLocally({ originalText:
    '工作经历：使用 JavaScript 开发网页应用，维护 MySQL 数据并编写页面组件，参与完整项目交付。' },
  '熟悉 Java、MySQL、C++');
  assert.equal(result.score, 33);
  assert.match(result.gaps.join('\n'), /Java/);
  assert.match(result.gaps.join('\n'), /C\+\+/);
});

test('年龄、性别、姓名与联系方式不影响评分，也不会出现在原文证据中', () => {
  const resume = { name: 'Python', phone: '13800000000', email: 'Java@example.test', originalText:
    '姓名：Python\n年龄：25岁\n性别：女\n邮箱：Java@example.test\n电话：13800000000\n' +
    '工作经历：使用 MySQL 维护业务数据，负责系统上线维护并参与完整项目交付。' };
  const requirements = '男性优先，35岁以下，熟悉 Java、MySQL、Python';
  const first = evaluateLocally(resume, requirements);
  const second = evaluateLocally({ ...resume, originalText: resume.originalText
    .replace('25岁', '50岁').replace('性别：女', '性别：男') }, requirements);
  assert.equal(first.score, 33);
  assert.deepEqual(first, second);
  assert.doesNotMatch(first.strengths.join('\n'), /13800000000|Java@example.test|25岁|50岁|姓名|性别/);
});

test('中文职责关键词直接核对原文，不根据结构化字段编造证据', () => {
  const result = evaluateLocally({ skills: ['产品规划'], originalText:
    '工作经历：参与需求分析与原型设计，整理用户访谈记录并跟进产品交付。项目经历包含多个业务模块。' },
  '具备需求分析、原型设计和产品规划经验');
  assert.equal(result.score, 67);
  assert.match(result.gaps.join('\n'), /产品规划/);
});

test('缺少原文或只有受保护特征的岗位条件不会生成匹配分', () => {
  assert.throws(() => evaluateLocally({ skills: ['Java'] }, '熟悉 Java 开发'), /内容不足/);
  assert.throws(() => evaluateLocally({ originalText: '工作经历：参与业务系统开发和部署，维护多个服务模块并支持项目交付。' },
    '男性优先，35岁以下'), /岗位要求无效/);
});

const COST_JD = '岗位：成本核算经理\n最低条件：本科及以上学历；相关从业经验不少于 3 年。\n' +
  '必备：成本核算、制造费用、标准成本、ERP、BOM、存货和预算。';

test('成本核算经理按岗位证据评分；JD 中大量提示文字不会稀释分数', () => {
  const resume = {
    education: '本科',
    workExperience: [{ position: '成本会计', duration: '2018.01 - 2022.02',
      description: '负责成本核算、制造费用分摊，使用 ERP 和 BOM 核对产品成本。' }],
    originalText: '工作经历：2018.01 - 2022.02 成本会计。负责成本核算、制造费用分摊，使用 ERP 和 BOM 核对产品成本。\n教育经历：财务管理本科。'
  };
  const normal = evaluateLocally(resume, COST_JD);
  const noisy = evaluateLocally(resume, COST_JD + '\n岗位背景：' + '统计报表模板和文件名。'.repeat(250));
  assert.equal(normal.score, noisy.score);
  assert.equal(normal.evaluationVersion, 2);
  assert.equal(normal.recommendationEligible, true);
  assert.deepEqual(Object.values(normal.requiredEvidence).map(item => item.status),
    ['met', 'met', 'met']);
  assert.ok(normal.score >= 70);
  assert.ok(normal.strengths.length <= 9);
});

test('成本核算经理学历明确不足时不自动推荐；仅缺失证据则待核实', () => {
  const base = {
    workExperience: [{ position: '成本会计', duration: '2018.01 - 2022.02',
      description: '负责制造业成本核算、月末成本结转。' }],
    originalText: '工作经历：2018.01 - 2022.02 成本会计，负责制造业成本核算、月末成本结转。\n教育经历：财务管理专业。'
  };
  const below = evaluateLocally({ ...base, education: '大专' }, COST_JD);
  assert.equal(below.requiredEvidence.education.status, 'not_met');
  assert.equal(below.recommendationEligible, false);
  assert.equal(below.recommendationStatus, '不满足最低条件');
  const unknown = evaluateLocally(base, COST_JD);
  assert.equal(unknown.requiredEvidence.education.status, 'unknown');
  assert.equal(unknown.recommendationEligible, false);
  assert.equal(unknown.recommendationStatus, '待核实');
});

test('相关年限只核对成本/财务岗位时间，重叠月份不重复计数', () => {
  const base = {
    education: '本科',
    workYears: '8年',
    workExperience: [
      { position: '销售经理', duration: '2016.01 - 2022.01', description: '负责客户销售' },
      { position: '成本会计', duration: '2022.01 - 2023.06', description: '负责成本核算' },
      { position: '财务会计', duration: '2022.06 - 2023.12', description: '负责月结及财务报表' }
    ],
    originalText: '工作经历：销售六年；后任成本会计和财务会计，负责成本核算与财务报表。\n教育经历：本科。'
  };
  const result = evaluateLocally(base, COST_JD);
  assert.equal(result.requiredEvidence.relatedExperience.status, 'unknown');
  assert.equal(result.recommendationEligible, false);
  const short = evaluateLocally({ ...base, workYears: '2年' }, COST_JD);
  assert.equal(short.requiredEvidence.relatedExperience.status, 'not_met');
});

test('求职意向写成本核算经理不等于有成本核算工作证据', () => {
  const result = evaluateLocally({ education: '本科',
    workExperience: [{ position: '销售经理', duration: '2018.01 - 2023.01',
      description: '负责客户拓展和商务谈判' }],
    originalText: '求职意向：成本核算经理。\n工作经历：2018.01 - 2023.01 销售经理，负责客户拓展和商务谈判。\n教育经历：本科。' }, COST_JD);
  assert.equal(result.requiredEvidence.costAccounting.status, 'unknown');
  assert.equal(result.requiredEvidence.relatedExperience.status, 'unknown');
  assert.equal(result.recommendationEligible, false);
});

test('合并后的长职责及错误解析的长职位不把泛财务岗位算为三年成本经验', () => {
  const result = evaluateLocally({ education: '本科', workYears: '8年',
    workExperience: [{ position: '财务经理', duration: '2016.01 - 2024.01',
      description: '负责日常财务报表。'.repeat(60) + '曾与成本会计交流并查看成本核算资料。' },
    { position: '背景：' + '项目说明文字'.repeat(10) + '成本经理',
      duration: '2016.01 - 2024.01', description: '负责流程管理。' }],
    originalText: '工作经历：2016.01 - 2024.01 财务经理，负责日常财务报表。\n教育经历：会计学本科。' },
  COST_JD);
  assert.equal(result.requiredEvidence.relatedExperience.status, 'unknown');
  assert.equal(result.requiredEvidence.costAccounting.status, 'unknown');
  assert.equal(result.recommendationEligible, false);
});

test('泛财务总年限陈述不能替代成本核算相关年限', () => {
  const result = evaluateLocally({ education: '本科',
    originalText: '工作经历：从事财务管理 6 年，曾学习成本核算并参与制造费用报告。\n教育经历：财务管理本科。' },
  COST_JD);
  assert.equal(result.requiredEvidence.relatedExperience.status, 'unknown');
  assert.equal(result.recommendationEligible, false);
});
