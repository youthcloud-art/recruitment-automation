'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {bossCardProbe,bossDialogProbe,bossJobProbe,bossFingerprintProbe,cardFingerprint,searchScope,
  locateBossCandidate,locateBossCandidateByFingerprint,locateOfficialCandidate}=
  require('../src/services/candidateSourceLocator');
const {scanBossSearchForCandidate}=require('../src/services/candidateSourceLocator');

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

test('BOSS official resume dialog must expose the same complete platform ID',()=>{
  const iframe={src:'https://www.zhipin.com/web/frame/c-resume/'};
  const dialog={querySelectorAll:()=>[iframe]};
  const document={querySelectorAll:()=>[dialog]};
  const expression=bossDialogProbe('247229183',true);
  assert.equal(vm.runInNewContext(expression,{document,URL}).state,'detail_unavailable');
  iframe.contentDocument={body:{innerText:'完整的官方候选人简历正文'.repeat(10)},
    querySelector:()=>null};
  assert.equal(vm.runInNewContext(expression,{document,URL}).state,'ready_card_only');
  iframe.src+='?expectId=other';
  assert.equal(vm.runInNewContext(expression,{document,URL}).state,'identity_conflict');
  iframe.src='https://www.zhipin.com/web/frame/c-resume/?expectId=247229183';
  assert.equal(vm.runInNewContext(expression,{document,URL}).state,'ready');
});

test('BOSS detail without URL ID requires the same official card and job after opening',async()=>{
  let cardReads=0;
  const session={assertRecruiterReady:async()=>
    'https://www.zhipin.com/web/chat/search',
  assertUsableRecruiterWindow:async()=>{},
  evaluate:async expression=>expression.includes('const id=')
    ? (cardReads++,{state:'ready',search:true,
      frameSelector:'iframe[src*="/web/frame/search/"]',
      cardSelector:'li.geek-info-card',attribute:'data-expect'})
    : {state:'ready_card_only'},
  scrollUnique:async()=>{},clickUnique:async()=>{}};
  const result=await locateBossCandidate(session,boss,{wait:async()=>{}});
  assert.equal(result.verified,'exact_card');
  assert.equal(cardReads,3);
});

test('BOSS locator closes an existing official search resume before exact lookup',async()=>{
  let open=true;
  const actions=[];
  const session={assertRecruiterReady:async()=>
    'https://www.zhipin.com/web/chat/search',
  assertUsableRecruiterWindow:async()=>{},
  evaluate:async expression=>expression.includes('const id=')
    ? {state:open?'dialog_open':'ready',search:true,
      frameSelector:'iframe[src*="/web/frame/search/"]',
      cardSelector:'li.geek-info-card',attribute:'data-expect'}
    : {state:'ready'},
  scrollUnique:async()=>actions.push('scroll'),
  clickUnique:async spec=>{
    actions.push(spec.selector);
    if(spec.selector.includes('.close-btn')) open=false;
  }};
  const result=await locateBossCandidate(session,boss,{wait:async()=>{}});
  assert.equal(result.verified,'exact_card');
  assert.equal(actions.length,3);
  assert.match(actions[0],/boss-dialog.*close-btn/);
  assert.match(actions[2],/247229183/);
});

test('BOSS locator never opens a candidate when existing dialog cannot be closed',async()=>{
  let clicks=0;
  const session={assertRecruiterReady:async()=>
    'https://www.zhipin.com/web/chat/search',
  assertUsableRecruiterWindow:async()=>{},
  evaluate:async()=>({state:'dialog_open'}),
  clickUnique:async()=>{clicks++;throw new Error('official close unavailable');}};
  await assert.rejects(locateBossCandidate(session,boss),/official close unavailable/);
  assert.equal(clicks,1);
});

