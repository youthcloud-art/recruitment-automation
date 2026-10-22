const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ResumeModel } = require('../src/models/resumeModel');
const { bossNameKey, textSimilarity, careerDates,
  sameBossNearDuplicate, chooseBossNearDuplicate } = require('../src/utils/bossResumeIdentity');

function fullResume({ dates = ['2017.03','2019.08','2020.02','2024.09'],
  marker = '制造企业成本核算' } = {}) {
  const jobs = dates.map((date,index) =>
    `${date} 负责第${index}阶段的产品成本结算和月度差异分析。`).join('\n');
  const details = Array.from({length:115},(_,index) =>
    `第${index}项${marker}经历：整理第${index}类生产订单、分析材料和人工费用差异并核验财务凭证。`).join('\n');
  return `姓名：李明华\n工作经历\n${jobs}\n${details}\n教育经历\n本科 财务管理专业\n专业技能\nERP 成本结转。`;
}

function candidate(text, overrides = {}) {
  return {source:'boss',name:'李明华',education:'本科',originalText:text,
    parseStatus:'completed',sourceFingerprint:'unique',...overrides};
}

test('near duplicate needs long text, trusted full name and two independent anchors', () => {
  const text = fullResume();
  const changed = text.replace('第23类生产订单','第23类生産订单')
    .replace('第61类生产订单','第61类生产定单');
  const a = candidate(text);
  const b = candidate(changed,{sourceFingerprint:'new-ocr'});
  assert.equal(careerDates(text).size,4);
  const similarity = textSimilarity(text,changed);
  assert.ok(similarity.jaccard > 0.92);
  assert.ok(similarity.containment > 0.96);
  assert.equal(sameBossNearDuplicate(a,b),true);
  assert.equal(sameBossNearDuplicate(a,{...b,education:null}),false,
    '工作年月仅算一个领域，学历缺失不能合并');
  assert.equal(sameBossNearDuplicate({...a,name:'李先生'},
    {...b,name:'李先生'}),false);
  assert.equal(sameBossNearDuplicate({...a,name:'李'},
    {...b,name:'李'}),false,'单姓 OCR 不是可靠身份');
  assert.equal(bossNameKey('李先生'),'');
  assert.equal(bossNameKey('候选人'),'');
});

test('spaced Canvas OCR with roughly 2,750 meaningful characters can be compared', () => {
  let source = '工作经历2017.03 2019.08 2020.02 2024.09 教育经历本科';
  let index = 0;
  while (source.length < 2740) source += `第${index++}项成本核算职责与差异分析`;
  const spaced = [...source].join(' ');
  const changed = spaced.replace('第 1 项','第 一 项');
  assert.ok(spaced.length > 4500);
  assert.ok(textSimilarity(spaced,changed).jaccard >= 0.92);
  assert.equal(sameBossNearDuplicate(candidate(spaced),
    candidate(changed,{sourceFingerprint:'other'})),true);
});

test('highly similar templates with conflicting work evidence or IDs remain separate', () => {
  const original = fullResume();
  const differentDates = fullResume({dates:['2016.04','2018.06','2021.07','2023.12']});
  const a = candidate(original);
  const b = candidate(differentDates,{sourceFingerprint:'new-ocr'});
  assert.ok(textSimilarity(original,differentDates).jaccard > 0.92);
  assert.equal(sameBossNearDuplicate(a,b),false,
    '相同姓名、学历和大段模板文字仍须匹配多段职业年月');
  assert.equal(sameBossNearDuplicate(a,{...a,sourceCandidateId:'different'}),true,
    '只有一侧有官方 ID 并非冲突');
  assert.equal(sameBossNearDuplicate({...a,sourceCandidateId:'expect-a'},
    {...a,sourceCandidateId:'expect-b'}),false);
  assert.equal(sameBossNearDuplicate({...a,phone:'13800000000'},
    {...a,phone:'13900000000'}),false);
  assert.equal(sameBossNearDuplicate(a,{...a,originalText:'工作经历 教育经历'}),false);
});

test('multiple historical near matches choose a canonical record only when pairwise consistent', () => {
  const text = fullResume();
  const old = candidate(text,{id:'old',createdAt:'2026-01-01T00:00:00.000Z'});
  const newer = candidate(text.replace('第61类生产订单','第61类生産订单'),
    {id:'newer',createdAt:'2026-01-02T00:00:00.000Z'});
  assert.equal(chooseBossNearDuplicate([newer,old]).id,'old');
  assert.equal(chooseBossNearDuplicate([null].filter(Boolean)),null);
  assert.equal(chooseBossNearDuplicate([
    {...old,sourceCandidateId:'expect-a'},
    {...newer,sourceCandidateId:'expect-b'}
  ]),null,'官方 ID 不同的记录不能归为同一人');
});

