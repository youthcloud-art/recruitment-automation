const test = require('node:test');
const assert = require('node:assert/strict');
const BossZhipinService = require('../src/services/bossZhipinService');
const { assessBossResumeText, isTrustedBossResumeSource } =
  require('../src/services/bossResumeQuality');

const shortResume =
  '姓名：测试候选人。工作经历：在某科技公司负责企业网络、服务器日常巡检与故障处理，保障业务系统稳定。' +
  '教育经历：某大学计算机专业本科。求职意向：网络运维工程师。';

const titlelessOcrScreens = [
  '2020年3月-2024年9月，某制造公司成本核算经理，负责产品成本归集与月度结账，管理多工厂的材料耗用核对，制定成本差异分析流程，协调仓库和生产团队逐月核验出入库单据，完成经营报表。针对材料价格波动建立月度追踪台账，汇总主要产品的单位成本变化，向财务负责人说明异常项目并跟进整改。',
  '2018年6月-2020年2月，某工业集团财务主管，参与年度预算和标准成本制定，实施 ERP 成本模块上线，优化成本中心分摊口径，协助业务部门复核库存和采购数据，持续分析毛利变化。每季度与供应链团队核对采购价格和生产损耗，编制管理层需要的分析材料，追踪预算执行情况。',
  '某大学本科财务管理专业毕业，熟悉 ERP 系统和 Excel 数据处理，掌握财务报表编制、预算分析和成本核算方法，能够向业务负责人解释差异原因，并持续建设核算流程。能够独立整理原始业务数据、编制多维度分析表，配合审计和财务团队完成相关资料核验。'
];

test('BOSS 只接受有实际经历或技能正文的短简历', () => {
  const result = assessBossResumeText(shortResume);
  assert.equal(result.valid, true);
  assert.ok(result.sections.includes('work'));
  assert.ok(result.sections.includes('education'));
  assert.equal(isTrustedBossResumeSource('.resume-detail-wrap (iframe在线简历)'), true);
  assert.equal(isTrustedBossResumeSource('body'), false);
  assert.equal(isTrustedBossResumeSource('[class*="content"]'), false);
});

test('BOSS 页面摘要、导航标题和单一经历不能当作简历', () => {
  const pageSummary = '搜索牛人 推荐牛人 我的消息 联系候选人 工作年限 5 年 本科' +
    '网络运维岗位候选人，熟悉交换机、防火墙，待沟通，查看详情。'.repeat(14);
  assert.ok(pageSummary.length > 398);
  assert.equal(assessBossResumeText(pageSummary).valid, false);
  assert.equal(assessBossResumeText('工作经历 教育经历 项目经历 专业技能'.repeat(10)).valid, false);
  assert.equal(assessBossResumeText('工作经历：负责网络维护和服务器巡检，处理企业生产故障。'.repeat(5)).valid, false);
});

test('BOSS OCR 标题字符被空格分开或轻微误识别时仍能认出完整简历', () => {
  const ocr = [
    '工 作 经 厉：在制造企业担任成本核算经理多年，负责月度结账、产品成本归集与差异分析。',
    '教 肓 经 厉：某大学财务管理专业本科毕业，系统学习管理会计。',
    '项 日 经 历：建设产品成本分析流程，完成部门报表和核算数据核对。'
  ].join(' ');
  const result = assessBossResumeText(ocr);
  assert.equal(result.valid, true);
  assert.deepEqual(result.sections, ['work', 'education', 'project']);
});

test('BOSS 懒加载 Canvas 只有拼接到末页后才满足简历证据', () => {
  const firstViewport = '姓名：测试候选人。现居某地，本科，期望成本核算经理，' +
    '熟悉制造企业的产品结构、数据整理和部门协作。'.repeat(4);
  const middleViewport = '工 作 经 历：在制造企业负责产品成本归集、月末结账和差异分析，' +
    '协调仓储和生产部门核对单据，持续优化核算流程。';
  const finalViewport = '教 育 经 历：某大学财务管理专业本科，学习管理会计和企业财务课程。';
  assert.equal(assessBossResumeText(firstViewport).valid, false);
  assert.equal(assessBossResumeText(`${firstViewport}\n${middleViewport}`).valid, false);
  assert.equal(assessBossResumeText(`${firstViewport}\n${middleViewport}\n${finalViewport}`).valid, true);
});

test('完整多页官方 OCR 的章节标题损坏时，仍可凭真实时间线和工作内容通过', () => {
  const text = titlelessOcrScreens.join('\n');
  assert.equal(assessBossResumeText(text).valid, false);
  const result = assessBossResumeText(text,{screens:titlelessOcrScreens,reachedEnd:true});
  assert.equal(result.valid,true);
  assert.equal(result.evidence,'verified_multiscreen_timeline');
});

