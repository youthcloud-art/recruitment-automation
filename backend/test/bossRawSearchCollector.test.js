const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {BossRawRecommendCollector}=require('../src/services/bossRawRecommendCollector');
const {jobResumeSignature}=require('../src/services/bossRawRecommendCollector');
const {
  BossRawSearchCollector,SEARCH_STATE,SEARCH_MODAL,SEARCH_CANVAS_IDENTITY,
  SEARCH_FRAME,SEARCH_CARD,SEARCH_LINK,SEARCH_CARDS,SEARCH_LOAD_MORE,
  searchLoadMoreProbe,searchCardHeaderAdjustment,searchScope
}=require('../src/services/bossRawSearchCollector');

const TITLE='IT网络运维';
const PAGE='https://www.zhipin.com/web/chat/search';
const RESUME='https://www.zhipin.com/web/frame/c-resume/?source=search';

function restorableSearchHarness({candidateVisibility=false}={}) {
  const job={title:TITLE,jobRequirements:'网络运维'};
  const frameUrl='https://www.zhipin.com/web/frame/search/';
  let windowState='minimized';
  let pageUrl=PAGE;
  let liveCardText='候选卡内容';
  let visibleCardCount=1;
  let modalActive=false;
  let restoreCalls=0;
  const collector=new BossRawSearchCollector({jobService:{current:()=>job}});
  collector.runIdentity={title:TITLE,chosenId:searchScope(TITLE),
    jobSignature:jobResumeSignature(job),pageUrl:PAGE,frameUrl};
  collector.cardWindowStart=0;
  collector.cardWindowTotal=1;
  collector.lastCandidateWindow=collector.candidateWindowSnapshot([
    {index:0,text:liveCardText,clickText:'官方简历入口'}]);
  collector.activeSearchTitle=TITLE;
  collector.searchEvidence={frameOrigin:11,keyword:TITLE};
  collector.assertPage=async()=>({url:pageUrl,iframeLiveUrl:frameUrl,
    visibilityState:windowState==='minimized'?'hidden':'visible'});
  collector.assertJob=async()=>({frameOrigin:11,cardCount:1});
  if (!candidateVisibility) collector.ensureVisibleRecruiterPage=async()=>{};
  collector.readOnlyExpression=async expression=>{
    if (expression.includes('bossRaw:searchModal')) return {active:modalActive};
    if (expression.includes('bossRaw:searchCards')) return {totalCount:1,cards:[
      {index:0,text:liveCardText,clickText:'官方简历入口'}]};
    if (expression.includes('bossRaw:searchVisibleCards')) return {
      state:'ready',cardCount:1,visibleCardCount};
    throw new Error('unexpected read-only expression');
  };
  collector.session={assertUsableRecruiterWindow:async()=>{
    if (windowState==='minimized') throw Object.assign(new Error('minimized'),
      {code:'BOSS_CDP_WINDOW_MINIMIZED'});
    return true;
  },restoreMinimizedOwnedWindow:async({expectedUrl})=>{
    assert.equal(expectedUrl,PAGE);
    restoreCalls++;
    windowState='normal';
    return {attempted:true};
  }};
  return {collector,job,setWindowState:value=>{windowState=value;},
    setPageUrl:value=>{pageUrl=value;},setCardText:value=>{liveCardText=value;},
    setModalActive:value=>{modalActive=value;},
    setVisibleCardCount:value=>{visibleCardCount=value;},
    getRestoreCalls:()=>restoreCalls};
}

test('search restores its owned minimized window only once after exact list checks',async()=>{
  const harness=restorableSearchHarness();
  const {collector}=harness;
  const expected={frameOrigin:11,cardCount:1};
  assert.equal(await collector.assertOrRestoreSearchWindow(TITLE,searchScope(TITLE),expected),true);
  assert.equal(harness.getRestoreCalls(),1);
  assert.equal(collector.getStatus().windowRestoreCount,1);
  harness.setWindowState('minimized');
  await assert.rejects(collector.assertOrRestoreSearchWindow(TITLE,searchScope(TITLE),expected),
    error=>error.code==='BOSS_CDP_WINDOW_MINIMIZED' && /再次最小化/.test(error.message));
  assert.equal(harness.getRestoreCalls(),1);
});

test('candidate-list visibility restores the same minimized window once before any candidate click',async()=>{
  const harness=restorableSearchHarness({candidateVisibility:true});
  const {collector}=harness;
  collector.status.phase='existing_candidate';
  let commands=0;
  collector.session.send=async()=>{commands++;};
  await collector.ensureVisibleRecruiterPage();
  assert.equal(harness.getRestoreCalls(),1);
  assert.equal(collector.status.windowRestoreCount,1);
  assert.equal(collector.status.phase,'existing_candidate');
  assert.equal(commands,0,'a visible restored page needs no extra foreground command');
  harness.setWindowState('minimized');
  await assert.rejects(collector.ensureVisibleRecruiterPage(),
    error=>error.code==='BOSS_CDP_WINDOW_MINIMIZED' && /再次最小化/.test(error.message));
  assert.equal(harness.getRestoreCalls(),1,'the same run never restores twice');
  assert.equal(commands,0);
});

test('candidate-list restoration refuses a changed card, popup or non-list phase',async()=>{
  for (const change of [
    h=>h.setCardText('另一位候选人'),
    h=>h.setModalActive(true),
    h=>{h.collector.searchEvidence.frameOrigin=12;}
  ]) {
    const harness=restorableSearchHarness({candidateVisibility:true});
    harness.collector.status.phase='reading_candidates';
    change(harness);
    await assert.rejects(harness.collector.ensureVisibleRecruiterPage(),
      error=>error.code==='BOSS_CDP_WINDOW_RESTORE_UNAVAILABLE');
    assert.equal(harness.getRestoreCalls(),0);
  }
  const opening=restorableSearchHarness({candidateVisibility:true});
  opening.collector.status.phase='opening_candidate';
  await assert.rejects(opening.collector.ensureVisibleRecruiterPage(),
    error=>error.code==='BOSS_CDP_WINDOW_MINIMIZED');
  assert.equal(opening.getRestoreCalls(),0,
    'an uncertain candidate click is never resumed through window restoration');
});

test('search never brings a minimized recruiter tab to front outside guarded restoration',async()=>{
  const collector=new BossRawSearchCollector();
  collector.windowRestoreUsed=true;
  let commands=0;
  collector.session={assertUsableRecruiterWindow:async()=>{
    throw Object.assign(new Error('second minimization'),
      {code:'BOSS_CDP_WINDOW_MINIMIZED'});
  },send:async()=>{commands++;}};
  collector.assertPage=async()=>({url:PAGE,visibilityState:'hidden'});
  await assert.rejects(collector.ensureVisibleRecruiterPage(),
    error=>error.code==='BOSS_CDP_WINDOW_MINIMIZED');
  assert.equal(commands,0,'Page.bringToFront must not bypass the one-time window limit');
});

