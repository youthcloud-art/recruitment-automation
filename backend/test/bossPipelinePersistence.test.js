const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
process.env.RESUME_STORAGE_ENGINE = 'json';
const BossZhipinService = require('../src/services/bossZhipinService');
const resumeModel = require('../src/models/resumeModel');

test('BOSS 简历直接写入统一简历库并按内容去重', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-resume-test-'));
  const oldFile = resumeModel.dbFile;
  resumeModel.dbFile = path.join(directory, 'resumes.json');
  fs.writeJsonSync(resumeModel.dbFile, { resumes: [], positions: [], categories: [] });
  const service = new BossZhipinService();
  service.page = { url: () => 'https://www.zhipin.com/web/geek/recommend' };
  const content = '姓名：测试候选人\n工作经历：负责 Node.js 后端系统和数据库开发五年，完成接口设计、性能优化与生产部署。\n教育经历：计算机科学本科。'.repeat(3);
  try {
    await assert.rejects(service.saveResumeToDatabase({ name: '测试候选人' }, content),
      { code: 'BOSS_PLATFORM_ID_UNAVAILABLE' });
    const first = await service.saveResumeToDatabase(
      { name: '测试候选人', sourceCandidateId: 'expect-verified-123' }, content);
    const second = await service.saveResumeToDatabase(
      { name: '测试候选人', sourceCandidateId: 'expect-verified-123' }, content);
    assert.equal(first.id, second.id);
    assert.equal(fs.readJsonSync(resumeModel.dbFile).resumes.length, 1);
    assert.equal(first.source, 'boss');
    assert.equal(first.sourceCandidateId, 'expect-verified-123');
    assert.equal(first.sourceCandidateIdSource, 'platform_card');
    assert.equal(first.originalText, content);
  } finally {
    resumeModel.dbFile = oldFile;
    resumeModel.clearRelatedCache();
    fs.removeSync(directory);
  }
});

test('BOSS 搜索将岗位关键词提交到搜索框', async () => {
  const service = new BossZhipinService();
  let value = '';
  let key = '';
  const frame = {
    locator: () => ({ first: () => ({
      isVisible: async () => true,
      fill: async text => { value = text; },
      press: async text => { key = text; }
    }) }),
    waitForTimeout: async () => {},
    $: async () => null
  };
  await service.applyFiltersInIframe(frame, { position: '后端工程师' });
  assert.equal(value, '后端工程师');
  assert.equal(key, 'Enter');
  assert.equal(service.searchSubmittedByEnter, true);
});
