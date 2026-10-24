const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');
const { ActiveJobService, normalizeJob, parseJobTemplate,
  readableXlsxBuffer } = require('../src/services/activeJobService');

const templatePath = path.join(__dirname, '../../frontend/public/岗位条件模板.xlsx');
const priorWorkbookPath = 'C:/Users/gt-003/Desktop/成本核算主管.xlsx';
const wrappedWorkbookPath = 'C:/Users/gt-003/Desktop/成本核算经理.xlsx';

function filledTemplate(cells) {
  const workbook = XLSX.read(readableXlsxBuffer(fs.readFileSync(templatePath)),
    { type: 'buffer' });
  const sheet = workbook.Sheets['岗位筛选条件'];
  for (const [address, value] of Object.entries(cells)) {
    sheet[address] = typeof value === 'number' ? { t: 'n', v: value } : { t: 's', v: value };
  }
  return XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' });
}

test('下载模板填写后可导入，岗位字段持久化并保持评估文本完全一致', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'active-job-test-'));
  const file = path.join(dir, 'active-job.json');
  try {
    const service = new ActiveJobService({ file });
    assert.equal(service.current().jobRequirements, '');
    const saved = service.import(filledTemplate({
      B7: '成本核算经理', B8: '深圳', B9: 3, B10: '本科及以上',
      B11: '成本核算、ERP', B12: '制造业经验', B13: '负责成本分析',
      B14: 18, B15: '成本核算经理，成本经理'
    }));
    assert.equal(saved.title, '成本核算经理');
    assert.equal(saved.recommendationTargetCount, 18);
    assert.equal(saved.targetCount, null);
    assert.equal(saved.minExperienceYears, 3);
    assert.equal(saved.searchKeywords, '成本核算经理，成本经理');
    assert.match(saved.jobRequirements, /必需技能：成本核算、ERP/);
    assert.equal(new ActiveJobService({ file }).current().jobRequirements, saved.jobRequirements);
    const edited = service.save({ ...saved, jobRequirements: saved.jobRequirements + '\n熟悉财务报表' });
    assert.equal(service.current().jobRequirements, edited.jobRequirements);
    assert.equal(service.current().title, '成本核算经理');
  } finally {
    try { fs.unlinkSync(file); } catch (_) {}
    fs.rmdirSync(dir);
  }
});

