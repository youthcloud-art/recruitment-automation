const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { performance } = require('node:perf_hooks');
const { ResumeModel } = require('../src/models/resumeModel');
const { ResumeRecommendationService } = require('../src/services/resumeRecommendationService');
const { RecruitmentAnalyticsService } = require('../src/services/recruitmentAnalyticsService');

function fixture(t, data) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-sqlite-'));
  const libraryDir = path.join(directory, 'resume_library');
  fs.mkdirSync(libraryDir);
  const legacy = path.join(libraryDir, 'resumes.json');
  fs.writeFileSync(legacy, JSON.stringify(data));
  return { directory, libraryDir, legacy,
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

test('SQLite migration retains legacy JSON, deduplicates and updates a single candidate', async t => {
  const first = { id: 'legacy-1', source: 'zlzp', sourceFingerprint: 'fp-1',
    name: '历史记录', createdAt: '2026-01-01T00:00:00.000Z', originalText: '已有简历' };
  const { libraryDir, legacy, cleanup } = fixture(t, {
    resumes: [first], positions: [{ id: 'job-1', title: '运维' }], categories: []
  });
  const before = fs.readFileSync(legacy);
  const model = new ResumeModel({ resumeStorageDir: libraryDir, storageEngine: 'sqlite' });
  t.after(() => { model.sqliteStore.close(); cleanup(); });

  assert.deepEqual(model.getResumeById('legacy-1'), first);
  assert.equal(model.getPositions()[0].title, '运维');
  const duplicate = await model.addResume({ source: 'zlzp', name: '历史记录',
    sourceFingerprint: 'fp-1' }, { returnStatus: true });
  assert.equal(duplicate.created, false);
  const created = await model.addResume({ source: 'qcwy', name: '新候选人',
    sourceFingerprint: 'fp-2', originalText: '新简历内容' }, { returnStatus: true });
  assert.equal(created.created, true);
  model.updateCandidateMetadata(created.resume.id, { matchScore: 88,
    workflowStatus: 'shortlisted' });
  assert.equal(model.getResumeById(created.resume.id).matchScore, 88);
  assert.equal(model.getResumesPage({ source: 'qcwy', status: 'shortlisted', limit: 1 }).total, 1);
  assert.equal(model.getResumesPage({ source: 'qcwy', status: 'new', limit: 1 }).total, 0);
  assert.deepEqual(fs.readFileSync(legacy), before);

  const all = model.readDatabase();
  all.positions.push({ id: 'job-2', title: '网络运维' });
  model.writeDatabase(all);
  assert.equal(model.getPositions().length, 2);
  assert.equal(model.getResumes().length, 2);
});

test('legacy official URLs backfill platform IDs, support search and keep distinct resumes', async t => {
  const resumes = [
    { id: 'zl-old', source: 'zlzp', sourceFingerprint: 'shared',
      sourceUrl: 'https://rd.zhaopin.com/app/search?resumeNumber=zl-001', originalText: '相同正文' },
    { id: 'qc-old', source: 'qcwy', sourceFingerprint: 'qc-old-fp',
      sourceUrl: 'https://ehire.51job.com/Revision/talent/resume/detail?resumeId=qc-001',
      originalText: '前程无忧正文' },
    { id: 'boss-old', source: 'boss', sourceFingerprint: 'boss-old-fp',
      sourceUrl: 'https://www.zhipin.com/web/frame/c-resume/?source=search',
      originalText: 'BOSS 正文' }
  ];
  const { libraryDir, cleanup } = fixture(t, { resumes, positions: [], categories: [] });
  const model = new ResumeModel({ resumeStorageDir: libraryDir, storageEngine: 'sqlite' });
  t.after(() => { model.sqliteStore.close(); cleanup(); });
  assert.equal(model.getResumeById('zl-old').sourceCandidateId, 'zl-001');
  assert.equal(model.getResumeById('qc-old').sourceCandidateId, 'qc-001');
  assert.equal(model.getResumeById('boss-old').sourceCandidateId, undefined);
  assert.equal(model.getResumesPage({ keyword: 'qc-001' }).total, 1);
  assert.equal(model.getResumesPage({ keyword: 'zl-001' }).total, 1);
  const distinct = await model.addResume({ source: 'zlzp', sourceCandidateId: 'zl-002',
    sourceFingerprint: 'shared', originalText: '相同正文' }, { returnStatus: true });
  assert.equal(distinct.created, true);
  assert.equal(model.getResumes().length, 4);
});

test('an earlier narrow ID backfill is rerun for real Zhilian numbers with parentheses', t => {
  const opaqueId = 'abcdefghijklmnopqr)stuvwxyz12345';
  const sourceUrl = `https://rd.zhaopin.com/app/search?resumeNumber=${encodeURIComponent(opaqueId)}`;
  const { libraryDir, cleanup } = fixture(t, { resumes: [{ id: 'zl-legacy',
    source: 'zlzp', sourceUrl, originalText: '历史智联简历' }], positions: [], categories: [] });
  const first = new ResumeModel({ resumeStorageDir: libraryDir, storageEngine: 'sqlite' });
  const legacy = first.getResumeById('zl-legacy');
  delete legacy.sourceCandidateId;
  first.sqliteStore.db.prepare(`UPDATE candidate_resumes SET source_candidate_id = NULL,
    payload = ? WHERE id = 'zl-legacy'`).run(JSON.stringify(legacy));
  first.sqliteStore.db.exec(`DELETE FROM library_metadata WHERE key = 'official_platform_ids_backfilled_v2';
    INSERT OR REPLACE INTO library_metadata (key, value)
    VALUES ('official_platform_ids_backfilled_v1', 'true');`);
  first.sqliteStore.close();
  const upgraded = new ResumeModel({ resumeStorageDir: libraryDir, storageEngine: 'sqlite' });
  t.after(() => { upgraded.sqliteStore.close(); cleanup(); });
  assert.equal(upgraded.getResumeById('zl-legacy').sourceCandidateId, opaqueId);
  assert.equal(upgraded.getResumesPage({ keyword: opaqueId }).total, 1);
});

test('三平台岗位筛选与评分排序在 SQLite 全部结果分页前执行', t => {
  const resumes = [
    { id: 'a', source: 'boss', captureJobTitle: '网络运维', matchScore: 60 },
    { id: 'b', source: 'zlzp', captureJobTitle: '网络运维', matchScore: 95 },
    { id: 'c', source: 'qcwy', captureJobTitle: '网络运维', matchScore: 0 },
    { id: 'd', source: 'boss', captureJobTitle: '网络运维' },
    { id: 'e', source: 'boss', captureJobTitle: '财务经理', matchScore: 99 },
    { id: 'f', source: 'qcwy', captureJobRequirements: '岗位名称：网络运维\n要求：Linux', matchScore: 70 }
  ].map((item, index) => ({ ...item, createdAt: `2026-10-0${index + 1}T00:00:00.000Z` }));
  const { libraryDir, cleanup } = fixture(t, { resumes, positions: [], categories: [] });
  const model = new ResumeModel({ resumeStorageDir: libraryDir, storageEngine: 'sqlite' });
  t.after(() => { model.sqliteStore.close(); cleanup(); });
  const filters = { hiringJobTitle: '网络运维', sources: ['boss', 'zlzp', 'qcwy'] };
  assert.deepEqual(model.getResumesPage({ ...filters, sortBy: 'scoreDesc', limit: 2 }).items.map(x => x.id), ['b', 'f']);
  assert.deepEqual(model.getResumesPage({ ...filters, sortBy: 'scoreDesc', limit: 2, offset: 2 }).items.map(x => x.id), ['a', 'c']);
  assert.deepEqual(model.getResumesPage({ ...filters, sortBy: 'scoreAsc', limit: 6 }).items.map(x => x.id), ['c', 'a', 'f', 'b', 'd']);
  assert.deepEqual(model.getResumesPage({ ...filters, source: 'qcwy', sortBy: 'scoreDesc' }).items.map(x => x.id), ['f', 'c']);
  const counts = model.getHiringJobCounts(['boss', 'zlzp', 'qcwy']);
  assert.equal(counts.filter(row => row.title === '网络运维').reduce((sum, row) => sum + row.total, 0), 5);
  model.updateCandidateMetadata('d', { matchScore: 85 });
  assert.deepEqual(model.getResumesPage({ ...filters, sortBy: 'scoreDesc', limit: 2 }).items.map(x => x.id), ['b', 'd']);
});

test('同名岗位归档后新旧候选人独立保存，旧无 ID 记录不会混入在用岗位', t => {
  const criteria = { jobRequirements: '岗位名称：磁轴销售工程师\n负责销售' };
  const positions = [
    { id: 'position_old', title: '磁轴销售工程师', jobCriteria: criteria,
      archivedAt: '2026-10-01T00:00:00Z' },
    { id: 'position_new', title: '磁轴销售工程师', jobCriteria: criteria }
  ];
  const resumes = [
    { id: 'old', source: 'boss', captureJobTitle: '磁轴销售工程师',
      captureJobRequirements: criteria.jobRequirements, capturePositionId: 'position_old' },
    { id: 'new', source: 'zlzp', captureJobTitle: '磁轴销售工程师',
      captureJobRequirements: criteria.jobRequirements, capturePositionId: 'position_new' },
    { id: 'legacy', source: 'qcwy', captureJobTitle: '磁轴销售工程师',
      captureJobRequirements: criteria.jobRequirements }
  ];
  const { libraryDir, cleanup } = fixture(t, { resumes, positions, categories: [] });
  const model = new ResumeModel({ resumeStorageDir: libraryDir, storageEngine: 'sqlite' });
  t.after(() => { model.sqliteStore.close(); cleanup(); });
  assert.deepEqual(model.getResumesPage({ hiringJobTitle: '磁轴销售工程师',
    jobGroup: 'current' }).items.map(item => item.id), ['new']);
  assert.deepEqual(model.getResumesPage({ hiringJobTitle: '磁轴销售工程师',
    jobGroup: 'historical' }).items.map(item => item.id).sort(), ['legacy', 'old']);
  const groups = model.getHiringJobCounts(['boss', 'zlzp', 'qcwy']);
  assert.equal(groups.filter(item => item.jobGroup === 'current').reduce((n, item) => n + item.total, 0), 1);
  assert.equal(groups.filter(item => item.jobGroup === 'historical').reduce((n, item) => n + item.total, 0), 2);
});

test('SQLite position edits avoid loading candidate payloads and preserve linked resumes', async t => {
  const { libraryDir, cleanup } = fixture(t, { resumes: [], positions: [], categories: [] });
  const model = new ResumeModel({ resumeStorageDir: libraryDir, storageEngine: 'sqlite' });
  t.after(() => { model.sqliteStore.close(); cleanup(); });
  model.readDatabase = () => { throw new Error('position edit loaded the full candidate library'); };
  const linked = await model.addPosition({ title: '网络运维' });
  const other = await model.addPosition({ title: '成本经理' });
  assert.equal(model.getPositionById(linked.id).title, '网络运维');
  const update = await model.updatePosition(linked.id, { description: '负责网络设备维护' });
  assert.equal(update.success, true);
  assert.equal(model.getPositionById(linked.id).description, '负责网络设备维护');
  const candidate = await model.addResume({ source: 'boss', positionId: linked.id,
    sourceFingerprint: 'position-linked', originalText: '独立测试简历' });
  const archived = await model.deletePosition(linked.id);
  assert.equal(archived.success, true);
  assert.ok(archived.position.archivedAt);
  assert.ok(model.getResumeById(candidate.id));
  assert.equal(model.getResumesPage({ jobGroup: 'historical' }).total, 1);
  assert.equal((await model.restorePosition(linked.id)).success, true);
  assert.equal(model.getResumesPage({ jobGroup: 'current' }).total, 1);
  assert.equal((await model.deletePosition(other.id)).success, true);
  assert.equal(model.getPositions().length, 2);
  assert.equal(model.getPositionById(other.id).status, '已归档');
  assert.equal(model.getResumeById(candidate.id).positionId, linked.id);
});

test('restoring a unique archived job also restores safely matched legacy candidates', async t => {
  const requirements = '岗位名称：网络运维\n负责企业网络设备维护';
  const { libraryDir, cleanup } = fixture(t, { resumes: [], positions: [], categories: [] });
  const model = new ResumeModel({ resumeStorageDir: libraryDir, storageEngine: 'sqlite' });
  t.after(() => { model.sqliteStore.close(); cleanup(); });
  const position = await model.addPosition({ title: '网络运维',
    jobCriteria: { jobRequirements: requirements } });
  await model.addResume({ source: 'boss', captureJobTitle: '网络运维',
    captureJobRequirements: requirements, sourceFingerprint: 'legacy-job-resume' });
  assert.equal(model.getResumesPage({ jobGroup: 'current' }).total, 1);
  assert.equal((await model.deletePosition(position.id)).success, true);
  assert.equal(model.getResumesPage({ jobGroup: 'historical' }).total, 1);
  assert.equal((await model.restorePosition(position.id)).success, true);
  assert.equal(model.getResumesPage({ jobGroup: 'current' }).total, 1);
});

test('历史岗位简历按岗位与 ID 原子删除，混入在用简历会整批拒绝', t => {
  const positions = [{ id: 'position_live', title: '网络运维',
    jobCriteria: { jobRequirements: '负责网络设备维护' } },
  { id: 'position_old', title: '网络运维', archivedAt: '2026-10-01T00:00:00Z',
    jobCriteria: { jobRequirements: '负责旧网络设备维护' } }];
  const resumes = [
    { id: 'live', source: 'boss', captureJobTitle: '网络运维', capturePositionId: 'position_live' },
    { id: 'old-a', source: 'zlzp', captureJobTitle: '网络运维', capturePositionId: 'position_old' },
    { id: 'old-b', source: 'qcwy', captureJobTitle: '网络运维', capturePositionId: 'position_old' }
  ];
  const { libraryDir, cleanup } = fixture(t, { resumes, positions, categories: [] });
  const model = new ResumeModel({ resumeStorageDir: libraryDir, storageEngine: 'sqlite' });
  t.after(() => { model.sqliteStore.close(); cleanup(); });
  assert.throws(() => model.deleteHistoricalResumes(['old-a', 'live'], '网络运维'), /已变化/);
  assert.equal(model.getResumesPage({ hiringJobTitle: '网络运维' }).total, 3);
  assert.throws(() => model.deleteHistoricalResumes(['old-a'], '其他岗位'), /已变化/);
  assert.equal(model.deleteHistoricalResumes(['old-a', 'old-b'], '网络运维').count, 2);
  assert.equal(model.getResumesPage({ jobGroup: 'historical' }).total, 0);
  assert.equal(model.getResumesPage({ jobGroup: 'current' }).total, 1);
});

test('invalid legacy JSON cannot create a replacement SQLite database', t => {
  const { libraryDir, legacy, cleanup } = fixture(t, { resumes: [{ id: 'same' }, { id: 'same' }],
    positions: [], categories: [] });
  t.after(cleanup);
  const bytes = fs.readFileSync(legacy);
  assert.throws(() => new ResumeModel({ resumeStorageDir: libraryDir,
    storageEngine: 'sqlite' }), /重复 ID/);
  assert.deepEqual(fs.readFileSync(legacy), bytes);
  assert.equal(fs.existsSync(path.join(libraryDir, 'resumes.sqlite')), false);
});

test('missing SQLite file after completed migration fails closed instead of replaying stale JSON', t => {
  const { libraryDir, cleanup } = fixture(t, { resumes: [], positions: [], categories: [] });
  t.after(cleanup);
  const model = new ResumeModel({ resumeStorageDir: libraryDir, storageEngine: 'sqlite' });
  const added = model.sqliteStore.getResumesPage({ limit: 1 });
  assert.equal(added.total, 0);
  model.sqliteStore.close();
  const sqliteFile = path.join(libraryDir, 'resumes.sqlite');
  const marker = `${sqliteFile}.migration.json`;
  assert.equal(fs.existsSync(marker), true);
  fs.unlinkSync(sqliteFile);
  assert.throws(() => new ResumeModel({ resumeStorageDir: libraryDir,
    storageEngine: 'sqlite' }), /已丢失/);
  assert.throws(() => new ResumeModel({ resumeStorageDir: libraryDir,
    storageEngine: null }), /已丢失/);
  assert.equal(fs.existsSync(sqliteFile), false);
});

test('restored SQLite is selected when .env storage setting is absent', async t => {
  const { libraryDir, legacy, cleanup } = fixture(t, {
    resumes: [{ id: 'old', source: 'qcwy', name: 'synthetic-old' }],
    positions: [], categories: []
  });
  t.after(cleanup);
  const original = new ResumeModel({ resumeStorageDir: libraryDir, storageEngine: 'sqlite' });
  await original.addResume({ source: 'zlzp', name: 'synthetic-new',
    sourceFingerprint: 'fresh' });
  original.sqliteStore.close();
  assert.equal(JSON.parse(fs.readFileSync(legacy, 'utf8')).resumes.length, 1);

  const restored = new ResumeModel({ resumeStorageDir: libraryDir, storageEngine: null });
  try {
    assert.equal(restored.storageEngine, 'sqlite');
    assert.equal(restored.getResumesPage({ limit: 10 }).total, 2);
  } finally { restored.sqliteStore.close(); }

  const intentionalRollback = new ResumeModel({ resumeStorageDir: libraryDir,
    storageEngine: 'json' });
  assert.equal(intentionalRollback.getResumesPage({ limit: 10 }).total, 1);
});

test('unknown resume storage engine is rejected rather than reading stale JSON', t => {
  const { libraryDir, cleanup } = fixture(t, { resumes: [], positions: [], categories: [] });
  t.after(cleanup);
  assert.throws(() => new ResumeModel({ resumeStorageDir: libraryDir,
    storageEngine: 'sqlte' }), /RESUME_STORAGE_ENGINE/);
});

test('dead migration lock can be recovered without trusting an active lock', t => {
  const { libraryDir, cleanup } = fixture(t, { resumes: [], positions: [], categories: [] });
  t.after(cleanup);
  const lock = path.join(libraryDir, 'resumes.sqlite.migration.lock');
  fs.writeFileSync(lock, JSON.stringify({ format: 1, host: os.hostname(),
    pid: 99999999, startedAt: new Date(Date.now() - 120000).toISOString() }));
  const model = new ResumeModel({ resumeStorageDir: libraryDir, storageEngine: 'sqlite' });
  model.sqliteStore.close();
  assert.equal(fs.existsSync(lock), false);
  assert.equal(fs.readdirSync(libraryDir).some(name => name.includes('.migration.lock.stale.')), true);
});

test('live migration lock is not stolen even if its timestamp is old', t => {
  const { libraryDir, cleanup } = fixture(t, { resumes: [], positions: [], categories: [] });
  t.after(cleanup);
  const lock = path.join(libraryDir, 'resumes.sqlite.migration.lock');
  fs.writeFileSync(lock, JSON.stringify({ format: 1, host: os.hostname(),
    pid: process.pid, startedAt: new Date(Date.now() - 120000).toISOString() }));
  assert.throws(() => new ResumeModel({ resumeStorageDir: libraryDir,
    storageEngine: 'sqlite' }), /其它进程/);
  assert.equal(fs.existsSync(lock), true);
});

test('stale position snapshot cannot delete a candidate inserted after its read', async t => {
  const { libraryDir, cleanup } = fixture(t, { resumes: [], positions: [], categories: [] });
  const model = new ResumeModel({ resumeStorageDir: libraryDir, storageEngine: 'sqlite' });
  t.after(() => { model.sqliteStore.close(); cleanup(); });
  const stale = model.readDatabase();
  const added = await model.addResume({ source: 'qcwy', name: '候选人',
    sourceFingerprint: 'after-snapshot' });
  stale.positions.push({ id: 'job-new', title: '网络运维' });
  model.writeDatabase(stale);
  assert.equal(model.getResumeById(added.id).id, added.id);
  assert.equal(model.getPositions()[0].title, '网络运维');

  const staleResume = model.readDatabase();
  model.updateCandidateMetadata(added.id, { matchScore: 83 });
  staleResume.resumes[0].workflowStatus = 'viewed';
  assert.throws(() => model.writeDatabase(staleResume), /已被其它操作修改/);
  assert.equal(model.getResumeById(added.id).matchScore, 83);
});

test('SQLite Zhilian dedup matches normalized names on the same result URL', async t => {
  const longText = ('工作经历：维护服务器、网络设备与企业 VPN。教育经历：计算机专业本科。').repeat(25);
  const { libraryDir, cleanup } = fixture(t, { resumes: [], positions: [], categories: [] });
  const model = new ResumeModel({ resumeStorageDir: libraryDir, storageEngine: 'sqlite' });
  t.after(() => { model.sqliteStore.close(); cleanup(); });
  const base = { source: 'zlzp', sourceUrl: 'https://rd.zhaopin.com/search',
    name: '张三', phone: '13800000000', originalText: `张三\n浏览标识：12\n${longText}` };
  const first = await model.addResume(base, { returnStatus: true });
  const duplicate = await model.addResume({ ...base, name: '张 三',
    originalText: `张三\n浏览标识：13\n${longText}` }, { returnStatus: true });
  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.resume.id, first.resume.id);
  assert.equal(model.getResumes().length, 1);
});

