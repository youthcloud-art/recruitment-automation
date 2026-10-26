const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {BossCardQuarantine} = require('../src/services/bossCardQuarantine');
const {
  BossRawRecommendCollector, normalizeTitle, chooseExactJob,
  officialResumeUrl, candidateIdFromUrl, joinScreenText, repeatedScreenText, hashText,
  verifiedCardName, platformCardAlias, verifiedCardPosition, EXPRESSIONS
} = require('../src/services/bossRawRecommendCollector');

const TITLE = '成本核算经理';
const RESUME = [
  '工作经历：在制造企业担任成本核算经理五年，负责产品成本核算、月末结账及成本差异分析。',
  '教育经历：本科毕业，财务管理专业，具备系统的会计和企业财务知识。',
  '专业技能：熟悉 ERP 系统、标准成本制定、预算分析、财务报表编制。'
].join('\n');
const LONG_CARD = '候选人甲在制造企业担任成本核算经理，负责标准成本、差异分析和月度结账。'.repeat(9);

test('BOSS official card record ID is stored when generic resume iframe has no ID', async () => {
  const records = [];
  const collector = new BossRawRecommendCollector({
    store: { addResume: async record => {
      records.push(record); return { resume: record, created: true };
    } }, queue: { enqueue: () => ({ queued: true }) }
  });
  const captured = { text: RESUME,
    url: new URL('https://www.zhipin.com/web/frame/c-resume/?source=search'), method: 'dom' };
  await collector.saveResume(captured, { title: TITLE, jobRequirements: '本科及以上' },
    '', { sourceCardIdHint: 'expect-verified-123' });
  assert.equal(records[0].sourceCandidateId, 'expect-verified-123');
  await assert.rejects(collector.saveResume(captured,
    { title: TITLE, jobRequirements: '本科及以上' }),
  error => error.code === 'BOSS_PLATFORM_ID_UNAVAILABLE');
  assert.equal(records.length, 1);
});
test('BOSS revisiting an exact historical resume backfills its official card ID', async () => {
  let historical = { id: 'legacy-boss', source: 'boss',
    sourceFingerprint: hashText(RESUME), originalText: RESUME };
  const collector = new BossRawRecommendCollector({
    store: {
      addResume: async () => ({ resume: historical, created: false }),
      updateCandidateMetadata: async (id, changes) => {
        assert.equal(id, 'legacy-boss');
        historical = { ...historical, ...changes };
        return historical;
      }
    }, queue: { enqueue: () => ({ queued: true }) }
  });
  const captured = { text: RESUME,
    url: new URL('https://www.zhipin.com/web/frame/c-resume/?source=search'), method: 'dom' };
  const result = await collector.saveResume(captured,
    { title: TITLE, jobRequirements: '本科及以上' }, '',
    { sourceCardIdHint: 'expect-verified-123' });
  assert.equal(result.created, false);
  assert.equal(historical.sourceCandidateId, 'expect-verified-123');
  assert.equal(historical.sourceCandidateIdSource, 'platform_card');
});
const TITLELESS_OCR_PAGES = new Map([
  [0,'2020年3月-2024年9月，某制造公司成本核算经理，负责产品成本归集与月度结账，管理多工厂的材料耗用核对，制定成本差异分析流程，协调仓库和生产团队逐月核验出入库单据，完成经营报表。针对材料价格波动建立月度追踪台账，汇总产品单位成本变化，向财务负责人说明异常项目并跟进整改。'],
  [700,'2018年6月-2020年2月，某工业集团财务主管，参与年度预算和标准成本制定，实施 ERP 成本模块上线，优化成本中心分摊口径，协助业务部门复核库存和采购数据，持续分析毛利变化。每季度与供应链团队核对采购价格和生产损耗，编制管理层需要的分析材料，追踪预算执行情况。'],
  [1400,'某大学本科财务管理专业毕业，熟悉 ERP 系统和 Excel 数据处理，掌握财务报表编制、预算分析和成本核算方法，能够向业务负责人解释差异原因，并持续建设核算流程。能够独立整理原始业务数据、编制多维度分析表，配合审计和财务团队完成相关资料核验。'],
  [1701,'持续关注制造企业业务流程和数据质量，协助管理层核对经营目标完成情况，参与跨部门沟通，推进成本中心和项目维度的数据整理。熟悉材料成本与人工费用归集，完成月度差异复盘和预算执行说明。']
]);

function fakeSession({ unknownModal = false, duplicate = false, canvasOnly = false,
  blankCanvas = false, multiPage = false, preservedScroll = false,
  lazyDrawAfterReads = 0, multiPageMax = 1701, closeDelayReads = 0,
  cardText = '候选人甲 5年成本核算工作经验',duplicateCards = false,
  cardTexts = null,initialHidden = false,staysHidden = false,
  delayedCardReads = 0,
  genericTransitionReads = 0,cardMetadata = {},guideModal = false,
  guideChallenge = false,unknownTopOverlay = false,
  guideCloseDelayReads = 0,guideAfterResumeClose = false,
  hideWhenGuideAppears = false,guideOnCardOpens = [],
  noResumeOnCardOpens = [],preOpenTimeoutCardTexts = [],
  obscuredClickCardTexts = [],
  uncertainClickCardTexts = [],windowPreflightError = '' } = {}) {
  const state = { selected:'财务总监 _ 惠州', jobId:'other', dropdown:false,
    modal:false, clicks:[], closed:false, greetClicked:false,scrollTop:0,openCount:0,
    modalReads:0,scrollTargets:[],closeClicks:0,closingReads:0,closing:false,
    cardText,visibilityState:initialHidden ? 'hidden' : 'visible',cdpCommands:[],
    genericPending:0,guideModal,guideChallenge,unknownTopOverlay,
    cardReads:0,windowChecks:0,
    guideCloseClicks:0,guideClosing:false,guideClosingReads:0 };
  const session = {
    state,
    async evaluate(expression) {
      if (expression === EXPRESSIONS.page) return {
        url:'https://www.zhipin.com/web/chat/recommend',
        // BOSS keeps this original attribute at null after SPA navigation.
        iframeSrc:'https://www.zhipin.com/web/frame/recommend/?jobid=null',
        frameReady:true,login:false,challenge:false,
        visibilityState:state.visibilityState
      };
      if (expression === EXPRESSIONS.job) return {selectedLabel:state.selected,
        jobId:state.jobId,options:[
          {label:'财务总监 _ 惠州',value:'other'},
          {label:'成本核算经理 _ 惠州 12-15K',value:'cost-job'}
        ]};
      if (expression === EXPRESSIONS.cards && ++state.cardReads <= delayedCardReads) return [];
      if (expression === EXPRESSIONS.cards) return (cardTexts ||
        (duplicateCards ? [cardText,cardText] : [cardText]))
        .map(text => ({text,...cardMetadata}));
      if (expression === EXPRESSIONS.canvasIdentity) return {
        state:'ready',resumeUrl:'https://www.zhipin.com/web/frame/c-resume/?expectId=geek-1',
        scrollTop:state.scrollTop,width:900,height:1500,
        outerOrigin:1,resumeOrigin:2
      };
      if (expression === EXPRESSIONS.guide) {
        if (state.guideClosing && ++state.guideClosingReads > guideCloseDelayReads) {
          state.guideModal = false;
          state.guideClosing = false;
        }
        return state.guideModal || state.unknownTopOverlay
          ? {active:true,eligible:state.guideModal && !guideChallenge,
            challenge:state.guideModal && guideChallenge}
          : {active:false};
      }
      if (expression === EXPRESSIONS.modal) {
        if (state.closing && ++state.closingReads > closeDelayReads) {
          state.modal = false;
          state.closing = false;
          state.genericPending = genericTransitionReads;
          if (guideAfterResumeClose) {
            state.guideModal = true;
            if (hideWhenGuideAppears) state.visibilityState = 'hidden';
          }
        }
        if (state.guideModal || state.unknownTopOverlay) return {
          active:true,transient:true,iframeSrc:'',frameReady:false
        };
        if (!state.modal && state.genericPending > 0) {
          state.genericPending--;
          return {active:true,transient:true,iframeSrc:'',frameReady:false};
        }
        if (!state.modal) return {active:false};
        state.modalReads++;
        const waitingForDraw = state.modalReads < lazyDrawAfterReads;
        return {active:true,frameReady:true,canvas:canvasOnly || blankCanvas || multiPage,
          text:canvasOnly || blankCanvas || multiPage ? '' : RESUME,
          canvasWidth:waitingForDraw || blankCanvas ? 300 : canvasOnly || multiPage ? 900 : 0,
          canvasHeight:waitingForDraw || blankCanvas ? 150 : canvasOnly || multiPage ? 1500 : 0,
          scrollTop:state.scrollTop,scrollHeight:multiPage ? multiPageMax+885 : 885,clientHeight:885,
          iframeSrc:unknownModal
            ? 'https://www.zhipin.com/web/passport/zp/verify.html'
            : 'https://www.zhipin.com/web/frame/c-resume/?expectId=geek-1'};
      }
      if (expression.includes('bossRaw:scroll')) return true;
      throw new Error('unexpected evaluate');
    },
    async scrollUnique(options) {
      state.clicks.push(`scroll:${options.selector}`);
      if (options.selector === 'li.card-item' &&
          preOpenTimeoutCardTexts.includes(options.identityValue)) {
        const error=new Error('CDP timeout');
        error.code='BOSS_CDP_TIMEOUT';
        throw error;
      }
    },
    async assertRecruiterReady() { return 'https://www.zhipin.com/web/chat/recommend'; },
    async assertUsableRecruiterWindow() {
      state.windowChecks++;
      if (windowPreflightError) {
        const error = new Error('BOSS 招聘窗口可视区域不足');
        error.code = windowPreflightError;
        throw error;
      }
    },
    async send(method,params) {
      state.cdpCommands.push({method,params});
      if (method === 'Page.bringToFront' && !staysHidden) {
        state.visibilityState = 'visible';
      }
      return {};
    },
    async revealOfficialResumeClose(options) {
      assert.equal(options.frameSelector,'iframe[src*="/web/frame/recommend/"]');
      state.clicks.push('reveal:official-close');
    },
    async captureCanvasPng() {
      throw new Error('Canvas may display a stale page after scrolling');
    },
    async captureRegionPng(options) {
      assert.equal(options.frameSelector,'iframe[src*="/web/frame/recommend/"]');
      assert.equal(options.selector,'.dialog-wrap.active .resume-detail-wrap');
      return Buffer.from(multiPage ? `frame ${state.scrollTop}` : 'fake screenshot');
    },
    async scrollOfficialResume({deltaY}) {
      throw new Error(`Unexpected smooth wheel scroll: ${deltaY}`);
    },
    async setOfficialResumeScrollTop({targetTop}) {
      assert.ok(targetTop <= multiPageMax);
      const before = state.scrollTop;
      state.scrollTop = targetTop;
      state.scrollTargets.push(targetTop);
      return {before,after:state.scrollTop,max:multiPageMax};
    },
    async clickUnique(options) {
      state.clicks.push(options.selector);
      if (options.selector === '.ui-dropmenu-label') state.dropdown = true;
      else if (options.selector.includes('.job-item')) {
        assert.equal(state.dropdown,true);
        assert.equal(options.identityValue,'cost-job');
        state.selected = '成本核算经理 _ 惠州 12-15K';
        state.jobId = 'cost-job';
      } else if (options.selector === 'li.card-item') {
        if (obscuredClickCardTexts.includes(options.identityValue)) {
          const error=new Error('BOSS 点击目标不可用：obscured');
          error.code='BOSS_CDP_TARGET_UNAVAILABLE';
          error.stage='pre_click_probe';
          error.targetState='obscured';
          throw error;
        }
        if (uncertainClickCardTexts.includes(options.identityValue)) {
          const error=new Error('click ack uncertain');
          error.code='BOSS_CDP_CLICK_UNCERTAIN';
          throw error;
        }
        assert.equal(options.identityAttribute,'textContent');
        assert.ok((cardTexts || [cardText]).includes(options.identityValue));
        state.openCount++;
        if (guideOnCardOpens.includes(state.openCount)) {
          state.guideModal = true;
          state.modal = false;
          if (hideWhenGuideAppears) state.visibilityState = 'hidden';
        } else state.modal = !noResumeOnCardOpens.includes(state.openCount);
        state.scrollTop = preservedScroll && state.openCount === 1 ? 100 : 0;
      } else if (options.selector.includes('.close-btn')) {
        state.closeClicks++;
        state.closing = true;
      } else if (options.selector ===
          'div[data-type="boss-dialog"].active .anonymous-geek-guide-list-wrapper .boss-popup__close') {
        state.guideCloseClicks++;
        state.guideClosing = true;
      }
      else if (options.selector.includes('greet')) state.greetClicked = true;
    },
    close() { state.closed = true; }
  };
  const store = { records:[],async addResume(record) {
    this.records.push(record);
    return {created:!duplicate,resume:{id:'resume-1',source:'boss'}};
  }};
  const queue = { records:[],enqueue(resume,job) { this.records.push({resume,job}); }};
  return {session,state,store,queue};
}

