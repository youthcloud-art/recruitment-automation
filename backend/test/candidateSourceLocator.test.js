'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {bossCardProbe,bossDialogProbe,bossFingerprintProbe,cardFingerprint,searchScope,
  locateBossCandidate,locateBossCandidateByFingerprint,locateOfficialCandidate}=
  require('../src/services/candidateSourceLocator');

const boss={source:'boss',captureJobTitle:'磁轴销售工程师',
  sourceCandidateId:'247229183',sourceCandidateIdSource:'platform_card',
  sourceUrl:'https://www.zhipin.com/web/frame/c-resume/?source=search'};

test('BOSS DOM probe is valid JavaScript and compares exact platform IDs',()=>{
  const expression=bossCardProbe('247229183','磁轴销售工程师');
  new vm.Script(expression);
  new vm.Script(bossDialogProbe('247229183',true));
  new vm.Script(bossDialogProbe('247229183',false));
  const link=id=>({getAttribute:key=>key==='data-expect'?id:null});
  const card=id=>({querySelectorAll:()=>[link(id)]});
  const frame={contentDocument:{querySelector:selector=>selector==='input.search-input'
    ? {value:'磁轴销售工程师'} : null,
    querySelectorAll:()=>[card('247229183'),card('other')]},
    contentWindow:{location:{href:'https://www.zhipin.com/web/frame/search/'}}};
  const document={querySelector:selector=>selector.includes('iframe')?frame:null};
  const context={document,location:{href:'https://www.zhipin.com/web/chat/search'},URL};
  assert.equal(vm.runInNewContext(expression,context).state,'ready');
  frame.contentDocument.querySelectorAll=()=>[card('247229183'),card('247229183')];
  assert.equal(vm.runInNewContext(expression,context).state,'ambiguous');
});

test('BOSS locator clicks only a unique card on the matching job and verifies a dialog',async()=>{
  const calls=[];
  const session={assertRecruiterReady:async()=>
    'https://www.zhipin.com/web/chat/search',
  assertUsableRecruiterWindow:async()=>calls.push('window'),
  evaluate:async expression=>expression.includes('const id=')
    ? {state:'ready',search:true,frameSelector:'iframe[src*="/web/frame/search/"]',
      cardSelector:'li.geek-info-card',attribute:'data-expect'}
    : {state:'ready'},
  scrollUnique:async spec=>calls.push(['scroll',spec.selector]),
  clickUnique:async spec=>calls.push(['click',spec.selector])};
  const result=await locateBossCandidate(session,boss,{wait:async()=>{}});
  assert.equal(result.recordId,'247229183');
  assert.deepEqual(calls.map(item=>Array.isArray(item)?item[0]:item),
    ['window','scroll','click']);
  assert.match(calls[2][1],/data-expect="247229183"/);
});

test('BOSS locator refuses an absent card without clicking',async()=>{
  let clicked=false;
  const session={assertRecruiterReady:async()=>
    'https://www.zhipin.com/web/chat/search',
  assertUsableRecruiterWindow:async()=>{},evaluate:async()=>({state:'not_in_current_list'}),
  scrollUnique:async()=>{clicked=true;},clickUnique:async()=>{clicked=true;}};
  await assert.rejects(locateBossCandidate(session,boss),/不在 BOSS 当前已加载/);
  assert.equal(clicked,false);
});

test('旧 BOSS 简历只按唯一候选卡证据补录官方编号',async()=>{
  new vm.Script(bossFingerprintProbe('磁轴销售工程师'));
  const title='磁轴销售工程师';
  const card='王先生 5年经验 磁轴销售工程师';
  const fingerprint=cardFingerprint(searchScope(title),card);
  const legacy={source:'boss',captureJobTitle:title,sourceCardFingerprint:fingerprint};
  const calls=[];
  const session={assertRecruiterReady:async()=> 'https://www.zhipin.com/web/chat/search',
    assertUsableRecruiterWindow:async()=>{},
    evaluate:async expression=>expression.includes('cards:cards.map')
      ? {state:'ready',search:true,cards:[{text:card,id:'247229183'}]}
      : expression.includes('const id=')
        ? {state:'ready',search:true,frameSelector:'iframe[src*="/web/frame/search/"]',
          cardSelector:'li.geek-info-card',attribute:'data-expect'} : {state:'ready'},
    scrollUnique:async()=>calls.push('scroll'),clickUnique:async()=>calls.push('click')};
  const result=await locateBossCandidateByFingerprint(session,legacy,{wait:async()=>{}});
  assert.deepEqual([result.recordId,result.recovered,calls],['247229183',true,['scroll','click']]);
  session.evaluate=async expression=>expression.includes('cards:cards.map')
    ? {state:'ready',search:true,cards:[{text:card,id:'247229183'},
      {text:card,id:'other'}]} : {state:'ready'};
  await assert.rejects(locateBossCandidateByFingerprint(session,legacy),/证据重复/);
  assert.equal(calls.length,2);
  await assert.rejects(locateBossCandidateByFingerprint(session,
    {...legacy,sourceCardFingerprint:''}),/缺少可用于安全补录/);
});

test('智联官方简历 URL 须导航到同一个简历号并显示详情',async()=>{
  const url='https://rd6.zhaopin.com/app/search?resumeNumber=ZL_2026-abc123';
  const candidate={source:'zlzp',sourceUrl:url,sourceCandidateId:'ZL_2026-abc123'};
  let current='';
  const page={goto:async next=>{current=next;},url:()=>current,
    locator:()=>({first:()=>({isVisible:async()=>true})})};
  assert.equal((await locateOfficialCandidate(page,candidate)).verified,'official_url');
  page.goto=async()=>{current='https://rd6.zhaopin.com/app/search?resumeNumber=other';};
  await assert.rejects(locateOfficialCandidate(page,candidate),/不是目标简历/);
});