test('SQLite platform dedup uses indexes without loading all candidates', async t => {
  const { libraryDir, cleanup } = fixture(t, { resumes: [], positions: [], categories: [] });
  const model = new ResumeModel({ resumeStorageDir: libraryDir, storageEngine: 'sqlite' });
  t.after(() => { model.sqliteStore.close(); cleanup(); });
  const stableUrl = 'https://ehire.51job.com/Revision/talent/resume/detail?resumeId=abc123';
  const recordKey = crypto.createHash('sha256').update(stableUrl).digest('hex');
  const first = await model.addResume({ source: 'qcwy', sourceUrl: stableUrl,
    sourceRecordKey: recordKey, sourceFingerprint: 'old-content',
    originalText: '工作经历：网络运维。教育经历：计算机大专。' });
  model.getResumes = () => { throw new Error('全库加载不应发生'); };
  const sameUrl = model.findWuyouDuplicate({ source: 'qcwy', sourceUrl: stableUrl,
    sourceRecordKey: recordKey, sourceFingerprint: 'changed-content',
    originalText: '工作经历：网络安全。教育经历：计算机本科。' }, { hasStableId: true });
  assert.equal(sameUrl.id, first.id);
  const duplicate = await model.addResume({ source: 'qcwy', sourceUrl: stableUrl,
    sourceRecordKey: recordKey, sourceFingerprint: 'changed-content',
    originalText: '工作经历：网络安全。教育经历：计算机本科。' }, { returnStatus: true });
  assert.equal(duplicate.created, false);
  const generic = await model.addResume({ source: 'qcwy',
    sourceUrl: 'https://ehire.51job.com/Revision/talent/resume/detail',
    sourceRecordKey: crypto.createHash('sha256').update('different-resume').digest('hex'),
    sourceFingerprint: 'different-resume', originalText: '不同候选人' }, { returnStatus: true });
  assert.equal(generic.created, true);
  assert.equal(model.findWuyouDuplicate({ source: 'qcwy',
    sourceFingerprint: 'different-resume', originalText: '不同候选人' }).id, generic.resume.id);
  const zl = await model.addResume({ source: 'zlzp', sourceFingerprint: 'zl-fingerprint',
    name: '张三', originalText: '智联内容' });
  assert.equal(model.findDuplicateResume({ source: 'zlzp',
    sourceFingerprint: 'zl-fingerprint' }).id, zl.id);
  assert.equal(model.getResumesPage({ limit: 1 }).total, 3);
});