test('recommendation job matching is exact and unique', () => {
  assert.equal(normalizeTitle('成本核算经理 _ 惠州 12-15K'), TITLE);
  assert.equal(chooseExactJob([{label:'成本核算主管 _ 惠州',value:'a'},
    {label:'成本核算经理 _ 惠州',value:'b'}],TITLE).value,'b');
  assert.throws(() => chooseExactJob([
    {label:'成本核算经理 _ 惠州',value:'a'},
    {label:'成本核算经理 _ 深圳',value:'b'}],TITLE),
  {code:'BOSS_RECOMMENDED_JOB_UNAVAILABLE'});
});

test('job probe uses live same-origin iframe URL when src attribute is stale', () => {
  const option = {getAttribute:() => 'cost-job',querySelector:() => null,
    textContent:'成本核算经理 _ 惠州 12-15K'};
  const frame = {
    src:'https://www.zhipin.com/web/frame/recommend/?jobid=null',
    contentWindow:{location:{href:'https://www.zhipin.com/web/frame/recommend/?jobid=cost-job'}},
    contentDocument:{
      querySelector:() => ({textContent:'成本核算经理 _ 惠州 12-15K'}),
      querySelectorAll:() => [option]
    }
  };
  const document = {querySelector:() => frame};
  const state = vm.runInNewContext(EXPRESSIONS.job,{document,URL});
  assert.equal(state.jobId,'cost-job');
  assert.equal(state.selectedLabel,'成本核算经理 _ 惠州 12-15K');
  frame.contentWindow.location.href = 'https://example.com/web/frame/recommend/?jobid=cost-job';
  assert.equal(vm.runInNewContext(EXPRESSIONS.job,{document,URL}),null);
});

test('official card metadata comes only from exact unique name and expected-job nodes', () => {
  const card = (nameValues,expectedValues) => ({
    textContent:'候选人卡片完整内容',
    querySelectorAll(selector) {
      const values = selector === '.row.name-wrap > span.name' ? nameValues
        : selector === '.row.expect-wrap .join-text-wrap > span' ? expectedValues : [];
      return values.map(textContent => ({textContent}));
    }
  });
  const cards = [card(['张三'],['惠州','成本核算经理']),
    card(['李四'],[]),card(['王五','赵六'],['惠州','会计'])];
  const document = {querySelector:() => ({contentDocument:{querySelectorAll:() => cards}})};
  const result = vm.runInNewContext(EXPRESSIONS.cards,{document});
  assert.equal(result.totalCount,3);
  assert.equal(result.cards[0].displayName,'张三');
  assert.equal(result.cards[0].expectedPosition,'成本核算经理');
  assert.equal(result.cards[1].displayName,'李四');
  assert.equal(result.cards[1].expectedPosition,'');
  assert.equal(result.cards[2].displayName,'');
});

test('recommendation card window advances beyond a retained 1000-card DOM',()=>{
  const cards=Array.from({length:1001},(_,index)=>({
    textContent:`候选人 ${index}`,querySelectorAll:()=>[]
  }));
  const document={querySelector:()=>({contentDocument:{querySelectorAll:()=>cards}})};
  const collector=new BossRawRecommendCollector();
  const first=vm.runInNewContext(collector.cardExpressionForWindow(),{document});
  assert.equal(first.totalCount,1001);
  assert.equal(first.cards.length,1000);
  collector.cardWindowTotal=first.totalCount;
  assert.equal(collector.advanceCardWindowIfNeeded(),true);
  assert.equal(collector.cardWindowStart,800);
  const next=vm.runInNewContext(collector.cardExpressionForWindow(),{document});
  assert.equal(next.cards.length,201);
  assert.equal(next.cards.at(-1).text,'候选人 1000');
});

test('a virtualized list shrinking below the current card window is rescanned once',async()=>{
  const collector=new BossRawRecommendCollector();
  collector.cardWindowStart=800;
  collector.assertCandidateListJob=async()=>{};
  const expressions=[];
  collector.readOnlyExpression=async expression=>{
    expressions.push(expression);
    return expressions.length===1
      ? {totalCount:19,cards:[]}
      : {totalCount:19,cards:[{text:'新出现的候选人'}]};
  };
  const cards=await collector.readCandidateCards('IT网络运维','job','/web/chat/recommend');
  assert.deepEqual(cards,[{text:'新出现的候选人'}]);
  assert.equal(collector.cardWindowStart,0);
  assert.equal(collector.cardWindowTotal,19);
  assert.equal(expressions.length,2,'a shrink permits one bounded head reread');
});

test('official card name and job validators reject single-character OCR artifacts', () => {
  assert.equal(verifiedCardName('张三'),'张三');
  assert.equal(verifiedCardName('张'),'');
  assert.equal(verifiedCardName('张先生'),'');
  assert.deepEqual(platformCardAlias('涂**'), {value:'涂**',type:'masked'});
  assert.deepEqual(platformCardAlias('张先生'), {value:'张先生',type:'honorific'});
  assert.equal(platformCardAlias('张三'), null);
  assert.equal(verifiedCardPosition('成本核算经理'),'成本核算经理');
  assert.equal(verifiedCardPosition('经'),'');
  assert.equal(verifiedCardPosition('不限'),'');
});

test('masked BOSS card label is saved as a platform alias, not a verified name', async () => {
  const {session,store} = fakeSession({cardMetadata:{
    displayName:'涂**',expectedPosition:'销售工程师'
  }});
  const collector = new BossRawRecommendCollector({
    connect:async () => session,store,queue:{enqueue() {}},
    jobService:{current:() => ({title:TITLE,jobRequirements:'销售经验'})},
    wait:async () => {}
  });
  const result = await collector.collect({targetCount:1});
  assert.equal(result.state,'completed');
  assert.equal(store.records[0].name,null);
  assert.equal(store.records[0].nameSource,'unverified');
  assert.equal(store.records[0].platformAlias,'涂**');
  assert.equal(store.records[0].platformAliasType,'masked');
});

test('validated official card metadata overrides one-character OCR fields at save', async () => {
  const {session,store} = fakeSession({cardMetadata:{
    displayName:'张三',expectedPosition:'成本核算经理'
  }});
  const collector = new BossRawRecommendCollector({
    connect:async () => session,store,queue:{enqueue() {}},
    jobService:{current:() => ({title:TITLE,jobRequirements:'本科，三年以上成本核算经验'})},
    wait:async () => {}
  });
  const result = await collector.collect({targetCount:1});
  assert.equal(result.state,'completed');
  assert.equal(store.records[0].name,'张三');
  assert.equal(store.records[0].expectedPosition.position,'成本核算经理');
  assert.equal(store.records[0].nameSource,'boss_recommend_card');
  assert.equal(store.records[0].positionSource,'boss_recommend_card');
});

