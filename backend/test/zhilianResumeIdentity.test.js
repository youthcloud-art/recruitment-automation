const test = require('node:test');
const assert = require('node:assert/strict');
process.env.RESUME_STORAGE_ENGINE = 'json';
const { isSameZhilianResume } = require('../src/utils/zhilianResumeIdentity');
const resumeModel = require('../src/models/resumeModel');

const body = ('工作经历：负责成本核算、库存分析与月度结账。教育经历：财务专业本科。').repeat(20);
const text = `测试候选人\n浏览标识：12\n${body}`;
const updatedText = `测试候选人\n浏览标识：13\n${body}`;
const resume = {
  source: 'zlzp', sourceUrl: 'https://rd.zhaopin.com/search', name: '测试候选人',
  age: '35', education: '本科', originalText: text
};

test('智联近重复仅合并同名、同页、身份字段不冲突且长正文只有极小变动的记录', () => {
  assert.equal(isSameZhilianResume(resume, { ...resume, originalText: updatedText }), true);
  assert.equal(isSameZhilianResume(resume, { ...resume, name: '另一位候选人', originalText: updatedText }), false);
  assert.equal(isSameZhilianResume(resume, { ...resume, phone: '13800000000',
    originalText: updatedText, age: '36' }), false);
  assert.equal(isSameZhilianResume({ ...resume, phone: '13800000000' },
    { ...resume, phone: '13900000000', originalText: updatedText }), false);
  assert.equal(isSameZhilianResume(resume, { ...resume, sourceUrl: 'https://rd.zhaopin.com/other',
    originalText: updatedText }), false);
  assert.equal(isSameZhilianResume(resume, { ...resume, source: 'boss', originalText: updatedText }), false);
  assert.equal(isSameZhilianResume({ ...resume, name: '未识别姓名' },
    { ...resume, name: '未识别姓名', originalText: updatedText }), false);
  assert.equal(isSameZhilianResume(resume, { ...resume, originalText: updatedText + '另外一个完整项目描述' }), false);
  assert.equal(isSameZhilianResume({ ...resume, originalText: '短内容' },
    { ...resume, originalText: '短内容更新' }), false);
});

test('年龄字段格式变化和单处页面状态变化需有多项身份字段佐证', () => {
  const longBody = body.repeat(3);
  const before = `测试候选人\n招聘状态更新：已查看岗位和简历\n${longBody}`;
  const after = `测试候选人\n招聘状态更新：最近浏览多个岗位\n${longBody}`;
  const older = { ...resume, age: '35岁（1991年生）', originalText: before };
  const newer = { ...resume, age: 35, originalText: after };
  assert.equal(isSameZhilianResume(older, newer), true);
  assert.equal(isSameZhilianResume({ ...older, age: null }, { ...newer, age: null }), false);
  assert.equal(isSameZhilianResume(older, { ...newer, age: 36 }), false);
  assert.equal(isSameZhilianResume(older, { ...newer, education: '大专' }), false);
});

test('匿名同名同年龄同学历时，仅长篇稳定经历完全一致才允许合并', () => {
  const core = `${body.repeat(2)}\n教育经历：财务管理本科，完成成本核算课程。`;
  const before = { ...resume, name: '王女士',
    originalText: `王女士\n求职期望：惠州成本经理，制造业。\n${core}` };
  const changedPreference = { ...before,
    originalText: `王女士\n求职期望：深圳成本经理，制造业。\n${core}` };
  assert.equal(isSameZhilianResume(before, changedPreference), true);

  const differentCareer = { ...before,
    originalText: before.originalText.replace('负责成本核算', '负责销售核算') };
  assert.equal(isSameZhilianResume(before, differentCareer), false);

  const vague = '匿名候选人\n自我介绍：' + '从事财务分析和项目沟通。'.repeat(80);
  assert.equal(isSameZhilianResume({ ...before, originalText: vague },
    { ...before, originalText: vague.replace('财务分析', '销售分析') }), false);
});

test('模型写入层再次阻止智联近重复，同时允许不同候选人入库', async t => {
  const readDatabase = resumeModel.readDatabase;
  const writeDatabase = resumeModel.writeDatabase;
  let db = { resumes: [{ id: 'existing', ...resume }], positions: [], categories: [] };
  resumeModel.readDatabase = () => db;
  resumeModel.writeDatabase = value => { db = value; };
  t.after(() => { resumeModel.readDatabase = readDatabase; resumeModel.writeDatabase = writeDatabase; });
  const duplicate = await resumeModel.addResume({ ...resume, originalText: updatedText }, { returnStatus: true });
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.resume.id, 'existing');
  assert.equal(db.resumes.length, 1);
  const distinct = await resumeModel.addResume({ ...resume, name: '另一位候选人',
    originalText: updatedText }, { returnStatus: true });
  assert.equal(distinct.created, true);
  assert.equal(db.resumes.length, 2);
});