test('BOSS card fingerprint is an indexed, privacy-preserving hint, not a merge key', async t => {
  const { libraryDir, cleanup } = fixture(t, { resumes: [], positions: [], categories: [] });
  const sqlite = new ResumeModel({ resumeStorageDir: libraryDir, storageEngine: 'sqlite' });
  const json = new ResumeModel({ resumeStorageDir: libraryDir, storageEngine: 'json' });
  t.after(() => { sqlite.sqliteStore.close(); cleanup(); });
  const cardFingerprint = crypto.createHash('sha256').update('job\nfull-card').digest('hex');
  const fullText = '完整工作经历与教育经历。'.repeat(12);
  for (const model of [sqlite, json]) {
    const first = await model.addResume({ source: 'boss', sourceCardFingerprint: cardFingerprint,
      sourceFingerprint: 'first-full-resume', originalText: fullText,
      parseStatus: 'completed', name: '测试甲' }, { returnStatus: true });
    assert.equal(first.created, true);
    assert.equal(model.findBossCardMatch(cardFingerprint).id, first.resume.id);
    const second = await model.addResume({ source: 'boss', sourceCardFingerprint: cardFingerprint,
      sourceFingerprint: 'second-full-resume', originalText: `${fullText}不同内容`,
      parseStatus: 'completed', name: '测试乙' }, { returnStatus: true });
    assert.equal(second.created, true, '相同卡片摘要不得合并两份不同完整简历');
    assert.equal(model.findBossCardMatch(cardFingerprint), null,
      '卡片摘要发生碰撞时不得提前跳过 OCR');
    const duplicate = await model.addResume({ source: 'boss',
      sourceCardFingerprint: cardFingerprint, sourceFingerprint: 'second-full-resume',
      originalText: `${fullText}不同内容`, parseStatus: 'completed' }, { returnStatus: true });
    assert.equal(duplicate.created, false, '完整简历指纹仍可去重');
    assert.equal(model.findBossCardMatch('not-a-sha256'), null);
    assert.equal(model.getResumesPage({ source: 'boss' }).total, 2);
  }
  const index = sqlite.sqliteStore.db.prepare(`SELECT name FROM sqlite_master
    WHERE type = 'index' AND name = 'candidate_boss_card'`).get();
  assert.equal(index.name, 'candidate_boss_card');
  const plan = sqlite.sqliteStore.db.prepare(`EXPLAIN QUERY PLAN SELECT payload
    FROM candidate_resumes WHERE source = 'boss' AND source_card_fingerprint = ? LIMIT 2`)
    .all(cardFingerprint).map(step => step.detail).join(' ');
  assert.match(plan, /candidate_boss_card/);
});