test('unlabelled BOSS OCR line prefix is not saved as candidate name', async () => {
  const {session,store} = fakeSession();
  const collector = new BossRawRecommendCollector({
    connect:async () => session,store,queue:{enqueue() {}},
    jobService:{current:() => ({title:TITLE,jobRequirements:'本科，三年以上成本核算经验'})},
    wait:async () => {}
  });
  const result = await collector.collect({targetCount:1});
  assert.equal(result.state,'completed');
  assert.equal(store.records.length,1);
  assert.equal(store.records[0].name,null);
  assert.equal(store.records[0].nameSource,'unverified');
  assert.equal(store.records[0].originalText,RESUME);
});

test('collector does not reopen job menu when live URL already matches', async () => {
  const {session,state,store} = fakeSession();
  state.selected = '成本核算经理 _ 惠州 12-15K';
  state.jobId = 'cost-job';
  const collector = new BossRawRecommendCollector({
    connect:async () => session,store,queue:{enqueue() {}},
    jobService:{current:() => ({title:TITLE,jobRequirements:'本科，三年以上成本核算经验'})},
    wait:async () => {}
  });
  const result = await collector.collect({targetCount:1});
  assert.equal(result.state,'completed');
  assert.equal(store.records.length,1);
  assert.equal(state.clicks.includes('.ui-dropmenu-label'),false);
});

test('collector waits for recommendation cards after a verified job switch', async () => {
  const {session,state,store} = fakeSession({delayedCardReads:3});
  const collector = new BossRawRecommendCollector({
    connect:async () => session,store,queue:{enqueue() {}},
    jobService:{current:() => ({title:TITLE,jobRequirements:'本科，三年以上成本核算经验'})},
    wait:async () => {}
  });
  const result = await collector.collect({targetCount:1});
  assert.equal(result.state,'completed');
  assert.equal(store.records.length,1);
  assert.ok(state.cardReads >= 4);
  assert.equal(state.clicks.includes('li.card-item'),true);
});

test('collector checks the browser viewport before selecting a job or opening a candidate', async () => {
  const {session,state,store} = fakeSession({windowPreflightError:'BOSS_CDP_VIEWPORT_TOO_SMALL'});
  const collector = new BossRawRecommendCollector({
    connect:async () => session,store,queue:{enqueue() {}},
    jobService:{current:() => ({title:TITLE,jobRequirements:'本科，三年以上成本核算经验'})},
    wait:async () => {}
  });
  const result = await collector.collect({targetCount:1});
  assert.equal(result.state,'paused');
  assert.equal(result.lastFailureCode,'BOSS_CDP_VIEWPORT_TOO_SMALL');
  assert.equal(state.windowChecks,1);
  assert.deepEqual(state.clicks,[]);
  assert.equal(store.records.length,0);
});

test('hidden owned recruiter page is activated and confirmed visible before opening card', async () => {
  const {session,state,store} = fakeSession({initialHidden:true});
  const collector = new BossRawRecommendCollector({
    connect:async () => session,store,queue:{enqueue() {}},
    jobService:{current:() => ({title:TITLE,jobRequirements:'本科，三年以上成本核算经验'})},
    wait:async () => {}
  });
  const result = await collector.collect({targetCount:1});
  assert.equal(result.state,'completed');
  assert.equal(store.records.length,1);
  assert.deepEqual(state.cdpCommands,[
    {method:'Page.setWebLifecycleState',params:{state:'active'}},
    {method:'Emulation.setFocusEmulationEnabled',params:{enabled:true}},
    {method:'Page.bringToFront',params:{}}
  ]);
  assert.equal(state.visibilityState,'visible');
});

test('collector pauses before candidate click when owned page stays hidden', async () => {
  const {session,state,store} = fakeSession({initialHidden:true,staysHidden:true});
  const collector = new BossRawRecommendCollector({
    connect:async () => session,store,queue:{enqueue() {}},
    jobService:{current:() => ({title:TITLE,jobRequirements:'本科，三年以上成本核算经验'})},
    wait:async () => {}
  });
  const result = await collector.collect({targetCount:1});
  assert.equal(result.state,'paused');
  assert.equal(result.lastFailureCode,'BOSS_PAGE_HIDDEN');
  assert.equal(store.records.length,0);
  assert.equal(state.clicks.includes('li.card-item'),false);
  assert.equal(state.cdpCommands.length,3);
});

test('recent unique long official card with a complete indexed resume skips repeat OCR', async () => {
  const {session,state,store} = fakeSession({cardText:LONG_CARD,
    cardMetadata:{displayName:'涂**'}});
  const fingerprint = hashText(`cost-job\n${LONG_CARD}`);
  let lookups = 0;
  const updates=[];
  const queued = [];
  store.updateCandidateMetadata=async (id,changes)=>{
    updates.push([id,changes]);
    return {id,source:'boss',...changes};
  };
  store.findBossCardMatch = async value => {
    lookups++;
    assert.equal(value,fingerprint);
    return {id:'existing',source:'boss',sourceCardFingerprint:fingerprint,
      sourceFingerprint:hashText(RESUME),parseStatus:'completed',
      originalText:RESUME,createdAt:new Date().toISOString(),
      matchEvaluation:{jobRequirements:'旧岗位要求'}};
  };
  const collector = new BossRawRecommendCollector({
    connect:async () => session,store,queue:{enqueue(resume,job) {
      queued.push([resume.id,job.jobRequirements]);
      return {queued:true};
    }},
    jobService:{current:() => ({title:TITLE,jobRequirements:'本科，三年以上成本核算经验'})},
    wait:async () => {}
  });
  const result = await collector.collect({targetCount:1});
  assert.equal(result.state,'partial');
  assert.equal(result.saved,0);
  assert.equal(result.skipped,1);
  assert.equal(store.records.length,0);
  assert.ok(lookups >= 1);
  assert.equal(state.clicks.includes('li.card-item'),false);
  assert.deepEqual(updates,[['existing',{
    platformAlias:'涂**',platformAliasType:'masked'
  }]]);
  assert.deepEqual(queued,[['existing','本科，三年以上成本核算经验']]);
});

test('short teaser never uses the OCR skip hint', async () => {
  const {session,state,store} = fakeSession({cardText:'候选人甲 5年成本核算工作经验'});
  let lookups = 0;
  store.findBossCardMatch = () => { lookups++; return {id:'existing'}; };
  const collector = new BossRawRecommendCollector({
    connect:async () => session,store,queue:{enqueue() {}},
    jobService:{current:() => ({title:TITLE,jobRequirements:'本科，三年以上成本核算经验'})},
    wait:async () => {}
  });
  const result = await collector.collect({targetCount:1});
  assert.equal(result.state,'completed');
  assert.equal(store.records.length,1);
  assert.equal(lookups,0);
  assert.equal(state.clicks.includes('li.card-item'),true);
});

test('known BOSS card without a stored platform ID is revisited instead of skipped', async () => {
  const { session, state, store } = fakeSession({ cardText: LONG_CARD,
    cardMetadata: { sourceCardIdHint: 'expect-verified-123' } });
  store.findBossCardMatch = () => ({ id: 'historical', source: 'boss',
    sourceCardFingerprint: hashText(`cost-job\n${LONG_CARD}`),
    sourceFingerprint: hashText(RESUME), parseStatus: 'completed',
    originalText: RESUME, createdAt: new Date().toISOString() });
  const collector = new BossRawRecommendCollector({ connect: async () => session,
    store, queue: { enqueue: () => ({ queued: true }) },
    jobService: { current: () => ({ title: TITLE,
      jobRequirements: '本科，三年以上成本核算经验' }) }, wait: async () => {} });
  const result = await collector.collect({ targetCount: 1 });
  assert.equal(result.state, 'completed');
  assert.equal(store.records.length, 1);
  assert.equal(state.clicks.includes('li.card-item'), true);
});

test('same-text official cards report ambiguity without merging or clicking', async () => {
  const {session,state,store} = fakeSession({cardText:LONG_CARD,duplicateCards:true});
  let lookups = 0;
  store.findBossCardMatch = () => { lookups++; return {id:'existing'}; };
  const collector = new BossRawRecommendCollector({
    connect:async () => session,store,queue:{enqueue() {}},
    jobService:{current:() => ({title:TITLE,jobRequirements:'本科，三年以上成本核算经验'})},
    wait:async () => {}
  });
  const result = await collector.collect({targetCount:1});
  assert.equal(result.state,'partial');
  assert.equal(result.lastFailureCode,'BOSS_CARD_IDENTITY_AMBIGUOUS');
  assert.equal(result.skipped,2);
  assert.equal(store.records.length,0);
  assert.equal(lookups,0);
  assert.equal(state.clicks.includes('li.card-item'),false);
});

test('historical duplicate receives card index only after full-resume identity matches', async () => {
  const {session,store} = fakeSession({cardText:LONG_CARD});
  const fingerprint = hashText(`cost-job\n${LONG_CARD}`);
  const updates = [];
  const queued = [];
  store.findBossCardMatch = () => null;
  store.addResume = async () => ({created:false,resume:{id:'historical',source:'boss',
    sourceFingerprint:hashText(RESUME),sourceCardFingerprint:''}});
  store.updateCandidateMetadata = async (id,changes) => {
    updates.push({id,changes});
    return {id,...changes};
  };
  const collector = new BossRawRecommendCollector({
    connect:async () => session,store,queue:{enqueue(resume,job) {
      queued.push([resume.id,job.jobRequirements]);
      return {queued:true};
    }},
    jobService:{current:() => ({title:TITLE,jobRequirements:'本科，三年以上成本核算经验'})},
    wait:async () => {}
  });
  const result = await collector.collect({targetCount:1});
  assert.equal(result.state,'partial');
  assert.deepEqual(updates,[
    {id:'historical',changes:{sourceCandidateId:'geek-1',sourceCandidateIdSource:'official_url'}},
    {id:'historical',changes:{sourceCardFingerprint:fingerprint}}
  ]);
  assert.deepEqual(queued,[['historical','本科，三年以上成本核算经验']]);
});