test('search refuses window restoration when job, page, card or visibility changes',async()=>{
  const expected={frameOrigin:11,cardCount:1};
  for (const alter of [
    h=>{h.job.jobRequirements='changed';},
    h=>{h.setPageUrl(PAGE+'?unexpected=1');},
    h=>{h.setCardText('候选卡已经变化');}
  ]) {
    const harness=restorableSearchHarness();
    alter(harness);
    await assert.rejects(harness.collector.assertOrRestoreSearchWindow(
      TITLE,searchScope(TITLE),expected),
    error=>error.code==='BOSS_CDP_WINDOW_RESTORE_UNAVAILABLE');
    assert.equal(harness.getRestoreCalls(),0);
  }
  const hidden=restorableSearchHarness();
  hidden.setVisibleCardCount(0);
  await assert.rejects(hidden.collector.assertOrRestoreSearchWindow(
    TITLE,searchScope(TITLE),expected),
  error=>error.code==='BOSS_CDP_WINDOW_RESTORE_UNAVAILABLE');
  assert.equal(hidden.getRestoreCalls(),1,'post-restore failure consumes the only attempt');
  hidden.setWindowState('minimized');
  await assert.rejects(hidden.collector.assertOrRestoreSearchWindow(
    TITLE,searchScope(TITLE),expected),
  error=>error.code==='BOSS_CDP_WINDOW_MINIMIZED');
  assert.equal(hidden.getRestoreCalls(),1);
});

test('search probes compile for the observed official iframe, cards, and top-level resume',()=>{
  for (const expression of [SEARCH_STATE,SEARCH_CARDS,SEARCH_MODAL,
    SEARCH_CANVAS_IDENTITY]) {
    new vm.Script(expression);
  }
  const collector=new BossRawSearchCollector();
  assert.equal(collector.frameSelector,SEARCH_FRAME);
  assert.equal(collector.cardSelector,SEARCH_CARD);
  assert.equal(collector.clickSelector,SEARCH_LINK);
  assert.equal(collector.pageSegment,'search');
  assert.match(collector.expressions.modal,/dialog-lib-resume/);
  new vm.Script(searchLoadMoreProbe(TITLE,1));
});

test('search load-more probe requires exact job, one visible official control, no dialog and stable frame',()=>{
  const card={textContent:'最后一张候选卡'};
  const parent={};
  const control={textContent:'点击加载更多',parentElement:parent,
    getBoundingClientRect:()=>({width:100,height:26})};
  const input={value:TITLE,getClientRects:()=>[{}]};
  const state={keyword:TITLE,controls:[control],dialogs:[],frameOrigin:1,
    scrollTop:33162,scrollHeight:34027};
  const doc={
    defaultView:{getComputedStyle:()=>({visibility:'visible',display:'block',pointerEvents:'auto'})},
    scrollingElement:{get scrollTop(){return state.scrollTop;},
      get scrollHeight(){return state.scrollHeight;},clientHeight:865},
    querySelectorAll:selector=>selector==='input.search-input' ? [input]
      : selector===SEARCH_CARD ? [card]
        : selector===SEARCH_LOAD_MORE ? state.controls
          : selector==='.dialog-wrap.active' ? state.dialogs : []
  };
  Object.defineProperty(input,'value',{get:()=>state.keyword});
  const frame={contentDocument:doc,contentWindow:{
    location:{href:'https://www.zhipin.com/web/frame/search/'},
    performance:{get timeOrigin(){return state.frameOrigin;}}
  }};
  const top={visibilityState:'visible',querySelector:selector=>
    selector===SEARCH_FRAME ? frame : null,
    querySelectorAll:selector=>selector==='.dialog-wrap.active' ? state.dialogs : []};
  const location={href:PAGE};
  const probe=()=>vm.runInNewContext(searchLoadMoreProbe(TITLE,1),{
    location,document:top,URL
  });
  assert.equal(probe().state,'ready');
  assert.equal(probe().cardCount,1);
  location.href=PAGE+'?_security_check=completed';
  assert.equal(probe().state,'ready',
    'official verification query must retain the confirmed search list');
  for (const unsafe of [PAGE+'?unknown=1',
    PAGE+'?_security_check=completed&unknown=1',PAGE+'#changed',
    'https://example.com/web/chat/search?_security_check=completed']) {
    location.href=unsafe;
    assert.equal(probe().state,'page_changed',unsafe);
  }
  location.href=PAGE;
  state.keyword='成本核算经理';
  assert.equal(probe().state,'keyword_changed');
  state.keyword=TITLE;
  state.controls=[control,control];
  assert.equal(probe().state,'ambiguous');
  state.controls=[control];
  state.dialogs=[{}];
  assert.equal(probe().state,'dialog_active');
  state.dialogs=[];
  state.frameOrigin=2;
  assert.equal(probe().state,'frame_changed');
  state.frameOrigin=1;
  state.scrollTop=32000;
  assert.equal(probe().state,'not_at_end');
  state.scrollTop=33162;
  state.controls=[];
  assert.equal(probe().state,'absent');
});

test('search scroll clicks the official load-more control once and requires new cards',async()=>{
  let count=164;
  let clicks=0;
  let reads=0;
  const collector=new BossRawSearchCollector({
    jobService:{current:()=>({title:TITLE})},wait:async()=>{}
  });
  collector.activeSearchTitle=TITLE;
  collector.assertJob=async(title,id)=>{
    assert.equal(title,TITLE);
    assert.equal(id,searchScope(TITLE));
    return {frameOrigin:1,cardCount:count};
  };
  collector.readModal=async()=>({active:false});
  collector.readOnlyExpression=async(expression)=>{
    assert.match(expression,/bossRaw:searchLoadMore/);
    reads++;
    return {state:'ready',cardCount:164,lastCardText:'末尾卡',frameOrigin:1};
  };
  collector.session={assertUsableRecruiterWindow:async()=>true,evaluate:async expression=>{
    assert.match(expression,/bossRaw:scroll/);
    return true;
  },clickUnique:async options=>{
    assert.deepEqual(options,{selector:SEARCH_LOAD_MORE,frameSelector:SEARCH_FRAME,
      identityAttribute:'textContent',identityValue:'点击加载更多'});
    clicks++;
    count=165;
  }};
  await collector.scrollCards();
  assert.equal(clicks,1);
  assert.equal(reads,2);
});

test('search load-more never retries an uncertain click or a stalled response',async()=>{
  const collector=new BossRawSearchCollector({
    jobService:{current:()=>({title:TITLE})},wait:async()=>{}
  });
  collector.activeSearchTitle=TITLE;
  collector.assertPage=async()=>({url:PAGE});
  collector.assertJob=async()=>({frameOrigin:1,cardCount:164});
  collector.readModal=async()=>({active:false});
  collector.readOnlyExpression=async()=>({state:'ready',cardCount:164,
    lastCardText:'末尾卡',frameOrigin:1});
  let clicks=0;
  collector.session={assertUsableRecruiterWindow:async()=>true,
    evaluate:async()=>true,clickUnique:async()=>{
    clicks++;
    throw Object.assign(new Error('click acknowledgement timed out'),
      {code:'BOSS_CDP_CLICK_UNCERTAIN'});
  }};
  await assert.rejects(collector.scrollCards(),
    error=>error.code==='BOSS_SEARCH_LOAD_MORE_UNCERTAIN');
  assert.equal(clicks,1);
  collector.session.clickUnique=async()=>{clicks++;};
  await assert.rejects(collector.scrollCards(),
    error=>error.code==='BOSS_SEARCH_LOAD_MORE_STALLED');
  assert.equal(clicks,2);
});

