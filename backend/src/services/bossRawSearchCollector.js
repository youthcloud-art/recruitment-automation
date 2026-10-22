// Search results have a different iframe and a top-level official resume
// dialog. Keep this path separate from the posted-job recommendation path.
const crypto = require('node:crypto');
const {BossRawRecommendCollector,buildExpressions,officialResumeUrl,
  joinScreenText,repeatedScreenText,hashText,jobResumeSignature} = require('./bossRawRecommendCollector');
const {assessBossResumeText} = require('./bossResumeQuality');

const SEARCH_FRAME = 'iframe[src*="/web/frame/search/"]';
const SEARCH_CARD = 'li.geek-info-card';
const SEARCH_LINK = 'li.geek-info-card > a[ka="search_click_open_resume"]';
const SEARCH_LOAD_MORE = '.loadmore > p.click-class';
// BOSS can retain this one query key after a recruiter completes its official
// security check. Do not allow arbitrary query state to authorize DOM actions.
const OFFICIAL_SEARCH_PAGE = `(() => {
  let url;
  try {url=new URL(location.href);} catch (_) {return false;}
  if (url.protocol!=='https:' || url.host!=='www.zhipin.com' ||
      url.username || url.password || url.pathname!=='/web/chat/search' ||
      location.href.includes('#')) return false;
  if (location.href==='https://www.zhipin.com/web/chat/search') return true;
  const keys=[...url.searchParams.keys()];
  return keys.length===1 && keys[0]==='_security_check';
})()`;
const DIALOG = 'div[data-type="boss-dialog"].active.dialog-wrap';
const RESUME_WRAPPER = ':scope > .boss-popup__wrapper.boss-dialog.boss-dialog__wrapper.dialog-lib-resume';
const RESUME_FRAME = DIALOG + ' '
  + '.boss-popup__wrapper.boss-dialog.boss-dialog__wrapper.dialog-lib-resume '
  + '.resume-detail-wrap iframe[src*="/web/frame/c-resume/"]';

function fail(code,message) { const error=new Error(message); error.code=code; return error; }
function normalized(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/g,' ').trim();
}
function searchScope(value) {
  return `search-${crypto.createHash('sha256').update(normalized(value))
    .digest('hex').slice(0,32)}`;
}

const SEARCH_STATE = `(() => { /* bossRaw:searchState */
  const outer=document.querySelector(${JSON.stringify(SEARCH_FRAME)});
  const doc=outer?.contentDocument;
  if (!doc) return {state:'frame_unavailable'};
  let frameUrl;
  try {frameUrl=new URL(outer.contentWindow.location.href);} catch (_) {
    return {state:'frame_unavailable'};
  }
  if (frameUrl.origin!=='https://www.zhipin.com' ||
      !/^\\/web\\/frame\\/search\\/?$/.test(frameUrl.pathname)) {
    return {state:'wrong_frame'};
  }
  const inputs=[...doc.querySelectorAll('input.search-input')].filter(el=>
    el.getClientRects().length && doc.defaultView.getComputedStyle(el).visibility!=='hidden');
  if (inputs.length!==1) return {state:'input_unavailable'};
  const cards=[...doc.querySelectorAll(${JSON.stringify(SEARCH_CARD)})];
  const safeCards=cards.filter(card=>
    card.querySelectorAll(':scope > a[ka="search_click_open_resume"][data-expect]').length===1);
  const selected={};
  for (const kind of ['degree','exp','age']) {
    selected[kind]=[...doc.querySelectorAll('.'+kind+'-item.active')]
      .filter(el=>el.getClientRects().length)
      .map(el=>(el.textContent||'').replace(/\\s+/g,' ').trim());
  }
  const selectedFiltersReady=selected.degree.length>=1 &&
    selected.exp.length>=1 && selected.age.length>=1;
  const nonDefaultSelected=Object.values(selected).flat()
    .filter(label=>label!=='不限').length;
  const checkedCount=doc.querySelectorAll('input[type="checkbox"]:checked').length;
  // In BOSS's custom degree UI the "不限" chip can remain active while the
  // range slider becomes enabled. Treat an enabled custom range as an applied
  // platform filter rather than silently claiming the search is unrestricted.
  const activeCustomSliderCount=[...doc.querySelectorAll(
    '.degree-select-custom-slider .ui-slider, '
      + '.exp-select-custom-slider .ui-slider, '
      + '.age-select-custom-slider .ui-slider')]
    .filter(slider=>!slider.classList.contains('custom-slider-disabled')).length;
  const term=inputs[0].value.normalize('NFKC').trim();
  const matchingSearchRequests=outer.contentWindow.performance.getEntriesByType('resource')
    .filter(entry=>{
      try {
        const resource=new URL(entry.name);
        if (resource.origin!=='https://www.zhipin.com' ||
            !/search.*geek|geek.*search/i.test(resource.pathname)) return false;
        return decodeURIComponent(resource.href).normalize('NFKC').includes(term);
      } catch (_) {return false;}
    }).length;
  return {state:'ready',value:inputs[0].value,cardCount:cards.length,
    safeCardCount:safeCards.length,frameUrl:frameUrl.href,
    frameOrigin:outer.contentWindow.performance.timeOrigin,
    matchingSearchRequests,selectedFiltersReady,nonDefaultSelected,
    checkedCount,activeCustomSliderCount};
})()`;

function searchCardsExpression(cardWindowStart = 0) { return `(() => { /* bossRaw:searchCards */
  const doc=document.querySelector(${JSON.stringify(SEARCH_FRAME)})?.contentDocument;
  if (!doc) return null;
  const all=[...doc.querySelectorAll(${JSON.stringify(SEARCH_CARD)})];
  return {totalCount:all.length,cards:all.slice(${cardWindowStart},
    ${cardWindowStart + 1000})
    .map((card,index)=>{
      const links=[...card.querySelectorAll(':scope > a[ka="search_click_open_resume"][data-expect]')];
      const names=[...card.querySelectorAll('.geek-info-basic-content > .name > span.name-label')];
      const expectRows=[...card.querySelectorAll('ul.exp-box.expect-exp-box > li')]
        .filter(row=>(row.textContent||'').includes('期望'));
      const roles=expectRows.length===1
        ? [...expectRows[0].querySelectorAll('span.render-two')] : [];
      return {index:index+${cardWindowStart},
        text:(card.textContent||'').replace(/\\s+/g,' ').trim(),
        clickText:links.length===1
          ? (links[0].textContent||'').replace(/\\s+/g,' ').trim() : '',
        displayName:names.length===1 ? (names[0].textContent||'').trim() : '',
        expectedPosition:roles.length===2 ? (roles[1].textContent||'').trim() : ''};
    }).filter(item=>item.text)};
})()`; }
const SEARCH_CARDS = searchCardsExpression();

function searchLoadMoreProbe(title,expectedFrameOrigin) { return `(() => { /* bossRaw:searchLoadMore */
  if (!${OFFICIAL_SEARCH_PAGE} ||
      document.visibilityState!=='visible') return {state:'page_changed'};
  const outer=document.querySelector(${JSON.stringify(SEARCH_FRAME)});
  const doc=outer?.contentDocument;
  if (!doc) return {state:'frame_unavailable'};
  let frameUrl;
  try {frameUrl=new URL(outer.contentWindow.location.href);} catch (_) {
    return {state:'frame_unavailable'};
  }
  if (frameUrl.origin!=='https://www.zhipin.com' ||
      !/^\\/web\\/frame\\/search\\/?$/.test(frameUrl.pathname) ||
      outer.contentWindow.performance.timeOrigin!==${expectedFrameOrigin}) {
    return {state:'frame_changed'};
  }
  const inputs=[...doc.querySelectorAll('input.search-input')].filter(el=>
    el.getClientRects().length && doc.defaultView.getComputedStyle(el).visibility!=='hidden');
  if (inputs.length!==1 ||
      inputs[0].value.normalize('NFKC').trim()!==${JSON.stringify(normalized(title))}) {
    return {state:'keyword_changed'};
  }
  if (document.querySelectorAll('.dialog-wrap.active').length ||
      doc.querySelectorAll('.dialog-wrap.active').length) return {state:'dialog_active'};
  const cards=[...doc.querySelectorAll(${JSON.stringify(SEARCH_CARD)})];
  const controls=[...doc.querySelectorAll(${JSON.stringify(SEARCH_LOAD_MORE)})];
  if (!controls.length) return {state:'absent',cardCount:cards.length};
  if (controls.length!==1) return {state:'ambiguous',cardCount:cards.length};
  const control=controls[0];
  const style=doc.defaultView.getComputedStyle(control);
  const rect=control.getBoundingClientRect();
  if ((control.textContent||'').normalize('NFKC').replace(/\\s+/g,' ').trim()!==
        '点击加载更多' || !rect.width || !rect.height ||
      style.display==='none' || style.visibility==='hidden' ||
      style.pointerEvents==='none' ||
      doc.defaultView.getComputedStyle(control.parentElement).display==='none') {
    return {state:'control_unavailable',cardCount:cards.length};
  }
  const root=doc.scrollingElement;
  if (!root) return {state:'root_unavailable',cardCount:cards.length};
  const identity={cardCount:cards.length,
    lastCardText:(cards.at(-1)?.textContent||'').normalize('NFKC').replace(/\\s+/g,' ').trim(),
    frameOrigin:outer.contentWindow.performance.timeOrigin};
  if (root.scrollHeight-root.clientHeight-root.scrollTop>5) {
    return {state:'not_at_end',...identity};
  }
  return {state:'ready',...identity};
})()`; }