test('SQLite and JSON merge only proven BOSS OCR near duplicates, using name index', async t => {
  for (const storageEngine of ['sqlite','json']) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(),`boss-ocr-${storageEngine}-`));
    fs.writeFileSync(path.join(directory,'resumes.json'),JSON.stringify({
      resumes:[],positions:[],categories:[]
    }));
    const model = new ResumeModel({resumeStorageDir:directory,storageEngine});
    t.after(() => { model.sqliteStore?.close(); fs.rmSync(directory,{recursive:true,force:true}); });
    const text = fullResume();
    const first = await model.addResume(candidate(text,{sourceFingerprint:'ocr-a'}),
      {returnStatus:true});
    assert.equal(first.resume.position,'',
      'BOSS 未提供岗位时不能把候选人姓名写成职位');
    const near = await model.addResume(candidate(text.replace('第61类生产订单','第61类生産订单'),
      {sourceFingerprint:'ocr-b'}),{returnStatus:true});
    assert.equal(first.created,true);
    assert.equal(near.created,false);
    assert.equal(near.resume.id,first.resume.id);
    const otherPerson = await model.addResume(candidate(fullResume({
      dates:['2016.04','2018.06','2021.07','2023.12']}),
    {sourceFingerprint:'ocr-c'}),{returnStatus:true});
    assert.equal(otherPerson.created,true);
    assert.equal(model.getResumesPage({source:'boss'}).total,2);
    if (storageEngine === 'sqlite') {
      const plan = model.sqliteStore.db.prepare(`EXPLAIN QUERY PLAN SELECT payload
        FROM candidate_resumes WHERE source = 'boss' AND boss_name_key = ? LIMIT 501`)
        .all(bossNameKey('李明华')).map(row => row.detail).join(' ');
      assert.match(plan,/candidate_boss_name/);
    }
  }
});

test('pre-name-index SQLite BOSS records backfill a hashed name without modifying payload', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'boss-name-migration-'));
  fs.writeFileSync(path.join(directory,'resumes.json'),JSON.stringify({
    resumes:[],positions:[],categories:[]
  }));
  t.after(() => fs.rmSync(directory,{recursive:true,force:true}));
  const initial = new ResumeModel({resumeStorageDir:directory,storageEngine:'sqlite'});
  initial.sqliteStore.putResume({id:'legacy-boss',...candidate(fullResume())});
  initial.sqliteStore.db.exec(`DROP INDEX candidate_boss_name;
    ALTER TABLE candidate_resumes DROP COLUMN boss_name_key;
    DELETE FROM library_metadata WHERE key = 'boss_name_key_backfilled';`);
  initial.sqliteStore.close();
  const restored = new ResumeModel({resumeStorageDir:directory,storageEngine:'sqlite'});
  try {
    assert.equal(restored.sqliteStore.db.prepare(`SELECT boss_name_key AS key
      FROM candidate_resumes WHERE id = 'legacy-boss'`).get().key,bossNameKey('李明华'));
    assert.equal(restored.getResumeById('legacy-boss').name,'李明华');
  } finally { restored.sqliteStore.close(); }
});

test('JSON BOSS ID conflict wins over identical OCR fingerprint', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'boss-json-id-conflict-'));
  fs.writeFileSync(path.join(directory,'resumes.json'),JSON.stringify({
    resumes:[],positions:[],categories:[]
  }));
  t.after(() => fs.rmSync(directory,{recursive:true,force:true}));
  const model = new ResumeModel({resumeStorageDir:directory,storageEngine:'json'});
  const first = await model.addResume(candidate(fullResume(),{
    sourceCandidateId:'expect-a',sourceFingerprint:'same-ocr'
  }),{returnStatus:true});
  const second = await model.addResume(candidate(fullResume(),{
    sourceCandidateId:'expect-b',sourceFingerprint:'same-ocr'
  }),{returnStatus:true});
  assert.equal(first.created,true);
  assert.equal(second.created,true);
  assert.equal(model.getResumesPage({source:'boss'}).total,2);
});