test('多页 OCR 备用证据不能放行未到末页、重复截图或缺少经历时间线的摘要', () => {
  const text = titlelessOcrScreens.join('\n');
  assert.equal(assessBossResumeText(text,{screens:titlelessOcrScreens,reachedEnd:false}).valid,false);
  assert.equal(assessBossResumeText(text,{screens:[titlelessOcrScreens[0],
    titlelessOcrScreens[0],titlelessOcrScreens[0]],reachedEnd:true}).valid,false);
  const undatedScreens = titlelessOcrScreens.map(screen => screen
    .replace(/(?:19|20)\d{2}年\d{1,2}月[-–—](?:19|20)\d{2}年\d{1,2}月/g,'在职期间'));
  assert.equal(assessBossResumeText(undatedScreens.join('\n'),
    {screens:undatedScreens,reachedEnd:true}).valid,false);
});

test('BOSS OCR 噪声不能让章节目录或简短候选人卡片入库', () => {
  const headingsOnly = '工 作 经 厉   教 育 经 厉   项 日 经 厉   专 业 技 能 '.repeat(12);
  const teaser = '推荐牛人 搜索牛人 待沟通 查看详情 '.repeat(15) +
    '工 作 经 历：财务经理 5 年。教 育 经 历：本科。';
  assert.equal(assessBossResumeText(headingsOnly).valid, false);
  assert.equal(assessBossResumeText(teaser).valid, false);
  assert.equal(assessBossResumeText('。'.repeat(100) + '工作经历：成本经理').valid, false);
});

test('BOSS iframe 的宽泛 body 摘要即使超过 100 字也继续尝试 Canvas OCR', async () => {
  const service = new BossZhipinService();
  let ocrCalls = 0;
  service.extractCanvasResumeContent = async () => null;
  service.extractCanvasOcrContent = async () => { ocrCalls++; return shortResume; };
  const frame = {
    evaluate: async () => ({ content: shortResume, source: 'body' })
  };
  assert.equal(await service.extractResumeContentFromIframe(frame), shortResume);
  assert.equal(ocrCalls, 1);
});

test('BOSS iframe 的非简历文本且 OCR 不可用时跳过', async () => {
  const service = new BossZhipinService();
  const pageSummary = '搜索牛人 推荐牛人 我的消息 联系候选人 '.repeat(10);
  service.extractCanvasResumeContent = async () => null;
  let ocrCalls = 0;
  service.extractCanvasOcrContent = async () => { ocrCalls++; return null; };
  const frame = { evaluate: async () => ({ content: pageSummary, source: '.resume-content' }) };
  assert.equal(await service.extractResumeContentFromIframe(frame), null);
  assert.equal(ocrCalls, 1);
});

test('BOSS Hook 返回页面摘要时仍尝试拖拽和 Canvas OCR', async () => {
  const service = new BossZhipinService();
  const pageSummary = '推荐牛人 搜索牛人 查看详情 待沟通。'.repeat(20);
  service.page = {};
  const calls = [];
  service.dragSelectionService.copyResumeByHook = async () => {
    calls.push('hook'); return pageSummary;
  };
  service.dragSelectionService.copyResumeByDragSelection = async () => {
    calls.push('drag'); return pageSummary;
  };
  service.canvasOcrService.captureAndRecognizeCanvas = async () => {
    calls.push('ocr'); return shortResume;
  };
  service.assertCollectorReady = async () => {};
  const frame = { locator: () => ({ first: () => ({ isVisible: async () => true }) }) };
  assert.equal(await service.extractCanvasResumeContent(frame), shortResume);
  assert.deepEqual(calls, ['hook', 'drag', 'ocr']);
});

test('BOSS 官方简历 iframe 提取失败时不读取背后的搜索列表', async () => {
  const service = new BossZhipinService();
  const page = { url: () => 'https://www.zhipin.com/web/boss/search' };
  service.page = page;
  service.browsingStatus.isActive = true;
  service.findResumeIframe = async () => ({ id: 'resume-frame' });
  service.extractResumeContentFromIframe = async () => null;
  service.extractResumeContentFromPage = async () => {
    throw new Error('搜索列表不应被读取');
  };
  const frame = { page: () => page, waitForTimeout: async () => {} };
  await assert.rejects(service.extractAndImportResume(frame, 1),
    /BOSS 简历内容未加载或不可访问/);
});

test('BOSS 写入层拒绝 398 字页面摘要，避免误计入采集目标', async () => {
  const service = new BossZhipinService();
  const pageSummary = '搜索牛人 推荐牛人 我的消息 联系候选人 工作年限 本科 待沟通 查看详情。'.repeat(12);
  assert.ok(pageSummary.length > 398);
  await assert.rejects(
    service.saveResumeToDatabase({ sourceCandidateId: 'test-id' }, pageSummary),
    error => error.code === 'RESUME_CONTENT_INVALID'
  );
});