test('existing SQLite BOSS payload is backfilled when card fingerprint column is added', t => {
  const fingerprint = crypto.createHash('sha256').update('historical-card').digest('hex');
  const fullText = '完整工作经历与教育经历。'.repeat(12);
  const { libraryDir, cleanup } = fixture(t, { resumes: [], positions: [], categories: [] });
  t.after(cleanup);
  const initial = new ResumeModel({ resumeStorageDir: libraryDir, storageEngine: 'sqlite' });
  initial.sqliteStore.putResume({ id: 'historical-boss', source: 'boss',
    sourceCardFingerprint: fingerprint, sourceFingerprint: 'historical-full-resume',
    originalText: fullText, parseStatus: 'completed' });
  initial.sqliteStore.db.exec(`DROP INDEX candidate_boss_card;
    ALTER TABLE candidate_resumes DROP COLUMN source_card_fingerprint;
    DELETE FROM library_metadata WHERE key = 'boss_card_fingerprint_backfilled';`);
  initial.sqliteStore.close();

  const restored = new ResumeModel({ resumeStorageDir: libraryDir, storageEngine: 'sqlite' });
  try {
    assert.equal(restored.findBossCardMatch(fingerprint).id, 'historical-boss');
    assert.equal(restored.getResumeById('historical-boss').sourceCardFingerprint, fingerprint);
    assert.equal(restored.sqliteStore.db.prepare(`SELECT source_card_fingerprint AS fingerprint
      FROM candidate_resumes WHERE id = 'historical-boss'`).get().fingerprint, fingerprint);
  } finally { restored.sqliteStore.close(); }
});