test('单个平台应用岗位时，其余两个平台保持原岗位；三平台应用可再次统一', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scoped-job-test-'));
  try {
    const file = path.join(dir, 'active-job.json');
    const service = new ActiveJobService({ file });
    const first = service.save({ title: '磁轴销售工程师',
      jobRequirements: '熟悉磁轴产品、客户开发与技术沟通' });
    assert.throws(() => service.current('unknown'), /应用平台无效/);
    const second = service.save({ title: 'IT网络运维',
      jobRequirements: '负责网络故障排查和服务器维护' }, { applyTo: 'boss' });
    assert.equal(service.current('boss').title, second.title);
    assert.equal(service.current('zlzp').title, first.title);
    assert.equal(service.current('qcwy').title, first.title);
    assert.equal(new ActiveJobService({ file }).current('zlzp').title, first.title);
    assert.throws(() => service.save(first, { applyTo: 'unknown' }), /应用平台无效/);
    service.save(first, { applyTo: 'all' });
    assert.deepEqual(Object.values(service.currentByPlatform()).map(job => job.title),
      [first.title, first.title, first.title]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('原有岗位筛选条件 Excel 可兼容导入，不丢失职责和优先技能', () => {
  if (!fs.existsSync(priorWorkbookPath)) return;
  const imported = parseJobTemplate(fs.readFileSync(priorWorkbookPath));
  assert.equal(imported.title, '成本核算经理');
  assert.equal(imported.recommendationTargetCount, 18);
  assert.equal(imported.targetCount, null);
  assert.match(imported.jobRequirements, /岗位职责：/);
  assert.match(imported.jobRequirements, /优先技能：/);
  assert.match(imported.jobRequirements, /必需技能：/);
});

test('Windows 文件提供器包装只在匹配的原始路径上回退读取，普通 OOXML 不依赖 Python', () => {
  const normal = filledTemplate({ B7: '成本核算经理', B11: '制造业成本核算' });
  assert.equal(parseJobTemplate(normal, { sourcePath: 'C:/missing.xlsx' }).title,
    '成本核算经理');
  if (!fs.existsSync(wrappedWorkbookPath)) return;
  const wrapped = fs.readFileSync(wrappedWorkbookPath);
  if (!wrapped.subarray(0, 3).equals(Buffer.from([0x88, 0x7d, 0x1c]))) return;
  assert.equal(parseJobTemplate(wrapped).title, '成本核算经理');
  assert.throws(() => parseJobTemplate(wrapped, { sourcePath: templatePath }),
    /此 Excel 文件无法在本机读取/);
  const job = parseJobTemplate(wrapped, { sourcePath: wrappedWorkbookPath });
  assert.equal(job.title, '成本核算经理');
  assert.equal(job.searchKeywords, '成本核算经理');
  assert.equal(job.minExperienceYears, 3);
  assert.equal(job.education, '本科');
  assert.equal(job.targetCount, null);
  assert.equal(job.recommendationTargetCount, 18);
  assert.match(job.jobRequirements, /岗位职责：/);
});

test('手填结构化条件进入同一份评估文本，重复保存幂等且编辑后无旧条件', () => {
  const first = normalizeJob({
    title: '成本核算经理', searchKeywords: '成本经理',
    location: '深圳', education: '本科', minExperienceYears: 3,
    jobRequirements: '熟悉制造业成本核算及 ERP 系统'
  });
  assert.match(first.jobRequirements, /工作经验：至少3年/);
  assert.match(first.jobRequirements, /学历要求：本科/);
  assert.equal(normalizeJob(first).jobRequirements, first.jobRequirements);
  const edited = normalizeJob({ ...first, title: '财务经理', location: '广州',
    minExperienceYears: 5, jobRequirements: first.jobRequirements + '\n具有团队管理经验' });
  assert.match(edited.jobRequirements, /岗位名称：财务经理/);
  assert.match(edited.jobRequirements, /工作地点：广州/);
  assert.match(edited.jobRequirements, /工作经验：至少5年/);
  assert.doesNotMatch(edited.jobRequirements, /深圳|至少3年|岗位名称：成本核算经理/);
  assert.match(edited.jobRequirements, /具有团队管理经验/);
});

test('推荐人数与单次采集目标独立保存，IT 网络运维的 100 人不会变成每平台采集 100 份', () => {
  const imported = parseJobTemplate(filledTemplate({
    B7: 'IT网络运维', B8: '不限', B9: 3, B10: '大专',
    B11: '网络架构规划、VLAN、OSPF/BGP、Linux 运维',
    B12: 'CCNP/HCIP、RHCE', B13: '负责网络故障排查和备份恢复', B14: 100
  }));
  assert.equal(imported.recommendationTargetCount, 100);
  assert.equal(imported.targetCount, null);
  assert.equal(imported.location, '不限');
  assert.match(imported.jobRequirements, /工作经验：至少3年/);
  assert.match(imported.jobRequirements, /必需技能：.*OSPF\/BGP/);
  const withBatchTarget = normalizeJob({ ...imported, targetCount: 20 });
  assert.equal(withBatchTarget.recommendationTargetCount, 100);
  assert.equal(withBatchTarget.targetCount, 20);
  assert.equal(normalizeJob(withBatchTarget).jobRequirements, imported.jobRequirements);
});

test('空模板、损坏文件、公式、无效数量和缺少工作表均明确拒绝', () => {
  assert.throws(() => parseJobTemplate(fs.readFileSync(templatePath)), /岗位名称/);
  assert.throws(() => parseJobTemplate(Buffer.from('not an xlsx')), /Excel 文件无法读取|缺少/);
  assert.throws(() => parseJobTemplate(filledTemplate({ B7: '经理', B11: '相关工作经验', B14: 201 })), /推荐人数/);
  assert.throws(() => parseJobTemplate(filledTemplate({ B7: '经理', B11: '相关工作经验', A16: '未识别条件', B16: '不能静默忽略' })), /无法识别的字段/);
  const workbook = XLSX.read(readableXlsxBuffer(fs.readFileSync(templatePath)),
    { type: 'buffer' });
  workbook.Sheets['岗位筛选条件'].B7 = { t: 'n', f: '1+1', v: 2 };
  assert.throws(() => parseJobTemplate(XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' })), /不能使用公式/);
  const other = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(other, XLSX.utils.aoa_to_sheet([['岗位名称', '经理']]), '其他');
  assert.throws(() => parseJobTemplate(XLSX.write(other, { bookType: 'xlsx', type: 'buffer' })), /缺少/);
});
