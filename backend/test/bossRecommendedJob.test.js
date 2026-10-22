const test = require('node:test');
const assert = require('node:assert/strict');
const BossZhipinService = require('../src/services/bossZhipinService');

function makeRecommendedFixture({ selected = '财务总监 _ 惠州 12-24K',
  jobId = 'finance-job', options = [
    { value: 'finance-job', label: '财务总监 _ 惠州 12-24K' },
    { value: 'cost-job', label: '成本核算经理 _ 惠州 12-15K' }
  ] } = {}) {
  const service = new BossZhipinService();
  let selectedLabel = selected;
  let selectedJobId = jobId;
  let dropdownClicks = 0;
  let optionClicks = 0;
  const frame = {
    isDetached: () => false,
    url: () => `https://www.zhipin.com/web/frame/recommend/?jobid=${selectedJobId}`,
    evaluate: async () => ({ selectedLabel, options }),
    locator: selector => ({
      first: () => ({
        isVisible: async () => true,
        waitFor: async () => {},
        click: async () => {
          if (selector === '.job-selecter-wrap') dropdownClicks++;
          else if (selector === '.job-list .job-item[value="cost-job"]') {
            optionClicks++;
            selectedLabel = '成本核算经理 _ 惠州 12-15K';
            selectedJobId = 'cost-job';
          }
        }
      }),
      count: async () => selector === '.job-list .job-item[value="cost-job"]' ? 1 : 0
    })
  };
  service.page = {
    url: () => 'https://www.zhipin.com/web/chat/recommend',
    waitForTimeout: async () => {}
  };
  service.assertCollectorReady = async () => {};
  service.getRecommendedFrame = async () => frame;
  service.activeJobSnapshot = { title: '成本核算经理' };
  return { service, frame, getClicks: () => ({ dropdownClicks, optionClicks }) };
}

test('推荐模式只选择当前岗位，并将正确 iframe 与岗位 ID 交给采集器', async () => {
  const { service, frame, getClicks } = makeRecommendedFixture();
  let collected = false;
  service.browseRecommendedCandidateList = async (count, actualFrame, selection) => {
    assert.equal(count, 1);
    assert.equal(actualFrame, frame);
    assert.deepEqual(selection, {
      frame, title: '成本核算经理', jobId: 'cost-job'
    });
    collected = true;
  };
  await service.browseRecommendedCandidates(1);
  assert.equal(collected, true);
  assert.deepEqual(getClicks(), { dropdownClicks: 1, optionClicks: 1 });
});

test('推荐模式无精确同名雇主岗位时拒绝采集', async () => {
  const { service, getClicks } = makeRecommendedFixture({
    options: [{ value: 'other-job', label: '成本核算经理助理 _ 惠州 12-15K' }]
  });
  service.browseRecommendedCandidateList = async () => {
    assert.fail('岗位不匹配时不应读取候选人');
  };
  await assert.rejects(service.browseRecommendedCandidates(1), error =>
    error.code === 'BOSS_RECOMMENDED_JOB_UNAVAILABLE');
  assert.deepEqual(getClicks(), { dropdownClicks: 0, optionClicks: 0 });
});

test('推荐 iframe 重绘时只恢复一次并再次校验岗位，绝不调用搜索恢复', async () => {
  const { service, frame: restored } = makeRecommendedFixture({
    selected: '成本核算经理 _ 惠州 12-15K', jobId: 'cost-job'
  });
  const old = { isDetached: () => true };
  let jobChecks = 0;
  let scrolls = 0;
  restored.waitForTimeout = async () => {};
  restored.locator = () => ({ count: async () => 0 });
  service.browsingStatus.isActive = true;
  service.ensureResumeDialogClosed = async () => {};
  service.assertRecommendedJob = async (frame, title, jobId) => {
    assert.equal(frame, restored);
    assert.equal(title, '成本核算经理');
    assert.equal(jobId, 'cost-job');
    jobChecks++;
  };
  service.getSearchContext = async () => assert.fail('不应跳到搜索页恢复');
  service.scrollSearchResults = async () => { scrolls++; };
  await service.processSearchResults(old, 1, {
    mode: 'recommended', expectedTitle: '成本核算经理',
    expectedJobId: 'cost-job'
  });
  assert.ok(jobChecks >= 2);
  assert.ok(scrolls > 0);
});

test('推荐 iframe 重绘后若切换了岗位则停止，不能继续采集', async () => {
  const { service, frame: restored } = makeRecommendedFixture();
  const old = { isDetached: () => true };
  service.browsingStatus.isActive = true;
  service.ensureResumeDialogClosed = async () => {};
  service.getSearchContext = async () => assert.fail('不应跳到搜索页恢复');
  await assert.rejects(service.processSearchResults(old, 1, {
    mode: 'recommended', expectedTitle: '成本核算经理',
    expectedJobId: 'cost-job'
  }), error => error.code === 'BOSS_RECOMMENDED_JOB_MISMATCH');
  assert.equal(service.browsingStatus.processedCount, 0);
});
