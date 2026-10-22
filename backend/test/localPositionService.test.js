const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ActiveJobService } = require('../src/services/activeJobService');
const { PositionService } = require('../src/services/positionService');

class MemoryPositions {
  constructor() { this.positions = []; this.nextId = 1; this.failAdd = false; }
  getPositions() { return [...this.positions]; }
  getPositionById(id) { return this.positions.find(item => item.id === id) || null; }
  async addPosition(data) {
    if (this.failAdd) throw new Error('无法写入岗位记录');
    const position = { ...data, id: `position_${this.nextId++}` };
    this.positions.push(position);
    return position;
  }
  async deletePosition(id) {
    const before = this.positions.length;
    this.positions = this.positions.filter(item => item.id !== id);
    return { success: this.positions.length < before };
  }
}

function withService(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-position-test-'));
  const activeJobService = new ActiveJobService({ file: path.join(dir, 'active-job.json') });
  const resumeModel = new MemoryPositions();
  const service = new PositionService({ activeJobService, resumeModel });
  return Promise.resolve().then(() => run({ service, activeJobService, resumeModel }))
    .finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

const initialJob = {
  title: '项目经理主管', searchKeywords: '项目经理主管，项目经理',
  location: '上海', education: '本科及以上', minExperienceYears: 5,
  targetCount: 18, recommendationTargetCount: 100,
  jobRequirements: '负责项目计划、交付以及跨部门团队协调。'
};

test('本地创建岗位同时生成可查看的 JD 并应用同一份三平台条件', () => withService(async ({ service, activeJobService, resumeModel }) => {
  const result = await service.createLocalPosition(initialJob);
  assert.equal(result.reused, false);
  assert.equal(resumeModel.positions.length, 1);
  assert.equal(result.position.title, '项目经理主管');
  assert.equal(result.position.name, '项目经理主管');
  assert.match(result.position.description, /负责项目计划、交付/);
  assert.equal(result.position.jobCriteria.jobRequirements, result.job.jobRequirements);
  assert.equal(activeJobService.current().jobRequirements, result.job.jobRequirements);
  assert.equal(result.job.targetCount, 18);
  assert.equal(result.job.recommendationTargetCount, 100);
  assert.equal(result.position.jobCriteria.recommendationTargetCount, 100);
  assert.equal(result.job.minExperienceYears, 5);
  assert.equal(result.job.searchKeywords, '项目经理主管，项目经理');
}));

test('新建岗位前归档当前岗位，旧岗位仍可重新应用，重复创建不重复入库', () => withService(async ({ service, activeJobService, resumeModel }) => {
  const previous = activeJobService.save({
    title: '成本核算经理', jobRequirements: '熟悉制造业成本核算和 ERP 系统',
    targetCount: 10, recommendationTargetCount: 25
  });
  const result = await service.createLocalPosition(initialJob);
  assert.equal(resumeModel.positions.length, 2);
  assert.equal(resumeModel.positions[0].jobCriteria.jobRequirements, previous.jobRequirements);
  const reused = await service.createLocalPosition(initialJob);
  assert.equal(reused.reused, true);
  assert.equal(resumeModel.positions.length, 2);
  const restored = service.applyLocalPosition(resumeModel.positions[0].id);
  assert.equal(restored.job.jobRequirements, previous.jobRequirements);
  assert.equal(restored.job.recommendationTargetCount, 25);
  assert.equal(activeJobService.current().title, '成本核算经理');
  assert.equal(result.position.jobCriteria.title, '项目经理主管');
}));

test('无效草稿和写入失败不会更改当前岗位，后续保存失败会回滚岗位记录', () => withService(async ({ service, activeJobService, resumeModel }) => {
  const previous = activeJobService.save({
    title: '成本核算经理', jobRequirements: '熟悉制造业成本核算和 ERP 系统'
  });
  await assert.rejects(service.createLocalPosition({ title: '新岗位', jobRequirements: '' }), /详细岗位要求/);
  assert.equal(resumeModel.positions.length, 0);
  resumeModel.failAdd = true;
  await assert.rejects(service.createLocalPosition(initialJob), /无法写入岗位记录/);
  assert.equal(activeJobService.current().jobRequirements, previous.jobRequirements);
  resumeModel.failAdd = false;
  const originalSave = activeJobService.save.bind(activeJobService);
  activeJobService.save = () => { throw new Error('模拟磁盘写入失败'); };
  await assert.rejects(service.createLocalPosition(initialJob), /模拟磁盘写入失败/);
  activeJobService.save = originalSave;
  assert.equal(resumeModel.positions.length, 0);
  assert.equal(activeJobService.current().jobRequirements, previous.jobRequirements);
}));

test('自然语言描述生成可编辑草稿，但不编造岗位要求', () => withService(({ service }) => {
  const description = '招聘项目经理主管，至少5年项目管理经验，本科及以上，工作地点：上海，获取18份简历，推荐100人。';
  const draft = service.draftLocalPosition(description);
  assert.equal(draft.title, '项目经理主管');
  assert.equal(draft.minExperienceYears, 5);
  assert.equal(draft.education, '本科及以上');
  assert.equal(draft.location, '上海');
  assert.equal(draft.targetCount, 18);
  assert.equal(draft.recommendationTargetCount, 100);
  assert.equal(draft.jobRequirements, description);
  assert.throws(() => service.draftLocalPosition('创建岗位'), /10～5000/);
}));