function searchVisibleCardsProbe(expectedFrameOrigin) { return `(() => { /* bossRaw:searchVisibleCards */
  if (!${OFFICIAL_SEARCH_PAGE} || document.visibilityState!=='visible') {
    return {state:'page_hidden'};
  }
  const outer=document.querySelector(${JSON.stringify(SEARCH_FRAME)});
  const doc=outer?.contentDocument;
  if (!doc || outer.contentWindow.performance.timeOrigin!==${expectedFrameOrigin}) {
    return {state:'frame_changed'};
  }
  const cards=[...doc.querySelectorAll(${JSON.stringify(SEARCH_CARD)})];
  const visibleCardCount=cards.filter(card=>{
    const rect=card.getBoundingClientRect();
    const style=doc.defaultView.getComputedStyle(card);
    return rect.width>0 && rect.height>0 && rect.bottom>0 && rect.top<doc.defaultView.innerHeight &&
      rect.right>0 && rect.left<doc.defaultView.innerWidth &&
      style.display!=='none' && style.visibility!=='hidden';
  }).length;
  return {state:'ready',cardCount:cards.length,visibleCardCount};
})()`; }

const SEARCH_MODAL = `(() => { /* bossRaw:searchModal */
  const dialogs=[...document.querySelectorAll(${JSON.stringify(DIALOG)})];
  if (!dialogs.length) return {active:false};
  if (dialogs.length!==1) {
    return {active:true,transient:true};
  }
  const dialog=dialogs[0];
  const wrappers=[...dialog.querySelectorAll(${JSON.stringify(RESUME_WRAPPER)})];
  if (wrappers.length!==1) return {active:true,transient:true};
  const panes=[...wrappers[0].querySelectorAll('.resume-detail-wrap')];
  const closes=[...wrappers[0].querySelectorAll('.close-btn')];
  if (panes.length!==1 || closes.length!==1) return {active:true,transient:true};
  const frames=[...panes[0].querySelectorAll('iframe[src*="/web/frame/c-resume/"]')];
  if (frames.length!==1) return {active:true,transient:true};
  const iframe=frames[0];
  const doc=iframe.contentDocument;
  let iframeLiveUrl='',resumeOrigin=0;
  try {
    iframeLiveUrl=iframe.contentWindow.location.href;
    resumeOrigin=iframe.contentWindow.performance.timeOrigin;
  } catch (_) {}
  const source=doc?.querySelector('.resume-detail-wrap, .resume-content, '
    + '.profile-content, .user-detail, .candidate-detail, .talent-detail');
  let text='';
  if (source) {
    const clone=source.cloneNode(true);
    clone.querySelectorAll('.resume-warning, .resume-anonymous-geek-card.v2')
      .forEach(el=>el.remove());
    text=(clone.textContent||'').trim();
  }
  const canvas=doc?.querySelector('canvas#resume');
  return {active:true,iframeSrc:iframe.src,iframeLiveUrl,
    outerOrigin:performance.timeOrigin,resumeOrigin,frameReady:!!doc,text,
    canvas:!!canvas,canvasWidth:canvas?.width||0,canvasHeight:canvas?.height||0,
    scrollTop:panes[0].scrollTop,scrollHeight:panes[0].scrollHeight,
    clientHeight:panes[0].clientHeight};
})()`;

const SEARCH_CANVAS_IDENTITY = `(() => { /* bossRaw:searchCanvasIdentity */
  const dialogs=[...document.querySelectorAll(${JSON.stringify(DIALOG)})];
  if (dialogs.length!==1) return {state:'dialog_unavailable'};
  const wrappers=[...dialogs[0].querySelectorAll(${JSON.stringify(RESUME_WRAPPER)})];
  if (wrappers.length!==1) return {state:'dialog_unavailable'};
  const panes=[...wrappers[0].querySelectorAll('.resume-detail-wrap')];
  if (panes.length!==1) return {state:'pane_unavailable'};
  const frames=[...panes[0].querySelectorAll('iframe[src*="/web/frame/c-resume/"]')];
  if (frames.length!==1 || !frames[0].contentDocument) return {state:'frame_unavailable'};
  const canvas=frames[0].contentDocument.querySelector('canvas#resume');
  if (!canvas || canvas.width<=300 || canvas.height<=150 ||
      canvas.width*canvas.height>16*1024*1024 ||
      document.visibilityState!=='visible') return {state:'canvas_unready'};
  let resumeUrl;
  try {resumeUrl=frames[0].contentWindow.location.href;} catch (_) {
    return {state:'frame_unavailable'};
  }
  return {state:'ready',resumeUrl,scrollTop:panes[0].scrollTop,
    width:canvas.width,height:canvas.height,
    outerOrigin:performance.timeOrigin,
    resumeOrigin:frames[0].contentWindow.performance.timeOrigin};
})()`;

