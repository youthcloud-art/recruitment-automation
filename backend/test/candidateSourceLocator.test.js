'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {bossCardProbe,bossDialogProbe,bossJobProbe,bossFingerprintProbe,cardFingerprint,searchScope,
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

test('BOSS locator selects only the exact posted job before matching a card',async()=>{
  new vm.Script(bossJobProbe('磁轴销售工程师'));
  const calls=[];
  let selected=false;
  const session={
    assertRecruiterReady:async()=> 'https://www.zhipin.com/web/chat/recommend',
    assertUsableRecruiterWindow:async()=>{},
    evaluate:async expression=>{
      if (expression.includes('const title=')) return {state:'ready',
        selected:selected?'磁轴销售工程师':'财务总监',jobId:selected?'posted-123':'other',
        options:[{label:'磁轴销售工程师',value:'posted-123'}]};
      if (expression.includes('const id=')) return {state:selected?'ready':'wrong_job',
        search:false,frameSelector:'iframe[src*="/web/frame/recommend/"]',
        cardSelector:'li.card-item',attribute:'data-expect'};
      return {state:'ready'};
    },
    scrollUnique:async spec=>calls.push(['scroll',spec.selector]),
    clickUnique:async spec=>{
      calls.push(['click',spec.selector]);
      if (spec.selector.includes('li.job-item')) selected=true;
    }
  };
  const result=await locateBossCandidate(session,boss,{wait:async()=>{}});
  assert.equal(result.verified,'exact_card');
  assert.deepEqual(calls.map(([action,selector])=>`${action}:${selector}`),[
    'click:.ui-dropmenu-label',
    'scroll:.job-selecter-options li.job-item[value="posted-123"]',
    'click:.job-selecter-options li.job-item[value="posted-123"]',
    'scroll:li.card-item:has(> a[ka="search_click_open_resume"][data-expect="247229183"])',
    'click:li.card-item:has(> a[ka="search_click_open_resume"][data-expect="247229183"])'
  ]);
});

test('BOSS locator refuses ambiguous posted jobs without clicking',async()=>{
  let clicked=false;
  const session={
    assertRecruiterReady:async()=> 'https://www.zhipin.com/web/chat/recommend',
    assertUsableRecruiterWindow:async()=>{},
    evaluate:async expression=>expression.includes('const title=')
      ? {state:'ready',selected:'财务总监',jobId:'other',options:[
        {label:'磁轴销售工程师',value:'posted-1'},
        {label:'磁轴销售工程师',value:'posted-2'}]}
      : {state:'wrong_job'},
    scrollUnique:async()=>{clicked=true;},clickUnique:async()=>{clicked=true;}
  };
  await assert.rejects(locateBossCandidate(session,boss),/多个同名/);
  assert.equal(clicked,false);
});

test('BOSS absent posted job explains the actual selected and available jobs',async()=>{
  const session={
    assertRecruiterReady:async()=> 'https://www.zhipin.com/web/chat/recommend',
    assertUsableRecruiterWindow:async()=>{},
    evaluate:async expression=>expression.includes('const title=')
      ? {state:'ready',selected:'财务总监',jobId:'other',options:[],
        availableTitles:['财务总监','项目经理'],availableCount:2}
      : {state:'wrong_job'},
    clickUnique:async()=>{},
  };
  await assert.rejects(locateBossCandidate(session,boss,{wait:async()=>{}}),
    /当前选中：财务总监；可见岗位：财务总监、项目经理/);
});