test('only official BOSS resume frame supplies candidate ID', () => {
  assert.equal(candidateIdFromUrl(officialResumeUrl(
    'https://www.zhipin.com/web/frame/c-resume/?expectId=abc_123')), 'abc_123');
  assert.equal(officialResumeUrl('https://www.zhipin.com/web/passport/zp/verify.html'),null);
  assert.equal(officialResumeUrl('https://other.example/web/frame/c-resume'),null);
});

test('screen text removes only a substantial exact overlap', () => {
  const overlap = '成本核算经历和学历背景详细说明'.repeat(4);
  assert.equal(joinScreenText([`第一页${overlap}`,`${overlap}第二页`]),
    `第一页${overlap}\n第二页`);
  assert.equal(joinScreenText(['工作经验甲','工作经验乙']),
    '工作经验甲\n工作经验乙');
});

test('Canvas OCR fallback rejects blank and near-duplicate screen text', () => {
  const prior='工作经历：负责制造企业成本核算、月末结账及差异分析。'.repeat(8);
  assert.equal(repeatedScreenText('  ',[prior]),true);
  assert.equal(repeatedScreenText('无法识别',[prior]),true);
  assert.equal(repeatedScreenText(prior,[prior]),true);
  assert.equal(repeatedScreenText(`${prior}，。`,[prior]),true);
  assert.equal(repeatedScreenText('教育经历：本科财务管理专业，熟悉 ERP 系统和财务报表编制，具备完整的预算管理和数据分析经验。',[prior]),false);
});

test('collector confirms exact posted job, saves one validated resume, queues evaluation', async () => {
  const {session,state,store,queue} = fakeSession();
  const collector = new BossRawRecommendCollector({
    connect:async () => session,store,queue,
    jobService:{current:() => ({title:TITLE,jobRequirements:'本科，三年以上成本核算经验'})},
    wait:async () => {}
  });
  const result = await collector.collect({targetCount:1});
  assert.equal(result.state,'completed');
  assert.equal(result.saved,1);
  assert.equal(store.records.length,1);
  assert.equal(store.records[0].sourceCandidateId,'geek-1');
  assert.equal(store.records[0].sourceCardFingerprint,
    hashText('cost-job\n候选人甲 5年成本核算工作经验'));
  assert.equal(store.records[0].source,'boss');
  assert.equal(store.records[0].originalText,RESUME);
  assert.equal(queue.records.length,1);
  assert.equal(state.greetClicked,false);
  assert.equal(state.closed,true);
});

test('collector accepts a verified full multi-page OCR timeline when section headings are unreadable', async () => {
  const {session,state,store,queue} = fakeSession({multiPage:true});
  const collector = new BossRawRecommendCollector({
    connect:async () => session,store,queue,
    ocr:{recognizeTextFromImage:async () => TITLELESS_OCR_PAGES.get(state.scrollTop),
      destroy:async () => {}},
    jobService:{current:() => ({title:TITLE,jobRequirements:'本科，三年以上成本核算经验'})},
    wait:async () => {}
  });
  const result = await collector.collect({targetCount:1});
  assert.equal(result.state,'completed');
  assert.equal(result.saved,1);
  assert.deepEqual(state.scrollTargets,[700,1400,1701]);
  assert.equal(store.records.length,1);
  assert.equal(queue.records.length,1);
});

test('pre-open CDP timeout skips only the verified card and continues to the next', async () => {
  const cards=['候选卡一 财务与制造业成本经验','候选卡二 成本核算经理经验'];
  const {session,state,store} = fakeSession({cardTexts:cards,
    preOpenTimeoutCardTexts:[cards[0]]});
  const collector = new BossRawRecommendCollector({
    connect:async () => session,store,queue:{enqueue() {}},
    jobService:{current:() => ({title:TITLE,jobRequirements:'本科，三年以上成本核算经验'})},
    wait:async () => {}
  });
  const result = await collector.collect({targetCount:1});
  assert.equal(result.state,'completed');
  assert.equal(result.attempted,2);
  assert.equal(result.skipped,1);
  assert.equal(result.saved,1);
  assert.equal(state.openCount,1);
  assert.equal(store.records.length,1);
});

test('two obscured exact card targets pause before mass skipping the recommendation list', async () => {
  const cards=['候选卡一 财务与制造业成本经验','候选卡二 成本核算经理经验',
    '候选卡三 成本管理经验'];
  const {session,state,store}=fakeSession({cardTexts:cards,
    obscuredClickCardTexts:cards});
  const collector=new BossRawRecommendCollector({
    connect:async()=>session,store,queue:{enqueue() {}},
    jobService:{current:()=>({title:TITLE,jobRequirements:'本科，三年以上成本核算经验'})},
    wait:async()=>{}
  });
  const result=await collector.collect({targetCount:1});
  assert.equal(result.state,'paused');
  assert.equal(result.lastFailureCode,'BOSS_CDP_TARGET_UNAVAILABLE');
  assert.equal(result.pausedAtPhase,'opening_candidate');
  assert.equal(result.attempted,2);
  assert.equal(result.skipped,1);
  assert.equal(result.saved,0);
  assert.equal(state.openCount,0);
  assert.equal(store.records.length,0);
  assert.equal(state.clicks.filter(value=>value==='li.card-item').length,2);
});

test('a single obscured card can be skipped after read-only checks and the next card captured', async () => {
  const cards=['候选卡一 财务与制造业成本经验','候选卡二 成本核算经理经验'];
  const {session,state,store}=fakeSession({cardTexts:cards,
    obscuredClickCardTexts:[cards[0]]});
  const collector=new BossRawRecommendCollector({
    connect:async()=>session,store,queue:{enqueue() {}},
    jobService:{current:()=>({title:TITLE,jobRequirements:'本科，三年以上成本核算经验'})},
    wait:async()=>{}
  });
  const result=await collector.collect({targetCount:1});
  assert.equal(result.state,'completed');
  assert.equal(result.attempted,2);
  assert.equal(result.skipped,1);
  assert.equal(result.saved,1);
  assert.equal(state.openCount,1);
  assert.equal(store.records.length,1);
});

test('five consecutive candidate processing failures pause before consuming a large list', async () => {
  const cards=Array.from({length:12},(_,index)=>`候选卡 ${index} 成本核算经历`);
  const {session,state,store}=fakeSession({cardTexts:cards});
  const collector=new BossRawRecommendCollector({
    connect:async()=>session,store,queue:{enqueue() {}},
    jobService:{current:()=>({title:TITLE,jobRequirements:'本科，三年以上成本核算经验'})},
    wait:async()=>{}
  });
  collector.extractResume=async()=>{
    const error=new Error('invalid resume content');
    error.code='BOSS_RESUME_CONTENT_INVALID';
    throw error;
  };
  const result=await collector.collect({targetCount:1});
  assert.equal(result.state,'paused');
  assert.equal(result.lastFailureCode,'BOSS_RESUME_CONTENT_INVALID');
  assert.equal(result.attempted,5);
  assert.equal(result.skipped,4);
  assert.equal(result.saved,0);
  assert.equal(state.openCount,5);
  assert.equal(store.records.length,0);
});

test('uncertain click acknowledgement never becomes a pre-open skip', async () => {
  const card='候选卡一 财务与制造业成本经验';
  const {session,state,store} = fakeSession({cardText:card,
    uncertainClickCardTexts:[card]});
  const collector = new BossRawRecommendCollector({
    connect:async () => session,store,queue:{enqueue() {}},
    jobService:{current:() => ({title:TITLE,jobRequirements:'本科，三年以上成本核算经验'})},
    wait:async () => {}
  });
  const result = await collector.collect({targetCount:1});
  assert.equal(result.state,'paused');
  assert.equal(result.lastFailureCode,'BOSS_CDP_CLICK_UNCERTAIN');
  assert.equal(result.skipped,0);
  assert.equal(state.openCount,0);
  assert.equal(store.records.length,0);
});

test('CDP timeout after confirmed card open remains a hard pause', async () => {
  const {session,state,store} = fakeSession();
  const marked=[];
  const collector = new BossRawRecommendCollector({
    connect:async () => session,store,queue:{enqueue() {}},
    quarantine:{has:()=>false,mark:(jobId,cardHash,code)=>
      marked.push({jobId,cardHash,code})},
    jobService:{current:() => ({title:TITLE,jobRequirements:'本科，三年以上成本核算经验'})},
    wait:async () => {}
  });
  collector.extractResume=async()=>{
    const error=new Error('CDP timeout');
    error.code='BOSS_CDP_TIMEOUT';
    error.stage='capture_screenshot';
    throw error;
  };
  const result = await collector.collect({targetCount:1});
  assert.equal(result.state,'paused');
  assert.equal(result.lastFailureCode,'BOSS_CDP_TIMEOUT');
  assert.equal(result.skipped,0);
  assert.equal(result.pausedAtPhase,'opening_candidate');
  assert.equal(result.pausedAtStage,'capture_screenshot');
  assert.deepEqual(marked,[{jobId:'cost-job',
    cardHash:hashText('cost-job\n候选人甲 5年成本核算工作经验'),
    code:'BOSS_CDP_TIMEOUT'}]);
  assert.equal(state.openCount,1);
  assert.equal(state.closeClicks,1);
  assert.equal(store.records.length,0);
});