test('search never restores or replays load-more after an uncertain mouse press and minimization',async()=>{
  const collector=new BossRawSearchCollector({wait:async()=>{}});
  collector.activeSearchTitle=TITLE;
  collector.assertJob=async()=>({frameOrigin:1,cardCount:164});
  collector.readModal=async()=>({active:false});
  collector.readOnlyExpression=async()=>({state:'ready',cardCount:164,
    lastCardText:'末尾卡',frameOrigin:1});
  let minimized=false,clickCalls=0,restoreCalls=0;
  collector.session={assertUsableRecruiterWindow:async()=>{
    if (minimized) throw Object.assign(new Error('window minimized'),
      {code:'BOSS_CDP_WINDOW_MINIMIZED'});
    return true;
  },evaluate:async()=>true,clickUnique:async()=>{
    clickCalls++;
    minimized=true;
    throw Object.assign(new Error('press ACK unknown'),
      {code:'BOSS_CDP_CLICK_UNCERTAIN',stage:'click_ack'});
  },restoreMinimizedOwnedWindow:async()=>{restoreCalls++;}};
  await assert.rejects(collector.scrollCards(),error=>
    error.code==='BOSS_CDP_WINDOW_MINIMIZED' &&
    error.cause?.code==='BOSS_CDP_CLICK_UNCERTAIN');
  assert.equal(clickCalls,1);
  assert.equal(restoreCalls,0);
});

test('search load-more identifies a pre-click target failure without sending a mouse press',async()=>{
  const collector=new BossRawSearchCollector({wait:async()=>{}});
  collector.activeSearchTitle=TITLE;
  collector.assertJob=async()=>({frameOrigin:1,cardCount:164});
  collector.readModal=async()=>({active:false});
  collector.readOnlyExpression=async()=>({state:'ready',cardCount:164,
    lastCardText:'末尾卡',frameOrigin:1});
  let calls=0;
  collector.session={assertUsableRecruiterWindow:async()=>true,
    evaluate:async()=>true,clickUnique:async()=>{
    calls++;
    throw Object.assign(new Error('not visible'),{
      code:'BOSS_CDP_TARGET_UNAVAILABLE',stage:'pre_click_probe',targetState:'out_of_view'});
  }};
  await assert.rejects(collector.scrollCards(),error=>
    error.code==='BOSS_SEARCH_LOAD_MORE_UNAVAILABLE' &&
    error.stage==='pre_click_probe' && error.targetState==='out_of_view' &&
    /未发出点击/.test(error.message) &&
    error.cause?.code==='BOSS_CDP_TARGET_UNAVAILABLE');
  assert.equal(calls,1);
  collector.session.clickUnique=async()=>{
    calls++;
    throw Object.assign(new Error('point moved before press'),
      {code:'BOSS_CDP_TARGET_UNSTABLE'});
  };
  await assert.rejects(collector.scrollCards(),error=>
    error.code==='BOSS_SEARCH_LOAD_MORE_UNAVAILABLE' &&
    error.stage==='pre_click_recheck' && /未发出点击/.test(error.message));
  assert.equal(calls,2);
});

test('search load-more preserves verification and reset search states after uncertain acknowledgement',async()=>{
  for (const code of ['BOSS_VERIFICATION_REQUIRED',
    'BOSS_SEARCH_KEYWORD_MISMATCH','BOSS_SEARCH_NOT_SUBMITTED']) {
    const collector=new BossRawSearchCollector({wait:async()=>{}});
    collector.activeSearchTitle=TITLE;
    let reads=0;
    collector.assertJob=async()=>{
      reads++;
      if (reads>=4) throw Object.assign(new Error('official state changed'),{code});
      return {frameOrigin:1,cardCount:164};
    };
    collector.readModal=async()=>({active:false});
    collector.readOnlyExpression=async()=>({state:'ready',cardCount:164,
      lastCardText:'末尾卡',frameOrigin:1});
    let calls=0;
    collector.session={assertUsableRecruiterWindow:async()=>true,
      evaluate:async()=>true,clickUnique:async()=>{
      calls++;
      throw Object.assign(new Error('click acknowledgement timed out'),
        {code:'BOSS_CDP_CLICK_UNCERTAIN',stage:'click_ack'});
    }};
    await assert.rejects(collector.scrollCards(),error=>
      error.code===code && error.cause?.code==='BOSS_CDP_CLICK_UNCERTAIN');
    assert.equal(calls,1,`only one click attempt when ${code}`);
  }
});

test('search load-more performs one scroll-only restabilization after pre-click movement',async()=>{
  const collector=new BossRawSearchCollector({wait:async()=>{}});
  collector.activeSearchTitle=TITLE;
  let count=164,probes=0,scrolls=0,preClickChecks=0,mousePresses=0;
  collector.assertJob=async()=>({frameOrigin:1,cardCount:count});
  collector.readModal=async()=>({active:false});
  collector.readOnlyExpression=async expression=>{
    if (expression===SEARCH_MODAL) return {active:false};
    probes++;
    return {state:probes===3 ? 'not_at_end' : 'ready',cardCount:164,
      lastCardText:'末尾卡',frameOrigin:1};
  };
  collector.session={assertUsableRecruiterWindow:async()=>true,
    evaluate:async()=>{scrolls++;return true;},
    clickUnique:async()=>{
      preClickChecks++;
      if (preClickChecks===1) throw Object.assign(new Error('target moved'),{
        code:'BOSS_CDP_TARGET_UNSTABLE',stage:'pre_click_recheck',
        reason:'position_moved',targetState:'ready'});
      mousePresses++;
      count=165;
    }};
  await collector.scrollCards();
  assert.equal(scrolls,2,'at most one scroll-only correction');
  assert.equal(preClickChecks,2,'one failed pre-click probe and one new check');
  assert.equal(mousePresses,1,'only one mouse click is ever sent');
  assert.equal(probes,5);
});

test('search load-more refuses restabilization when document or window state changes',async()=>{
  const makeCollector=()=>{
    const collector=new BossRawSearchCollector({wait:async()=>{}});
    collector.activeSearchTitle=TITLE;
    collector.readModal=async()=>({active:false});
    collector.readOnlyExpression=async()=>({state:'ready',cardCount:164,
      lastCardText:'末尾卡',frameOrigin:1});
    return collector;
  };
  {
    const collector=makeCollector();
    let reads=0,clicks=0;
    collector.assertJob=async()=>({frameOrigin:++reads>=4 ? 2 : 1,cardCount:164});
    collector.session={assertUsableRecruiterWindow:async()=>true,
      evaluate:async()=>true,clickUnique:async()=>{
        clicks++;
        throw Object.assign(new Error('target moved'),{
          code:'BOSS_CDP_TARGET_UNSTABLE',stage:'pre_click_recheck',
          reason:'position_moved',targetState:'ready'});
      }};
    await assert.rejects(collector.scrollCards(),error=>
      error.code==='BOSS_SEARCH_LOAD_MORE_UNAVAILABLE' && /未发出点击/.test(error.message));
    assert.equal(clicks,1);
  }
  {
    const collector=makeCollector();
    collector.assertJob=async()=>({frameOrigin:1,cardCount:164});
    let windowChecks=0,clicks=0;
    collector.session={assertUsableRecruiterWindow:async()=>{
      if (++windowChecks>=3) throw Object.assign(new Error('restore Chrome'),{
        code:'BOSS_CDP_WINDOW_MINIMIZED'});
      return true;
    },evaluate:async()=>true,clickUnique:async()=>{
      clicks++;
      throw Object.assign(new Error('target moved'),{
        code:'BOSS_CDP_TARGET_UNSTABLE',stage:'pre_click_recheck',
        reason:'position_moved',targetState:'ready'});
    }};
    await assert.rejects(collector.scrollCards(),error=>
      error.code==='BOSS_CDP_WINDOW_MINIMIZED');
    assert.equal(clicks,1);
  }
  {
    const collector=makeCollector();
    let clicks=0;
    collector.session={assertUsableRecruiterWindow:async()=>{
      throw Object.assign(new Error('restore dedicated Chrome'),
        {code:'BOSS_CDP_WINDOW_MINIMIZED'});
    },evaluate:async()=>true,clickUnique:async()=>{clicks++;}};
    await assert.rejects(collector.scrollCards(),error=>
      error.code==='BOSS_CDP_WINDOW_MINIMIZED');
    assert.equal(clicks,0,'minimized window fails before any scroll or click');
  }
});