test('BOSS locator reads lazily mounted job options after opening dropdown',async()=>{
  let opened=false,selected=false;
  const calls=[];
  const session={
    assertRecruiterReady:async()=> 'https://www.zhipin.com/web/chat/recommend',
    assertUsableRecruiterWindow:async()=>{},
    evaluate:async expression=>{
      if (expression.includes('const title=')) return {state:'ready',
        selected:selected?'磁轴销售工程师':'财务总监',
        jobId:selected?'posted-123':'other',
        options:opened?[{label:'磁轴销售工程师',value:'posted-123'}]:[]};
      if (expression.includes('const id=')) return {state:selected?'ready':'wrong_job',
        search:false,frameSelector:'iframe[src*="/web/frame/recommend/"]',
        cardSelector:'li.card-item',attribute:'data-expect'};
      return {state:'ready'};
    },
    scrollUnique:async spec=>calls.push(['scroll',spec.selector]),
    clickUnique:async spec=>{
      calls.push(['click',spec.selector]);
      if (spec.selector==='.ui-dropmenu-label') opened=true;
      if (spec.selector.includes('li.job-item')) selected=true;
    }
  };
  assert.equal((await locateBossCandidate(session,boss,{wait:async()=>{}})).verified,'exact_card');
  assert.equal(calls.filter(([action,selector])=>action==='click' &&
    selector==='.ui-dropmenu-label').length,1);
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

test('旧 BOSS 简历补录先切换到唯一匹配的原招聘岗位',async()=>{
  const card='王先生 5年经验 磁轴销售工程师';
  const legacy={source:'boss',captureJobTitle:'磁轴销售工程师',
    sourceCardFingerprint:cardFingerprint('posted-123',card)};
  let selected=false;
  const calls=[];
  const session={
    assertRecruiterReady:async()=> 'https://www.zhipin.com/web/chat/recommend',
    assertUsableRecruiterWindow:async()=>{},
    evaluate:async expression=>{
      if (expression.includes('cards:cards.map')) return selected
        ? {state:'ready',search:false,jobId:'posted-123',
          cards:[{text:card,id:'247229183'}]}
        : {state:'wrong_job'};
      if (expression.includes('const title=')) return {state:'ready',
        selected:selected?'磁轴销售工程师':'财务总监',
        jobId:selected?'posted-123':'other',
        options:[{label:'磁轴销售工程师',value:'posted-123'}]};
      if (expression.includes('const id=')) return {state:selected?'ready':'wrong_job',
        search:false,frameSelector:'iframe[src*="/web/frame/recommend/"]',
        cardSelector:'li.card-item',attribute:'data-expect'};
      return {state:'ready'};
    },
    scrollUnique:async spec=>calls.push(['scroll',spec.selector]),
    clickUnique:async spec=>{
      calls.push(['click',spec.selector]);
      if (spec.selector.includes('li.job-item')) selected=true;
    }
  };
  const result=await locateBossCandidateByFingerprint(session,legacy,
    {wait:async()=>{}});
  assert.equal(result.recordId,'247229183');
  assert.equal(result.recovered,true);
  assert.equal(calls.filter(([action])=>action==='click').length,3);
});

test('智联当前官方简历号与可见详情一致时直接核实',async()=>{
  const url='https://rd6.zhaopin.com/app/search?resumeNumber=ZL_2026-abc123';
  const candidate={source:'zlzp',sourceUrl:url,sourceCandidateId:'ZL_2026-abc123'};
  let current=url;
  const page={goto:async()=>{throw new Error('must not navigate');},url:()=>current,
    locator:selector=>selector.startsWith('div.search-resume-item')
      ? {evaluateAll:async()=>[]} : {first:()=>({waitFor:async()=>{}})}};
  assert.equal((await locateOfficialCandidate(page,candidate)).verified,'official_detail');
  current='https://rd6.zhaopin.com/app/search?resumeNumber=other';
  await assert.rejects(locateOfficialCandidate(page,candidate),/当前打开的是另一份简历/);
});

test('智联仅打开带简历号的搜索地址不能冒充已核实详情或重置搜索页',async()=>{
  const url='https://rd6.zhaopin.com/app/search?resumeNumber=ZL_2026-abc123';
  const candidate={source:'zlzp',sourceUrl:url,sourceCandidateId:'ZL_2026-abc123'};
  const page={goto:async()=>{throw new Error('must not navigate');},url:()=>url,
    locator:selector=>selector.startsWith('div.search-resume-item')
      ? {evaluateAll:async()=>[]} : {first:()=>({waitFor:async()=>{throw new Error('timeout');}})}};
  await assert.rejects(locateOfficialCandidate(page,candidate),/不在当前已加载/);
});

test('智联只点击官方列表中编号完全一致的唯一候选卡',async()=>{
  const url='https://rd6.zhaopin.com/app/search?resumeNumber=ZL_2026-abc123';
  const candidate={source:'zlzp',sourceUrl:url,sourceCandidateId:'ZL_2026-abc123'};
  let opened=false, navigated=false;
  const page={
    url:()=>opened?url:'https://rd6.zhaopin.com/app/search',
    goto:async()=>{navigated=true;},
    locator:selector=>selector.startsWith('div.search-resume-item')
      ? {evaluateAll:async()=>[2],nth:index=>{
        assert.equal(index,2);
        return {click:async()=>{opened=true;}};
      }} : {first:()=>({waitFor:async()=>{if(!opened) throw new Error('not open');}})}
  };
  const result=await locateOfficialCandidate(page,candidate);
  assert.equal(result.verified,'exact_card');
  assert.equal(navigated,false);
});

test('智联卡片不显示编号时按唯一姓名与两段公司经历定位，详情编号必须一致',async()=>{
  const id='XevrLIqHU6t4wDMqb6)yt9PUL0fFDpih';
  const url=`https://rd6.zhaopin.com/app/search?resumeNumber=${encodeURIComponent(id)}`;
  const candidate={source:'zlzp',name:'涂先生',sourceUrl:url,sourceCandidateId:id,
    workExperience:[{company:'上海帝森克罗德电力技术有限公司'},
      {company:'深圳市泰永电气科技有限公司'}]};
  let opened=false,escaped=false;
  const cards=[{textContent:'涂先生 帝森克罗德电力技术 泰永电气科技 销售工程师'},
    {textContent:'涂先生 其他企业 销售工程师'}];
  const page={
    url:()=>opened?url:'https://rd6.zhaopin.com/app/search',
    goto:async()=>{throw new Error('must not navigate');},
    keyboard:{press:async()=>{escaped=true;}},
    locator:selector=>selector.startsWith('div.search-resume-item')
      ? {evaluateAll:async(fn,arg)=>typeof arg==='string'?[]:fn(cards,arg),
        nth:index=>({click:async()=>{assert.equal(index,0);opened=true;}})}
      : {first:()=>({waitFor:async()=>{if(!opened)throw new Error('not open');}})}
  };
  assert.equal((await locateOfficialCandidate(page,candidate)).verified,'exact_card');
  assert.equal(escaped,false);
});

test('智联经历证据相似但详情编号不同则关闭弹窗并拒绝定位',async()=>{
  const candidate={source:'zlzp',name:'涂先生',sourceCandidateId:'target-id',
    sourceUrl:'https://rd6.zhaopin.com/app/search?resumeNumber=target-id',
    workExperience:[{company:'上海帝森克罗德电力技术有限公司'},
      {company:'深圳市泰永电气科技有限公司'}]};
  let opened=false,escaped=false;
  const cards=[{textContent:'涂先生 帝森克罗德电力技术 泰永电气科技'}];
  const page={url:()=>opened?'https://rd6.zhaopin.com/app/search?resumeNumber=other-id':
    'https://rd6.zhaopin.com/app/search',
    keyboard:{press:async key=>{assert.equal(key,'Escape');escaped=true;}},
    locator:selector=>selector.startsWith('div.search-resume-item')
      ? {evaluateAll:async(fn,arg)=>typeof arg==='string'?[]:fn(cards,arg),
        nth:()=>({click:async()=>{opened=true;}})}
      : {first:()=>({waitFor:async()=>{if(!opened)throw new Error('not open');}})}
  };
  await assert.rejects(locateOfficialCandidate(page,candidate),/未能核实对应编号/);
  assert.equal(escaped,true);
});

test('智联相似经历匹配多张卡片时不点击任何人',async()=>{
  const candidate={source:'zlzp',name:'涂先生',sourceCandidateId:'target-id',
    sourceUrl:'https://rd6.zhaopin.com/app/search?resumeNumber=target-id',
    workExperience:[{company:'上海帝森克罗德电力技术有限公司'},
      {company:'深圳市泰永电气科技有限公司'}]};
  let clicked=false;
  const cards=Array(2).fill({textContent:'涂先生 帝森克罗德电力技术 泰永电气科技'});
  const page={url:()=> 'https://rd6.zhaopin.com/app/search',
    locator:selector=>selector.startsWith('div.search-resume-item')
      ? {evaluateAll:async(fn,arg)=>typeof arg==='string'?[]:fn(cards,arg),
        nth:()=>({click:async()=>{clicked=true;}})}
      : {first:()=>({waitFor:async()=>{throw new Error('not open');}})}
  };
  await assert.rejects(locateOfficialCandidate(page,candidate),/多个经历相似/);
  assert.equal(clicked,false);
});