function searchCardHeaderAdjustment(clickText,expectedIndex,allowAdjust=true,
  expectedCardText='') {
  return `(() => { /* bossRaw:searchCardHeaderAdjustment */
    if (!${OFFICIAL_SEARCH_PAGE} ||
        document.visibilityState!=='visible' ||
        document.querySelector('div[data-type="boss-dialog"].active.dialog-wrap')) {
      return {state:'page_changed'};
    }
    const frame=document.querySelector(${JSON.stringify(SEARCH_FRAME)});
    const doc=frame?.contentDocument;
    if (!doc || doc.querySelector('.dialog-wrap.active')) return {state:'frame_unavailable'};
    let frameUrl;
    try {frameUrl=new URL(frame.contentWindow.location.href);} catch (_) {
      return {state:'frame_unavailable'};
    }
    if (frameUrl.origin!=='https://www.zhipin.com' ||
        !/^\\/web\\/frame\\/search\\/?$/.test(frameUrl.pathname)) {
      return {state:'frame_changed'};
    }
    const normalized=value=>(value||'').replace(/\\s+/g,' ').trim();
    const links=[...doc.querySelectorAll(${JSON.stringify(SEARCH_LINK)})]
      .filter(el=>normalized(el.textContent)===${JSON.stringify(clickText)});
    if (links.length!==1) return {state:links.length?'ambiguous':'missing'};
    const link=links[0];
    const cards=[...doc.querySelectorAll(${JSON.stringify(SEARCH_CARD)})];
    const card=link.closest('li.geek-info-card');
    const cardIndex=cards.indexOf(card);
    if (cardIndex<0) return {state:'card_unavailable'};
    if (${JSON.stringify(expectedCardText)} &&
        normalized(card.textContent)!==${JSON.stringify(expectedCardText)}) {
      return {state:'card_mismatch',cardIndex};
    }
    if (cardIndex!==${Number.isInteger(expectedIndex) ? expectedIndex : -1}) {
      return {state:'card_reordered',cardIndex};
    }
    const headers=[...doc.querySelectorAll(
      '.search-part-container.fix-top-sarch-part')];
    if (headers.length!==1) return {state:'header_unverified',cardIndex};
    const header=headers[0];
    const hr=header.getBoundingClientRect();
    const hs=doc.defaultView.getComputedStyle(header);
    const rect=link.getBoundingClientRect();
    const frameRect=frame.getBoundingClientRect();
    if (hs.position!=='fixed' || hr.top< -2 || hr.top>2 ||
        hr.height<40 || hr.height>160 || hr.left>rect.left ||
        hr.right<rect.right || !rect.width || !rect.height) {
      return {state:'header_unverified',cardIndex};
    }
    let safe=0,coveredByHeader=0,otherObstruction=0;
    for (const [fx,fy] of [[.25,.5],[.5,.5],[.25,.25],
        [.5,.25],[.75,.25],[.25,.75],[.75,.75]]) {
      const px=rect.left+rect.width*fx,py=rect.top+rect.height*fy;
      if (px<0 || py<0 || px>=doc.defaultView.innerWidth ||
          py>=doc.defaultView.innerHeight) continue;
      const hit=doc.elementFromPoint(px,py);
      const x=frameRect.left+frame.clientLeft+px;
      const y=frameRect.top+frame.clientTop+py;
      const outerHit=document.elementFromPoint(x,y);
      if (x<0 || y<0 || x>=innerWidth || y>=innerHeight ||
          (outerHit!==frame && !frame.contains(outerHit))) {
        otherObstruction++;
      } else if (hit && (hit===link || link.contains(hit)) &&
          !hit.closest('.btn-greet,[ka*="greet"],[class*="btn-greet"]')) {
        safe++;
      } else if (hit && header.contains(hit)) coveredByHeader++;
      else otherObstruction++;
    }
    if (safe) return {state:'ready',cardIndex};
    if (!coveredByHeader || otherObstruction || rect.bottom<=0 ||
        rect.top>=hr.bottom || rect.bottom>hr.bottom+32) {
      return {state:'other_obstruction',cardIndex};
    }
    if (!${Boolean(allowAdjust)}) return {state:'repeat_adjustment',cardIndex};
    const root=doc.scrollingElement;
    const adjustment=Math.ceil(hr.bottom+64-rect.top);
    if (root?.tagName!=='HTML' || root.scrollHeight<=root.clientHeight ||
        adjustment<1 || adjustment>400 || root.scrollTop<adjustment) {
      return {state:'scroll_unavailable',cardIndex};
    }
    const before=root.scrollTop;
    root.scrollTop=before-adjustment;
    if (Math.abs(root.scrollTop-(before-adjustment))>2) {
      return {state:'scroll_unchanged',cardIndex};
    }
    return {state:'adjusted',cardIndex,scrollDelta:adjustment};
  })()`;
}

class BossRawSearchCollector extends BossRawRecommendCollector {
  constructor(options={}) {
    super(options);
    this.frameSelector=SEARCH_FRAME;
    this.cardSelector=SEARCH_CARD;
    this.clickSelector=SEARCH_LINK;
    this.pageSegment='search';
    this.maxRuntimeCapMs=180*60*1000;
    this.expressions={...buildExpressions(SEARCH_FRAME,SEARCH_CARD),
      cards:SEARCH_CARDS,modal:SEARCH_MODAL,canvasIdentity:SEARCH_CANVAS_IDENTITY};
    this.adjustedCardHashes=new Set();
    this.activeSearchTitle=null;
    this.searchResumeContext=null;
    this.searchFocusRecoveryUsed=false;
    this.windowRestoreUsed=false;
    this.status.windowRestoreCount=0;
  }

  async collect(options={}) {
    if (!options.resume) {
      this.windowRestoreUsed=false;
      this.status.windowRestoreCount=0;
    }
    return super.collect(options);
  }

  async ensureVisibleRecruiterPage() {
    // Page.bringToFront may implicitly restore a minimized browser. Keep all
    // such restoration behind the single guarded, identity-checked path below.
    try {
      await this.session.assertUsableRecruiterWindow({frameSelector:SEARCH_FRAME});
    } catch (error) {
      if (error.code!=='BOSS_CDP_WINDOW_MINIMIZED' ||
          !['reading_candidates','existing_candidate','quarantined_candidate']
            .includes(this.status.phase)) throw error;
      const title=String(this.activeSearchTitle || '').trim();
      const saved=this.lastCandidateWindow;
      const frameOrigin=this.searchEvidence?.frameOrigin;
      if (!title || !saved || !Number.isFinite(frameOrigin) ||
          !Number.isSafeInteger(saved.totalCount) || saved.totalCount<1) throw error;
      // No candidate click has been attempted at this point. The shared
      // restoration path checks the exact official URL, iframe, job, complete
      // list fingerprints and absence of a resume popup on both sides.
      await this.assertOrRestoreSearchWindow(title,searchScope(title),
        {frameOrigin,cardCount:saved.totalCount},this.status.phase);
    }
    return super.ensureVisibleRecruiterPage();
  }

  cardExpressionForWindow() {
    return this.cardWindowStart === 0 ? this.expressions.cards
      : searchCardsExpression(this.cardWindowStart);
  }

  async prepareCandidateCard(card,title,id) {
    await super.prepareCandidateCard(card);
    await this.assertJob(title,id);
    if ((await this.readModal()).active) throw fail('BOSS_RESUME_DIALOG_BLOCKED',
      'BOSS 搜索候选卡滚动后出现官方弹窗，已暂停采集');
    const clickText=card.clickText || card.text;
    const cardHash=crypto.createHash('sha256').update(clickText).digest('hex');
    const probe=async expectedIndex=>{
      try {return await this.session.evaluate(searchCardHeaderAdjustment(clickText,
        expectedIndex,!this.adjustedCardHashes.has(cardHash),card.text),
      {timeoutMs:12000});}
      catch (error) {
        if (error.code==='BOSS_CDP_TIMEOUT') throw fail('BOSS_CDP_SCROLL_UNCERTAIN',
          'BOSS 搜索候选卡位置调整结果无法确认，已暂停采集');
        throw error;
      }
    };
    let expectedIndex=card.index;
    let result=await probe(expectedIndex);
    if (result?.state==='card_reordered' &&
        Number.isSafeInteger(result.cardIndex) && result.cardIndex>=0) {
      // The SPA moved this exact unique card after the snapshot. Confirm the
      // same posted job and no dialog, then relocate only once. The DOM probe
      // also requires unchanged full card text before any scroll or click.
      expectedIndex=result.cardIndex;
      await this.assertJob(title,id);
      if ((await this.readModal()).active) throw fail('BOSS_RESUME_DIALOG_BLOCKED',
        'BOSS 候选卡重排时出现官方弹窗，已暂停采集');
      result=await probe(expectedIndex);
    }
    const unavailable=state=>{
      const error=fail('BOSS_CDP_TARGET_UNAVAILABLE',
        'BOSS 搜索候选卡点击区域不可确认，已暂停当前候选');
      error.stage='search_card_header_probe';
      error.targetState=state;
      return error;
    };
    if (result?.state==='ready') return;
    if (result?.state!=='adjusted') throw unavailable(result?.state || 'unknown');
    this.adjustedCardHashes.add(cardHash);
    await this.wait(350);
    await this.assertJob(title,id);
    if ((await this.readModal()).active) throw fail('BOSS_RESUME_DIALOG_BLOCKED',
      'BOSS 搜索候选卡位置调整后出现官方弹窗，已暂停采集');
    const checked=await probe(expectedIndex);
    if (checked?.state!=='ready') throw unavailable(checked?.state || 'unknown');
  }