test('search load-more leaves absent controls untouched and pauses on ambiguous controls',async()=>{
  const collector=new BossRawSearchCollector({wait:async()=>{}});
  collector.activeSearchTitle=TITLE;
  collector.assertJob=async()=>({frameOrigin:1,cardCount:164});
  collector.readModal=async()=>({active:false});
  collector.session={assertUsableRecruiterWindow:async()=>true,
    evaluate:async()=>true,clickUnique:async()=>{
    throw new Error('must not click');
  }};
  collector.readOnlyExpression=async()=>({state:'absent',cardCount:164});
  await collector.scrollCards();
  collector.readOnlyExpression=async()=>({state:'ambiguous',cardCount:164});
  await assert.rejects(collector.scrollCards(),
    error=>error.code==='BOSS_SEARCH_LOAD_MORE_UNAVAILABLE');
});

test('search load-more preserves official verification after one click',async()=>{
  const collector=new BossRawSearchCollector({wait:async()=>{}});
  collector.activeSearchTitle=TITLE;
  let clicked=false;
  collector.assertJob=async()=>{
    if (clicked) throw Object.assign(new Error('official verification'),
      {code:'BOSS_VERIFICATION_REQUIRED'});
    return {frameOrigin:1,cardCount:164};
  };
  collector.readModal=async()=>({active:false});
  collector.readOnlyExpression=async()=>({state:'ready',cardCount:164,
    lastCardText:'末尾卡',frameOrigin:1});
  let clicks=0;
  collector.session={assertUsableRecruiterWindow:async()=>true,
    evaluate:async()=>true,clickUnique:async()=>{
    clicked=true;
    clicks++;
  }};
  await assert.rejects(collector.scrollCards(),
    error=>error.code==='BOSS_VERIFICATION_REQUIRED');
  assert.equal(clicks,1);
});

test('search runtime is capped at 180 minutes while recommendations keep 90',async()=>{
  const jobService={current:()=>({title:TITLE,jobRequirements:'网络运维经验'})};
  const connect=async()=>{throw new Error('offline test: no browser connection');};
  const search=new BossRawSearchCollector({jobService,connect});
  const recommended=new BossRawRecommendCollector({jobService,connect});
  assert.equal((await search.collect({targetCount:1,maxRuntimeMs:240*60_000}))
    .maxRuntimeMinutes,180);
  assert.equal((await recommended.collect({targetCount:1,maxRuntimeMs:240*60_000}))
    .maxRuntimeMinutes,90);
});

test('search reports a runtime-limited partial run without manufacturing new candidates',async()=>{
  let now=0;
  let reads=0;
  const session={assertUsableRecruiterWindow:async()=>{},close:async()=>{}};
  const collector=new BossRawSearchCollector({
    connect:async()=>session,
    jobService:{current:()=>({title:TITLE,jobRequirements:'网络运维经验'})},
    now:()=>now,wait:async ms=>{now+=ms*30;}
  });
  collector.assertPage=async()=>({url:PAGE});
  collector.ensureVisibleRecruiterPage=async()=>{};
  collector.selectJob=async()=>({value:searchScope(TITLE)});
  collector.assertCandidateListJob=async()=>{};
  collector.dismissKnownGuideModal=async()=>{};
  collector.readModal=async()=>({active:false});
  collector.scrollCards=async()=>{};
  collector.readCandidateCards=async()=>++reads===1 ? [{text:'official card'}] : [];
  const result=await collector.collect({targetCount:2,maxRuntimeMs:60_000});
  assert.equal(result.state,'partial');
  assert.equal(result.saved,0);
  assert.equal(result.maxRuntimeMinutes,1);
  assert.match(result.completionReason,/1 分钟运行上限/);
});

test('search cards read one official name and the second expected-job field',()=>{
  const city={textContent:'上海'};
  const role={textContent:'IT网络运维'};
  const row={textContent:'期望 上海 IT网络运维',querySelectorAll:selector=>
    selector==='span.render-two' ? [city,role] : []};
  const link={textContent:'张三 期望 上海 IT网络运维'};
  const name={textContent:'张三'};
  const card={textContent:link.textContent,querySelectorAll:selector=>
    selector===':scope > a[ka="search_click_open_resume"][data-expect]' ? [link]
      : selector==='.geek-info-basic-content > .name > span.name-label' ? [name]
        : selector==='ul.exp-box.expect-exp-box > li' ? [row] : []};
  const frame={contentDocument:{querySelectorAll:selector=>
    selector===SEARCH_CARD ? [card] : []}};
  const document={querySelector:selector=>selector===SEARCH_FRAME ? frame : null};
  const result=vm.runInNewContext(SEARCH_CARDS,{document});
  assert.equal(result.totalCount,1);
  assert.equal(result.cards.length,1);
  assert.equal(result.cards[0].displayName,'张三');
  assert.equal(result.cards[0].expectedPosition,'IT网络运维');
  assert.equal(result.cards[0].clickText,link.textContent);
  assert.equal(result.cards[0].index,0);
  row.querySelectorAll=()=>[city];
  assert.equal(vm.runInNewContext(SEARCH_CARDS,{document}).cards[0].expectedPosition,'',
    'an unverified second role must not be guessed from the search keyword');
});

test('search card windows retain the 1001st dynamically loaded candidate',()=>{
  const cards=Array.from({length:1001},(_,index)=>({
    textContent:`候选人 ${index}`,
    querySelectorAll:selector=>selector===':scope > a[ka="search_click_open_resume"][data-expect]'
      ? [{textContent:`候选人 ${index}`}] : []
  }));
  const document={querySelector:selector=>selector===SEARCH_FRAME
    ? {contentDocument:{querySelectorAll:()=>cards}} : null};
  const collector=new BossRawSearchCollector();
  const first=vm.runInNewContext(collector.cardExpressionForWindow(),{document});
  assert.equal(first.totalCount,1001);
  assert.equal(first.cards.length,1000);
  collector.cardWindowTotal=first.totalCount;
  assert.equal(collector.advanceCardWindowIfNeeded(),true);
  assert.equal(collector.cardWindowStart,800);
  const next=vm.runInNewContext(collector.cardExpressionForWindow(),{document});
  assert.equal(next.cards.length,201);
  assert.equal(next.cards.at(-1).index,1000);
  assert.equal(next.cards.at(-1).text,'候选人 1000');
  collector.cardWindowTotal=next.totalCount;
  assert.equal(collector.advanceCardWindowIfNeeded(),false);
  cards.unshift({textContent:'滚动后插入的新候选人',querySelectorAll:()=>[]});
  collector.rewindCardWindowAfterScroll();
  const rescanned=vm.runInNewContext(collector.cardExpressionForWindow(),{document});
  assert.equal(rescanned.cards[0].text,'滚动后插入的新候选人');
  assert.equal(collector.cardWindowStart,0);
});