test('paged library filters and sorts before LIMIT without loading the full library', t => {
  const resumes = [
    { id: 'a', source: 'zlzp', name: 'Alice', position: '网络运维', skills: ['Linux'],
      workYears: '5年', education: '本科', age: 31, createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'b', source: 'qcwy', name: 'Bob', expectedPosition: { position: '网络工程师' },
      skills: ['Cisco'], workYears: '8年', education: '大专', age: 28,
      createdAt: '2026-01-02T00:00:00.000Z' },
    { id: 'c', source: 'zlzp', name: 'Cara', position: '项目经理',
      workExperience: [{ company: '网络服务公司', position: '系统管理员' }],
      workYears: '2年', education: '硕士', age: 35,
      createdAt: '2026-01-03T00:00:00.000Z' }
  ];
  const { libraryDir, cleanup } = fixture(t, { resumes, positions: [], categories: [] });
  const sqlite = new ResumeModel({ resumeStorageDir: libraryDir, storageEngine: 'sqlite' });
  const json = new ResumeModel({ resumeStorageDir: libraryDir, storageEngine: 'json' });
  t.after(() => { sqlite.sqliteStore.close(); cleanup(); });
  for (const model of [json, sqlite]) {
    assert.equal(model.getResumesPage({ keyword: '网络', limit: 1 }).total, 3);
    assert.deepEqual(model.getResumesPage({ keyword: 'Linux', limit: 5 }).items.map(x => x.id), ['a']);
    assert.deepEqual(model.getResumesPage({ keyword: '网络', sortBy: 'experience', limit: 1 })
      .items.map(x => x.id), ['b']);
    assert.deepEqual(model.getResumesPage({ keyword: '网络', source: 'zlzp',
      sortBy: 'age', limit: 1, offset: 1 }).items.map(x => x.id), ['c']);
    assert.deepEqual(model.getResumesPage({ sortBy: 'education', limit: 1 })
      .items.map(x => x.id), ['c']);
    assert.equal(model.getResumesPage({ sources: ['zlzp', 'qcwy'],
      keyword: '网络服务公司', keywordFields: 'pipeline' }).total, 0);
    assert.equal(model.getResumesPage({ sources: ['zlzp', 'qcwy'],
      keyword: '网络服务公司', keywordFields: 'library' }).total, 1);
    assert.deepEqual(model.getSourceStatusCounts(['zlzp', 'qcwy'])
      .reduce((counts, row) => ({ ...counts, [row.source]: row.total }), {}),
    { zlzp: 2, qcwy: 1 });
  }
});