  async assertJob(title,id) {
    await this.assertPage();
    const state=await this.readOnlyExpression(SEARCH_STATE,'read_search_state');
    if (state?.state!=='ready' || normalized(state.value)!==normalized(title) ||
        searchScope(title)!==id) {
      throw fail('BOSS_SEARCH_KEYWORD_MISMATCH',
        'BOSS 官方搜索页尚未确认当前岗位关键词，已暂停采集');
    }
    if (state.cardCount>0 && state.safeCardCount!==state.cardCount) {
      throw fail('BOSS_SEARCH_CARD_UNAVAILABLE',
        'BOSS 搜索结果中有无法确认官方简历入口的卡片，已暂停采集');
    }
    if (!state.selectedFiltersReady || state.nonDefaultSelected>0 ||
        state.checkedCount>0 || state.activeCustomSliderCount>0) throw fail(
      'BOSS_SEARCH_FILTER_UNVERIFIED',
      'BOSS 官方搜索页保留了额外平台筛选或无法确认默认筛选状态，已暂停采集');
    if (!this.searchEvidence || this.searchEvidence.frameOrigin!==state.frameOrigin ||
        this.searchEvidence.keyword!==normalized(title)) {
      if (state.matchingSearchRequests<1) throw fail('BOSS_SEARCH_NOT_SUBMITTED',
        'BOSS 搜索框已有关键词，但无法确认官方搜索请求已提交；请在搜索页按 Enter 后重试');
      this.searchEvidence={frameOrigin:state.frameOrigin,keyword:normalized(title)};
    }
    return state;
  }

  async selectJob(title) {
    const scope=searchScope(title);
    // A recruiter can start a saved-job search from the assistant. Submit the
    // exact active title through BOSS's visible search input once, then keep
    // the existing official-request and result checks before opening resumes.
    // An interrupted verification resume must never submit a new search.
    if (this.status.phase!=='validating_resume') {
      let state;
      for (let poll=0;poll<20;poll++) {
        state=await this.readOnlyExpression(SEARCH_STATE,'prepare_search_keyword');
        if (state?.state==='ready' && state.selectedFiltersReady) break;
        if (!['frame_unavailable','input_unavailable','ready'].includes(state?.state)) break;
        await this.assertPage({allowMissingFrame:true});
        await this.wait(500);
      }
      if (state?.state!=='ready' || !state.selectedFiltersReady) throw fail(
        'BOSS_SEARCH_PAGE_UNAVAILABLE',
        'BOSS 官方搜索控件未加载完成，未提交岗位搜索；请在平台页面确认后重试');
      if (normalized(state.value)!==normalized(title) ||
          state.matchingSearchRequests<1) {
        await this.submitOfficialSearch(title,state);
      }
    }
    const state=await this.assertJob(title,scope);
    if (!state.cardCount) throw fail('BOSS_SEARCH_RESULTS_UNAVAILABLE',
      'BOSS 当前搜索词没有可访问的候选卡片，请在官方页面确认搜索结果');
    this.activeSearchTitle=title;
    return {value:scope};
  }

  async submitOfficialSearch(title,before) {
    if (before?.state!=='ready' || !before.selectedFiltersReady ||
        before.nonDefaultSelected>0 || before.checkedCount>0 ||
        before.activeCustomSliderCount>0) throw fail('BOSS_SEARCH_FILTER_UNVERIFIED',
      'BOSS 官方搜索页有未确认的筛选条件，未自动提交岗位搜索');
    if ((await this.readModal()).active) throw fail('BOSS_RESUME_DIALOG_BLOCKED',
      'BOSS 当前有简历弹窗，未更改搜索关键词');
    await this.session.assertUsableRecruiterWindow({frameSelector:SEARCH_FRAME});
    await this.clickStableSearchControl('input.search-input',before.value,
      before.frameOrigin);
    // Trusted keyboard input preserves the official site's search handlers.
    // A failed or uncertain edit stops before clicking the search icon.
    await this.session.send('Input.dispatchKeyEvent',{
      type:'rawKeyDown',key:'Control',code:'ControlLeft',windowsVirtualKeyCode:17,modifiers:2
    });
    try {
      await this.session.send('Input.dispatchKeyEvent',{
        type:'rawKeyDown',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:2
      });
      await this.session.send('Input.dispatchKeyEvent',{
        type:'keyUp',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:2
      });
    } finally {
      await this.session.send('Input.dispatchKeyEvent',{
        type:'keyUp',key:'Control',code:'ControlLeft',windowsVirtualKeyCode:17
      });
    }
    await this.session.send('Input.insertText',{text:title});
    const filled=await this.readOnlyExpression(SEARCH_STATE,'verify_search_keyword');
    if (filled?.state!=='ready' || filled.frameOrigin!==before.frameOrigin ||
        normalized(filled.value)!==normalized(title) ||
        !filled.selectedFiltersReady || filled.nonDefaultSelected>0 ||
        filled.checkedCount>0 || filled.activeCustomSliderCount>0 ||
        (await this.readModal()).active) throw fail('BOSS_SEARCH_KEYWORD_MISMATCH',
      'BOSS 搜索框未准确写入当前岗位，未提交搜索');
    // The SPA can replace the focused input while applying the new value.
    // Its visible search icon submits without depending on that focus.
    await this.clickStableSearchControl('.search-input-wrap .icon-search',title,
      before.frameOrigin);
    for (let poll=0;poll<20;poll++) {
      await this.wait(500);
      await this.assertPage({allowMissingFrame:true});
      const state=await this.readOnlyExpression(SEARCH_STATE,'wait_official_search');
      if (state?.state==='ready' && normalized(state.value)===normalized(title) &&
          state.matchingSearchRequests>0 && state.cardCount>0) {
        await this.wait(800);
        return;
      }
    }
    throw fail('BOSS_SEARCH_RESULTS_UNAVAILABLE',
      'BOSS 官方岗位搜索未返回可确认的候选结果，未打开任何简历');
  }

  async clickStableSearchControl(selector,expectedValue,expectedFrameOrigin) {
    const click=()=>this.session.clickUnique({selector,frameSelector:SEARCH_FRAME});
    for (let attempt=0;attempt<3;attempt++) {
      try { return await click(); }
      catch (error) {
        // A pre-click probe/recheck has sent no mouse press. The official
        // search panel may briefly hide, move or replace a control while
        // rendering. Never retry an uncertain click or a changed document.
        const transient=['missing','hidden','obscured','out_of_view'];
        const safe=error.code==='BOSS_CDP_TARGET_UNSTABLE' &&
          error.stage==='pre_click_recheck' &&
          (error.reason==='position_moved' ||
            (error.reason==='target_not_ready' &&
              transient.includes(error.targetState))) ||
          error.code==='BOSS_CDP_TARGET_UNAVAILABLE' &&
          error.stage==='pre_click_probe' &&
          transient.includes(error.targetState);
        if (!safe || attempt===2) throw error;
        await this.wait(500+attempt*250);
        await this.assertPage();
        const state=await this.readOnlyExpression(SEARCH_STATE,
          'recheck_search_control');
        if (state?.state!=='ready' ||
            state.frameOrigin!==expectedFrameOrigin ||
            normalized(state.value)!==normalized(expectedValue) ||
            !state.selectedFiltersReady || state.nonDefaultSelected>0 ||
            state.checkedCount>0 || state.activeCustomSliderCount>0 ||
            (await this.readModal()).active) throw error;
      }
    }
  }

  async readCandidateCards(title,id,path,signal) {
    const cards=await super.readCandidateCards(title,id,path,signal);
    if (cards.some(card=>!card.clickText)) throw fail('BOSS_SEARCH_CARD_UNAVAILABLE',
      'BOSS 搜索卡片缺少唯一的官方简历入口，已暂停采集');
    return cards;
  }

  async assertRestorableCandidateWindow() {
    const saved=this.lastCandidateWindow;
    if (!saved || !Number.isSafeInteger(saved.start) || saved.start<0 ||
        !Number.isSafeInteger(saved.totalCount) || saved.totalCount<1 ||
        !Array.isArray(saved.cards) || saved.cards.length<1 ||
        saved.cards.length>1000) throw fail('BOSS_CDP_WINDOW_RESTORE_UNAVAILABLE',
      'BOSS 缺少可核对的候选列表断点，不能自动恢复最小化窗口');
    const live=await this.readOnlyExpression(searchCardsExpression(saved.start),
      'verify_restore_candidate_window');
    if (live?.totalCount!==saved.totalCount ||
        !Array.isArray(live.cards) || live.cards.length!==saved.cards.length ||
        live.cards.some((card,index)=>card.index!==saved.cards[index]?.index ||
          hashText(JSON.stringify([card.text,card.clickText]))!==saved.cards[index]?.fingerprint)) {
      throw fail('BOSS_CDP_WINDOW_RESTORE_UNAVAILABLE',
        'BOSS 候选卡列表已变化，不能自动恢复最小化窗口');
    }
  }