test('search card adjusts once only for its unique verified fixed header',async()=>{
  const clickText='测试候选卡';
  const root={tagName:'HTML',scrollHeight:17787,clientHeight:865,scrollTop:14518};
  const originalScroll=root.scrollTop;
  const header={getBoundingClientRect:()=>({top:0,bottom:110,left:0,right:1650,
    height:110}),contains:hit=>hit===header};
  const card={textContent:clickText};
  const link={textContent:clickText,
    closest:selector=>selector==='li.geek-info-card' ? card : null,
    contains:hit=>hit===link,
    getBoundingClientRect:()=>{
      const top=-89+(originalScroll-root.scrollTop);
      return {left:200,right:1500,width:1300,top,bottom:top+206,height:206};
    }};
  const frame={contentDocument:null,clientLeft:0,clientTop:0,
    contentWindow:{location:{href:'https://www.zhipin.com/web/frame/search/'}},
    getBoundingClientRect:()=>({left:168,top:0}),contains:()=>false};
  let otherOverlay=false;
  const doc={defaultView:{innerWidth:1650,innerHeight:865,
    getComputedStyle:()=>({position:'fixed'})},scrollingElement:root,
    querySelector:()=>null,querySelectorAll:selector=>selector===SEARCH_LINK ? [link]
      : selector===SEARCH_CARD ? [card]
        : selector==='.search-part-container.fix-top-sarch-part' ? [header] : [],
    elementFromPoint:(x,y)=>otherOverlay ? {closest:()=>null} : y<110 ? header : link};
  frame.contentDocument=doc;
  const document={visibilityState:'visible',querySelector:selector=>
    selector===SEARCH_FRAME ? frame : null,
    elementFromPoint:()=>frame};
  const context={location:{href:PAGE},document,URL,innerWidth:1824,innerHeight:865};
  const probe=(allow,index=0,expectedText='')=>vm.runInNewContext(
    searchCardHeaderAdjustment(clickText,index,allow,expectedText),context);
  context.location.href=PAGE+'?_security_check=completed';
  assert.equal(probe(false).state,'repeat_adjustment',
    'official verification query must reach the existing card and header checks');
  for (const unsafe of [PAGE+'?unknown=1',
    PAGE+'?_security_check=completed&unknown=1',PAGE+'#changed',
    'https://example.com/web/chat/search?_security_check=completed']) {
    context.location.href=unsafe;
    assert.equal(probe(true).state,'page_changed',unsafe);
  }
  context.location.href=PAGE;
  assert.equal(probe(true,1).state,'card_reordered');
  assert.equal(root.scrollTop,originalScroll,'changed card order must not move list');
  card.textContent='另一位候选人';
  assert.equal(probe(true,1,clickText).state,'card_mismatch');
  assert.equal(root.scrollTop,originalScroll,'changed card identity must not move list');
  card.textContent=clickText;
  const noRepeat=probe(false);
  assert.equal(noRepeat.state,'repeat_adjustment');
  assert.equal(noRepeat.cardIndex,0);
  assert.equal(root.scrollTop,originalScroll,'read-only repeat probe must not move list');
  otherOverlay=true;
  assert.equal(probe(true).state,'other_obstruction');
  assert.equal(root.scrollTop,originalScroll,'unknown overlay must not move list');
  otherOverlay=false;
  const adjusted=probe(true);
  assert.equal(adjusted.state,'adjusted');
  assert.equal(adjusted.cardIndex,0);
  assert.ok(adjusted.scrollDelta>0 && adjusted.scrollDelta<=400);
  assert.equal(root.scrollTop,originalScroll-adjusted.scrollDelta);
  assert.equal(probe(false).state,'ready','the adjusted click point is rechecked');
  assert.equal(root.scrollTop,originalScroll-adjusted.scrollDelta);

  root.scrollTop=originalScroll;
  const collector=new BossRawSearchCollector({wait:async()=>{}});
  collector.session={scrollUnique:async()=>{},evaluate:async expression=>
    vm.runInNewContext(expression,context)};
  collector.assertJob=async()=>{};
  collector.readModal=async()=>({active:false});
  await collector.prepareCandidateCard({text:clickText,clickText,index:1},
    TITLE,searchScope(TITLE));
  assert.ok(root.scrollTop<originalScroll,
    'the same unique card can be relocated once and adjusted under the header');
  assert.equal(collector.adjustedCardHashes.size,1);

  root.scrollTop=originalScroll;
  card.textContent='另一位候选人';
  await assert.rejects(collector.prepareCandidateCard(
    {text:clickText,clickText,index:1},TITLE,searchScope(TITLE)),
  error=>error.code==='BOSS_CDP_TARGET_UNAVAILABLE' &&
    error.targetState==='card_mismatch');
  assert.equal(root.scrollTop,originalScroll,
    'a card whose full text changed must not be adjusted');
  card.textContent=clickText;
  doc.querySelectorAll=selector=>selector===SEARCH_LINK ? [link]
    : selector===SEARCH_CARD ? [card]
      : selector==='.search-part-container.fix-top-sarch-part' ? [header,header] : [];
  assert.equal(probe(true).state,'header_unverified');
  assert.equal(root.scrollTop,originalScroll,'ambiguous header must not move list');
});

test('search card relocation stops after one reorder without clicking',async()=>{
  const collector=new BossRawSearchCollector({wait:async()=>{}});
  let probes=0;
  collector.session={scrollUnique:async()=>{},evaluate:async()=>{
    probes++;
    return {state:'card_reordered',cardIndex:probes};
  }};
  collector.assertJob=async()=>{};
  collector.readModal=async()=>({active:false});
  await assert.rejects(collector.prepareCandidateCard(
    {text:'原候选人',clickText:'原候选人',index:0},TITLE,searchScope(TITLE)),
  error=>error.code==='BOSS_CDP_TARGET_UNAVAILABLE' &&
    error.targetState==='card_reordered');
  assert.equal(probes,2,'the relocation is bounded to one retry');
});

test('search state detects an enabled custom slider despite an active 不限 chip',()=>{
  let disabled=true;
  const chip={textContent:'不限',getClientRects:()=>[{}]};
  const slider={classList:{contains:label=>label==='custom-slider-disabled' && disabled}};
  const input={value:TITLE,getClientRects:()=>[{}]};
  const doc={defaultView:{getComputedStyle:()=>({visibility:'visible'})},
    querySelectorAll:selector=>selector==='input.search-input' ? [input]
      : selector===SEARCH_CARD ? []
        : selector.endsWith('-item.active') ? [chip]
          : selector==='input[type="checkbox"]:checked' ? []
            : selector.includes('degree-select-custom-slider') ? [slider] : []};
  const frame={contentDocument:doc,contentWindow:{
    location:{href:'https://www.zhipin.com/web/frame/search/'},
    performance:{timeOrigin:1,getEntriesByType:()=>[{
      name:'https://www.zhipin.com/wapi/zpitem/web/boss/search/geeks.json'
        + '?keyword='+encodeURIComponent(TITLE)}]}}};
  const document={querySelector:selector=>selector===SEARCH_FRAME ? frame : null};
  const context={document,URL};
  assert.equal(vm.runInNewContext(SEARCH_STATE,context).activeCustomSliderCount,0);
  disabled=false;
  const state=vm.runInNewContext(SEARCH_STATE,context);
  assert.equal(state.nonDefaultSelected,0);
  assert.equal(state.activeCustomSliderCount,1);
});