test('old descending time indexes upgrade atomically and deep pages avoid temporary sorting', t => {
  const resumes = Array.from({ length: 12 }, (_, index) => ({
    id: `same-time-${index}`, source: index % 2 ? 'qcwy' : 'zlzp',
    createdAt: '2026-01-01T00:00:00.000Z', name: `合成${index}`
  }));
  const { libraryDir, cleanup } = fixture(t, { resumes, positions: [], categories: [] });
  const first = new ResumeModel({ resumeStorageDir: libraryDir, storageEngine: 'sqlite' });
  first.sqliteStore.db.exec(`
    DROP INDEX candidate_created;
    DROP INDEX candidate_source_created;
    CREATE INDEX candidate_created ON candidate_resumes(created_at DESC);
    CREATE INDEX candidate_source_created ON candidate_resumes(source, created_at DESC);
  `);
  first.sqliteStore.close();
  const reopened = new ResumeModel({ resumeStorageDir: libraryDir, storageEngine: 'sqlite' });
  t.after(() => { reopened.sqliteStore.close(); cleanup(); });
  assert.deepEqual(reopened.getResumesPage({ limit: 3, offset: 2 }).items.map(item => item.id),
    ['same-time-9', 'same-time-8', 'same-time-7']);
  for (const query of [
    'SELECT payload FROM candidate_resumes ORDER BY created_at DESC, rowid DESC LIMIT 3 OFFSET 2',
    `SELECT payload FROM candidate_resumes WHERE source = 'qcwy'
      ORDER BY created_at DESC, rowid DESC LIMIT 3 OFFSET 2`
  ]) {
    const plan = reopened.sqliteStore.db.prepare(`EXPLAIN QUERY PLAN ${query}`).all();
    assert.equal(plan.some(item => item.detail.includes('USE TEMP B-TREE')), false);
  }
  assert.equal(reopened.sqliteStore.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
});

test('1,000 synthetic resumes migrate, paginate and update without rewriting legacy JSON', t => {
  const resumes = Array.from({ length: 1000 }, (_, index) => ({
    id: `candidate-${index}`, source: index % 2 ? 'qcwy' : 'zlzp',
    sourceFingerprint: `synthetic-${index}`, createdAt: new Date(2026, 0, 1, 0, 0, index).toISOString(),
    name: `样例${index}`, originalText: '测试技能和经历 '.repeat(100)
  }));
  const { libraryDir, legacy, cleanup } = fixture(t, { resumes, positions: [], categories: [] });
  const before = fs.readFileSync(legacy);
  const started = performance.now();
  const model = new ResumeModel({ resumeStorageDir: libraryDir, storageEngine: 'sqlite' });
  const migratedMs = Math.round(performance.now() - started);
  assert.equal(model.getResumesPage({ limit: 100 }).total, 1000);
  assert.equal(model.getResumesPage({ source: 'qcwy', limit: 25, offset: 25 }).items.length, 25);
  const updateStart = performance.now();
  for (let index = 0; index < 50; index++) {
    model.updateCandidateMetadata(`candidate-${index}`, { matchScore: index,
      workflowStatus: 'viewed' });
  }
  const updateMs = Math.round(performance.now() - updateStart);
  assert.equal(model.getResumesPage({ status: 'viewed', limit: 100 }).total, 50);
  assert.deepEqual(fs.readFileSync(legacy), before);
  const reopened = new ResumeModel({ resumeStorageDir: libraryDir, storageEngine: 'sqlite' });
  t.after(() => { reopened.sqliteStore.close(); model.sqliteStore.close(); cleanup(); });
  assert.equal(reopened.getResumeById('candidate-49').matchScore, 49);
  console.log(`SQLite 1000 synthetic resumes: migration ${migratedMs} ms; 50 metadata updates ${updateMs} ms`);
});

test('recommendation and analytics stream a 6,000-record SQLite library without a full-library read', t => {
  const requirements = '岗位名称：IT网络运维\n网络故障排查和服务器维护';
  const history = '岗位名称：历史岗位\n其他工作要求';
  const resumes = Array.from({ length: 6000 }, (_, index) => ({
    id: `synthetic-boss-${index}`, source: 'boss', name: `样例${index}`,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    originalText: '工作经历：服务器与网络设备维护。'.repeat(10),
    matchScore: index < 50 ? 80 : 60,
    matchEvaluation: { jobRequirements: index < 50 ? requirements : history,
      method: 'llm', evaluationVersion: 1, evaluatedAt: '2026-01-01T01:00:00Z' }
  }));
  const { libraryDir, cleanup } = fixture(t, { resumes, positions: [], categories: [] });
  const model = new ResumeModel({ resumeStorageDir: libraryDir, storageEngine: 'sqlite' });
  t.after(() => { model.sqliteStore.close(); cleanup(); });
  model.getResumes = () => { throw new Error('aggregate loaded the full candidate library'); };
  const activeJobService = { current: () => ({ title: 'IT网络运维',
    jobRequirements: requirements, updatedAt: '2026-01-01T00:00:00Z',
    recommendationTargetCount: 100 }) };
  const recommendation = new ResumeRecommendationService({ store: model, activeJobService })
    .recommend({ source: 'boss', minScore: 70, limit: 20 });
  assert.equal(recommendation.evaluatedCount, 50);
  assert.equal(recommendation.qualifiedCount, 50);
  assert.equal(recommendation.recommendations.length, 20);
  const analytics = new RecruitmentAnalyticsService({ store: model, activeJobService });
  const current = analytics.snapshot({ scope: 'active', threshold: 70 });
  assert.equal(current.metrics.total, 50);
  assert.equal(current.metrics.passed, 50);
  const all = analytics.snapshot({ scope: 'all', threshold: 70 });
  assert.equal(all.metrics.total, 6000);
  assert.equal(all.metrics.passed, 50);
});

test('SQLite active-job iteration includes captured resumes awaiting AI evaluation', t => {
  const requirements = '岗位名称：项目经理主管\n项目管理经验五年以上';
  const { libraryDir, cleanup } = fixture(t, { resumes: [
    { id: 'pending', source: 'zlzp', captureJobRequirements: requirements,
      matchEvaluationStatus: 'pending', originalText: '完整简历正文' },
    { id: 'other', source: 'zlzp', captureJobRequirements: '其他岗位条件',
      originalText: '其他岗位简历' }
  ], positions: [], categories: [] });
  const model = new ResumeModel({ resumeStorageDir: libraryDir, storageEngine: 'sqlite' });
  t.after(() => { model.sqliteStore.close(); cleanup(); });
  const found = [];
  model.forEachResume(item => found.push(item.id), { jobRequirements: requirements });
  assert.deepEqual(found, ['pending']);
  const analytics = new RecruitmentAnalyticsService({ store: model,
    activeJobService: { current: () => ({ title: '项目经理主管', jobRequirements: requirements }) } });
  assert.equal(analytics.snapshot().metrics.unevaluated, 1);
});

test('SQLite resume iteration uses a read snapshot while another connection writes', t => {
  const requirements = 'IT网络运维：服务器和网络维护';
  const { libraryDir, cleanup } = fixture(t, { resumes: [
    { id: 'before-1', source: 'boss', createdAt: '2026-01-01T00:00:00Z',
      matchEvaluation: { jobRequirements: requirements } },
    { id: 'before-2', source: 'boss', createdAt: '2026-01-01T00:00:01Z',
      matchEvaluation: { jobRequirements: requirements } }
  ], positions: [], categories: [] });
  const reader = new ResumeModel({ resumeStorageDir: libraryDir, storageEngine: 'sqlite' });
  const writer = new ResumeModel({ resumeStorageDir: libraryDir, storageEngine: 'sqlite' });
  t.after(() => { writer.sqliteStore.close(); reader.sqliteStore.close(); cleanup(); });
  const seen = [];
  reader.forEachResume(item => {
    seen.push(item.id);
    if (seen.length === 1) writer.sqliteStore.putResume({ id: 'after', source: 'boss',
      createdAt: '2026-01-01T00:00:02Z',
      matchEvaluation: { jobRequirements: requirements } });
  }, { source: 'boss', jobRequirements: requirements });
  assert.deepEqual(seen, ['before-2', 'before-1']);
  assert.equal(reader.getResumesPage({ source: 'boss', limit: 10 }).total, 3);
});