test('after-open timeout quarantines only that job/card across collector instances', async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boss-collector-quarantine-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'quarantine.json');
  const cards=['卡片一 成本核算经历','卡片二 成本核算经历'];
  const first=fakeSession({cardTexts:cards});
  const firstCollector=new BossRawRecommendCollector({
    connect:async()=>first.session,store:first.store,queue:{enqueue() {}},
    quarantine:new BossCardQuarantine({file}),
    jobService:{current:()=>({title:TITLE,jobRequirements:'本科，三年以上成本核算经验'})},
    wait:async()=>{}
  });
  firstCollector.extractResume=async()=>{
    const error=new Error('CDP timeout');
    error.code='BOSS_CDP_TIMEOUT';
    throw error;
  };
  const failed=await firstCollector.collect({targetCount:1});
  assert.equal(failed.state,'paused');
  assert.equal(failed.lastFailureCode,'BOSS_CDP_TIMEOUT');
  const savedFile=JSON.parse(fs.readFileSync(file,'utf8'));
  assert.deepEqual(savedFile.entries,[{
    jobId:'cost-job',cardFingerprint:hashText(`cost-job\n${cards[0]}`),
    failureCode:'BOSS_CDP_TIMEOUT',failedAt:savedFile.entries[0].failedAt
  }]);
  const next=fakeSession({cardTexts:cards});
  const nextCollector=new BossRawRecommendCollector({
    connect:async()=>next.session,store:next.store,queue:{enqueue() {}},
    quarantine:new BossCardQuarantine({file}),
    jobService:{current:()=>({title:TITLE,jobRequirements:'本科，三年以上成本核算经验'})},
    wait:async()=>{}
  });
  const resumed=await nextCollector.collect({targetCount:1});
  assert.equal(resumed.state,'completed');
  assert.equal(resumed.attempted,2);
  assert.equal(resumed.skipped,1);
  assert.equal(resumed.saved,1);
  assert.equal(next.state.openCount,1);
  assert.equal(next.store.records.length,1);
  assert.equal(new BossCardQuarantine({file}).clear(),1);
  assert.equal(new BossCardQuarantine({file}).has('cost-job',
    hashText(`cost-job\n${cards[0]}`)),false);
});

test('CDP timeout while closing an acknowledged resume also records quarantine', async () => {
  const {session,store}=fakeSession();
  const marked=[];
  const collector=new BossRawRecommendCollector({
    connect:async()=>session,store,queue:{enqueue() {}},
    quarantine:{has:()=>false,mark:(...args)=>marked.push(args)},
    jobService:{current:()=>({title:TITLE,jobRequirements:'本科，三年以上成本核算经验'})},
    wait:async()=>{}
  });
  collector.closeOfficialModal=async()=>{
    const error=new Error('CDP timeout');
    error.code='BOSS_CDP_TIMEOUT';
    throw error;
  };
  const result=await collector.collect({targetCount:1});
  assert.equal(result.state,'paused');
  assert.equal(result.lastFailureCode,'BOSS_CDP_TIMEOUT');
  assert.equal(result.pausedAtPhase,'closing_resume');
  assert.equal(marked.length,1);
  assert.equal(marked[0][0],'cost-job');
  assert.equal(marked[0][1],hashText('cost-job\n候选人甲 5年成本核算工作经验'));
  assert.equal(marked[0][2],'BOSS_CDP_TIMEOUT');
});

test('pre-open timeout with any active popup remains a hard pause', async () => {
  const {session,state,store} = fakeSession();
  session.scrollUnique=async options=>{
    if (options.selector === 'li.card-item') {
      state.modal=true;
      const error=new Error('CDP timeout');
      error.code='BOSS_CDP_TIMEOUT';
      throw error;
    }
  };
  const collector = new BossRawRecommendCollector({
    connect:async () => session,store,queue:{enqueue() {}},
    jobService:{current:() => ({title:TITLE,jobRequirements:'本科，三年以上成本核算经验'})},
    wait:async () => {}
  });
  const result = await collector.collect({targetCount:1});
  assert.equal(result.state,'paused');
  assert.equal(result.lastFailureCode,'BOSS_CDP_TIMEOUT');
  assert.equal(result.skipped,0);
  assert.equal(state.openCount,0);
  assert.equal(state.closeClicks,0);
  assert.equal(store.records.length,0);
});

test('three consecutive pre-open timeouts pause instead of probing more cards', async () => {
  const cards=['卡片一 财务经历','卡片二 财务经历','卡片三 财务经历','卡片四 财务经历'];
  const {session,state,store} = fakeSession({cardTexts:cards,
    preOpenTimeoutCardTexts:cards});
  const collector = new BossRawRecommendCollector({
    connect:async () => session,store,queue:{enqueue() {}},
    jobService:{current:() => ({title:TITLE,jobRequirements:'本科，三年以上成本核算经验'})},
    wait:async () => {}
  });
  const result = await collector.collect({targetCount:1});
  assert.equal(result.state,'paused');
  assert.equal(result.lastFailureCode,'BOSS_CDP_TIMEOUT');
  assert.equal(result.attempted,3);
  assert.equal(result.skipped,2);
  assert.equal(state.openCount,0);
  assert.equal(store.records.length,0);
});

test('known official anonymous-geek guide closes once before any candidate card', async () => {
  const {session,state,store} = fakeSession({guideModal:true,guideCloseDelayReads:2});
  const collector = new BossRawRecommendCollector({
    connect:async () => session,store,queue:{enqueue() {}},
    jobService:{current:() => ({title:TITLE,jobRequirements:'本科，三年以上成本核算经验'})},
    wait:async () => {}
  });
  const result = await collector.collect({targetCount:1});
  assert.equal(result.state,'completed');
  assert.equal(state.guideCloseClicks,1);
  assert.ok(state.clicks.indexOf('div[data-type="boss-dialog"].active .anonymous-geek-guide-list-wrapper .boss-popup__close') <
    state.clicks.indexOf('li.card-item'));
  assert.equal(store.records.length,1);
});

test('initial closeOfficialModal read dismisses exact guide without a resume or recursion', async () => {
  const {session,state} = fakeSession({guideModal:true,guideCloseDelayReads:2});
  const collector = new BossRawRecommendCollector({
    connect:async () => session,store:{},queue:{},jobService:{},wait:async () => {}
  });
  collector.session=session;
  await collector.closeOfficialModal();
  assert.equal(state.guideCloseClicks,1);
  assert.equal(state.closeClicks,0);
  assert.equal(state.guideModal,false);
  assert.equal((await collector.readModal()).active,false);
  assert.equal(state.guideCloseClicks,1);
});

test('transition-only read does not itself click an exact guide', async () => {
  const {session,state} = fakeSession({guideModal:true});
  const collector = new BossRawRecommendCollector({
    connect:async () => session,store:{},queue:{},jobService:{},wait:async () => {}
  });
  collector.session=session;
  const modal=await collector.readModal({allowTransition:true});
  assert.equal(modal.active,true);
  assert.equal(modal.transient,true);
  assert.equal(state.guideCloseClicks,0);
});

test('official modal read uses a bounded longer timeout and records its stage', async () => {
  const {session,state}=fakeSession();
  let timeoutMs=0;
  let reads=0;
  session.evaluate=async (expression,options) => {
    assert.equal(expression,EXPRESSIONS.modal);
    timeoutMs=options.timeoutMs;
    reads++;
    const error=new Error('CDP timeout');
    error.code='BOSS_CDP_TIMEOUT';
    throw error;
  };
  const collector=new BossRawRecommendCollector({
    connect:async()=>session,store:{},queue:{},jobService:{},wait:async()=>{}
  });
  collector.session=session;
  await assert.rejects(collector.readModal(),
    error => error.code === 'BOSS_CDP_TIMEOUT' && error.stage === 'read_modal');
  assert.equal(timeoutMs,15000);
  assert.equal(reads,2);
  assert.equal(state.openCount,0);
});

test('official modal read retries one timed-out read without another click', async () => {
  const {session,state}=fakeSession();
  let reads=0;
  session.evaluate=async expression => {
    assert.equal(expression,EXPRESSIONS.modal);
    reads++;
    if (reads===1) {
      const error=new Error('CDP timeout');
      error.code='BOSS_CDP_TIMEOUT';
      throw error;
    }
    return {active:false};
  };
  const collector=new BossRawRecommendCollector({
    connect:async()=>session,store:{},queue:{},jobService:{},wait:async()=>{}
  });
  collector.session=session;
  assert.deepEqual(await collector.readModal(),{active:false});
  assert.equal(reads,2);
  assert.equal(state.openCount,0);
});

test('initial closeOfficialModal read leaves unknown top overlay untouched', async () => {
  const {session,state} = fakeSession({unknownTopOverlay:true});
  const collector = new BossRawRecommendCollector({
    connect:async () => session,store:{},queue:{},jobService:{},wait:async () => {}
  });
  collector.session=session;
  await assert.rejects(collector.closeOfficialModal(),{
    code:'BOSS_RESUME_DIALOG_BLOCKED'
  });
  assert.equal(state.guideCloseClicks,0);
  assert.equal(state.closeClicks,0);
});

test('unknown top-level guide and official verification remain untouched', async () => {
  for (const options of [{unknownTopOverlay:true},
    {guideModal:true,guideChallenge:true}]) {
    const {session,state,store} = fakeSession(options);
    const collector = new BossRawRecommendCollector({
      connect:async () => session,store,queue:{enqueue() {}},
      jobService:{current:() => ({title:TITLE,jobRequirements:'本科，三年以上成本核算经验'})},
      wait:async () => {}
    });
    const result = await collector.collect({targetCount:1});
    assert.equal(result.state,'paused');
    assert.equal(result.lastFailureCode,options.guideChallenge
      ? 'BOSS_VERIFICATION_REQUIRED' : 'BOSS_RESUME_DIALOG_BLOCKED');
    assert.equal(state.guideCloseClicks,0);
    assert.equal(state.openCount,0);
    assert.equal(store.records.length,0);
  }
});

test('known guide that cannot be verified closed pauses after one click', async () => {
  const {session,state,store} = fakeSession({guideModal:true,guideCloseDelayReads:1000});
  const collector = new BossRawRecommendCollector({
    connect:async () => session,store,queue:{enqueue() {}},
    jobService:{current:() => ({title:TITLE,jobRequirements:'本科，三年以上成本核算经验'})},
    wait:async () => {}
  });
  const result = await collector.collect({targetCount:1});
  assert.equal(result.state,'paused');
  assert.equal(result.lastFailureCode,'BOSS_RESUME_DIALOG_BLOCKED');
  assert.equal(state.guideCloseClicks,1);
  assert.equal(state.openCount,0);
  assert.equal(store.records.length,0);
});