  async assertOrRestoreSearchWindow(title,id,expected,restorePhase='scrolling_candidates') {
    try {
      await this.session.assertUsableRecruiterWindow({frameSelector:SEARCH_FRAME});
      return false;
    } catch (error) {
      if (error.code!=='BOSS_CDP_WINDOW_MINIMIZED') throw error;
      if (this.windowRestoreUsed) throw fail('BOSS_CDP_WINDOW_MINIMIZED',
        'BOSS 专用 Chrome 本轮已自动恢复一次，再次最小化后已暂停；请手动恢复窗口并重新开始采集');
      if (!this.runIdentity || !this.lastCandidateWindow) throw error;
      const currentJob=this.jobService.current();
      if (this.runIdentity.title!==title || this.runIdentity.chosenId!==id ||
          this.runIdentity.jobSignature!==jobResumeSignature(currentJob)) throw fail(
        'BOSS_CDP_WINDOW_RESTORE_UNAVAILABLE',
        'BOSS 当前岗位条件已变化，不能自动恢复最小化窗口');
      const page=await this.assertPage();
      const frameUrl=page.iframeLiveUrl || page.iframeSrc;
      if (page.url!==this.runIdentity.pageUrl ||
          frameUrl!==this.runIdentity.frameUrl) throw fail(
        'BOSS_CDP_WINDOW_RESTORE_UNAVAILABLE',
        'BOSS 官方页面或搜索 iframe 已变化，不能自动恢复最小化窗口');
      const state=await this.assertJob(title,id);
      if (state.frameOrigin!==expected.frameOrigin ||
          state.cardCount!==expected.cardCount || state.cardCount<1) throw fail(
        'BOSS_CDP_WINDOW_RESTORE_UNAVAILABLE',
        'BOSS 官方搜索结果在窗口最小化期间变化，不能自动恢复');
      if ((await this.readOnlyExpression(SEARCH_MODAL,
        'verify_restore_no_modal'))?.active) throw fail(
        'BOSS_CDP_WINDOW_RESTORE_UNAVAILABLE',
        'BOSS 出现弹窗，不能自动恢复最小化窗口');
      await this.assertRestorableCandidateWindow();
      // Consume the sole in-batch attempt before the command: its ACK may
      // time out after Chrome already restored the window.
      this.windowRestoreUsed=true;
      this.progress({phase:'restoring_recruiter_window',windowRestoreCount:1});
      await this.session.restoreMinimizedOwnedWindow({expectedUrl:page.url});
      await this.ensureVisibleRecruiterPage();
      await this.session.assertUsableRecruiterWindow({frameSelector:SEARCH_FRAME});
      const afterPage=await this.assertPage();
      const afterFrameUrl=afterPage.iframeLiveUrl || afterPage.iframeSrc;
      const afterJob=await this.assertJob(title,id);
      if (afterPage.url!==page.url || afterFrameUrl!==frameUrl ||
          afterJob.frameOrigin!==expected.frameOrigin ||
          afterJob.cardCount!==expected.cardCount) throw fail(
        'BOSS_CDP_WINDOW_RESTORE_UNAVAILABLE',
        'BOSS 窗口恢复后页面、岗位或候选列表变化，已暂停采集');
      await this.assertRestorableCandidateWindow();
      const visible=await this.readOnlyExpression(
        searchVisibleCardsProbe(expected.frameOrigin),'verify_restore_visible_cards');
      if (visible?.state!=='ready' || visible.cardCount!==expected.cardCount ||
          visible.visibleCardCount<1) throw fail(
        'BOSS_CDP_WINDOW_RESTORE_UNAVAILABLE',
        'BOSS 窗口恢复后未确认可见候选卡，已暂停采集');
      this.progress({phase:restorePhase,windowRestoreCount:1});
      return true;
    }
  }

  async restabilizeLoadMore(title,id,before,first,expression) {
    // Called only after CDP proves its first attempt stopped before sending a
    // mouse event because the same target moved or slipped out of view. The
    // list may have reflowed in the meantime; a single scroll-only correction
    // is permitted after rechecking the exact job, frame and last card.
    const sameList=probe=>probe?.cardCount===first.cardCount &&
      probe?.lastCardText===first.lastCardText &&
      probe?.frameOrigin===first.frameOrigin;
    const modalActive=async()=>Boolean((await this.readOnlyExpression(
      SEARCH_MODAL,'search_load_more_modal_probe'))?.active);
    await this.assertOrRestoreSearchWindow(title,id,before);
    await this.wait(350);
    const job=await this.assertJob(title,id);
    if (job.frameOrigin!==before.frameOrigin) throw fail(
      'BOSS_SEARCH_LOAD_MORE_UNAVAILABLE',
      'BOSS 加载更多按钮移动时搜索页已重载，未发出点击，已暂停采集');
    if (job.cardCount>first.cardCount) return {newCards:true};
    if (job.cardCount!==first.cardCount || await modalActive()) throw fail(
      'BOSS_SEARCH_LOAD_MORE_UNAVAILABLE',
      'BOSS 加载更多按钮移动时候选列表或弹窗发生变化，未发出点击，已暂停采集');
    let probe=await this.readOnlyExpression(expression,'search_load_more_stabilize');
    if (probe?.state==='not_at_end' && sameList(probe)) {
      await super.scrollCards();
      await this.wait(350);
      const afterScroll=await this.assertJob(title,id);
      if (afterScroll.frameOrigin===before.frameOrigin &&
          afterScroll.cardCount>first.cardCount) return {newCards:true};
      if (afterScroll.frameOrigin!==before.frameOrigin ||
          afterScroll.cardCount!==first.cardCount ||
          await modalActive()) throw fail(
        'BOSS_SEARCH_LOAD_MORE_UNAVAILABLE',
        'BOSS 加载更多按钮重新定位时页面发生变化，未发出点击，已暂停采集');
      probe=await this.readOnlyExpression(expression,'search_load_more_rescroll');
    }
    if (probe?.state!=='ready' || !sameList(probe)) throw fail(
      'BOSS_SEARCH_LOAD_MORE_UNAVAILABLE',
      `BOSS 官方加载更多按钮无法重新稳定定位（${probe?.state || 'unknown'}），未发出点击，已暂停采集`);
    await this.wait(250);
    const final=await this.readOnlyExpression(expression,'search_load_more_stabilize_recheck');
    if (final?.state!=='ready' || !sameList(final) ||
        await modalActive()) throw fail(
      'BOSS_SEARCH_LOAD_MORE_UNAVAILABLE',
      'BOSS 官方加载更多按钮重新定位后仍不稳定，未发出点击，已暂停采集');
    await this.assertOrRestoreSearchWindow(title,id,before);
    const finalJob=await this.assertJob(title,id);
    if (finalJob.frameOrigin!==before.frameOrigin ||
        finalJob.cardCount!==first.cardCount) throw fail(
      'BOSS_SEARCH_LOAD_MORE_UNAVAILABLE',
      'BOSS 加载更多按钮点击前岗位或候选列表变化，未发出点击，已暂停采集');
    return {newCards:false};
  }