test('search modal probes require the observed official child wrapper',()=>{
  const canvas={width:777,height:905};
  const resumeDoc={querySelector:selector=>selector==='canvas#resume' ? canvas : null};
  const frame={src:RESUME,contentDocument:resumeDoc,
    contentWindow:{location:{href:RESUME},performance:{timeOrigin:3}}};
  const pane={scrollTop:0,scrollHeight:2570,clientHeight:905,
    querySelectorAll:selector=>selector==='iframe[src*="/web/frame/c-resume/"]' ? [frame] : []};
  const wrapper={querySelectorAll:selector=>selector==='.resume-detail-wrap' ? [pane]
    : selector==='.close-btn' ? [{}] : []};
  const dialog={querySelectorAll:selector=>selector.startsWith(':scope > .boss-popup__wrapper')
    ? [wrapper] : []};
  const document={visibilityState:'visible',querySelectorAll:selector=>
    selector==='div[data-type="boss-dialog"].active.dialog-wrap' ? [dialog] : []};
  const context={document,performance:{timeOrigin:1}};
  const modal=vm.runInNewContext(SEARCH_MODAL,context);
  assert.equal(modal.active,true);
  assert.equal(modal.frameReady,true);
  assert.equal(modal.canvasWidth,777);
  assert.equal(modal.scrollHeight,2570);
  assert.equal(modal.iframeLiveUrl,RESUME);
  assert.equal(modal.resumeOrigin,3);
  const identity=vm.runInNewContext(SEARCH_CANVAS_IDENTITY,context);
  assert.equal(identity.state,'ready');
  assert.equal(identity.resumeUrl,RESUME);
  dialog.querySelectorAll=()=>[];
  assert.equal(vm.runInNewContext(SEARCH_MODAL,context).transient,true,
    'an unknown top-level popup must not be treated as a resume');
  assert.equal(vm.runInNewContext(SEARCH_CANVAS_IDENTITY,context).state,
    'dialog_unavailable');
});

test('search resumes one hidden official Canvas only after exact popup and job checks',async()=>{
  const collector=new BossRawSearchCollector();
  let hidden=false,focusCalls=0;
  const modal=()=>({active:true,frameReady:true,iframeSrc:RESUME,
    iframeLiveUrl:RESUME,outerOrigin:1,resumeOrigin:2,scrollTop:0});
  collector.searchResumeContext={job:{title:TITLE,id:searchScope(TITLE)},
    url:RESUME,outerOrigin:1,resumeOrigin:2,lastKnownTop:0};
  collector.assertPage=async()=>({url:PAGE,
    visibilityState:hidden?'hidden':'visible'});
  collector.assertJob=async()=>{};
  collector.readModal=async()=>({...modal(),url:new URL(RESUME)});
  collector.readOnlyExpression=async expression=>expression===SEARCH_MODAL ? modal()
    : {state:'ready',resumeUrl:RESUME,outerOrigin:1,resumeOrigin:2,
      scrollTop:0,width:777,height:905};
  collector.ensureVisibleRecruiterPage=async()=>{focusCalls++;hidden=false;};
  const image=Buffer.alloc(24);
  image.writeUInt32BE(777,16);image.writeUInt32BE(905,20);
  collector.session={captureCanvasPng:async()=>{hidden=true;return image;}};
  const capture=await collector.verifiedCanvas(RESUME,0);
  assert.equal(capture.image,image);
  assert.equal(focusCalls,1);
  assert.equal(collector.searchFocusRecoveryUsed,true);
  hidden=true;
  await assert.rejects(collector.verifiedCanvas(RESUME,0),
    error=>error.code==='BOSS_PAGE_HIDDEN');
  assert.equal(focusCalls,1,'the same candidate is never brought forward twice');
});

test('search refuses focus and close if the official popup identity changes',async()=>{
  const collector=new BossRawSearchCollector();
  let focusCalls=0,clicks=0;
  collector.searchResumeContext={job:{title:TITLE,id:searchScope(TITLE)},
    url:RESUME,outerOrigin:1,resumeOrigin:2,lastKnownTop:0};
  collector.assertPage=async()=>({url:PAGE,visibilityState:'hidden'});
  collector.assertJob=async()=>{};
  collector.readOnlyExpression=async()=>({active:true,frameReady:true,
    iframeSrc:RESUME,iframeLiveUrl:RESUME,outerOrigin:1,
    resumeOrigin:3,scrollTop:0});
  collector.ensureVisibleRecruiterPage=async()=>{focusCalls++;};
  collector.session={clickUnique:async()=>{clicks++;}};
  await assert.rejects(collector.closeOfficialModal(),
    error=>error.code==='BOSS_RESUME_DIALOG_BLOCKED');
  assert.equal(focusCalls,0);
  assert.equal(clicks,0);
});

test('search closes one confirmed official popup after one bounded visibility recovery',async()=>{
  const collector=new BossRawSearchCollector({wait:async()=>{}});
  let hidden=true,focusCalls=0,clicks=0;
  collector.searchResumeContext={job:{title:TITLE,id:searchScope(TITLE)},
    url:RESUME,outerOrigin:1,resumeOrigin:2,lastKnownTop:0};
  collector.assertPage=async()=>({url:PAGE,
    visibilityState:hidden?'hidden':'visible'});
  collector.assertJob=async()=>{};
  collector.readOnlyExpression=async()=>clicks ? {active:false} : {
    active:true,frameReady:true,iframeSrc:RESUME,iframeLiveUrl:RESUME,
    outerOrigin:1,resumeOrigin:2,scrollTop:0};
  collector.ensureVisibleRecruiterPage=async()=>{focusCalls++;hidden=false;};
  collector.session={clickUnique:async()=>{clicks++;}};
  await collector.closeOfficialModal();
  assert.equal(focusCalls,1);
  assert.equal(clicks,1);
  assert.equal(collector.searchResumeContext,null);
});

test('search page preflight accepts only the official search route and iframe',async()=>{
  const collector=new BossRawSearchCollector();
  const observed=vm.runInNewContext(collector.expressions.page,{
    location:{href:PAGE},document:{visibilityState:'visible',body:{innerText:''},
      querySelector:selector=>selector===SEARCH_FRAME ? {
        src:'https://www.zhipin.com/web/frame/search/',contentDocument:{},
        contentWindow:{location:{href:'https://www.zhipin.com/web/passport/zp/verify.html'}}
      } : null}
  });
  assert.equal(observed.iframeLiveUrl,
    'https://www.zhipin.com/web/passport/zp/verify.html',
    'live frame URL must override a stale iframe src when classifying verification');
  collector.session={evaluate:async()=>({url:PAGE,
    iframeSrc:'https://www.zhipin.com/web/frame/search/',frameReady:true,
    login:false,challenge:false,rateLimited:false,visibilityState:'visible'})};
  assert.equal((await collector.assertPage()).url,PAGE);
  collector.session.evaluate=async()=>({url:'https://www.zhipin.com/web/chat/recommend',
    iframeSrc:'https://www.zhipin.com/web/frame/search/',frameReady:true});
  await assert.rejects(collector.assertPage(),
    error=>error.code==='BOSS_PAGE_UNAVAILABLE');
  collector.session.evaluate=async()=>({url:PAGE,
    iframeSrc:'https://www.zhipin.com/web/frame/search/',
    iframeLiveUrl:'https://www.zhipin.com/web/passport/zp/verify.html',
    frameReady:true});
  await assert.rejects(collector.assertPage(),
    error=>error.code==='BOSS_VERIFICATION_REQUIRED');
});