test('BOSS locator reloads the same official search once when its resume dialog stays active',async()=>{
  let open=true,reloads=0,escapes=0;
  const session={assertRecruiterReady:async()=>
    'https://www.zhipin.com/web/chat/search',
  assertUsableRecruiterWindow:async()=>{},
  evaluate:async expression=>expression.includes('const id=')
    ? {state:open?'dialog_open':'ready',search:true,
      frameSelector:'iframe[src*="/web/frame/search/"]',
      cardSelector:'li.geek-info-card',attribute:'data-expect'}
    : {state:'ready'},
  clickUnique:async()=>{},scrollUnique:async()=>{},
  send:async method=>{
    if(method==='Input.dispatchKeyEvent') escapes++;
    if(method==='Page.reload'){reloads++;open=false;}
  }};
  const result=await locateBossCandidate(session,boss,{wait:async()=>{}});
  assert.equal(result.verified,'exact_card');
  assert.equal(escapes,2);
  assert.equal(reloads,1);
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
  assert.equal(calls[1][1],
    'li.geek-info-card > a[ka="search_click_open_resume"][data-expect="247229183"]');
  assert.equal(calls[2][1],calls[1][1]);
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

test('BOSS absent posted job falls back to official search and verifies the exact card',async()=>{
  let search=false,prepared=0,clicked=0;
  const session={
    assertRecruiterReady:async()=>search?'https://www.zhipin.com/web/chat/search':
      'https://www.zhipin.com/web/chat/recommend',
    assertUsableRecruiterWindow:async()=>{},
    evaluate:async expression=>{
      if(expression.includes('const title=')) return {state:'ready',selected:'财务总监',
        jobId:'other',options:[],availableTitles:['财务总监'],availableCount:1};
      if(expression.includes('const id=')) return search
        ? {state:'ready',search:true,frameSelector:'iframe[src*="/web/frame/search/"]',
          cardSelector:'li.geek-info-card',attribute:'data-expect'}
        : {state:'wrong_job'};
      return {state:'ready'};
    },
    scrollUnique:async()=>{},
    clickUnique:async spec=>{if(spec.selector.includes('li.geek-info-card')) clicked++;}
  };
  const result=await locateBossCandidate(session,boss,{wait:async()=>{},
    prepareSearch:async(_session,title)=>{assert.equal(title,'磁轴销售工程师');
      prepared++; search=true;}});
  assert.equal(result.recordId,'247229183');
  assert.equal(prepared,1);
  assert.equal(clicked,1);
});

test('BOSS locator submits the saved job when already on another official search',async()=>{
  let prepared=0,clicked=0;
  const session={
    assertRecruiterReady:async()=> 'https://www.zhipin.com/web/chat/search',
    assertUsableRecruiterWindow:async()=>{},
    evaluate:async expression=>expression.includes('const id=')
      ? prepared
        ? {state:'ready',search:true,frameSelector:'iframe[src*="/web/frame/search/"]',
          cardSelector:'li.geek-info-card',attribute:'data-expect'}
        : {state:'wrong_job'}
      : {state:'ready'},
    scrollUnique:async()=>{},
    clickUnique:async()=>{clicked++;}
  };
  const result=await locateBossCandidate(session,boss,{wait:async()=>{},
    prepareSearch:async(_session,title)=>{
      assert.equal(title,'磁轴销售工程师'); prepared++;
    }});
  assert.equal(result.recordId,'247229183');
  assert.equal(prepared,1);
  assert.equal(clicked,1);
});

test('BOSS fallback uses the existing official page to submit a checked job search',async()=>{
  let url='https://www.zhipin.com/web/chat/recommend';
  let keyword='',submitted=false,clickedCard=false;
  const session={
    assertRecruiterReady:async()=>url,
    assertUsableRecruiterWindow:async()=>{},
    evaluate:async expression=>{
      if(expression.includes('const id=')) return url.endsWith('/search') && submitted
        ? {state:'ready',search:true,frameSelector:'iframe[src*="/web/frame/search/"]',
          cardSelector:'li.geek-info-card',attribute:'data-expect'}
        : {state:'wrong_job'};
      if(expression.includes('const title=')) return {state:'ready',selected:'财务总监',
        jobId:'other',options:[],availableTitles:['财务总监']};
      if(expression.includes('bossRaw:page')) return {url,frameReady:true,
        iframeLiveUrl:'https://www.zhipin.com/web/frame/search/',
        iframeSrc:'https://www.zhipin.com/web/frame/search/'};
      if(expression.includes('bossRaw:searchState')) return {state:'ready',
        selectedFiltersReady:true,nonDefaultSelected:0,checkedCount:0,
        activeCustomSliderCount:0,value:keyword,frameOrigin:1,
        matchingSearchRequests:submitted?1:0,cardCount:submitted?1:0,
        safeCardCount:submitted?1:0};
      if(expression.includes('bossRaw:searchModal')) return {active:false};
      if(expression.includes('const frame=document.querySelector(')) return true;
      return {state:'ready'};
    },
    clickUnique:async spec=>{
      if(spec.selector==='a[ka="menu-geek-search"]') url='https://www.zhipin.com/web/chat/search';
      if(spec.selector==='.search-input-wrap .icon-search') submitted=true;
      if(spec.selector.includes('li.geek-info-card')) clickedCard=true;
    },
    send:async(method,payload)=>{if(method==='Input.insertText') keyword=payload.text;},
    scrollUnique:async()=>{}
  };
  const result=await locateBossCandidate(session,boss,{wait:async()=>{}});
  assert.equal(result.recordId,'247229183');
  assert.equal(keyword,'磁轴销售工程师');
  assert.equal(submitted,true);
  assert.equal(clickedCard,true);
});

test('BOSS absent posted job explains the actual selected and available jobs if official search fails',async()=>{
  const session={
    assertRecruiterReady:async()=> 'https://www.zhipin.com/web/chat/recommend',
    assertUsableRecruiterWindow:async()=>{},
    evaluate:async expression=>expression.includes('const title=')
      ? {state:'ready',selected:'财务总监',jobId:'other',options:[],
        availableTitles:['财务总监','项目经理'],availableCount:2}
      : {state:'wrong_job'},
    clickUnique:async()=>{},
  };
  await assert.rejects(locateBossCandidate(session,boss,{wait:async()=>{},
    prepareSearch:async()=>{throw new Error('当前选中：财务总监；可见岗位：财务总监、项目经理');}}),
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
  await assert.rejects(locateBossCandidate(session,boss,{scanSearch:async()=>
    ({state:'not_in_current_list'})}),/不在 BOSS 当前已加载/);
  assert.equal(clicked,false);
});

test('BOSS locator loads only guarded official search pages until exact ID appears',async()=>{
  let loaded=0,selected=0;
  const collector={selectJob:async title=>{assert.equal(title,'磁轴销售工程师');selected++;},
    scrollCards:async()=>{loaded++;}};
  const session={evaluate:async()=>({state:loaded>=2?'ready':'not_in_current_list',
    cardCount:15*(loaded+1)})};
  const found=await scanBossSearchForCandidate(session,'磁轴销售工程师',
    '247229183',async()=>{},{createCollector:()=>collector});
  assert.equal(found.state,'ready');
  assert.equal(selected,1);
  assert.equal(loaded,2);
  assert.equal(collector.session,session);
});

test('BOSS locator stops scanning when official result count no longer grows',async()=>{
  let loaded=0;
  const collector={selectJob:async()=>{},scrollCards:async()=>{loaded++;}};
  const session={evaluate:async()=>({state:'not_in_current_list',cardCount:15})};
  const found=await scanBossSearchForCandidate(session,'磁轴销售工程师',
    '247229183',async()=>{},{createCollector:()=>collector});
  assert.equal(found.state,'not_in_current_list');
  assert.equal(loaded,1);
});

test('BOSS locator waits for cards that arrive after an official scroll',async()=>{
  let loaded=0,settled=false,waits=0;
  const collector={selectJob:async()=>{},scrollCards:async()=>{loaded++;}};
  const session={evaluate:async()=>({state:loaded && settled?'ready':'not_in_current_list',
    cardCount:loaded && settled?30:15})};
  const found=await scanBossSearchForCandidate(session,'磁轴销售工程师',
    '247229183',async()=>{settled=true;waits++;},
    {createCollector:()=>collector});
  assert.equal(found.state,'ready');
  assert.equal(loaded,1);
  assert.equal(waits,1);
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
    locator:selector=>selector==='.new-shortcut-resume__modal'
      ? {first:()=>({isVisible:async()=>false})}
      : selector.startsWith('div.search-resume-item')
      ? {evaluateAll:async()=>[]} : {first:()=>({waitFor:async()=>{}})}};
  assert.equal((await locateOfficialCandidate(page,candidate)).verified,'official_detail');
  current='https://rd6.zhaopin.com/app/search?resumeNumber=other';
  await assert.rejects(locateOfficialCandidate(page,candidate),/详情弹窗无法确认/);
});

test('智联回查下一人前关闭并确认上一份官方详情',async()=>{
  const id='XevrLIqHU6t4wDMqb6)yt9PUL0fFDpih';
  const candidate={source:'zlzp',sourceCandidateId:id,
    sourceUrl:`https://rd6.zhaopin.com/app/search?resumeNumber=${encodeURIComponent(id)}`};
  let oldOpen=true,targetOpen=false,escapes=0;
  const card={getAttribute:key=>key==='data-resume-number'?id:null,
    querySelectorAll:()=>[]};
  const page={url:()=>targetOpen?candidate.sourceUrl:oldOpen
    ? 'https://rd6.zhaopin.com/app/search?resumeNumber=previous-id'
    : 'https://rd6.zhaopin.com/app/search',
  keyboard:{press:async key=>{assert.equal(key,'Escape');oldOpen=false;escapes++;}},
  locator:selector=>selector==='.new-shortcut-resume__modal'
    ? {first:()=>({isVisible:async()=>oldOpen,
      waitFor:async({state})=>{assert.equal(state,'hidden');assert.equal(oldOpen,false);}})}
    : selector.startsWith('div.search-resume-item')
      ? {evaluateAll:async(fn,arg)=>fn([card],arg),
        nth:()=>({click:async()=>{targetOpen=true;}})}
      : {first:()=>({waitFor:async({state})=>{
        assert.equal(state,'visible');
        if(!oldOpen&&!targetOpen)throw new Error('detail closed');
      }})}};
  assert.equal((await locateOfficialCandidate(page,candidate)).verified,'exact_card');
  assert.equal(escapes,1);
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
    keyboard:{press:async key=>{assert.equal(key,'Escape');escaped=true;opened=false;}},
    locator:selector=>selector.startsWith('div.search-resume-item')
      ? {evaluateAll:async(fn,arg)=>typeof arg==='string'?[]:fn(cards,arg),
        nth:()=>({click:async()=>{opened=true;}})}
      : {first:()=>({waitFor:async ({state})=>{if(state==='hidden'&&!opened)return;
        if(!opened)throw new Error('not open');}})}
  };
  await assert.rejects(locateOfficialCandidate(page,candidate),/不在当前已加载/);
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

test('智联原结果已切换时按保存的岗位词重新搜索并核对官方简历号',async()=>{
  const id='ZL_2026-abc123';
  const url=`https://rd6.zhaopin.com/app/search?resumeNumber=${id}`;
  const candidate={source:'zlzp',sourceUrl:url,sourceCandidateId:id,
    sourceSearchKeyword:'磁轴销售工程师'};
  let term='',opened=false,clicks=0;
  const page={url:()=>opened?url:'https://rd6.zhaopin.com/app/search',
    waitForTimeout:async()=>{},
    locator:selector=>selector.startsWith('input[placeholder')
      ? {first:()=>({isVisible:async()=>true,fill:async value=>{term=value;},
        press:async key=>assert.equal(key,'Enter')})}
      : selector.startsWith('div.search-resume-item')
        ? {evaluateAll:async(_fn,arg)=>typeof arg==='string'&&term==='磁轴销售工程师'?[0]:[],
          nth:()=>({click:async()=>{clicks++;opened=true;}})}
        : {first:()=>({waitFor:async()=>{if(!opened)throw new Error('not open');}})}
  };
  const result=await locateOfficialCandidate(page,candidate,
    {searchTerms:[candidate.sourceSearchKeyword]});
  assert.equal(result.verified,'exact_card');
  assert.equal(term,'磁轴销售工程师');
  assert.equal(clicks,1);
});

test('智联回查可使用官方文字下一页，并只打开编号相同的第二页候选卡',async()=>{
  const id='ZL_2026-page2';
  const url=`https://rd6.zhaopin.com/app/search?resumeNumber=${id}`;
  const candidate={source:'zlzp',sourceUrl:url,sourceCandidateId:id};
  let pageNumber=1,opened=false,searches=0,nextClicks=0;
  const page={url:()=>opened?url:'https://rd6.zhaopin.com/app/search',
    waitForTimeout:async()=>{},
    locator:selector=>selector.startsWith('input[placeholder')
      ? {first:()=>({isVisible:async()=>selector.includes('关键词'),
        fill:async()=>{},press:async()=>{searches++;}})}
      : selector.startsWith('div.search-resume-item')
        ? {evaluateAll:async(_fn,arg)=>typeof arg==='string'
          ? pageNumber===2?[0]:[] : `page-${pageNumber}`,
          nth:()=>({click:async()=>{opened=true;}})}
        : {first:()=>selector==='text="下一页"'
          ? {isVisible:async()=>true,isEnabled:async()=>true,
            getAttribute:async()=>null,click:async()=>{nextClicks++;pageNumber=2;}}
          : {isVisible:async()=>false,waitFor:async()=>{
            if(!opened)throw new Error('not open');}}}
  };
  const result=await locateOfficialCandidate(page,candidate,
    {searchTerms:['磁轴销售工程师']});
  assert.equal(result.recordId,id);
  assert.equal(searches,1);
  assert.equal(nextClicks,1);
});

test('智联单段独特公司经历可作候选卡线索，最终仍需详情编号一致',async()=>{
  const id='ZL_2026-abc123';
  const url=`https://rd6.zhaopin.com/app/search?resumeNumber=${id}`;
  const candidate={source:'zlzp',name:'张先生',sourceUrl:url,sourceCandidateId:id,
    workExperience:[{company:'佛山精燃机电设备有限公司'}]};
  let opened=false;
  const cards=[{textContent:'张先生 佛山精燃机电设备 销售工程师'},
    {textContent:'张先生 其他公司 销售工程师'}];
  const page={url:()=>opened?url:'https://rd6.zhaopin.com/app/search',
    locator:selector=>selector.startsWith('div.search-resume-item')
      ? {evaluateAll:async(fn,arg)=>typeof arg==='string'?[]:fn(cards,arg),
        nth:index=>({click:async()=>{assert.equal(index,0);opened=true;}})}
      : {first:()=>({waitFor:async()=>{if(!opened)throw new Error('not open');}})}
  };
  assert.equal((await locateOfficialCandidate(page,candidate)).verified,'exact_card');
});