  async scrollCards() {
    const title=String(this.activeSearchTitle || '').trim();
    if (!title) throw fail('BOSS_SEARCH_KEYWORD_MISMATCH',
      'BOSS 本次采集的岗位关键词未确认，已暂停采集');
    const id=searchScope(title);
    let before;
    try { before=await this.assertJob(title,id); }
    catch (error) {
      // A minimized Chrome can temporarily hide the search input/iframe.
      // Preserve a genuine verification/login/rate-limit state, but otherwise
      // give the recruiter the actionable window state instead of a generic
      // missing-page diagnosis. No restore is possible without a job snapshot.
      if (['BOSS_VERIFICATION_REQUIRED','BOSS_LOGIN_REQUIRED',
        'BOSS_RATE_LIMITED'].includes(error.code)) throw error;
      try { await this.session.assertUsableRecruiterWindow({frameSelector:SEARCH_FRAME}); }
      catch (windowError) {
        if (windowError.code==='BOSS_CDP_WINDOW_MINIMIZED') throw windowError;
      }
      throw error;
    }
    await this.assertOrRestoreSearchWindow(title,id,before);
    if ((await this.readModal()).active) throw fail('BOSS_RESUME_DIALOG_BLOCKED',
      'BOSS 搜索列表滚动前仍有官方简历弹窗，已暂停采集');
    await super.scrollCards();
    await this.wait(350);
    const afterScroll=await this.assertJob(title,id);
    if (afterScroll.frameOrigin!==before.frameOrigin) throw fail(
      'BOSS_SEARCH_LOAD_MORE_UNCERTAIN','BOSS 搜索列表滚动时页面已重新加载，已暂停采集');
    if (afterScroll.cardCount>before.cardCount) return;
    const expression=searchLoadMoreProbe(title,before.frameOrigin);
    const first=await this.readOnlyExpression(expression,'search_load_more_probe');
    if (first?.state==='absent') return;
    if (first?.state!=='ready' || first.cardCount!==afterScroll.cardCount) throw fail(
      'BOSS_SEARCH_LOAD_MORE_UNAVAILABLE',
      `BOSS 官方加载更多控件状态无法确认（${first?.state || 'unknown'}），已暂停采集`);
    // A single click is allowed only after two matching DOM snapshots. The
    // CDP click helper independently confirms the visible hit point twice.
    await this.wait(250);
    const second=await this.readOnlyExpression(expression,'search_load_more_recheck');
    if (second?.state!=='ready' || second.cardCount!==first.cardCount ||
        second.lastCardText!==first.lastCardText ||
        second.frameOrigin!==first.frameOrigin) throw fail(
      'BOSS_SEARCH_LOAD_MORE_UNCERTAIN',
      'BOSS 官方加载更多控件或候选列表在点击前变化，已暂停采集');
    const beforeClick=await this.assertJob(title,id);
    if (beforeClick.frameOrigin!==before.frameOrigin ||
        beforeClick.cardCount!==first.cardCount ||
        (await this.readModal()).active) throw fail('BOSS_SEARCH_LOAD_MORE_UNCERTAIN',
      'BOSS 搜索岗位、候选列表或弹窗在点击前变化，已暂停采集');
    const clickOptions={selector:SEARCH_LOAD_MORE,
      frameSelector:SEARCH_FRAME,identityAttribute:'textContent',
      identityValue:'点击加载更多'};
    let clickError=null;
    try {
      const restored=await this.assertOrRestoreSearchWindow(title,id,beforeClick);
      if (restored) {
        const refreshed=await this.readOnlyExpression(expression,
          'search_load_more_after_window_restore');
        if (refreshed?.state!=='ready' || refreshed.cardCount!==first.cardCount ||
            refreshed.lastCardText!==first.lastCardText ||
            refreshed.frameOrigin!==first.frameOrigin) throw fail(
          'BOSS_SEARCH_LOAD_MORE_UNAVAILABLE',
          'BOSS 恢复窗口后加载更多按钮位置或候选列表变化，已暂停采集');
      }
      await this.session.clickUnique(clickOptions);
    } catch (error) {
      const safeMovement=error.code==='BOSS_CDP_TARGET_UNSTABLE' &&
        error.stage==='pre_click_recheck' &&
        (error.reason==='position_moved' ||
          (error.reason==='target_not_ready' && error.targetState==='out_of_view'));
      if (!safeMovement) clickError=error;
      else {
        try {
          const settled=await this.restabilizeLoadMore(title,id,before,first,expression);
          if (settled.newCards) return;
          // The first helper call sent no Input.dispatchMouseEvent. This is
          // the only follow-up click attempt, after exact list revalidation.
          await this.session.clickUnique(clickOptions);
        } catch (secondError) { clickError=secondError; }
      }
    }
    if (clickError) {
      const error=clickError;
      if (['BOSS_VERIFICATION_REQUIRED','BOSS_RATE_LIMITED',
        'BOSS_LOGIN_REQUIRED','BOSS_CDP_WINDOW_MINIMIZED',
        'BOSS_CDP_WINDOW_UNAVAILABLE','BOSS_CDP_VIEWPORT_TOO_SMALL',
        'BOSS_SEARCH_LOAD_MORE_UNAVAILABLE'].includes(error.code)) throw error;
      if (error.code==='BOSS_CDP_CLICK_UNCERTAIN') {
        // A mouse press may already have reached Chrome. If the recruiter
        // minimizes the window before the ACK, report the minimized state but
        // never invoke the one-time restore path or replay this click.
        let windowError=null;
        try { await this.session.assertUsableRecruiterWindow({frameSelector:SEARCH_FRAME}); }
        catch (candidate) { windowError=candidate; }
        if (windowError?.code==='BOSS_CDP_WINDOW_MINIMIZED') {
          try { await this.assertJob(title,id); }
          catch (pageError) {
            if (['BOSS_VERIFICATION_REQUIRED','BOSS_RATE_LIMITED',
              'BOSS_LOGIN_REQUIRED'].includes(pageError.code)) {
              pageError.cause=error;
              throw pageError;
            }
          }
          windowError.cause=error;
          throw windowError;
        }
      }
      if (['BOSS_CDP_TARGET_UNAVAILABLE','BOSS_CDP_TARGET_UNSTABLE']
        .includes(error.code)) {
        try { await this.session.assertUsableRecruiterWindow({frameSelector:SEARCH_FRAME}); }
        catch (windowError) {
          if (['BOSS_CDP_WINDOW_MINIMIZED','BOSS_CDP_WINDOW_UNAVAILABLE',
            'BOSS_CDP_VIEWPORT_TOO_SMALL'].includes(windowError.code)) {
            windowError.cause=error;
            throw windowError;
          }
        }
      }
      // The click helper may have timed out after Chrome received the press.
      // Observe the official page only: a verification or reset search state
      // is more actionable than a generic click error, but never retry here.
      try { await this.assertJob(title,id); } catch (pageError) {
        if (['BOSS_VERIFICATION_REQUIRED','BOSS_RATE_LIMITED',
          'BOSS_LOGIN_REQUIRED','BOSS_PAGE_UNAVAILABLE','BOSS_PAGE_HIDDEN',
          'BOSS_RECOMMEND_FRAME_UNAVAILABLE',
          'BOSS_SEARCH_KEYWORD_MISMATCH','BOSS_SEARCH_NOT_SUBMITTED',
          'BOSS_SEARCH_FILTER_UNVERIFIED','BOSS_SEARCH_CARD_UNAVAILABLE'
        ].includes(pageError.code)) {
          pageError.cause=error;
          throw pageError;
        }
      }
      // These two helper errors occur only before Input.dispatchMouseEvent.
      // Distinguish a safely unsent click from an acknowledgement timeout.
      if (error.code==='BOSS_CDP_TARGET_UNAVAILABLE' ||
          error.code==='BOSS_CDP_TARGET_UNSTABLE') {
        const targetState=error.reason && error.reason!=='target_not_ready'
          ? error.reason : error.targetState || error.code;
        const unavailable=fail('BOSS_SEARCH_LOAD_MORE_UNAVAILABLE',
          `BOSS 官方加载更多按钮点击前目标不可用（${targetState}）；未发出点击，已暂停采集`);
        unavailable.stage=error.stage || (error.code==='BOSS_CDP_TARGET_UNSTABLE'
          ? 'pre_click_recheck' : 'pre_click_probe');
        unavailable.targetState=targetState;
        unavailable.cause=error;
        throw unavailable;
      }
      const uncertain=fail('BOSS_SEARCH_LOAD_MORE_UNCERTAIN',
        'BOSS 官方加载更多按钮点击未确认，已暂停采集且不会自动重试');
      uncertain.stage=error.stage || 'load_more_click_ack';
      uncertain.cause=error;
      throw uncertain;
    }
    for (let poll=0;poll<30;poll++) {
      await this.wait(500);
      const result=await this.assertJob(title,id);
      if (result.frameOrigin!==before.frameOrigin) throw fail(
        'BOSS_SEARCH_LOAD_MORE_UNCERTAIN',
        'BOSS 加载更多后搜索页面已重新加载，已暂停采集');
      if (result.cardCount>first.cardCount) return;
    }
    throw fail('BOSS_SEARCH_LOAD_MORE_STALLED',
      'BOSS 官方加载更多点击后 15 秒仍无新增候选卡，已暂停采集');
  }