test('search requires exact visible keyword and an official submitted search resource',async()=>{
  const collector=new BossRawSearchCollector();
  collector.assertPage=async()=>({url:PAGE});
  let state={state:'ready',value:TITLE,cardCount:15,safeCardCount:15,
    frameOrigin:1,matchingSearchRequests:2,selectedFiltersReady:true,
    nonDefaultSelected:0,checkedCount:0};
  collector.readOnlyExpression=async expression=>{
    assert.equal(expression,SEARCH_STATE);
    return state;
  };
  assert.match((await collector.selectJob(TITLE)).value,/^search-[a-f0-9]{32}$/);
  state={...state,matchingSearchRequests:0};
  assert.equal((await collector.assertJob(TITLE,searchScope(TITLE))).cardCount,15,
    'same unchanged frame retains the verified submission evidence');
  state={...state,frameOrigin:2};
  await assert.rejects(collector.assertJob(TITLE,searchScope(TITLE)),
    error=>error.code==='BOSS_SEARCH_NOT_SUBMITTED');
  state={...state,value:'成本核算经理',matchingSearchRequests:1};
  await assert.rejects(collector.assertJob(TITLE,searchScope(TITLE)),
    error=>error.code==='BOSS_SEARCH_KEYWORD_MISMATCH');
  state={...state,value:TITLE,safeCardCount:14};
  await assert.rejects(collector.assertJob(TITLE,searchScope(TITLE)),
    error=>error.code==='BOSS_SEARCH_CARD_UNAVAILABLE');
  state={...state,safeCardCount:15,checkedCount:1};
  await assert.rejects(collector.assertJob(TITLE,searchScope(TITLE)),
    error=>error.code==='BOSS_SEARCH_FILTER_UNVERIFIED');
  state={...state,checkedCount:0,activeCustomSliderCount:1};
  await assert.rejects(collector.assertJob(TITLE,searchScope(TITLE)),
    error=>error.code==='BOSS_SEARCH_FILTER_UNVERIFIED',
    'an enabled custom slider must not be hidden behind the default 不限 chip');
});

test('assistant search submits the active job through the official input once',async()=>{
  const collector=new BossRawSearchCollector();
  let state={state:'ready',value:'旧岗位',cardCount:1,safeCardCount:1,
    frameOrigin:7,matchingSearchRequests:0,selectedFiltersReady:true,
    nonDefaultSelected:0,checkedCount:0,activeCustomSliderCount:0};
  const sent=[];
  const clicked=[];
  collector.readOnlyExpression=async expression=>{
    assert.equal(expression,SEARCH_STATE);
    return state;
  };
  collector.readModal=async()=>({active:false});
  collector.assertPage=async()=>({url:PAGE});
  collector.wait=async()=>{};
  collector.session={assertUsableRecruiterWindow:async()=>true,
    clickUnique:async options=>{
      clicked.push(options.selector);
      if(options.selector==='.search-input-wrap .icon-search') {
        state={...state,matchingSearchRequests:1};
      }
    },
    send:async(method,args)=>{
      sent.push(method);
      if(method==='Input.insertText') state={...state,value:args.text};
    }};
  assert.match((await collector.selectJob(TITLE)).value,/^search-[a-f0-9]{32}$/);
  assert.equal(sent.filter(method=>method==='Input.insertText').length,1);
  assert.equal(sent.filter(method=>method==='Input.dispatchKeyEvent').length,4);
  assert.deepEqual(clicked,['input.search-input','.search-input-wrap .icon-search']);
  assert.equal(state.value,TITLE);
});

test('assistant retries a moving search control only before any mouse press',async()=>{
  const collector=new BossRawSearchCollector();
  collector.wait=async()=>{};
  collector.assertPage=async()=>({url:PAGE});
  collector.readModal=async()=>({active:false});
  collector.readOnlyExpression=async()=>({state:'ready',value:TITLE,
    frameOrigin:7,selectedFiltersReady:true,nonDefaultSelected:0,
    checkedCount:0,activeCustomSliderCount:0});
  let clicks=0;
  collector.session={clickUnique:async()=>{
    clicks++;
    if(clicks===1) throw Object.assign(new Error('control moved'),{
      code:'BOSS_CDP_TARGET_UNSTABLE',stage:'pre_click_recheck',
      reason:'position_moved'});
  }};
  await collector.clickStableSearchControl('input.search-input',TITLE,7);
  assert.equal(clicks,2);
});

test('assistant waits through transient hidden search control with unchanged iframe',async()=>{
  const collector=new BossRawSearchCollector();
  collector.wait=async()=>{};
  collector.assertPage=async()=>({url:PAGE});
  collector.readModal=async()=>({active:false});
  collector.readOnlyExpression=async()=>({state:'ready',value:TITLE,
    frameOrigin:7,selectedFiltersReady:true,nonDefaultSelected:0,
    checkedCount:0,activeCustomSliderCount:0});
  let clicks=0;
  collector.session={clickUnique:async()=>{
    clicks++;
    if(clicks<3) throw Object.assign(new Error('rendering'),{
      code:'BOSS_CDP_TARGET_UNSTABLE',stage:'pre_click_recheck',
      reason:'target_not_ready',targetState:'hidden'});
  }};
  await collector.clickStableSearchControl('input.search-input',TITLE,7);
  assert.equal(clicks,3);
});

test('assistant stops retrying when the official search iframe changes',async()=>{
  const collector=new BossRawSearchCollector();
  collector.wait=async()=>{};
  collector.assertPage=async()=>({url:PAGE});
  collector.readModal=async()=>({active:false});
  collector.readOnlyExpression=async()=>({state:'ready',value:TITLE,
    frameOrigin:8,selectedFiltersReady:true,nonDefaultSelected:0,
    checkedCount:0,activeCustomSliderCount:0});
  let clicks=0;
  collector.session={clickUnique:async()=>{
    clicks++;
    throw Object.assign(new Error('control moved'),{
      code:'BOSS_CDP_TARGET_UNSTABLE',stage:'pre_click_recheck',
      reason:'target_not_ready',targetState:'hidden'});
  }};
  await assert.rejects(collector.clickStableSearchControl(
    'input.search-input',TITLE,7),error=>error.reason==='target_not_ready');
  assert.equal(clicks,1);
});

test('assistant does not retry a search control after iframe replacement',async()=>{
  const collector=new BossRawSearchCollector();
  let clicks=0;
  collector.session={clickUnique:async()=>{
    clicks++;
    throw Object.assign(new Error('iframe changed'),{
      code:'BOSS_CDP_TARGET_UNSTABLE',stage:'pre_click_recheck',
      reason:'document_changed'});
  }};
  await assert.rejects(collector.clickStableSearchControl(
    'input.search-input',TITLE,7),
  error=>error.reason==='document_changed');
  assert.equal(clicks,1);
});

test('assistant waits for newly opened official search controls before editing',async()=>{
  const collector=new BossRawSearchCollector();
  const states=[{state:'frame_unavailable'},{state:'input_unavailable'},
    {state:'ready',value:'',selectedFiltersReady:false},
    {state:'ready',value:TITLE,cardCount:2,safeCardCount:2,
      frameOrigin:7,matchingSearchRequests:1,selectedFiltersReady:true,
      nonDefaultSelected:0,checkedCount:0,activeCustomSliderCount:0}];
  let reads=0,waits=0,mutations=0;
  collector.readOnlyExpression=async()=>states[Math.min(reads++,states.length-1)];
  collector.assertPage=async()=>({url:PAGE});
  collector.wait=async()=>{waits++;};
  collector.session={clickUnique:async()=>{mutations++;}};
  assert.match((await collector.selectJob(TITLE)).value,/^search-[a-f0-9]{32}$/);
  assert.equal(waits,3);
  assert.equal(mutations,0);
});

test('assistant search refuses non-default platform filters before editing',async()=>{
  const collector=new BossRawSearchCollector();
  collector.readOnlyExpression=async()=>({state:'ready',value:'旧岗位',
    selectedFiltersReady:true,nonDefaultSelected:1,checkedCount:0,
    activeCustomSliderCount:0});
  collector.readModal=async()=>({active:false});
  let clicked=false;
  collector.session={clickUnique:async()=>{clicked=true;}};
  await assert.rejects(collector.selectJob(TITLE),
    error=>error.code==='BOSS_SEARCH_FILTER_UNVERIFIED');
  assert.equal(clicked,false);
});