test('guide replacing the first resume opens the same exact card once more without four-minute wait', async () => {
  const {session,state,store} = fakeSession({
    guideOnCardOpens:[1],hideWhenGuideAppears:true
  });
  let elapsed=0;
  const collector = new BossRawRecommendCollector({
    connect:async () => session,store,queue:{enqueue() {}},
    jobService:{current:() => ({title:TITLE,jobRequirements:'本科，三年以上成本核算经验'})},
    now:() => elapsed,wait:async ms => {elapsed += ms;}
  });
  const result = await collector.collect({targetCount:1});
  assert.equal(result.state,'completed');
  assert.equal(result.saved,1);
  assert.equal(result.attempted,1);
  assert.equal(state.openCount,2);
  assert.equal(state.guideCloseClicks,1);
  assert.equal(state.closeClicks,1);
  assert.equal(store.records.length,1);
  assert.ok(elapsed < 60_000);
});

test('guide replacing both resume opens skips after one bounded retry with explicit reason', async () => {
  const {session,state,store} = fakeSession({guideOnCardOpens:[1,2]});
  let elapsed=0;
  const collector = new BossRawRecommendCollector({
    connect:async () => session,store,queue:{enqueue() {}},
    jobService:{current:() => ({title:TITLE,jobRequirements:'本科，三年以上成本核算经验'})},
    now:() => elapsed,wait:async ms => {elapsed += ms;}
  });
  const result = await collector.collect({targetCount:1});
  assert.equal(result.state,'partial');
  assert.equal(result.saved,0);
  assert.equal(result.skipped,1);
  assert.equal(result.lastFailureCode,'BOSS_RESUME_GUIDE_INTERRUPTED');
  assert.match(result.lastError,/再次替代简历/);
  assert.equal(state.openCount,2);
  assert.equal(state.guideCloseClicks,2);
  assert.equal(state.closeClicks,0);
  assert.equal(store.records.length,0);
  assert.ok(elapsed < 60_000);
});

test('card click with no resume gets one bounded retry instead of four-minute wait', async () => {
  const {session,state,store} = fakeSession({noResumeOnCardOpens:[1]});
  let elapsed=0;
  const collector = new BossRawRecommendCollector({
    connect:async () => session,store,queue:{enqueue() {}},
    jobService:{current:() => ({title:TITLE,jobRequirements:'本科，三年以上成本核算经验'})},
    now:() => elapsed,wait:async ms => {elapsed += ms;}
  });
  const result = await collector.collect({targetCount:1});
  assert.equal(result.state,'completed');
  assert.equal(result.saved,1);
  assert.equal(state.openCount,2);
  assert.equal(state.guideCloseClicks,0);
  assert.equal(store.records.length,1);
  assert.ok(elapsed >= 20_000 && elapsed < 60_000);
});

test('unknown popup pauses without saving or revealing a resume', async () => {
  const {session,state,store,queue} = fakeSession({unknownModal:true});
  const collector = new BossRawRecommendCollector({
    connect:async () => session,store,queue,
    jobService:{current:() => ({title:TITLE,jobRequirements:'本科，三年以上成本核算经验'})},
    wait:async () => {}
  });
  const result = await collector.collect({targetCount:1});
  assert.equal(result.state,'paused');
  assert.equal(result.lastFailureCode,'BOSS_RESUME_DIALOG_BLOCKED');
  assert.equal(store.records.length,0);
  assert.equal(queue.records.length,0);
  assert.equal(state.closed,true);
});

test('Canvas-only official resume uses bounded OCR before storing', async () => {
  const {session,store,queue} = fakeSession({canvasOnly:true});
  let recognized = 0;
  const collector = new BossRawRecommendCollector({
    connect:async () => session,store,queue,
    jobService:{current:() => ({title:TITLE,jobRequirements:'本科，三年以上成本核算经验'})},
    ocr:{async recognizeTextFromImage(image) {
      assert.equal(image.toString(),'fake screenshot');
      recognized++;
      return RESUME;
    },async destroy() {}},
    wait:async () => {}
  });
  const result = await collector.collect({targetCount:1});
  assert.equal(result.state,'completed');
  assert.equal(recognized,1);
  assert.equal(store.records[0].parseMethod,'ocr');
  assert.equal(queue.records.length,1);
});

test('preserved résumé scroll is verified back at page zero before OCR', async () => {
  const {session,state,store} = fakeSession({canvasOnly:true,preservedScroll:true});
  const collector = new BossRawRecommendCollector({
    connect:async () => session,store,queue:{enqueue() {}},
    jobService:{current:() => ({title:TITLE,jobRequirements:'本科，三年以上成本核算经验'})},
    ocr:{async recognizeTextFromImage() { return RESUME; },async destroy() {}},
    wait:async () => {}
  });
  const result = await collector.collect({targetCount:1});
  assert.equal(result.state,'completed');
  assert.equal(state.scrollTop,0);
  assert.equal(state.openCount,1);
  assert.deepEqual(state.scrollTargets,[0]);
});

test('uncertain rewind reopens the same verified card only once', async () => {
  const {session,state,store} = fakeSession({canvasOnly:true,preservedScroll:true});
  let rewindCalls = 0;
  session.setOfficialResumeScrollTop = async () => {
    rewindCalls++;
    const error = new Error('position uncertain');
    error.code = 'BOSS_CDP_SCROLL_UNCERTAIN';
    throw error;
  };
  const collector = new BossRawRecommendCollector({
    connect:async () => session,store,queue:{enqueue() {}},
    jobService:{current:() => ({title:TITLE,jobRequirements:'本科，三年以上成本核算经验'})},
    ocr:{async recognizeTextFromImage() { return RESUME; },async destroy() {}},
    wait:async () => {}
  });
  const result = await collector.collect({targetCount:1});
  assert.equal(result.state,'completed');
  assert.equal(rewindCalls,1);
  assert.equal(state.openCount,2);
  assert.equal(store.records.length,1);
});

test('official close waits through a long v-leave transition without clicking twice', async () => {
  const {session,state,store} = fakeSession({closeDelayReads:30});
  let virtualNow = 0;
  const collector = new BossRawRecommendCollector({
    connect:async () => session,store,queue:{enqueue() {}},
    jobService:{current:() => ({title:TITLE,jobRequirements:'本科，三年以上成本核算经验'})},
    now:() => virtualNow,wait:async ms => { virtualNow += ms; }
  });
  const result = await collector.collect({targetCount:1});
  assert.equal(result.state,'completed');
  assert.equal(store.records.length,1);
  assert.equal(state.closeClicks,1);
  assert.ok(virtualNow >= 20_000);
});

test('official guide appearing during resume close is verified and closed once', async () => {
  const {session,state,store} = fakeSession({
    guideAfterResumeClose:true,hideWhenGuideAppears:true,guideCloseDelayReads:3
  });
  const collector = new BossRawRecommendCollector({
    connect:async () => session,store,queue:{enqueue() {}},
    jobService:{current:() => ({title:TITLE,jobRequirements:'本科，三年以上成本核算经验'})},
    wait:async () => {}
  });
  const result = await collector.collect({targetCount:1});
  assert.equal(result.state,'completed');
  assert.equal(store.records.length,1);
  assert.equal(state.closeClicks,1);
  assert.equal(state.guideCloseClicks,1);
  assert.ok(state.cdpCommands.some(command =>
    command.method === 'Emulation.setFocusEmulationEnabled' &&
    command.params.enabled === true));
  assert.equal(state.visibilityState,'visible');
});

test('brief generic popup wrapper after official close settles without another click', async () => {
  const {session,state,store} = fakeSession({genericTransitionReads:5});
  const collector = new BossRawRecommendCollector({
    connect:async () => session,store,queue:{enqueue() {}},
    jobService:{current:() => ({title:TITLE,jobRequirements:'本科，三年以上成本核算经验'})},
    wait:async () => {}
  });
  const result = await collector.collect({targetCount:1});
  assert.equal(result.state,'completed');
  assert.equal(store.records.length,1);
  assert.equal(state.closeClicks,1);
});

function replaceRecommendFrameAfterFirstClose(session,state,{missingReads=0,
  missingJobReads=0,pagePatch={},jobPatch={}}={}) {
  const originalEvaluate=session.evaluate.bind(session);
  const probe={missingReads,missingJobReads,pageReads:0};
  session.evaluate=async expression=>{
    const value=await originalEvaluate(expression);
    const closedFirstResume=state.closeClicks > 0 && !state.modal && !state.closing;
    if (!closedFirstResume) return value;
    if (expression === EXPRESSIONS.page) {
      probe.pageReads++;
      if (probe.missingReads-- > 0) return {...value,
        iframeSrc:probe.missingReads % 2 ? 'about:blank' : '',frameReady:false};
      return {...value,...pagePatch};
    }
    if (expression === EXPRESSIONS.job) {
      if (probe.missingJobReads-- > 0) return {...value,selectedLabel:''};
      return {...value,...jobPatch};
    }
    return value;
  };
  return probe;
}

function twoCardCollector(session,store,clock) {
  return new BossRawRecommendCollector({
    connect:async()=>session,store,queue:{enqueue() {}},
    jobService:{current:()=>({title:TITLE,jobRequirements:'本科，三年以上成本核算经验'})},
    now:()=>clock.time,wait:async ms=>{ clock.time+=ms; }
  });
}

test('recommend iframe re-render after a saved resume recovers on the same route and exact job', async () => {
  const {session,state,store}=fakeSession({cardTexts:[
    '候选人甲 5年成本核算工作经验','候选人乙 6年制造业成本核算工作经验']});
  const probe=replaceRecommendFrameAfterFirstClose(session,state,
    {missingReads:4,missingJobReads:2});
  const clock={time:0};
  const result=await twoCardCollector(session,store,clock).collect({targetCount:2});
  assert.equal(result.state,'completed');
  assert.equal(result.saved,2);
  assert.equal(state.openCount,2);
  assert.equal(state.closeClicks,2);
  assert.ok(probe.pageReads >= 5);
  assert.ok(clock.time >= 3000);
  assert.equal(state.clicks.filter(value=>value === '.ui-dropmenu-label').length,1);
});