  async assertSameSearchResume(expectedTop=this.searchResumeContext?.lastKnownTop) {
    const context=this.searchResumeContext;
    if (!context) throw fail('BOSS_RESUME_DIALOG_BLOCKED',
      'BOSS 搜索简历缺少已确认的弹窗身份，已暂停采集');
    await this.assertJob(context.job.title,context.job.id);
    const modal=await this.readOnlyExpression(SEARCH_MODAL,'verify_search_resume_identity');
    if (!modal?.active || modal.transient || !modal.frameReady ||
        officialResumeUrl(modal.iframeSrc)?.href!==context.url ||
        officialResumeUrl(modal.iframeLiveUrl)?.href!==context.url ||
        modal.outerOrigin!==context.outerOrigin ||
        modal.resumeOrigin!==context.resumeOrigin ||
        !Number.isFinite(modal.scrollTop) ||
        (expectedTop!=null && Math.abs(modal.scrollTop-expectedTop)>2)) {
      throw fail('BOSS_RESUME_DIALOG_BLOCKED',
        'BOSS 搜索简历弹窗、候选画布或位置已变化，已暂停采集');
    }
    return modal;
  }

  async ensureVisibleSearchResume() {
    const page=await this.assertPage();
    if (page.visibilityState==='visible') return;
    if (page.visibilityState!=='hidden' || this.searchFocusRecoveryUsed ||
        !this.searchResumeContext) throw fail('BOSS_PAGE_HIDDEN',
      'BOSS 搜索简历页面再次隐藏或缺少已确认弹窗，已暂停采集');
    await this.assertSameSearchResume();
    // One foreground recovery per candidate. A second hide is not retried.
    this.searchFocusRecoveryUsed=true;
    await this.ensureVisibleRecruiterPage();
    await this.assertSameSearchResume();
  }

  async closeOfficialModal() {
    const initial=await this.readOnlyExpression(SEARCH_MODAL,'read_modal');
    if (!initial?.active) {this.searchResumeContext=null;return;}
    const page=await this.assertPage();
    if (page.visibilityState==='hidden') await this.ensureVisibleSearchResume();
    else if (page.visibilityState!=='visible') throw fail('BOSS_PAGE_HIDDEN',
      'BOSS 搜索简历关闭前页面可见性无法确认，已暂停采集');
    const modal=this.searchResumeContext
      ? await this.assertSameSearchResume() : await this.readModal();
    if (!modal.active) {this.searchResumeContext=null;return;}
    await this.session.clickUnique({selector:
      DIALOG + ' > .boss-popup__wrapper.boss-dialog.boss-dialog__wrapper.dialog-lib-resume .close-btn'});
    for (let attempt=0;attempt<30;attempt++) {
      if (this.stopRequested) throw fail('BOSS_STOPPED','已停止 BOSS 采集');
      const next=await this.readOnlyExpression(SEARCH_MODAL,'read_modal');
      if (!next?.active) {this.searchResumeContext=null;return;}
      const state=await this.assertPage();
      if (state.visibilityState==='hidden') await this.ensureVisibleSearchResume();
      else if (state.visibilityState!=='visible') throw fail('BOSS_PAGE_HIDDEN',
        'BOSS 搜索简历关闭期间页面可见性无法确认，已暂停采集');
      if (!next.transient && next.iframeSrc!==modal.iframeSrc) {
        throw fail('BOSS_RESUME_DIALOG_BLOCKED','BOSS 搜索简历弹窗在关闭时被替换，已暂停采集');
      }
      await this.wait(500);
    }
    throw fail('BOSS_RESUME_DIALOG_BLOCKED','BOSS 搜索简历弹窗未确认关闭，已暂停采集');
  }

  async verifiedCanvas(expectedUrl,expectedTop) {
    const inspect=async()=>{
      let page=await this.assertPage();
      if (page.visibilityState==='hidden') {
        await this.ensureVisibleSearchResume();
        page=await this.assertPage();
      }
      if (page.visibilityState!=='visible') throw fail('BOSS_PAGE_HIDDEN',
        'BOSS 搜索简历页面未保持可见，已暂停采集');
      const modal=await this.readModal();
      const identity=await this.readOnlyExpression(SEARCH_CANVAS_IDENTITY,
        'canvas_preflight');
      if (!modal.active || identity?.state!=='ready' ||
          modal.url?.href!==expectedUrl ||
          officialResumeUrl(identity.resumeUrl)?.href!==expectedUrl ||
          Math.abs(modal.scrollTop-expectedTop)>2 ||
          Math.abs(identity.scrollTop-expectedTop)>2) {
        throw fail('BOSS_RESUME_DIALOG_BLOCKED',
          'BOSS 搜索简历画布或位置已变化，已暂停采集');
      }
      return identity;
    };
    const before=await inspect();
    const image=await this.session.captureCanvasPng({frameSelector:RESUME_FRAME,
      canvasSelector:'canvas#resume',timeoutMs:15000});
    const after=await inspect();
    if (before.outerOrigin!==after.outerOrigin ||
        before.resumeOrigin!==after.resumeOrigin || before.width!==after.width ||
        before.height!==after.height ||
        image.readUInt32BE(16)!==after.width ||
        image.readUInt32BE(20)!==after.height) {
      throw fail('BOSS_RESUME_DIALOG_BLOCKED',
        'BOSS 搜索简历画布在读取期间发生变化，已暂停采集');
    }
    return {image,fingerprint:crypto.createHash('sha256').update(image).digest('hex')};
  }

  async setSearchResumeScrollTop(targetTop,expectedUrl) {
    await this.ensureVisibleSearchResume();
    const modal=await this.readModal();
    if (!modal.active || modal.url?.href!==expectedUrl ||
        !Number.isInteger(targetTop) || targetTop<0 ||
        targetTop>modal.scrollHeight-modal.clientHeight) {
      throw fail('BOSS_RESUME_SCROLL_UNAVAILABLE','BOSS 搜索简历目标位置无法确认');
    }
    const before=await this.readOnlyExpression(SEARCH_CANVAS_IDENTITY,'pre_scroll_probe');
    if (before?.state!=='ready' || Math.abs(before.scrollTop-modal.scrollTop)>2) {
      throw fail('BOSS_RESUME_SCROLL_UNAVAILABLE','BOSS 搜索简历画布已变化');
    }
    if (Math.abs(modal.scrollTop-targetTop)<1) return {after:modal.scrollTop};
    const expression=`(() => { /* bossRaw:searchScroll */
      if (location.href!==${JSON.stringify((await this.assertPage()).url)} ||
          performance.timeOrigin!==${before.outerOrigin}) return {state:'changed'};
      const dialogs=[...document.querySelectorAll(${JSON.stringify(DIALOG)})];
      if (dialogs.length!==1) return {state:'dialog_unavailable'};
      const wrappers=[...dialogs[0].querySelectorAll(${JSON.stringify(RESUME_WRAPPER)})];
      if (wrappers.length!==1) return {state:'dialog_unavailable'};
      const panes=[...wrappers[0].querySelectorAll('.resume-detail-wrap')];
      if (panes.length!==1) return {state:'pane_unavailable'};
      const frames=[...panes[0].querySelectorAll('iframe[src*="/web/frame/c-resume/"]')];
      if (frames.length!==1 || !frames[0].contentDocument ||
          frames[0].contentWindow.performance.timeOrigin!==${before.resumeOrigin} ||
          frames[0].contentWindow.location.href!==${JSON.stringify(expectedUrl)} ||
          Math.abs(panes[0].scrollTop-${modal.scrollTop})>2 ||
          ${targetTop}>panes[0].scrollHeight-panes[0].clientHeight) {
        return {state:'changed'};
      }
      panes[0].scrollTo({top:${targetTop},left:panes[0].scrollLeft,behavior:'instant'});
      return {state:'ready',after:panes[0].scrollTop};
    })()`;
    let result;
    try {result=await this.session.evaluate(expression,{timeoutMs:12000});}
    catch (error) {
      if (error.code==='BOSS_CDP_TIMEOUT') throw fail('BOSS_CDP_SCROLL_UNCERTAIN',
        'BOSS 搜索简历滚动命令可能已执行，已暂停采集');
      throw error;
    }
    if (result?.state!=='ready') throw fail('BOSS_RESUME_SCROLL_UNAVAILABLE',
      'BOSS 搜索简历位置在滚动前变化，已暂停采集');
    await this.wait(350);
    const after=await this.readModal();
    if (!after.active || after.url?.href!==expectedUrl ||
        Math.abs(after.scrollTop-targetTop)>2) throw fail('BOSS_CDP_SCROLL_UNCERTAIN',
      'BOSS 搜索简历滚动后未到达目标位置，已暂停采集');
    if (this.searchResumeContext) this.searchResumeContext.lastKnownTop=after.scrollTop;
    return {after:after.scrollTop};
  }