test('search extraction accepts complete official DOM resume and rejects blank canvas',async()=>{
  const collector=new BossRawSearchCollector();
  const text=[
    '工作经历：负责企业网络运维五年，维护服务器、交换机和防火墙，处理故障、变更和监控。',
    '教育经历：计算机专业本科毕业，系统学习计算机网络和信息安全。',
    '专业技能：熟悉 Linux、Windows Server、网络设备配置及自动化运维脚本。'
  ].join('\n');
  const url=new URL(RESUME);
  collector.readModal=async()=>({active:true,frameReady:true,text,canvas:false,
    url,scrollTop:0,iframeSrc:RESUME,iframeLiveUrl:RESUME,
    outerOrigin:1,resumeOrigin:2});
  collector.assertJob=async()=>({});
  const direct=await collector.extractResume(Date.now()+1000,
    {title:TITLE,id:TITLE});
  assert.equal(direct.method,'dom');
  assert.equal(direct.text,text);

  let time=0;
  const blank=new BossRawSearchCollector({now:()=>time,wait:async ms=>{time+=ms;}});
  blank.readModal=async()=>({active:true,frameReady:true,text:'',canvas:true,
    canvasWidth:300,canvasHeight:150,url});
  await assert.rejects(blank.extractResume(3000,{title:TITLE,id:TITLE}),
    error=>error.code==='BOSS_CANDIDATE_TIMEOUT' && error.blankCanvas===true);
});

test('search OCR shifts only within the prior viewport when one lazy screen repeats',async()=>{
  let top=0;
  const moves=[];
  const screens={
    0:'工作经历：2020年至今在某公司负责企业网络运维，维护服务器、交换机和防火墙，负责故障处置、变更与监控。',
    700:'工作经历：2020年至今在某公司负责企业网络运维，维护服务器、交换机和防火墙，负责故障处置、变更与监控。',
    850:'教育经历：2016年至2020年在某大学计算机专业完成本科学习。专业技能：熟悉 Linux、Windows Server 和自动化脚本，掌握网络设备配置及信息安全。',
    1495:'项目经历：参与某企业网络升级项目，完成核心交换机迁移、服务器监控建设和故障应急预案优化，保障业务系统运行。'
  };
  const collector=new BossRawSearchCollector({wait:async()=>{},
    ocr:{recognizeTextFromImage:async image=>screens[Number(image.toString())]}});
  collector.readModal=async()=>({active:true,frameReady:true,text:'',canvas:true,
    canvasWidth:777,canvasHeight:905,scrollTop:top,scrollHeight:2400,
    clientHeight:905,url:new URL(RESUME),iframeSrc:RESUME,
    iframeLiveUrl:RESUME,outerOrigin:1,resumeOrigin:2});
  collector.assertJob=async()=>({});
  collector.assertPage=async()=>({url:PAGE,visibilityState:'visible'});
  collector.verifiedCanvas=async()=>({image:Buffer.from(String(top)),fingerprint:`top-${top}`});
  collector.setSearchResumeScrollTop=async value=>{
    moves.push(value);
    top=value;
    return {after:top};
  };
  const result=await collector.extractResume(Date.now()+10_000,
    {title:TITLE,id:searchScope(TITLE)});
  assert.equal(result.method,'ocr');
  assert.deepEqual(moves,[700,850,1495]);
  assert.match(result.text,/教育经历/);
  assert.match(result.text,/项目经历/);
});

test('search OCR reads the verified visible resume when a static Canvas repeats after scrolling',async()=>{
  let top=0;
  const screens={
    canvas:'工作经历：2020年至今负责设备销售与客户维护，跟进合同、交付、验收、回款以及售后服务，持续五年以上。',
    viewport:'教育经历：2016年至2020年在大学完成机械工程本科学习。专业技能：熟悉磁性材料、电机产品和工业客户项目沟通。'
  };
  const collector=new BossRawSearchCollector({wait:async()=>{},
    ocr:{recognizeTextFromImage:async image=>screens[image.toString()]}});
  collector.session={captureSearchResumeViewportPng:async()=>{}};
  collector.readModal=async()=>({active:true,frameReady:true,text:'',canvas:true,
    canvasWidth:777,canvasHeight:905,scrollTop:top,scrollHeight:1605,
    clientHeight:905,url:new URL(RESUME),iframeSrc:RESUME,
    iframeLiveUrl:RESUME,outerOrigin:1,resumeOrigin:2});
  collector.assertJob=async()=>({});
  collector.assertPage=async()=>({url:PAGE,visibilityState:'visible'});
  collector.verifiedCanvas=async()=>({image:Buffer.from('canvas'),
    fingerprint:'same-canvas-pixels'});
  collector.verifiedViewport=async()=>({image:Buffer.from('viewport'),
    fingerprint:`visible-at-${top}`});
  collector.setSearchResumeScrollTop=async value=>{
    top=value;return {after:top};
  };
  const result=await collector.extractResume(Date.now()+10_000,
    {title:TITLE,id:searchScope(TITLE)});
  assert.equal(result.method,'ocr');
  assert.match(result.text,/工作经历/);
  assert.match(result.text,/教育经历/);
  assert.equal(top,700);
});

test('search OCR refuses to bridge an unknown gap when the final screen repeats',async()=>{
  let top=0;
  const moves=[];
  const text='工作经历：负责企业网络运维五年，维护服务器、交换机、防火墙，并处理故障、变更和监控。';
  const collector=new BossRawSearchCollector({wait:async()=>{},
    ocr:{recognizeTextFromImage:async()=>text}});
  collector.readModal=async()=>({active:true,frameReady:true,text:'',canvas:true,
    canvasWidth:777,canvasHeight:905,scrollTop:top,scrollHeight:1605,
    clientHeight:905,url:new URL(RESUME),iframeSrc:RESUME,
    iframeLiveUrl:RESUME,outerOrigin:1,resumeOrigin:2});
  collector.assertJob=async()=>({});
  collector.assertPage=async()=>({url:PAGE,visibilityState:'visible'});
  collector.verifiedCanvas=async()=>({image:Buffer.from(String(top)),fingerprint:`top-${top}`});
  collector.setSearchResumeScrollTop=async value=>{
    moves.push(value);top=value;return {after:top};
  };
  await assert.rejects(collector.extractResume(Date.now()+10_000,
    {title:TITLE,id:searchScope(TITLE)}),
  error=>error.code==='BOSS_RESUME_CANVAS_STALLED');
  assert.deepEqual(moves,[700],
    'there is no further safe scroll when the repeated viewport is at the end');
});

test('search scroll changes only the verified official resume pane once',async()=>{
  const collector=new BossRawSearchCollector({wait:async()=>{}});
  let top=0;
  let writes=0;
  collector.readModal=async()=>({active:true,url:new URL(RESUME),scrollTop:top,
    scrollHeight:2570,clientHeight:905});
  collector.assertPage=async()=>({url:PAGE,visibilityState:'visible'});
  collector.readOnlyExpression=async expression=>{
    assert.equal(expression,SEARCH_CANVAS_IDENTITY);
    return {state:'ready',scrollTop:top,outerOrigin:1,resumeOrigin:2};
  };
  collector.session={evaluate:async expression=>{
    assert.match(expression,/bossRaw:searchScroll/);
    writes++;
    top=500;
    return {state:'ready',after:top};
  }};
  const result=await collector.setSearchResumeScrollTop(500,RESUME);
  assert.equal(result.after,500);
  assert.equal(writes,1);
});