test('recommend iframe recovery stops after a bounded wait when the frame does not return', async () => {
  const {session,state,store}=fakeSession({cardTexts:[
    '候选人甲 5年成本核算工作经验','候选人乙 6年制造业成本核算工作经验']});
  replaceRecommendFrameAfterFirstClose(session,state,{missingReads:1000});
  const clock={time:0};
  const result=await twoCardCollector(session,store,clock).collect({targetCount:2});
  assert.equal(result.state,'paused');
  assert.equal(result.lastFailureCode,'BOSS_RECOMMEND_FRAME_UNAVAILABLE');
  assert.equal(result.saved,1);
  assert.equal(state.openCount,1);
  assert.equal(state.closeClicks,1);
  assert.ok(clock.time >= 10_000 && clock.time <= 11_000);
});

test('recommend candidate document mounts after its verified iframe without a false pause',async()=>{
  const {session,state,store}=fakeSession();
  state.selected='成本核算经理 _ 惠州 12-15K';
  state.jobId='cost-job';
  const evaluate=session.evaluate.bind(session);
  let nullReads=3;
  session.evaluate=async expression=>
    expression === EXPRESSIONS.cards && nullReads-- > 0 ? null : evaluate(expression);
  const clock={time:0};
  const collector=twoCardCollector(session,store,clock);
  collector.session=session;
  const cards=await collector.readCandidateCards(
    TITLE,'cost-job','/web/chat/recommend');
  assert.equal(cards.length,1);
  assert.equal(clock.time,1500);
});

for (const [reason,pagePatch,code] of [
  ['changed route',{url:'https://www.zhipin.com/web/chat/search'},'BOSS_PAGE_UNAVAILABLE'],
  ['login lost',{login:true},'BOSS_LOGIN_REQUIRED'],
  ['login redirect',{url:'https://www.zhipin.com/web/user/?ka=header-login'},'BOSS_LOGIN_REQUIRED'],
  ['security challenge',{challenge:true},'BOSS_VERIFICATION_REQUIRED'],
  ['security redirect',{url:'https://www.zhipin.com/web/passport/zp/verify.html'},'BOSS_VERIFICATION_REQUIRED'],
  ['security iframe redirect',{iframeLiveUrl:'https://www.zhipin.com/web/passport/zp/verify.html'},
    'BOSS_VERIFICATION_REQUIRED'],
  ['rate limited',{rateLimited:true},'BOSS_RATE_LIMITED']
]) {
  test(`recommend iframe recovery stops on ${reason} without opening another candidate`,async()=>{
    const {session,state,store}=fakeSession({cardTexts:[
      '候选人甲 5年成本核算工作经验','候选人乙 6年制造业成本核算工作经验']});
    replaceRecommendFrameAfterFirstClose(session,state,{missingReads:1,pagePatch});
    const result=await twoCardCollector(session,store,{time:0}).collect({targetCount:2});
    assert.equal(result.state,'paused');
    assert.equal(result.lastFailureCode,code);
    assert.equal(result.saved,1);
    assert.equal(state.openCount,1);
    assert.equal(state.closeClicks,1);
  });
}

test('recommend iframe recovery refuses a different posted job after re-render',async()=>{
  const {session,state,store}=fakeSession({cardTexts:[
    '候选人甲 5年成本核算工作经验','候选人乙 6年制造业成本核算工作经验']});
  replaceRecommendFrameAfterFirstClose(session,state,
    {missingReads:1,jobPatch:{jobId:'another-job'}});
  const result=await twoCardCollector(session,store,{time:0}).collect({targetCount:2});
  assert.equal(result.state,'paused');
  assert.equal(result.lastFailureCode,'BOSS_RECOMMENDED_JOB_MISMATCH');
  assert.equal(result.saved,1);
  assert.equal(state.openCount,1);
});

test('rate limit appearing while a candidate is open pauses before another card',async()=>{
  const {session,state,store}=fakeSession({cardTexts:[
    '候选人甲 5年成本核算工作经验','候选人乙 6年制造业成本核算工作经验']});
  const originalEvaluate=session.evaluate.bind(session);
  session.evaluate=async expression=>{
    const page=await originalEvaluate(expression);
    return expression === EXPRESSIONS.page && state.openCount >= 1
      ? {...page,rateLimited:true} : page;
  };
  const result=await twoCardCollector(session,store,{time:0}).collect({targetCount:2});
  assert.equal(result.state,'paused');
  assert.equal(result.lastFailureCode,'BOSS_RATE_LIMITED');
  assert.equal(result.saved,0);
  assert.equal(state.openCount,1);
});

test('persistent unknown wrapper after official close pauses without touching it', async () => {
  const {session,state,store} = fakeSession({genericTransitionReads:1000});
  const collector = new BossRawRecommendCollector({
    connect:async () => session,store,queue:{enqueue() {}},
    jobService:{current:() => ({title:TITLE,jobRequirements:'本科，三年以上成本核算经验'})},
    wait:async () => {}
  });
  const result = await collector.collect({targetCount:1});
  assert.equal(result.state,'paused');
  assert.equal(result.lastFailureCode,'BOSS_RESUME_DIALOG_BLOCKED');
  assert.equal(state.closeClicks,1);
  assert.equal(store.records.length,1);
});

test('official close fails closed after bounded wait and never repeats click', async () => {
  const {session,state} = fakeSession({closeDelayReads:1000});
  let virtualNow = 0;
  const collector = new BossRawRecommendCollector({
    connect:async () => session,store:{async addResume() {
      return {created:true,resume:{id:'one'}};
    }},queue:{enqueue() {}},
    jobService:{current:() => ({title:TITLE,jobRequirements:'本科，三年以上成本核算经验'})},
    now:() => virtualNow,wait:async ms => { virtualNow += ms; }
  });
  const result = await collector.collect({targetCount:1});
  assert.equal(result.state,'paused');
  assert.equal(result.lastFailureCode,'BOSS_RESUME_DIALOG_BLOCKED');
  assert.equal(state.closeClicks,1);
  assert.ok(virtualNow >= 90_000);
});

test('blank default-sized official Canvas never becomes a saved resume', async () => {
  const {session,store,queue} = fakeSession({blankCanvas:true});
  let captureCalled = false;
  let virtualNow = 0;
  session.captureRegionPng = async () => { captureCalled = true; throw new Error('unexpected'); };
  const collector = new BossRawRecommendCollector({
    connect:async () => session,store,queue,
    jobService:{current:() => ({title:TITLE,jobRequirements:'本科，三年以上成本核算经验'})},
    now:() => virtualNow, wait:async ms => { virtualNow += ms; }
  });
  const result = await collector.collect({targetCount:1});
  assert.equal(result.state,'partial');
  assert.equal(result.lastFailureCode,'BOSS_CANDIDATE_TIMEOUT');
  assert.equal(result.skipped,1);
  assert.equal(result.saved,0);
  assert.equal(store.records.length,0);
  assert.equal(queue.records.length,0);
  assert.equal(captureCalled,false);
});

test('two consecutive blank official Canvases pause after safely closing both', async () => {
  const {session,state,store} = fakeSession({blankCanvas:true,
    cardTexts:['候选人甲 5年成本核算工作经验','候选人乙 6年制造业成本核算工作经验']});
  let virtualNow = 0;
  const collector = new BossRawRecommendCollector({
    connect:async () => session,store,queue:{enqueue() {}},
    jobService:{current:() => ({title:TITLE,jobRequirements:'本科，三年以上成本核算经验'})},
    now:() => virtualNow,wait:async ms => { virtualNow += ms; }
  });
  const result = await collector.collect({targetCount:1});
  assert.equal(result.state,'paused');
  assert.equal(result.lastFailureCode,'BOSS_CANDIDATE_TIMEOUT');
  assert.match(result.lastError,/连续 2 份/);
  assert.equal(result.skipped,2);
  assert.equal(state.closeClicks,2);
  assert.equal(store.records.length,0);
});

test('close failure preserves the original blank-Canvas timeout reason', async () => {
  const {session,state} = fakeSession({blankCanvas:true,closeDelayReads:1000});
  let virtualNow = 0;
  const collector = new BossRawRecommendCollector({
    connect:async () => session,store:{async addResume() {
      throw new Error('must not save blank resume');
    }},queue:{enqueue() {}},
    jobService:{current:() => ({title:TITLE,jobRequirements:'本科，三年以上成本核算经验'})},
    now:() => virtualNow,wait:async ms => { virtualNow += ms; }
  });
  const result = await collector.collect({targetCount:1});
  assert.equal(result.state,'paused');
  assert.equal(result.lastFailureCode,'BOSS_CANDIDATE_TIMEOUT');
  assert.match(result.lastError,/Canvas/);
  assert.match(result.lastError,/弹窗关闭未确认/);
  assert.equal(state.closeClicks,1);
});

test('official Canvas may draw after more than one minute within candidate deadline', async () => {
  const {session,state,store} = fakeSession({canvasOnly:true,lazyDrawAfterReads:95});
  let virtualNow = 0;
  const collector = new BossRawRecommendCollector({
    connect:async () => session,store,queue:{enqueue() {}},
    jobService:{current:() => ({title:TITLE,jobRequirements:'本科，三年以上成本核算经验'})},
    ocr:{async recognizeTextFromImage() { return RESUME; },async destroy() {}},
    now:() => virtualNow, wait:async ms => { virtualNow += ms; }
  });
  const result = await collector.collect({targetCount:1});
  assert.equal(result.state,'completed');
  assert.equal(store.records.length,1);
  assert.ok(virtualNow > 60_000);
  assert.ok(virtualNow < 4*60_000);
  assert.ok(state.modalReads >= 95);
});

test('lazy Canvas is OCRed through the final scroll position before saving', async () => {
  const {session,state,store} = fakeSession({multiPage:true});
  const pages = [];
  const collector = new BossRawRecommendCollector({
    connect:async () => session,store,queue:{enqueue() {}},
    jobService:{current:() => ({title:TITLE,jobRequirements:'本科，三年以上成本核算经验'})},
    ocr:{async recognizeTextFromImage(image) {
      const position = Number(image.toString().split(' ')[1]);
      pages.push(position);
      return position === 0
        ? '工作经历：在制造企业从事成本核算和月度分析五年，熟悉结账。'
        : position === 1701
          ? '教育经历：本科财务管理专业，系统学习了会计和企业财务知识。'
          : '项目经历：建设成本核算系统，完成数据分析与产品成本差异报告。';
    },async destroy() {}},wait:async () => {}
  });
  const result = await collector.collect({targetCount:1});
  assert.equal(result.state,'completed');
  assert.deepEqual(pages,[0,700,1400,1701]);
  assert.equal(state.scrollTop,1701);
  assert.deepEqual(state.scrollTargets,[700,1400,1701]);
  assert.equal(store.records.length,1);
  assert.match(store.records[0].originalText,/教育经历/);
});