  async extractResume(deadlineAt,expectedJob) {
    this.searchResumeContext=null;
    this.searchFocusRecoveryUsed=false;
    this.progress({phase:'waiting_resume'});
    let modal;
    const firstModalDeadline=Math.min(deadlineAt,this.now()+20_000);
    let sawOfficial=false;
    while (this.now()<deadlineAt) {
      if (this.stopRequested) throw fail('BOSS_STOPPED','已停止 BOSS 采集');
      modal=await this.readModal();
      if (modal.active) sawOfficial=true;
      if (!sawOfficial && this.now()>=firstModalDeadline) throw fail(
        'BOSS_RESUME_UNAVAILABLE','BOSS 搜索卡未打开官方简历弹窗');
      if (modal.active && modal.frameReady &&
          (assessBossResumeText(modal.text).valid ||
            (modal.canvas && modal.canvasWidth>300 && modal.canvasHeight>150))) break;
      await this.wait(750);
    }
    if (!modal?.active || !modal.frameReady ||
        (!assessBossResumeText(modal.text).valid &&
          (!modal.canvas || modal.canvasWidth<=300 || modal.canvasHeight<=150))) {
      const error=fail('BOSS_CANDIDATE_TIMEOUT',
        'BOSS 搜索简历未在单份时间上限内完整渲染，已暂停采集');
      error.blankCanvas=Boolean(modal?.canvas && modal.canvasWidth<=300 && modal.canvasHeight<=150);
      throw error;
    }
    const expectedUrl=modal.url.href;
    await this.assertJob(expectedJob.title,expectedJob.id);
    if (officialResumeUrl(modal.iframeLiveUrl)?.href!==expectedUrl ||
        !Number.isFinite(modal.outerOrigin) || modal.outerOrigin<=0 ||
        !Number.isFinite(modal.resumeOrigin) || modal.resumeOrigin<=0) throw fail(
      'BOSS_RESUME_DIALOG_BLOCKED','BOSS 搜索简历 iframe 身份无法确认，已暂停采集');
    this.searchResumeContext={job:{title:expectedJob.title,id:expectedJob.id},
      url:expectedUrl,outerOrigin:modal.outerOrigin,
      resumeOrigin:modal.resumeOrigin,lastKnownTop:modal.scrollTop};
    if (modal.scrollTop>1) {
      await this.setSearchResumeScrollTop(0,expectedUrl);
      modal=await this.readModal();
    }
    if (assessBossResumeText(modal.text).valid) {
      return {text:modal.text,url:modal.url,method:'dom'};
    }
    const texts=[];
    const hashes=new Set();
    let reachedEnd=false;
    let previousAcceptedTop=null;
    let duplicateRecoveryShifts=0;
    for (let page=0;page<12;page++) {
      if (this.now()>=deadlineAt) throw fail('BOSS_CANDIDATE_TIMEOUT',
        'BOSS 搜索多页简历超过单份时间上限');
      this.progress({phase:`ocr_resume_page_${page+1}`});
      await this.ensureVisibleSearchResume();
      await this.assertJob(expectedJob.title,expectedJob.id);
      modal=await this.readModal();
      if (!modal.active || modal.url?.href!==expectedUrl) throw fail(
        'BOSS_RESUME_DIALOG_BLOCKED','BOSS 搜索简历弹窗已变化');
      const currentTop=modal.scrollTop;
      let stable=null;
      for (let attempt=0;attempt<20 && this.now()<deadlineAt;attempt++) {
        const first=await this.verifiedCanvas(expectedUrl,currentTop);
        await this.wait(300);
        const second=await this.verifiedCanvas(expectedUrl,currentTop);
        if (first.fingerprint===second.fingerprint &&
            !hashes.has(first.fingerprint)) {stable=second;break;}
        await this.wait(350);
      }
      if (!stable) throw fail('BOSS_RESUME_CANVAS_STALLED',
        'BOSS 搜索简历画布未稳定更新，未入库');
      let recognized=await this.ocr.recognizeTextFromImage(stable.image);
      if (repeatedScreenText(recognized,texts)) {
        // A settled Canvas may finish painting a moment after its dimensions
        // change. Re-read pixels once; never reuse an old OCR result as proof.
        await this.wait(600);
        const refreshedFirst=await this.verifiedCanvas(expectedUrl,currentTop);
        await this.wait(300);
        const refreshedSecond=await this.verifiedCanvas(expectedUrl,currentTop);
        if (refreshedFirst.fingerprint===refreshedSecond.fingerprint &&
            refreshedSecond.fingerprint!==stable.fingerprint &&
            !hashes.has(refreshedSecond.fingerprint)) {
          recognized=await this.ocr.recognizeTextFromImage(refreshedSecond.image);
          stable=refreshedSecond;
        }
      }
      if (repeatedScreenText(recognized,texts)) {
        modal=await this.readModal();
        if (!modal.active || modal.url?.href!==expectedUrl ||
            Math.abs(modal.scrollTop-currentTop)>2) throw fail(
          'BOSS_RESUME_DIALOG_BLOCKED','BOSS 搜索简历弹窗在 OCR 后变化');
        const max=Math.max(0,modal.scrollHeight-modal.clientHeight);
        const shifted=Math.min(max,currentTop+150);
        // Shift at most twice, and never past the last accepted viewport's
        // coverage. That can reveal lazy text without omitting resume lines.
        if (previousAcceptedTop!==null && duplicateRecoveryShifts<2 &&
            shifted>currentTop &&
            shifted<previousAcceptedTop+modal.clientHeight-32) {
          await this.setSearchResumeScrollTop(shifted,expectedUrl);
          duplicateRecoveryShifts++;
          await this.wait(500);
          continue;
        }
        throw fail('BOSS_RESUME_CANVAS_STALLED',
          'BOSS 搜索简历 OCR 为空白或重复，已尝试无缺页恢复但未入库');
      }
      hashes.add(stable.fingerprint);
      texts.push(recognized);
      previousAcceptedTop=currentTop;
      duplicateRecoveryShifts=0;
      modal=await this.readModal();
      if (!modal.active || modal.url?.href!==expectedUrl) throw fail(
        'BOSS_RESUME_DIALOG_BLOCKED','BOSS 搜索简历弹窗在 OCR 后变化');
      const max=Math.max(0,modal.scrollHeight-modal.clientHeight);
      if (max<=1 || modal.scrollTop>=max-2) {reachedEnd=true;break;}
      const next=Math.min(max,Math.round(modal.scrollTop+700));
      const moved=await this.setSearchResumeScrollTop(next,expectedUrl);
      if (moved.after<=currentTop) throw fail('BOSS_RESUME_SCROLL_UNAVAILABLE',
        'BOSS 搜索简历未能滚动到下一页');
      await this.wait(500);
    }
    if (!reachedEnd) throw fail('BOSS_RESUME_INCOMPLETE',
      'BOSS 搜索简历超过安全页数上限，未入库');
    const text=joinScreenText(texts);
    const quality=assessBossResumeText(text,{screens:texts,reachedEnd});
    if (!quality.valid) throw fail('BOSS_RESUME_CONTENT_INVALID',
      `BOSS 搜索简历正文不完整：${quality.reason}`);
    return {text,url:modal.url,method:'ocr'};
  }
}

module.exports={BossRawSearchCollector,SEARCH_FRAME,SEARCH_CARD,SEARCH_LINK,
  SEARCH_STATE,SEARCH_CARDS,SEARCH_MODAL,SEARCH_CANVAS_IDENTITY,
  SEARCH_LOAD_MORE,searchLoadMoreProbe,searchCardHeaderAdjustment,searchScope};
