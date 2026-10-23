'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {extractBossOcrWorkExperience}=require('../src/services/bossOcrWorkExperience');
const {repairBossOcrWorkHistory}=require('../src/services/bossOcrWorkHistoryRepair');
const {BossRawRecommendCollector}=require('../src/services/bossRawRecommendCollector');

const history='工作经历 星海设备有限公司 | 销售工程师 2020.03 - 2023.08 '
  +'负责客户需求、项目协调和技术沟通。'.repeat(8)
  +'教育经历 某某大学 本科';

test('recovers only employer, role and date evidence from an OCR-joined work line',()=>{
  const rows=extractBossOcrWorkExperience(history);
  assert.equal(rows.length,1);
  assert.deepEqual(rows[0],{
    company:'星海设备有限公司',position:'销售工程师',
    duration:'2020.03 - 2023.08',description:'',
    verificationStatus:'ocr_needs_review'
  });
});

test('does not infer a work entry from a teaser or a date without an employer',()=>{
  assert.deepEqual(extractBossOcrWorkExperience('工作经历 2020.03 - 2023.08 销售工程师'),[]);
  assert.deepEqual(extractBossOcrWorkExperience(
    '工作经历 销售工程师 2020.03 - 2023.08 '+ '负责客户沟通。'.repeat(20)),[]);
});

test('stops before education and rejects reversed or implausible work dates',()=>{
  const text='工作经历 云舟制造有限公司 | 项目经理 2024.01 - 2021.01 '
    +'负责项目实施和部门协作。'.repeat(10)
    +'教育经历 星海大学 2018.09 - 2022.06';
  assert.deepEqual(extractBossOcrWorkExperience(text),[]);
});

test('backfill changes only completed BOSS OCR records with empty work history',async()=>{
  const items=[
    {id:'repair',parseMethod:'ocr',parseStatus:'completed',originalText:history},
    {id:'manual',parseMethod:'dom',parseStatus:'completed',originalText:history},
    {id:'existing',parseMethod:'ocr',parseStatus:'completed',originalText:history,
      workExperience:[{company:'已核实'}]}
  ];
  const updates=[];
  const store={
    getResumesPage:({source,offset})=>{
      assert.equal(source,'boss');
      return {items:offset?[]:items};
    },
    updateCandidateMetadata:(id,changes)=>updates.push({id,changes})
  };
  const result=await repairBossOcrWorkHistory({store,yieldTurn:async()=>{}});
  assert.deepEqual(result,{scanned:3,updated:1});
  assert.equal(updates[0].id,'repair');
  assert.equal(updates[0].changes.workExperience[0].verificationStatus,'ocr_needs_review');
});

test('the BOSS collector persists evidence-backed OCR history with the resume',async()=>{
  let saved;
  const collector=new BossRawRecommendCollector({
    store:{addResume:async record=>{saved=record;return {created:true,resume:{id:'one'}};}},
    queue:{enqueue:()=>{}}
  });
  await collector.saveResume({text:history,method:'ocr',
    url:new URL('https://www.zhipin.com/web/frame/c-resume/?uid=example')},
  {title:'销售工程师',jobRequirements:'有客户服务经历'});
  assert.equal(saved.source,'boss');
  assert.equal(saved.workExperience[0].company,'星海设备有限公司');
  assert.equal(saved.workExperience[0].verificationStatus,'ocr_needs_review');
});