test('hidden recruiter tab is reactivated before the next OCR page after confirming the same job and resume', async () => {
  const {session,state,store}=fakeSession({multiPage:true});
  const originalSet=session.setOfficialResumeScrollTop;
  session.setOfficialResumeScrollTop=async options=>{
    const result=await originalSet(options);
    if (options.targetTop === 700) state.visibilityState='hidden';
    return result;
  };
  const collector=new BossRawRecommendCollector({
    connect:async()=>session,store,queue:{enqueue() {}},
    jobService:{current:()=>({title:TITLE,jobRequirements:'本科，三年以上成本核算经验'})},
    ocr:{async recognizeTextFromImage(image) {
      const position=Number(image.toString().split(' ')[1]);
      return position === 0 ? RESUME.split('\n')[0]
        : position === 1701 ? RESUME.split('\n').slice(1).join('\n')
          : '项目经历：建设成本核算系统，完成制造业财务数据分析与产品成本差异报告。';
    },async destroy() {}},wait:async()=>{}
  });
  const result=await collector.collect({targetCount:1});
  assert.equal(result.state,'completed');
  assert.equal(store.records.length,1);
  assert.equal(state.cdpCommands.filter(command =>
    command.method === 'Emulation.setFocusEmulationEnabled').length,1);
  assert.equal(state.visibilityState,'visible');
  assert.equal(state.openCount,1);
});

test('last Canvas scroll is clamped to the verified maximum', async () => {
  const {session,state,store} = fakeSession({multiPage:true,multiPageMax:1000});
  const collector = new BossRawRecommendCollector({
    connect:async () => session,store,queue:{enqueue() {}},
    jobService:{current:() => ({title:TITLE,jobRequirements:'本科，三年以上成本核算经验'})},
    ocr:{async recognizeTextFromImage(image) {
      const position = Number(image.toString().split(' ')[1]);
      return position === 0 ? RESUME.split('\n')[0]
        : position === 1000 ? RESUME.split('\n').slice(1).join('\n')
          : '项目经历：建设成本核算系统，完成制造业财务数据分析与产品成本差异报告。';
    },async destroy() {}},wait:async () => {}
  });
  const result = await collector.collect({targetCount:1});
  assert.equal(result.state,'completed');
  assert.deepEqual(state.scrollTargets,[700,1000]);
  assert.equal(store.records.length,1);
});

test('visible resume screenshot retries one stale frame after each scroll', async () => {
  const {session,state,store} = fakeSession({multiPage:true});
  let settledPosition = 0;
  let staleEmittedFor = null;
  let captures = 0;
  session.captureRegionPng = async ({selector}) => {
    assert.equal(selector,'.dialog-wrap.active .resume-detail-wrap');
    captures++;
    if (state.scrollTop !== settledPosition) {
      if (staleEmittedFor !== state.scrollTop) {
        staleEmittedFor = state.scrollTop;
        return Buffer.from(`frame ${settledPosition}`);
      }
      settledPosition = state.scrollTop;
    }
    return Buffer.from(`frame ${settledPosition}`);
  };
  const collector = new BossRawRecommendCollector({
    connect:async () => session,store,queue:{enqueue() {}},
    jobService:{current:() => ({title:TITLE,jobRequirements:'本科，三年以上成本核算经验'})},
    ocr:{async recognizeTextFromImage(image) {
      const position = Number(image.toString().split(' ')[1]);
      return position === 0 ? RESUME.split('\n')[0]
        : position === 1701 ? RESUME.split('\n').slice(1).join('\n')
          : '项目经历：建设成本核算系统，完成制造业财务数据分析与产品成本差异报告。';
    },async destroy() {}},wait:async () => {}
  });
  const result = await collector.collect({targetCount:1});
  assert.equal(result.state,'completed');
  assert.equal(store.records.length,1);
  assert.equal(captures,7);
  assert.deepEqual(state.scrollTargets,[700,1400,1701]);
});

test('page-two screenshot timeout uses only the stable current official Canvas', async () => {
  const {session,state,store} = fakeSession({multiPage:true});
  const screenshots=[];
  const canvasReads=[];
  session.captureRegionPng = async () => {
    screenshots.push(state.scrollTop);
    if (state.scrollTop === 700) {
      const error=new Error('screenshot timed out');
      error.code='BOSS_CDP_TIMEOUT';
      error.stage='capture_screenshot';
      throw error;
    }
    return Buffer.from(`frame ${state.scrollTop}`);
  };
  session.captureCanvasPng = async options => {
    assert.deepEqual(options.frameSelectors,[
      'iframe[src*="/web/frame/recommend/"]',
      '.dialog-wrap.active .resume-detail-wrap iframe[src*="/web/frame/c-resume/"]'
    ]);
    canvasReads.push(state.scrollTop);
    const image=Buffer.alloc(28);
    image.writeUInt32BE(900,16);
    image.writeUInt32BE(1500,20);
    image.writeUInt32BE(state.scrollTop,24);
    return image;
  };
  const pages=[];
  const collector = new BossRawRecommendCollector({
    connect:async()=>session,store,queue:{enqueue() {}},
    jobService:{current:()=>({title:TITLE,jobRequirements:'本科，三年以上成本核算经验'})},
    ocr:{async recognizeTextFromImage(image) {
      const top=image.length === 28 ? image.readUInt32BE(24)
        : Number(image.toString().split(' ')[1]);
      pages.push(top);
      return top === 0 ? RESUME.split('\n')[0]
        : top === 1701 ? RESUME.split('\n').slice(1).join('\n')
          : '项目经历：建设成本核算系统，完成制造业财务数据分析与产品成本差异报告。';
    },async destroy() {}},wait:async()=>{}
  });
  const result=await collector.collect({targetCount:1});
  assert.equal(result.state,'completed');
  assert.equal(result.saved,1);
  assert.deepEqual(pages,[0,700,1400,1701]);
  assert.equal(screenshots.filter(top=>top===700).length,1);
  assert.ok(canvasReads.filter(top=>top===700).length >= 2);
  assert.deepEqual(state.scrollTargets,[700,1400,1701]);
  assert.equal(store.records.length,1);
});

test('screenshot timeout cannot OCR a stale prior-page Canvas', async () => {
  const {session,state,store} = fakeSession({multiPage:true});
  const marked=[];
  session.captureRegionPng=async()=>{
    if (state.scrollTop === 700) {
      const error=new Error('screenshot timed out');
      error.code='BOSS_CDP_TIMEOUT';
      error.stage='capture_screenshot';
      throw error;
    }
    return Buffer.from(`frame ${state.scrollTop}`);
  };
  session.captureCanvasPng=async()=>{
    const image=Buffer.alloc(28);
    image.writeUInt32BE(900,16);
    image.writeUInt32BE(1500,20);
    image.writeUInt32BE(0,24); // The Canvas never repainted after scrolling.
    return image;
  };
  const collector=new BossRawRecommendCollector({
    connect:async()=>session,store,queue:{enqueue() {}},
    quarantine:{has:()=>false,mark:(jobId,cardHash,code)=>marked.push(code)},
    jobService:{current:()=>({title:TITLE,jobRequirements:'本科，三年以上成本核算经验'})},
    ocr:{async recognizeTextFromImage(image) {
      assert.equal(image.toString(),'frame 0');
      return RESUME.split('\n')[0];
    },async destroy() {}},wait:async()=>{}
  });
  const result=await collector.collect({targetCount:1});
  assert.equal(result.state,'paused');
  assert.equal(result.lastFailureCode,'BOSS_CDP_TIMEOUT');
  assert.equal(result.pausedAtStage,'capture_screenshot');
  assert.deepEqual(state.scrollTargets,[700]);
  assert.deepEqual(marked,['BOSS_CDP_TIMEOUT']);
  assert.equal(store.records.length,0);
});

test('Canvas fallback refuses a replaced official iframe after scrolling', async () => {
  const {session,state,store}=fakeSession({multiPage:true});
  const evaluate=session.evaluate.bind(session);
  session.evaluate=async expression=>{
    const value=await evaluate(expression);
    if (expression === EXPRESSIONS.canvasIdentity && state.scrollTop === 700) {
      return {...value,resumeOrigin:3};
    }
    return value;
  };
  session.captureRegionPng=async()=>{
    if (state.scrollTop === 700) {
      const error=new Error('screenshot timed out');
      error.code='BOSS_CDP_TIMEOUT';
      error.stage='capture_screenshot';
      throw error;
    }
    return Buffer.from(`frame ${state.scrollTop}`);
  };
  session.captureCanvasPng=async()=>{
    const image=Buffer.alloc(28);
    image.writeUInt32BE(900,16);
    image.writeUInt32BE(1500,20);
    image.writeUInt32BE(state.scrollTop,24);
    return image;
  };
  const collector=new BossRawRecommendCollector({
    connect:async()=>session,store,queue:{enqueue() {}},
    jobService:{current:()=>({title:TITLE,jobRequirements:'本科，三年以上成本核算经验'})},
    ocr:{async recognizeTextFromImage(image) {
      assert.equal(image.toString(),'frame 0');
      return RESUME.split('\n')[0];
    },async destroy() {}},wait:async()=>{}
  });
  const result=await collector.collect({targetCount:1});
  assert.equal(result.state,'paused');
  assert.equal(result.lastFailureCode,'BOSS_RESUME_DIALOG_BLOCKED');
  assert.equal(store.records.length,0);
  assert.deepEqual(state.scrollTargets,[700]);
});
