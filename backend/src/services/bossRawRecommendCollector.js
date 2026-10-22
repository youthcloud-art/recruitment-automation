// The BOSS recommendation page is a long-lived SPA iframe. Attaching
// Playwright to the recruiter tab has caused repeated reloads in practice;
// this collector uses one raw CDP connection and deliberately never navigates.
const crypto = require('node:crypto');
const { connectOwnedBossPage } = require('./bossRawCdp');
const { ActiveJobService } = require('./activeJobService');
const resumeModel = require('../models/resumeModel');
const resumeParserService = require('./resumeParserService');
const CanvasOcrService = require('./canvasOcrService');
const { postCaptureEvaluationQueue } = require('./postCaptureEvaluationQueue');
const { assessBossResumeText } = require('./bossResumeQuality');
const { BossCardQuarantine } = require('./bossCardQuarantine');
const { verifiedBossOcrName } = require('../utils/bossCandidateName');

const FRAME = 'iframe[src*="/web/frame/recommend/"]';
const MAX_RUNTIME_MS = 90 * 60 * 1000;
const MAX_SCROLL_ROUNDS = 60;
const CARD_WINDOW_SIZE = 1000;
const CARD_WINDOW_STRIDE = 800;
const CANDIDATE_DEADLINE_MS = 4 * 60 * 1000;
const RECOMMEND_FRAME_SETTLE_POLLS = 20;
const RESUME_FRAME_PATH = /^\/web\/frame\/c-resume\/?$/;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeTitle(label) {
  return String(label || '').split(/\s*[_＿]\s*/)[0].replace(/\s+/g, ' ').trim();
}

function hashText(value) {
  return crypto.createHash('sha256').update(String(value || '')
    .normalize('NFKC').replace(/\s+/g, ' ').trim()).digest('hex');
}

function jobResumeSignature(job) {
  // A human may edit the active job while a BOSS verification is open. Never
  // apply an interrupted candidate list to a different evaluation context.
  return hashText(JSON.stringify([
    job?.title,job?.searchKeywords,job?.location,job?.education,
    job?.minExperienceYears,job?.targetCount,job?.recommendationTargetCount,
    job?.jobRequirements,job?.updatedAt
  ]));
}

function verifiedCardName(value) {
  const name = String(value || '').normalize('NFKC').replace(/\s+/g,'').trim();
  return /^[\u4e00-\u9fff]{2,4}$/.test(name) ? name : '';
}

function verifiedCardPosition(value) {
  const position = String(value || '').normalize('NFKC')
    .replace(/\s+/g,' ').trim();
  return position.length >= 2 && position.length <= 24 &&
      /[\u4e00-\u9fff]{2}/.test(position) &&
      /^[\u4e00-\u9fffA-Za-z0-9\/（）()·+\- ]+$/.test(position) &&
      !/^(?:不限|待定|无|地区不限|行业不限)$/.test(position)
    ? position : '';
}

function joinScreenText(screens) {
  let result = '';
  for (const screen of screens) {
    const next = String(screen || '').trim();
    if (!next) continue;
    if (!result) { result = next; continue; }
    // A 700-pixel step overlaps adjacent 885-pixel views. Trim only an
    // identical overlap; fuzzy OCR merging could discard real resume lines.
    let overlap = 0;
    for (let size = Math.min(500,result.length,next.length); size >= 40; size--) {
      if (result.slice(-size) === next.slice(0,size)) { overlap = size; break; }
    }
    result += `\n${next.slice(overlap)}`;
  }
  return result;
}

function repeatedScreenText(current,priorScreens) {
  const normalize = value => String(value || '').normalize('NFKC')
    .toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
  const next = normalize(current);
  if (next.length < 30) return true;
  for (const prior of priorScreens) {
    const previous = normalize(prior);
    if (next === previous) return true;
    if (next.length < 120 || previous.length < 120 ||
        Math.min(next.length,previous.length) / Math.max(next.length,previous.length) < .8) continue;
    const grams = value => new Set([...Array(value.length-4)].map((_,i)=>value.slice(i,i+5)));
    const a=grams(next),b=grams(previous);
    let shared=0;
    for (const gram of a) if (b.has(gram)) shared++;
    if (shared / Math.min(a.size,b.size) >= .96) return true;
  }
  return false;
}

function chooseExactJob(options, title) {
  const matches = (options || []).filter(item =>
    normalizeTitle(item.label) === title && /^[A-Za-z0-9_-]{1,128}$/.test(item.value || ''));
  if (matches.length !== 1) throw fail('BOSS_RECOMMENDED_JOB_UNAVAILABLE',
    `BOSS 企业账号下没有唯一的“${title}”在招岗位；请改用“官方搜索结果”模式，或在平台确认同名在招岗位`);
  return matches[0];
}

function officialResumeUrl(value) {
  try {
    const url = new URL(value, 'https://www.zhipin.com');
    return url.origin === 'https://www.zhipin.com' && RESUME_FRAME_PATH.test(url.pathname)
      ? url : null;
  } catch (_) { return null; }
}

function candidateIdFromUrl(url) {
  if (!url) return '';
  return ['expectId', 'expectid', 'geekId', 'geekid']
    .map(key => url.searchParams.get(key)).find(value =>
      value && /^[A-Za-z0-9_-]{1,256}$/.test(value)) || '';
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function safePhase(value) {
  const phase=String(value || '');
  return /^[a-z0-9_]{1,64}$/.test(phase) ? phase : 'unknown';
}

// Markers make the read-only DOM probes straightforward to fake in unit tests.
function buildExpressions(frameSelector, cardSelector, cardWindowStart = 0) { return {
  page: `(() => { /* bossRaw:page */
    const url = location.href;
    const iframe = document.querySelector(${JSON.stringify(frameSelector)});
    let iframeLiveUrl = '';
    try { iframeLiveUrl = iframe?.contentWindow?.location?.href || ''; }
    catch (_) { /* A changed-origin iframe is treated as unavailable below. */ }
    const login = !!document.querySelector('input[type="password"], input[placeholder*="手机号"]');
    const body = (document.body?.innerText || '').slice(0, 3000);
    return {url, iframeSrc: iframe?.src || '', iframeLiveUrl,
      frameReady: !!iframe?.contentDocument,
      visibilityState:document.visibilityState,
      login, challenge: /安全验证|请完成验证|人机验证|滑块验证/.test(body),
      rateLimited: /访问过于频繁|操作过于频繁|请求过于频繁|访问受限|请稍后再试/.test(body)};
  })()`,
  job: `(() => { /* bossRaw:job */
    const frame = document.querySelector(${JSON.stringify(frameSelector)});
    const doc = frame?.contentDocument;
    if (!doc) return null;
    const trigger = doc.querySelector('.ui-dropmenu-label');
    const options = [...doc.querySelectorAll('.job-selecter-options li.job-item, .ui-dropmenu-list li.job-item')]
      .map(el => ({value:el.getAttribute('value') || '',
        label:(el.querySelector('.label')?.textContent || el.textContent || '').replace(/\\s+/g,' ').trim()}));
    // The iframe is a SPA: its original src attribute can remain jobid=null
    // after selecting a posted job. Read the live same-origin frame URL.
    let jobId = '';
    try {
      const liveUrl = new URL(frame.contentWindow.location.href);
      if (liveUrl.origin !== 'https://www.zhipin.com' ||
          !['/web/frame/recommend/', '/web/frame/recommend'].includes(liveUrl.pathname)) return null;
      jobId = liveUrl.searchParams.get('jobid') || '';
    } catch (_) { return null; }
    return {selectedLabel:(trigger?.textContent || '').replace(/\\s+/g,' ').trim(),jobId,options};
  })()`,
  cards: `(() => { /* bossRaw:cards */
    const doc = document.querySelector(${JSON.stringify(frameSelector)})?.contentDocument;
    if (!doc) return null;
    const all = [...doc.querySelectorAll(${JSON.stringify(cardSelector)})];
    return {totalCount:all.length,cards:all.slice(${cardWindowStart},
      ${cardWindowStart + CARD_WINDOW_SIZE})
      .map(el => {
        const names = [...el.querySelectorAll('.row.name-wrap > span.name')];
        const expected = [...el.querySelectorAll('.row.expect-wrap .join-text-wrap > span')];
        const resumeLinks = [...el.querySelectorAll(':scope > a[ka="search_click_open_resume"]')];
        return {text:(el.textContent || '').replace(/\\s+/g,' ').trim(),
          clickText:resumeLinks.length === 1
            ? (resumeLinks[0].textContent || '').replace(/\\s+/g,' ').trim() : '',
          displayName:names.length === 1 ? (names[0].textContent || '').trim() : '',
          expectedPosition:expected.length === 2
            ? (expected[1].textContent || '').trim() : ''};
      })
      .filter(item => item.text)};
  })()`,
  modal: `(() => { /* bossRaw:modal */
    const recommend = document.querySelector(${JSON.stringify(frameSelector)})?.contentDocument;
    const dialog = recommend?.querySelector('.dialog-wrap.active');
    if (!dialog) return document.querySelector('div[data-type="boss-dialog"].active')
      ? {active:true,transient:true,iframeSrc:'',frameReady:false,text:'',canvas:false}
      : {active:false};
    const iframe = dialog.querySelector('iframe');
    const doc = iframe?.contentDocument;
    const pane = dialog.querySelector('.resume-detail-wrap');
    const source = doc?.querySelector('.resume-detail-wrap, .resume-content, .profile-content, .user-detail, .candidate-detail, .talent-detail');
    let text = '';
    if (source) {
      const clone = source.cloneNode(true);
      clone.querySelectorAll('.resume-warning, .resume-anonymous-geek-card.v2').forEach(el => el.remove());
      text = (clone.textContent || '').trim();
    }
    const canvas = doc?.querySelector('canvas#resume');
    return {active:true,iframeSrc:iframe?.src || '',frameReady:!!doc,
      source:source?.className || '',text,canvas:!!canvas,
      canvasWidth:canvas?.width || 0,canvasHeight:canvas?.height || 0,
      scrollTop:pane?.scrollTop || 0,scrollHeight:pane?.scrollHeight || 0,
      clientHeight:pane?.clientHeight || 0};
  })()`,
  canvasIdentity: `(() => { /* bossRaw:canvasIdentity */
    const outer = document.querySelector(${JSON.stringify(frameSelector)});
    const recommend = outer?.contentDocument;
    const dialogs = [...(recommend?.querySelectorAll('.dialog-wrap.active') || [])];
    if (dialogs.length !== 1) return {state:'dialog_unavailable'};
    const panes = [...dialogs[0].querySelectorAll('.resume-detail-wrap')];
    if (panes.length !== 1) return {state:'pane_unavailable'};
    const frames = [...panes[0].querySelectorAll('iframe[src*="/web/frame/c-resume/"]')];
    if (frames.length !== 1 || !frames[0].contentDocument) return {state:'frame_unavailable'};
    const canvases = [...frames[0].contentDocument.querySelectorAll('canvas#resume')];
    if (canvases.length !== 1) return {state:'canvas_unavailable'};
    const canvas = canvases[0];
    const rect = canvas.getBoundingClientRect();
    const frameRect = frames[0].getBoundingClientRect();
    if (document.visibilityState !== 'visible' || canvas.width <= 300 ||
        canvas.height <= 150 || canvas.width * canvas.height > 16 * 1024 * 1024 ||
        rect.width < 200 || rect.height < 200 ||
        rect.right <= 0 || rect.bottom <= 0 ||
        rect.left >= frameRect.width || rect.top >= frameRect.height) {
      return {state:'canvas_unready'};
    }
    let resumeUrl = '';
    try { resumeUrl = frames[0].contentWindow.location.href; }
    catch (_) { return {state:'frame_unavailable'}; }
    return {state:'ready',resumeUrl,scrollTop:panes[0].scrollTop,
      width:canvas.width,height:canvas.height,
      outerOrigin:outer.contentWindow.performance.timeOrigin,
      resumeOrigin:frames[0].contentWindow.performance.timeOrigin};
  })()`,
  guide: `(() => { /* bossRaw:guide */
    const overlays = [...document.querySelectorAll('div[data-type="boss-dialog"].active')];
    if (!overlays.length) return {active:false};
    const overlay = overlays.length === 1 ? overlays[0] : null;
    const wrappers = overlay ? [...overlay.querySelectorAll('.anonymous-geek-guide-list-wrapper')] : [];
    const wrapper = wrappers.length === 1 ? wrappers[0] : null;
    const close = wrapper ? [...wrapper.querySelectorAll('.boss-popup__close')] : [];
    const frames = wrapper ? [...wrapper.querySelectorAll('iframe')] : [];
    let officialSearch = false;
    if (frames.length === 1) {
      try {
        const url = new URL(frames[0].src);
        officialSearch = url.origin === 'https://www.zhipin.com' &&
          /^\\/web\\/frame\\/search\\/?$/.test(url.pathname);
      } catch (_) {}
    }
    let frameText = '';
    if (officialSearch) {
      try { frameText = frames[0].contentDocument?.body?.innerText || ''; }
      catch (_) { officialSearch = false; }
    }
    const content = (wrapper?.innerText || '') + ' ' + frameText;
    const challenge = /安全验证|请完成验证|滑块验证|访问过于频繁|操作过于频繁|请求过于频繁/.test(content);
    const resume = document.querySelector(${JSON.stringify(frameSelector)})
      ?.contentDocument?.querySelector('.dialog-wrap.active');
    return {active:true,eligible:!!overlay && !!wrapper && close.length === 1 &&
      officialSearch && !resume && !challenge,challenge};
  })()`
}; }

const EXPRESSIONS = buildExpressions(FRAME,'li.card-item');

class BossRawRecommendCollector {
  constructor({ connect = connectOwnedBossPage, store = resumeModel,
    jobService = new ActiveJobService(), queue = postCaptureEvaluationQueue,
    ocr = new CanvasOcrService(), wait = sleep, now = Date.now,
    quarantine = new BossCardQuarantine(),onProgress = () => {} } = {}) {
    this.connect = connect;
    this.frameSelector = FRAME;
    this.cardSelector = 'li.card-item';
    this.clickSelector = this.cardSelector;
    this.pageSegment = 'recommend';
    this.maxRuntimeCapMs = MAX_RUNTIME_MS;
    this.expressions = EXPRESSIONS;
    this.store = store;
    this.jobService = jobService;
    this.queue = queue;
    this.ocr = ocr;
    this.wait = wait;
    this.now = now;
    this.quarantine = quarantine;
    this.onProgress = onProgress;
    this.session = null;
    this.stopRequested = false;
    this.cardWindowStart = 0;
    this.cardWindowTotal = 0;
    this.status = {state:'idle',saved:0,attempted:0,skipped:0,scrollRounds:0,
      targetCount:0,phase:'idle',lastFailureCode:'',lastError:'',
      pausedAtPhase:'',pausedAtStage:'',startedAt:null,finishedAt:null};
    this.completedCardFingerprints = new Set();
    this.resumeCheckpoint = null;
    this.lastCandidateWindow = null;
    this.runIdentity = null;
  }

  progress(patch) {
    Object.assign(this.status, patch);
    this.onProgress({...this.status});
  }

  stop() { this.stopRequested = true; }
  getStatus() { return {...this.status}; }

  canResume() {
    return this.pageSegment==='search' && this.status.state==='paused' &&
      this.status.lastFailureCode==='BOSS_VERIFICATION_REQUIRED' &&
      !!this.resumeCheckpoint?.window?.cards?.length;
  }

  getResumeInfo() {
    if (!this.canResume()) return null;
    return {mode:'search',filters:{position:this.resumeCheckpoint.title},
      targetCount:this.resumeCheckpoint.targetCount,
      maxRuntimeMinutes:this.resumeCheckpoint.runtimeLimitMs/60_000};
  }

  validateResumeRequest({job,targetCount,runtimeLimitMs}) {
    if (!this.canResume()) throw fail('BOSS_RESUME_UNAVAILABLE',
      '当前 BOSS 采集没有可安全续接的人工验证断点，请新建任务');
    const checkpoint=this.resumeCheckpoint;
    if (checkpoint.jobSignature!==jobResumeSignature(job) ||
        checkpoint.title!==String(job?.title || '').trim() ||
        checkpoint.targetCount!==targetCount ||
        checkpoint.runtimeLimitMs!==runtimeLimitMs) throw fail(
      'BOSS_RESUME_JOB_CHANGED',
      '岗位条件、目标份数或运行上限与验证前不同，已拒绝续采');
    return checkpoint;
  }

  candidateWindowSnapshot(cards) {
    if (this.pageSegment!=='search' || !Array.isArray(cards) ||
        cards.length<1 || cards.length>1000 ||
        !Number.isSafeInteger(this.cardWindowTotal) || this.cardWindowTotal<cards.length ||
        !Number.isSafeInteger(this.cardWindowStart) || this.cardWindowStart<0) return null;
    const indices=new Set();
    const items=[];
    for (const card of cards) {
      if (!Number.isSafeInteger(card.index) || card.index<0 ||
          indices.has(card.index) || !String(card.text || '').trim() ||
          !String(card.clickText || '').trim()) return null;
      indices.add(card.index);
      items.push({index:card.index,
        fingerprint:hashText(JSON.stringify([card.text,card.clickText]))});
    }
    if (items.some((card,index)=>index>0 && card.index<=items[index-1].index)) return null;
    return {start:this.cardWindowStart,totalCount:this.cardWindowTotal,cards:items};
  }

  rememberCandidateWindow(cards) {
    if (this.pageSegment==='search') {
      this.lastCandidateWindow=this.candidateWindowSnapshot(cards);
    }
  }

  validateResumeWindow(checkpoint,cards) {
    const current=this.candidateWindowSnapshot(cards);
    if (!current || !checkpoint?.window ||
        JSON.stringify(current)!==JSON.stringify(checkpoint.window)) throw fail(
      'BOSS_RESUME_LIST_CHANGED',
      'BOSS 人工验证后候选卡列表顺序或完整文字发生变化，已拒绝续采；可新建任务并由已入库数据去重');
  }

  markTimeoutQuarantine(jobId, cardFingerprint) {
    try { this.quarantine.mark(jobId,cardFingerprint,'BOSS_CDP_TIMEOUT'); }
    catch (_) { throw fail('BOSS_CARD_QUARANTINE_WRITE_FAILED',
      'BOSS 超时卡片无法保存暂缓记录，已暂停采集；请检查本地数据目录'); }
  }

  async readOnlyExpression(expression, stage, timeoutMs = 15000) {
    try { return await this.session.evaluate(expression,{timeoutMs}); }
    catch (error) { if (!error.stage) error.stage = stage; throw error; }
  }

  async assertPage({allowMissingFrame=false}={}) {
    const page = await this.readOnlyExpression(this.expressions.page,'read_page');
    // The recruiter can redirect to official verification or login between
    // candidate steps. Preserve the actionable pause reason before checking
    // whether the current URL still points at the recommendation list.
    if (/captcha|\/verify(?:\.html)?(?:[/?#]|$)|\/security-check/.test(page?.url || '') ||
        /captcha|\/verify(?:\.html)?(?:[/?#]|$)|\/security-check/.test(page?.iframeLiveUrl || '') ||
        page?.challenge) throw fail('BOSS_VERIFICATION_REQUIRED',
      'BOSS 请求人工安全验证，已暂停采集');
    if (page?.rateLimited) throw fail('BOSS_RATE_LIMITED',
      'BOSS 提示访问频繁，已暂停采集，请稍后由人工确认后继续');
    if (page?.login || /^https:\/\/www\.zhipin\.com\/web\/user(?:[/?#]|$)/.test(page?.url || '') ||
        /^https:\/\/www\.zhipin\.com\/web\/user(?:[/?#]|$)/.test(page?.iframeLiveUrl || '')) {
      throw fail('BOSS_LOGIN_REQUIRED', 'BOSS 登录会话失效，已暂停采集');
    }
    const expectedPage = new RegExp(`^https:\\/\\/www\\.zhipin\\.com\\/web\\/(chat|boss)\\/${this.pageSegment}(?:[/?#]|$)`);
    const expectedFrame = new RegExp(`^https:\\/\\/www\\.zhipin\\.com\\/web\\/frame\\/${this.pageSegment}\\/`);
    if (!page || !expectedPage.test(page.url || '')) {
      throw fail('BOSS_PAGE_UNAVAILABLE', 'BOSS 当前不是预期的招聘端候选人页面，已暂停采集');
    }
    if ((!page.frameReady || !expectedFrame.test(page.iframeLiveUrl || page.iframeSrc || '')) &&
        !allowMissingFrame) {
      throw fail('BOSS_RECOMMEND_FRAME_UNAVAILABLE', 'BOSS 推荐列表未加载，已暂停采集');
    }
    return page;
  }

  async assertCandidateListJob(title, id, expectedPath, signal) {
    // Closing a genuine resume can briefly destroy/recreate BOSS's SPA
    // recommendation iframe. This recovery is limited to the candidate-list
    // stage: never wait through a changed route, login, verification, or a
    // different posted job. It performs no click, navigation or job selection.
    let sawFrameGap = false;
    for (let poll = 0; poll <= RECOMMEND_FRAME_SETTLE_POLLS; poll++) {
      if (this.stopRequested || signal?.aborted) throw fail('BOSS_STOPPED',
        '已停止 BOSS 采集');
      const page = await this.assertPage({allowMissingFrame:true});
      if (new URL(page.url).pathname !== expectedPath) throw fail('BOSS_PAGE_UNAVAILABLE',
        'BOSS 推荐页面在采集期间发生切换，已暂停采集');
      const frameUrl=page.iframeLiveUrl || page.iframeSrc;
      if (frameUrl && frameUrl !== 'about:blank' &&
          !new RegExp(`^https:\\/\\/www\\.zhipin\\.com\\/web\\/frame\\/${this.pageSegment}\\/`).test(frameUrl)) {
        throw fail('BOSS_RECOMMEND_FRAME_UNAVAILABLE',
          'BOSS 推荐列表切换为未知页面，已暂停采集');
      }
      if (page.frameReady && page.iframeSrc) {
        try {
          await this.assertJob(title,id);
          return;
        } catch (error) {
          if (error.code !== 'BOSS_RECOMMEND_FRAME_UNAVAILABLE' &&
              !(sawFrameGap && error.code === 'BOSS_RECOMMENDED_JOB_UNAVAILABLE')) throw error;
        }
      }
      sawFrameGap = true;
      if (poll === RECOMMEND_FRAME_SETTLE_POLLS) break;
      await this.wait(500);
    }
    throw fail('BOSS_RECOMMEND_FRAME_UNAVAILABLE',
      'BOSS 推荐列表在 10 秒内未恢复并确认原岗位，已暂停采集');
  }

  async readCandidateCards(title, id, expectedPath, signal) {
    // The outer frame may already exist while its candidate list document is
    // still mounting. Do not classify that short null read as a finished list.
    for (let poll = 0; poll <= RECOMMEND_FRAME_SETTLE_POLLS; poll++) {
      await this.assertCandidateListJob(title,id,expectedPath,signal);
      const expression = this.cardExpressionForWindow();
      const result = await this.readOnlyExpression(expression,'read_candidate_cards');
      // Legacy test doubles may return an array; the live DOM probe also
      // reports the uncapped list length so we can visit later windows.
      if (Array.isArray(result)) { this.cardWindowTotal = result.length; return result; }
      if (result && Array.isArray(result.cards) &&
          Number.isSafeInteger(result.totalCount) && result.totalCount >= 0) {
        this.cardWindowTotal = result.totalCount;
        if (this.cardWindowStart > 0 && result.totalCount <= this.cardWindowStart) {
          // The official SPA can replace a long list with a short virtualized
          // window. Rewind once so newly visible cards are not mistaken for an
          // exhausted tail. The run-scoped seen set still prevents duplicates.
          this.cardWindowStart = 0;
          const head = await this.readOnlyExpression(
            this.cardExpressionForWindow(),'read_candidate_cards_rewind');
          if (!head || !Array.isArray(head.cards) ||
              !Number.isSafeInteger(head.totalCount) || head.totalCount < 0) {
            throw fail('BOSS_RECOMMEND_LIST_UNAVAILABLE',
              'BOSS 候选列表重排后无法确认新的列表，已暂停采集');
          }
          this.cardWindowTotal = head.totalCount;
          return head.cards;
        }
        return result.cards;
      }
      if (poll === RECOMMEND_FRAME_SETTLE_POLLS) break;
      await this.wait(500);
    }
    throw fail('BOSS_RECOMMEND_LIST_UNAVAILABLE',
      'BOSS 推荐候选人列表在 10 秒内未恢复，已暂停采集');
  }

  cardExpressionForWindow() {
    return this.cardWindowStart === 0 ? this.expressions.cards
      : buildExpressions(this.frameSelector,this.cardSelector,this.cardWindowStart).cards;
  }

  advanceCardWindowIfNeeded() {
    if (this.cardWindowTotal <= this.cardWindowStart + CARD_WINDOW_SIZE) return false;
    // Keep 200 cards of overlap when the SPA appends a large batch. The seen
    // fingerprints prevent reprocessing the overlap without losing the tail.
    this.cardWindowStart += CARD_WINDOW_STRIDE;
    return true;
  }

  rewindCardWindowAfterScroll() {
    // A retained list can prepend cards while scrolling; a virtualized list
    // can recycle its DOM nodes. Rescan from the head after each bounded
    // scroll, then advance through overlapping 1000-card windows as needed.
    this.cardWindowStart = 0;
    this.cardWindowTotal = 0;
  }

  async prepareCandidateCard(card) {
    await this.session.scrollUnique({selector:this.clickSelector,
      frameSelector:this.frameSelector,identityAttribute:'textContent',
      identityValue:card.clickText || card.text});
  }

  async readJob() {
    await this.assertPage();
    const state = await this.readOnlyExpression(this.expressions.job,'read_job');
    if (!state?.selectedLabel) throw fail(
      'BOSS_RECOMMENDED_JOB_UNAVAILABLE', 'BOSS 当前推荐岗位尚未加载，已暂停采集');
    return state;
  }

  async ensureVisibleRecruiterPage() {
    const before = await this.assertPage();
    if (before.visibilityState === 'visible') return;
    if (before.visibilityState !== 'hidden') throw fail('BOSS_PAGE_HIDDEN',
      'BOSS 招聘页可见性状态无法确认，已暂停采集');
    this.progress({phase:'activating_recruiter_page'});
    try {
      // These CDP commands restore the owned Chrome tab's normal foreground
      // lifecycle. They do not navigate, request verification or interact
      // with a candidate. BOSS delays Canvas/v-leave indefinitely while the
      // document remains hidden.
      await this.session.send('Page.setWebLifecycleState',{state:'active'},
        {timeoutMs:8000});
      await this.session.send('Emulation.setFocusEmulationEnabled',{enabled:true},
        {timeoutMs:8000});
      // The official resume iframe may leave its Canvas at the blank 300x150
      // placeholder until the owned recruiter tab actually reaches the front.
      await this.session.send('Page.bringToFront',{}, {timeoutMs:8000});
    } catch (error) {
      throw fail('BOSS_PAGE_HIDDEN',
        `BOSS 招聘页无法恢复可见状态：${error.message || 'CDP 命令失败'}`);
    }
    for (let attempt = 0; attempt < 12; attempt++) {
      const after = await this.assertPage();
      if (after.url !== before.url) throw fail('BOSS_PAGE_UNAVAILABLE',
        'BOSS 招聘页在恢复可见状态时发生切换，已暂停采集');
      if (after.visibilityState === 'visible') return;
      await this.wait(250);
    }
    throw fail('BOSS_PAGE_HIDDEN',
      'BOSS 招聘页仍处于隐藏状态，Canvas 无法可靠加载，已暂停采集');
  }

  async selectJob(title) {
    const initial = await this.readJob();
    if (!initial.options?.length) throw fail('BOSS_RECOMMENDED_JOB_UNAVAILABLE',
      'BOSS 推荐岗位选项尚未加载，已暂停采集');
    const chosen = chooseExactJob(initial.options, title);
    if (normalizeTitle(initial.selectedLabel) !== title || initial.jobId !== chosen.value) {
      // Only one intentional dropdown interaction. No reloads or URL changes.
      await this.session.clickUnique({selector:'.ui-dropmenu-label',frameSelector:this.frameSelector});
      await this.session.scrollUnique({selector:`.job-selecter-options li.job-item[value="${chosen.value}"]`,
        frameSelector:this.frameSelector,identityAttribute:'value',identityValue:chosen.value});
      await this.session.clickUnique({selector:`.job-selecter-options li.job-item[value="${chosen.value}"]`,
        frameSelector:this.frameSelector,identityAttribute:'value',identityValue:chosen.value});
    }
    let stable = 0;
    for (let attempt = 0; attempt < 16; attempt++) {
      if (this.stopRequested) throw fail('BOSS_STOPPED', '已停止 BOSS 采集');
      const state = await this.readJob().catch(() => null);
      if (state && normalizeTitle(state.selectedLabel) === title && state.jobId === chosen.value) {
        if (++stable >= 2) return chosen;
      } else stable = 0;
      await this.wait(500);
    }
    throw fail('BOSS_RECOMMENDED_JOB_MISMATCH',
      `BOSS 无法确认候选人列表属于“${title}”，已暂停采集`);
  }

  async assertJob(title, id) {
    const state = await this.readJob();
    if (normalizeTitle(state.selectedLabel) !== title || state.jobId !== id) {
      throw fail('BOSS_RECOMMENDED_JOB_MISMATCH',
        `BOSS 当前推荐岗位与“${title}”不一致，已暂停采集`);
    }
  }

  async captureVerifiedCanvas({expectedJob,expectedResumeUrl,expectedScrollTop,
    expectedOrigins=null}) {
    // This is a read-only fallback for a timed-out CDP screenshot. Never
    // select a different iframe, scroll, click, or infer a candidate from OCR.
    const inspect = async stage => {
      const page = await this.assertPage();
      if (page.visibilityState !== 'visible') throw fail('BOSS_PAGE_HIDDEN',
        'BOSS 简历画布读取前页面不再可见，已暂停采集');
      await this.assertJob(expectedJob.title,expectedJob.id);
      const modal = await this.readOnlyExpression(this.expressions.modal,stage);
      if (!modal?.active || !Number.isFinite(modal.scrollTop) ||
          !officialResumeUrl(modal.iframeSrc) ||
          officialResumeUrl(modal.iframeSrc).href !== expectedResumeUrl ||
          Math.abs(modal.scrollTop-expectedScrollTop) > 2) {
        throw fail('BOSS_RESUME_DIALOG_BLOCKED',
          'BOSS 简历弹窗或滚动位置在画布读取时发生变化，已暂停采集');
      }
      const identity = await this.readOnlyExpression(this.expressions.canvasIdentity,stage);
      if (identity?.state !== 'ready') throw fail('BOSS_CDP_CANVAS_UNAVAILABLE',
        'BOSS 官方简历画布尚未可靠显示，无法接替截图');
      const url = officialResumeUrl(identity.resumeUrl);
      if (!url || url.href !== expectedResumeUrl ||
          !Number.isFinite(identity.scrollTop) ||
          Math.abs(identity.scrollTop-expectedScrollTop) > 2) {
        throw fail('BOSS_RESUME_DIALOG_BLOCKED',
          'BOSS 官方简历画布与已确认候选人或滚动位置不一致，已暂停采集');
      }
      return identity;
    };
    const before = await inspect('canvas_preflight');
    if (expectedOrigins && (before.outerOrigin !== expectedOrigins.outerOrigin ||
        before.resumeOrigin !== expectedOrigins.resumeOrigin ||
        before.width !== expectedOrigins.width ||
        before.height !== expectedOrigins.height)) {
      throw fail('BOSS_RESUME_DIALOG_BLOCKED',
        'BOSS 简历画布在滚动后被替换，已暂停采集');
    }
    const image = await this.session.captureCanvasPng({frameSelectors:[this.frameSelector,
      '.dialog-wrap.active .resume-detail-wrap iframe[src*="/web/frame/c-resume/"]'],
    canvasSelector:'canvas#resume',timeoutMs:12000});
    const after = await inspect('canvas_postflight');
    if (before.outerOrigin !== after.outerOrigin ||
        before.resumeOrigin !== after.resumeOrigin ||
        before.width !== after.width || before.height !== after.height ||
        image.readUInt32BE(16) !== after.width ||
        image.readUInt32BE(20) !== after.height) {
      throw fail('BOSS_RESUME_DIALOG_BLOCKED',
        'BOSS 简历画布在读取期间发生变化，已暂停采集');
    }
    return {image,fingerprint:crypto.createHash('sha256').update(image).digest('hex'),
      identity:after};
  }

  async readCanvasBaseline(options,seenCanvasImages,deadlineAt) {
    // A successful screenshot is authoritative. This optional snapshot only
    // establishes the previous visible Canvas pixels for a later timeout.
    const hardFailure = error => /^(?:BOSS_(?:VERIFICATION|LOGIN|PAGE|RECOMMENDED_JOB|RESUME_DIALOG))/.test(
      error.code || '');
    for (let attempt = 0; attempt < 6 && this.now() < deadlineAt; attempt++) {
      let first;
      try { first = await this.captureVerifiedCanvas(options); }
      catch (error) { if (hardFailure(error)) throw error; return null; }
      if (seenCanvasImages.has(first.fingerprint)) {
        await this.wait(350);
        continue;
      }
      await this.wait(250);
      let second;
      try { second = await this.captureVerifiedCanvas({...options,
        expectedOrigins:first.identity}); }
      catch (error) { if (hardFailure(error)) throw error; return null; }
      if (second.fingerprint === first.fingerprint) {
        seenCanvasImages.add(second.fingerprint);
        return second;
      }
      await this.wait(350);
    }
    return null;
  }

  async canSkipPreOpenFailure(title, id) {
    // Only pre-click failures reach here. A timed-out press/release is mapped
    // to BOSS_CDP_CLICK_UNCERTAIN instead. Confirm the page, exact job and
    // absence of official dialogs twice before skipping one card.
    try {
      await this.session.assertRecruiterReady();
      await this.assertJob(title,id);
      const first = await this.session.evaluate(this.expressions.modal);
      if (first?.active) return false;
      await this.wait(400);
      await this.assertJob(title,id);
      const second = await this.session.evaluate(this.expressions.modal);
      return !!second && !second.active;
    } catch (_) { return false; }
  }

  async readModal({allowTransition=false}={}) {
    let modal = await this.readOnlyExpression(this.expressions.modal,'read_modal');
    if (!modal?.active) return {active:false};
    // The official search guide can replace an already-closed resume before
    // closeOfficialModal() reaches its transition loop. Handle it here only
    // for ordinary reads; the allowTransition loop has its own bounded
    // handling. Re-read once, never recurse or click a second time here.
    if (modal.transient && !allowTransition) {
      const guide = await this.readOnlyExpression(this.expressions.guide,'read_guide');
      if (guide?.challenge) throw fail('BOSS_VERIFICATION_REQUIRED',
        'BOSS 请求人工安全验证或提示操作频繁，已暂停采集');
      if (guide?.active && guide.eligible) {
        await this.dismissKnownGuideModal();
        modal = await this.readOnlyExpression(this.expressions.modal,'read_modal');
        if (!modal?.active) return {active:false,guideDismissed:true};
      }
    }
    // Only the verified close flow may observe a brief generic wrapper after
    // the official dialog has begun its exit animation. Everywhere else an
    // unknown popup remains a hard stop.
    if (modal.transient && allowTransition) return modal;
    const url = officialResumeUrl(modal.iframeSrc);
    if (!url) throw fail('BOSS_RESUME_DIALOG_BLOCKED',
      'BOSS 出现未知弹窗或安全验证，已暂停采集');
    return {...modal,url};
  }

  async dismissKnownGuideModal() {
    const guide = await this.session.evaluate(this.expressions.guide);
    if (!guide?.active) return;
    if (guide.challenge) throw fail('BOSS_VERIFICATION_REQUIRED',
      'BOSS 请求人工安全验证或提示操作频繁，已暂停采集');
    // Only the observed BOSS anonymous-geek guide, containing a single
    // official search frame and one close icon, may be dismissed. Unknown
    // dialogs remain a hard stop in readModal().
    if (!guide.eligible) return;
    await this.ensureVisibleRecruiterPage();
    const rechecked = await this.session.evaluate(this.expressions.guide);
    if (!rechecked?.active) return;
    if (rechecked.challenge) throw fail('BOSS_VERIFICATION_REQUIRED',
      'BOSS 请求人工安全验证或提示操作频繁，已暂停采集');
    if (!rechecked.eligible) throw fail('BOSS_RESUME_DIALOG_BLOCKED',
      'BOSS 弹窗在关闭前发生变化，已暂停采集');
    await this.session.assertRecruiterReady();
    this.progress({phase:'closing_official_guide'});
    await this.session.clickUnique({selector:
      'div[data-type="boss-dialog"].active .anonymous-geek-guide-list-wrapper .boss-popup__close'});
    // One click only. Hidden tabs can prolong the official exit animation.
    for (let attempt = 0; attempt < 20; attempt++) {
      if (this.stopRequested) throw fail('BOSS_STOPPED', '已停止 BOSS 采集');
      await this.assertPage();
      const after = await this.session.evaluate(this.expressions.guide);
      if (!after?.active) return;
      if (!after.eligible || after.challenge) break;
      await this.wait(750);
    }
    throw fail('BOSS_RESUME_DIALOG_BLOCKED',
      'BOSS 官方引导弹窗未能确认关闭，已暂停采集');
  }

  async closeOfficialModal() {
    const modal = await this.readModal();
    if (!modal.active) return;
    // BOSS can render the close icon beyond the visible right edge while the
    // resume pane itself is visible. Reveal only that verified official icon.
    await this.session.revealOfficialResumeClose({frameSelector:this.frameSelector});
    await this.session.clickUnique({selector:'.dialog-wrap.active .close-btn',
      frameSelector:this.frameSelector});
    // BOSS keeps the official popup in a v-leave transition for many seconds.
    // The first click may have succeeded even while the dialog is still in
    // the DOM. Observe for up to 90 seconds; never send a second close click.
    let transientPolls = 0;
    for (let attempt = 0; attempt < 120; attempt++) {
      if (this.stopRequested) throw fail('BOSS_STOPPED', '已停止 BOSS 采集');
      const state = await this.readModal({allowTransition:true});
      if (!state.active) return;
      if (state.transient) {
        await this.assertPage();
        // A verified BOSS search guide can appear as the official resume
        // dialog leaves. It is distinct from the resume overlay and has its
        // own single close icon. Never treat a different wrapper as safe.
        const guide = await this.session.evaluate(this.expressions.guide);
        if (guide?.active && guide.eligible) {
          await this.dismissKnownGuideModal();
          transientPolls = 0;
          continue;
        }
        if (guide?.challenge) throw fail('BOSS_VERIFICATION_REQUIRED',
          'BOSS 请求人工安全验证或提示操作频繁，已暂停采集');
        if (++transientPolls > 20) throw fail('BOSS_RESUME_DIALOG_BLOCKED',
          'BOSS 弹窗退出过渡超过安全等待时间，已暂停采集');
      } else transientPolls = 0;
      await this.wait(750);
    }
    // The final poll must run after the last wait as well; a v-leave dialog
    // can disappear precisely at the end of the bounded transition window.
    for (let settle = 0; settle < 20; settle++) {
      const state = await this.readModal({allowTransition:true});
      if (!state.active) return;
      if (!state.transient) break;
      await this.assertPage();
      const guide = await this.session.evaluate(this.expressions.guide);
      if (guide?.active && guide.eligible) {
        await this.dismissKnownGuideModal();
        if (!(await this.readModal({allowTransition:true})).active) return;
      }
      if (guide?.challenge) throw fail('BOSS_VERIFICATION_REQUIRED',
        'BOSS 请求人工安全验证或提示操作频繁，已暂停采集');
      await this.wait(500);
    }
    throw fail('BOSS_RESUME_DIALOG_BLOCKED', 'BOSS 官方简历弹窗无法关闭，已暂停采集');
  }

  async extractResume(deadlineAt, expectedJob = null) {
    this.progress({phase:'waiting_resume'});
    let modal;
    // A visible official resume may need minutes to draw its Canvas, but a
    // card click that opens no resume at all must not consume that deadline.
    const firstModalDeadline = Math.min(deadlineAt,this.now()+20_000);
    let sawOfficialModal = false;
    // The official iframe initially exposes a blank 300x150 canvas. In a
    // live recruiter session it can take tens of seconds to draw the resume.
    while (this.now() < deadlineAt) {
      if (this.stopRequested) throw fail('BOSS_STOPPED', '已停止 BOSS 采集');
      modal = await this.readModal();
      if (modal.guideDismissed) throw fail('BOSS_RESUME_GUIDE_INTERRUPTED',
        'BOSS 点击候选人后显示官方引导而非简历，将对当前候选人有界重试');
      if (modal.active) sawOfficialModal = true;
      if (!sawOfficialModal && this.now() >= firstModalDeadline) {
        throw fail('BOSS_RESUME_UNAVAILABLE',
          'BOSS 点击候选人后未出现官方简历弹窗，将对当前候选人有界重试');
      }
      const direct = assessBossResumeText(modal?.text);
      const drawnCanvas = modal?.canvas && modal.canvasWidth > 300 &&
        modal.canvasHeight > 150;
      if (modal.active && modal.frameReady && (direct.valid || drawnCanvas)) break;
      await this.wait(750);
    }
    if (modal?.active && modal.frameReady && modal.canvas &&
        modal.canvasWidth <= 300 && modal.canvasHeight <= 150) {
      const error = fail('BOSS_CANDIDATE_TIMEOUT',
        'BOSS 官方简历 Canvas 在当前候选人时间上限内仍为空白');
      error.blankCanvas = true;
      throw error;
    }
    if (!modal?.active || !modal.frameReady ||
        (!assessBossResumeText(modal.text).valid &&
          (!modal.canvas || modal.canvasWidth <= 300 || modal.canvasHeight <= 150))) {
      throw fail('BOSS_CANDIDATE_TIMEOUT',
        'BOSS 官方简历在当前候选人时间上限内仍未完成渲染，已暂停采集');
    }
    if (!modal?.active || !modal.frameReady) throw fail('BOSS_RESUME_UNAVAILABLE',
      'BOSS 官方简历弹窗未加载，已暂停采集');
    if (modal.scrollTop > 1) {
      // The official pane can retain the last candidate's scroll position.
      // Rewind it once with the same guarded instant-position helper used for
      // forward pages; never OCR an opened resume from the middle.
      const rewind = await this.session.setOfficialResumeScrollTop({
        frameSelector:this.frameSelector,targetTop:0});
      if (!rewind || Math.abs(rewind.after) > 2) throw fail(
        'BOSS_RESUME_SCROLL_UNAVAILABLE','BOSS 简历未返回首页，已暂停该候选人');
      await this.wait(500);
      modal = await this.readModal();
      if (modal.guideDismissed) throw fail('BOSS_RESUME_GUIDE_INTERRUPTED',
        'BOSS 简历读取被官方引导弹窗中断，将对当前候选人有界重试');
      if (!modal.active || modal.scrollTop > 2) throw fail(
        'BOSS_RESUME_SCROLL_UNAVAILABLE','BOSS 简历首页位置无法确认，已暂停该候选人');
    }
    const direct = assessBossResumeText(modal.text);
    if (direct.valid) return {text:modal.text,url:modal.url,method:'dom'};
    if (!modal.canvas || modal.canvasWidth <= 300 || modal.canvasHeight <= 150) {
      throw fail('BOSS_RESUME_CONTENT_INVALID',
        'BOSS 官方简历仅显示空白 Canvas，未提供完整正文');
    }
    const texts = [];
    const seenImages = new Set();
    const seenCanvasImages = new Set();
    let previousCanvas = null;
    let expectedScrollTop = modal.scrollTop;
    let reachedEnd = false;
    const expectedResumeUrl = modal.url.href;
    for (let page = 0; page < 12; page++) {
      this.progress({phase:`ocr_resume_page_${page+1}`});
      if (this.now() > deadlineAt) throw fail('BOSS_CANDIDATE_TIMEOUT',
        'BOSS 多页简历读取超时，已暂停采集');
      const pageState = await this.assertPage();
      if (pageState.visibilityState !== 'visible') {
        if (pageState.visibilityState !== 'hidden' || !expectedJob) throw fail(
          'BOSS_PAGE_HIDDEN','BOSS 简历截图前页面可见性无法确认，已暂停采集');
        const beforeFocus = await this.readModal();
        if (!beforeFocus.active || beforeFocus.url?.href !== expectedResumeUrl) throw fail(
          'BOSS_RESUME_DIALOG_BLOCKED','BOSS 简历在恢复可见状态前发生变化，已暂停采集');
        await this.assertJob(expectedJob.title,expectedJob.id);
        await this.ensureVisibleRecruiterPage();
        await this.assertJob(expectedJob.title,expectedJob.id);
        const afterFocus = await this.readModal();
        if (!afterFocus.active || afterFocus.url?.href !== expectedResumeUrl) throw fail(
          'BOSS_RESUME_DIALOG_BLOCKED','BOSS 简历在恢复可见状态后发生变化，已暂停采集');
        this.progress({phase:`ocr_resume_page_${page+1}`});
      }
      let image;
      let fingerprint;
      let canvasFallback = false;
      let screenshotTimeout = null;
      let acceptedCanvas = null;
      // The nested canvas can lag behind its scroll container and return the
      // previous page even after scrollTop is verified. Capture only the
      // visible official resume pane instead; its clip and frame are checked
      // by the raw CDP helper before and after each screenshot. Only a
      // screenshot-command timeout can switch this page to a verified,
      // read-only Canvas capture. The previous page's stable Canvas hash
      // must exist so a delayed repaint cannot be mistaken for new content.
      for (let repaint = 0; repaint < 30; repaint++) {
        if (!canvasFallback) {
          try {
            image = await this.session.captureRegionPng({frameSelector:this.frameSelector,
              selector:'.dialog-wrap.active .resume-detail-wrap',timeoutMs:20000});
          } catch (error) {
            if (error.code !== 'BOSS_CDP_TIMEOUT' ||
                error.stage !== 'capture_screenshot' ||
                !expectedJob ||
                (page > 0 && previousCanvas?.pageIndex !== page-1)) throw error;
            screenshotTimeout = error;
            canvasFallback = true;
          }
        }
        if (canvasFallback) {
          const options = {expectedJob,expectedResumeUrl,expectedScrollTop,
            expectedOrigins:page > 0 ? previousCanvas.identity : null};
          let current;
          try { current = await this.captureVerifiedCanvas(options); }
          catch (error) {
            if (error.code !== 'BOSS_CDP_CANVAS_UNAVAILABLE') throw error;
            if (this.now() >= deadlineAt) break;
            await this.wait(500);
            continue;
          }
          if (seenCanvasImages.has(current.fingerprint)) {
            if (this.now() >= deadlineAt) break;
            await this.wait(500);
            continue;
          }
          // Two matching reads, separated by a paint opportunity, protect
          // against OCRing a Canvas while BOSS is still redrawing it.
          await this.wait(300);
          let confirmed;
          try { confirmed = await this.captureVerifiedCanvas(options); }
          catch (error) {
            if (error.code !== 'BOSS_CDP_CANVAS_UNAVAILABLE') throw error;
            if (this.now() >= deadlineAt) break;
            await this.wait(500);
            continue;
          }
          if (confirmed.fingerprint !== current.fingerprint ||
              seenCanvasImages.has(confirmed.fingerprint)) {
            if (this.now() >= deadlineAt) break;
            await this.wait(500);
            continue;
          }
          acceptedCanvas = confirmed;
          image = confirmed.image;
          fingerprint = confirmed.fingerprint;
          seenCanvasImages.add(fingerprint);
          break;
        }
        fingerprint = crypto.createHash('sha256').update(image).digest('hex');
        if (!seenImages.has(fingerprint)) break;
        if (this.now() >= deadlineAt) break;
        await this.wait(500);
      }
      if (canvasFallback && !acceptedCanvas) {
        screenshotTimeout.message = 'BOSS 截图超时，且官方画布未能证明已更新到当前页；已暂停采集';
        throw screenshotTimeout;
      }
      if (seenImages.has(fingerprint)) throw fail('BOSS_RESUME_CANVAS_STALLED',
        'BOSS 多页简历滚动后画面没有更新，已暂停该候选人');
      seenImages.add(fingerprint);
      const recognized = await this.ocr.recognizeTextFromImage(image);
      if (canvasFallback && repeatedScreenText(recognized,texts)) throw fail(
        'BOSS_RESUME_CANVAS_STALLED',
        'BOSS 截图超时后官方画布识别为空白或与已读取页面重复，未保存该候选人');
      texts.push(recognized);
      modal = await this.readModal();
      if (modal.guideDismissed) throw fail('BOSS_RESUME_GUIDE_INTERRUPTED',
        'BOSS 多页简历读取被官方引导弹窗中断，将对当前候选人有界重试');
      if (!modal.active || modal.url?.href !== expectedResumeUrl) throw fail(
        'BOSS_RESUME_DIALOG_BLOCKED','BOSS 多页简历的候选人弹窗发生变化，已暂停采集');
      const maxScroll = Math.max(0,modal.scrollHeight-modal.clientHeight);
      if (maxScroll <= 1 || modal.scrollTop >= maxScroll-2) {
        reachedEnd = true;
        break;
      }
      if (acceptedCanvas) previousCanvas = {...acceptedCanvas,pageIndex:page};
      else {
        const baseline = await this.readCanvasBaseline({expectedJob,
          expectedResumeUrl,expectedScrollTop},seenCanvasImages,deadlineAt);
        previousCanvas = baseline ? {...baseline,pageIndex:page} : null;
      }
      // This pane uses CSS smooth scrolling, and a trusted wheel command can
      // time out without any confirmed movement. The helper makes one
      // guarded instant scroll to the next verified offset and reads it back.
      const targetTop = Math.min(maxScroll,Math.round(modal.scrollTop+700));
      const move = await this.session.setOfficialResumeScrollTop({
        frameSelector:this.frameSelector,targetTop});
      if (!move || Math.abs(move.after-targetTop) > 2 || move.after <= modal.scrollTop) {
        throw fail('BOSS_RESUME_SCROLL_UNAVAILABLE',
          'BOSS 多页简历未到达指定位置，已暂停该候选人');
      }
      expectedScrollTop = move.after;
      await this.wait(500);
    }
    if (!reachedEnd) throw fail('BOSS_RESUME_INCOMPLETE',
      'BOSS 多页简历超出安全采集上限，未入库');
    const text = joinScreenText(texts);
    const quality = assessBossResumeText(text,{screens:texts,reachedEnd});
    if (!quality.valid) throw fail('BOSS_RESUME_CONTENT_INVALID',
      `BOSS Canvas 识别出的正文不完整：${quality.reason}`);
    return {text,url:modal.url,method:'ocr'};
  }

  async saveResume(captured, job, sourceCardFingerprint = '', cardMeta = {}) {
    const parsed = resumeParserService.parseResumeText(captured.text);
    const cardName = verifiedCardName(cardMeta.displayName);
    const cardPosition = verifiedCardPosition(cardMeta.expectedPosition);
    const ocrName = verifiedBossOcrName(parsed.name, captured.text);
    const ocrPosition = verifiedCardPosition(parsed.expectedPosition?.position);
    parsed.name = cardName || ocrName || null;
    parsed.expectedPosition = {...(parsed.expectedPosition || {}),
      position:cardPosition || ocrPosition || null};
    const sourceFingerprint = hashText(captured.text);
    const sourceCandidateId = candidateIdFromUrl(captured.url);
    let result;
    try {
      result = await this.store.addResume({
        ...parsed,
        source:'boss',platform:'BOSS直聘',sourceUrl:captured.url.href,
        sourceCandidateId,sourceFingerprint,sourceCardFingerprint,
        nameSource:cardName ? `boss_${this.pageSegment}_card` : ocrName ? 'ocr' : 'unverified',
        positionSource:cardPosition ? `boss_${this.pageSegment}_card`
          : ocrPosition ? 'ocr' : 'unverified',
        originalText:captured.text,
        captureJobRequirements:String(job?.jobRequirements || '').trim() || null,
        qualityScore:parsed.qualityScore,parseMethod:captured.method,
        parseStatus:'completed'
      }, {returnStatus:true});
    } catch (error) {
      if (['ENOSPC','SQLITE_FULL','SQLITE_IOERR','SQLITE_CORRUPT'].includes(error.code)) {
        throw fail('BOSS_STORAGE_ERROR', '本地简历存储不可用，已暂停采集');
      }
      throw error;
    }
    // Existing records created before card fingerprints were introduced are
    // still fully OCRed once. Only bind the new card to a duplicate when the
    // full resume hash or official candidate ID proves it is the same record.
    if (!result.created && sourceCardFingerprint && result.resume?.id &&
        !result.resume.sourceCardFingerprint &&
        (result.resume.sourceFingerprint === sourceFingerprint ||
          (sourceCandidateId && result.resume.sourceCandidateId === sourceCandidateId)) &&
        typeof this.store.updateCandidateMetadata === 'function') {
      try {
        const updated = await this.store.updateCandidateMetadata(result.resume.id,
          {sourceCardFingerprint});
        if (updated) result.resume = updated;
      } catch (_) {
        this.progress({lastFailureCode:'BOSS_CARD_INDEX_DEFERRED',
          lastError:'简历已存在，但卡片去重索引暂未更新；下次仍会完整核验'});
      }
    }
    this.queueEvaluation(result.resume, job);
    return result;
  }

  queueEvaluation(resume, job) {
    if (!job.jobRequirements) return;
    try {
      // A duplicate may have been evaluated for an earlier active job. Reuse
      // its verified OCR text and evaluate it for these exact requirements.
      const queued = this.queue.enqueue(resume, job);
      if (queued?.queued === false && queued.reason !== 'already_evaluated_or_queued') {
        this.progress({lastFailureCode:'BOSS_EVALUATION_QUEUE_DEFERRED',
          lastError:'简历已入库，但当前岗位自动评估暂未完成；可在候选人列表中补评'});
      }
    } catch (_) {
      this.progress({lastFailureCode:'BOSS_EVALUATION_QUEUE_ERROR',
        lastError:'简历已入库，但当前岗位自动评估未能排队；可在候选人列表中补评'});
    }
  }

  async scrollCards() {
    const frameSelector = this.frameSelector;
    const cardSelector = this.cardSelector;
    const moved = await this.session.evaluate(`(() => { /* bossRaw:scroll */
      const doc = document.querySelector(${JSON.stringify(frameSelector)})?.contentDocument;
      const last = [...(doc?.querySelectorAll(${JSON.stringify(cardSelector)}) || [])].at(-1);
      if (!last) return false;
      let container = last.parentElement;
      while (container && container !== doc.body && container !== doc.documentElement) {
        const style = getComputedStyle(container);
        if (container.scrollHeight > container.clientHeight + 32 &&
            /auto|scroll|overlay/.test(style.overflowY)) {
          container.scrollTop = container.scrollHeight;
          return true;
        }
        container = container.parentElement;
      }
      const root = doc.scrollingElement || doc.documentElement;
      root.scrollTop = root.scrollHeight;
      return true;
    })()`);
    if (!moved) throw fail('BOSS_RECOMMEND_LIST_UNAVAILABLE',
      'BOSS 推荐列表没有可滚动的候选人，已停止当前采集');
  }

  async collect({targetCount=1,maxRuntimeMs=this.maxRuntimeCapMs,signal,
    resume=false}={}) {
    if (this.status.state === 'running') throw fail('BOSS_ALREADY_RUNNING', 'BOSS 采集已在运行');
    if (!Number.isInteger(targetCount) || targetCount < 1 || targetCount > 500) {
      throw new Error('目标份数需为 1～500');
    }
    if (!Number.isFinite(maxRuntimeMs) || maxRuntimeMs < 1000) {
      throw new Error('采集时间上限无效');
    }
    const runtimeLimitMs=Math.min(Math.max(maxRuntimeMs,1000),this.maxRuntimeCapMs);
    const job = this.jobService.current();
    const title = String(job?.title || '').trim();
    if (!title || !job.jobRequirements) throw fail('BOSS_JOB_REQUIRED',
      '请先保存岗位条件，再启动 BOSS 采集');
    const resumeContext = resume
      ? this.validateResumeRequest({job,targetCount,runtimeLimitMs}) : null;
    this.stopRequested = false;
    this.cardWindowStart = resume ? resumeContext.window.start : 0;
    this.cardWindowTotal = resume ? resumeContext.window.totalCount : 0;
    if (!resume) {
      this.completedCardFingerprints.clear();
      this.resumeCheckpoint = null;
      this.lastCandidateWindow = null;
      this.runIdentity = null;
    }
    this.progress({state:'running',saved:resume ? this.status.saved : 0,
      attempted:resume ? this.status.attempted : 0,
      skipped:resume ? this.status.skipped : 0,
      scrollRounds:resume ? this.status.scrollRounds : 0,
      targetCount,phase:resume ? 'validating_resume' : 'selecting_job',
      lastFailureCode:'',lastError:'',currentCardIndex:-1,lastCardIndex:-1,
      lastTargetState:'',maxRuntimeMinutes:runtimeLimitMs/60_000,
      pausedAtPhase:'',pausedAtStage:'',
      startedAt:resume ? this.status.startedAt : new Date().toISOString(),
      finishedAt:null});
    const started = this.now();
    // Only completed OCR saves or confirmed stored duplicates are skipped on
    // continuation. The candidate interrupted by verification is retried.
    const seen = new Set(resume ? this.completedCardFingerprints : []);
    let noNewRounds = 0;
    let noSaveRounds = 0;
    let blankCanvasStreak = 0;
    let preOpenTimeoutStreak = 0;
    let targetUnavailableStreak = 0;
    let targetUnavailableWithoutSave = 0;
    let candidateErrorStreak = 0;
    try {
      this.session = await this.connect();
      if (typeof this.session.assertOrRestoreInitialRecruiterWindow === 'function') {
        await this.session.assertOrRestoreInitialRecruiterWindow({frameSelector:this.frameSelector});
      } else {
        await this.session.assertUsableRecruiterWindow({frameSelector:this.frameSelector});
      }
      await this.ensureVisibleRecruiterPage();
      const pageBeforeSelection=await this.assertPage();
      const expectedPagePath = new URL(pageBeforeSelection.url).pathname;
      const chosen = await this.selectJob(title);
      const pageAfterSelection=await this.assertPage();
      const frameUrl=pageAfterSelection.iframeLiveUrl || pageAfterSelection.iframeSrc;
      if (resume) {
        if (pageAfterSelection.url!==resumeContext.pageUrl ||
            frameUrl!==resumeContext.frameUrl ||
            chosen.value!==resumeContext.chosenId) throw fail(
          'BOSS_RESUME_PAGE_CHANGED',
          'BOSS 人工验证后岗位页面或官方搜索 iframe 与断点不同，已拒绝续采');
      } else {
        this.runIdentity={jobSignature:jobResumeSignature(job),title,
          chosenId:chosen.value,pageUrl:pageAfterSelection.url,frameUrl,
          targetCount,runtimeLimitMs};
      }
      // BOSS switches the selected job before its recommendation cards finish
      // rendering. Wait for the first real card rather than treating that
      // short empty state as a completed scroll or an unavailable list.
      this.progress({phase:'waiting_candidates'});
      let initialCards = await this.readCandidateCards(
        title,chosen.value,expectedPagePath,signal);
      for (let poll = 0; initialCards.length === 0 && poll < 40; poll++) {
        if (this.stopRequested || signal?.aborted) throw fail('BOSS_STOPPED',
          '已停止 BOSS 采集');
        await this.wait(500);
        initialCards = await this.readCandidateCards(
          title,chosen.value,expectedPagePath,signal);
      }
      if (initialCards.length === 0) throw fail('BOSS_RECOMMEND_LIST_UNAVAILABLE',
        'BOSS 在 20 秒内未加载推荐候选人，请检查平台页面后重试');
      if (resume) {
        if ((await this.readModal()).active) throw fail('BOSS_RESUME_DIALOG_BLOCKED',
          'BOSS 人工验证后仍有简历弹窗，无法确认中断候选人，已拒绝续采');
        this.validateResumeWindow(resumeContext,initialCards);
      }
      this.progress({phase:'reading_candidates'});
      let resumeWindowPending=resume;
      while (!this.stopRequested && !signal?.aborted && this.status.saved < targetCount &&
          this.now() - started < runtimeLimitMs &&
          this.status.scrollRounds < MAX_SCROLL_ROUNDS && noSaveRounds < 12) {
        await this.assertCandidateListJob(title,chosen.value,expectedPagePath,signal);
        await this.dismissKnownGuideModal();
        const modal = await this.readModal();
        if (modal.active) await this.closeOfficialModal();
        const cards = await this.readCandidateCards(title,chosen.value,expectedPagePath,signal);
        if (resumeWindowPending) {
          this.validateResumeWindow(resumeContext,cards);
          resumeWindowPending=false;
          this.resumeCheckpoint=null;
        }
        this.rememberCandidateWindow(cards);
        const cardCounts = new Map();
        for (const card of cards) {
          const key = hashText(`${chosen.value}\n${card.text}`);
          cardCounts.set(key,(cardCounts.get(key) || 0)+1);
        }
        let attemptedThisRound = 0;
        const savedBeforeRound = this.status.saved;
        for (const card of cards) {
          if (this.stopRequested || signal?.aborted || this.status.saved >= targetCount) break;
          // Cards have no stable DOM ID. Scope their normalized full-text
          // fingerprint to the exact posted job selected in this run.
          const identity = hashText(`${chosen.value}\n${card.text}`);
          if (seen.has(identity)) continue;
          seen.add(identity);
          const duplicateCount = cardCounts.get(identity) || 1;
          attemptedThisRound += duplicateCount;
          if (duplicateCount > 1) {
            // No stable DOM ID exists, so clickUnique cannot safely choose
            // between same-text cards. Surface the ambiguity explicitly.
            this.progress({attempted:this.status.attempted+duplicateCount,
              skipped:this.status.skipped+duplicateCount,
              lastFailureCode:'BOSS_CARD_IDENTITY_AMBIGUOUS',
              lastError:'当前列表有内容完全相同的候选人卡片，无法安全区分，已跳过该组'});
            continue;
          }
          // A card hash is only a read-only hint. Skip OCR solely when this
          // long official card is unique in the current list and a unique
          // existing BOSS record already has complete OCR attached to it.
          const specificCard = String(card.text || '').normalize('NFKC')
            .replace(/\s+/g,' ').trim().length >= 300;
          if (specificCard && cardCounts.get(identity) === 1 &&
              typeof this.store.findBossCardMatch === 'function') {
            const prior = await this.store.findBossCardMatch(identity);
            const capturedAt = Date.parse(prior?.createdAt || '');
            const ageMs = this.now() - capturedAt;
            if (prior?.source === 'boss' &&
                prior.sourceCardFingerprint === identity &&
                prior.parseStatus === 'completed' && prior.sourceFingerprint &&
                String(prior.originalText || '').length >= 100 &&
                Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= 24*60*60*1000) {
              this.queueEvaluation(prior,job);
              this.completedCardFingerprints.add(identity);
              this.progress({attempted:this.status.attempted+1,
                skipped:this.status.skipped+1,phase:'existing_candidate'});
              continue;
            }
          }
          if (this.quarantine.has(chosen.value,identity)) {
            this.progress({attempted:this.status.attempted+1,
              skipped:this.status.skipped+1,phase:'quarantined_candidate',
              lastFailureCode:'BOSS_CARD_QUARANTINED',
              lastError:'该岗位候选卡曾在打开后发生浏览器命令超时，暂缓 24 小时；可手动清除暂缓记录'});
            continue;
          }
          await this.assertCandidateListJob(title,chosen.value,expectedPagePath,signal);
          await this.ensureVisibleRecruiterPage();
          await this.dismissKnownGuideModal();
          if ((await this.readModal()).active) throw fail('BOSS_RESUME_DIALOG_BLOCKED',
            'BOSS 上一份简历弹窗仍在，已暂停采集');
          this.progress({attempted:this.status.attempted+1});
          const cardIndex=Number.isInteger(card.index) ? card.index : -1;
          this.progress({currentCardIndex:cardIndex});
          this.progress({phase:'opening_candidate'});
          let opened = false;
          let processingError = null;
          try {
            // Card has no stable ID. A complete text match is required at
            // click time; the helper rejects any hit on its greet button.
            await this.prepareCandidateCard(card,title,chosen.value);
            await this.assertJob(title,chosen.value);
            await this.session.clickUnique({selector:this.clickSelector,frameSelector:this.frameSelector,
              identityAttribute:'textContent',identityValue:card.clickText || card.text});
            opened = true;
            preOpenTimeoutStreak = 0;
            targetUnavailableStreak = 0;
            let captured;
            for (let reopen = 0; reopen < 2; reopen++) {
              try {
                captured = await this.extractResume(this.now()+CANDIDATE_DEADLINE_MS,
                  {title,id:chosen.value});
                break;
              } catch (error) {
                const retryable = ['BOSS_RESUME_SCROLL_UNAVAILABLE',
                  'BOSS_CDP_SCROLL_UNCERTAIN','BOSS_CDP_SCROLL_STALLED',
                  'BOSS_RESUME_GUIDE_INTERRUPTED','BOSS_RESUME_UNAVAILABLE']
                  .includes(error.code);
                if (!retryable || reopen > 0) {
                  if (error.code === 'BOSS_RESUME_GUIDE_INTERRUPTED' && reopen > 0) {
                    error.message = 'BOSS 官方引导弹窗再次替代简历，已跳过当前候选人';
                  } else if (error.code === 'BOSS_RESUME_UNAVAILABLE' && reopen > 0) {
                    error.message = 'BOSS 重试后仍未出现官方简历弹窗，已跳过当前候选人';
                  }
                  throw error;
                }
                this.progress({phase:'reopening_resume_once'});
                await this.closeOfficialModal();
                await this.assertCandidateListJob(title,chosen.value,expectedPagePath,signal);
                await this.prepareCandidateCard(card,title,chosen.value);
                await this.session.clickUnique({selector:this.clickSelector,frameSelector:this.frameSelector,
                  identityAttribute:'textContent',identityValue:card.clickText || card.text});
              }
            }
            await this.assertJob(title,chosen.value);
            this.progress({phase:'saving_resume'});
            const saved = await this.saveResume(captured,job,identity,card);
            this.completedCardFingerprints.add(identity);
            blankCanvasStreak = 0;
            candidateErrorStreak = 0;
            if (saved.created) {
              targetUnavailableWithoutSave = 0;
              this.progress({saved:this.status.saved+1});
            }
            else this.progress({skipped:this.status.skipped+1});
          } catch (error) {
            processingError = error;
            error.pausedAtPhase = safePhase(error.pausedAtPhase || this.status.phase);
            if (error.code === 'BOSS_CDP_TIMEOUT' && opened) {
              this.markTimeoutQuarantine(chosen.value,identity);
            }
            if (error.code === 'BOSS_CDP_TIMEOUT' && !opened) {
              if (!(await this.canSkipPreOpenFailure(title,chosen.value))) throw error;
              preOpenTimeoutStreak++;
              if (preOpenTimeoutStreak > 2) throw fail('BOSS_CDP_TIMEOUT',
                'BOSS 连续多个候选人在点击前发生浏览器命令超时，已暂停采集');
              this.progress({skipped:this.status.skipped+1,
                lastFailureCode:'BOSS_CDP_PREOPEN_TIMEOUT',
                lastError:'BOSS 候选人卡片打开前命令超时，已确认岗位和无弹窗，跳过当前卡片'});
              continue;
            }
            if (error.code === 'BOSS_CDP_TARGET_UNAVAILABLE') {
              const targetState=/^[a-z_]{1,40}$/.test(error.targetState || '')
                ? error.targetState : 'unknown';
              this.progress({lastTargetState:targetState,lastCardIndex:cardIndex});
              // A blocked click is never retried blindly. Permit at most one
              // card skip after reconfirming the exact job and no dialog;
              // persistent or intermittent obstruction pauses quickly rather
              // than silently consuming an entire dynamic list.
              if (opened || !(await this.canSkipPreOpenFailure(title,chosen.value))) throw error;
              targetUnavailableStreak++;
              targetUnavailableWithoutSave++;
              if (targetUnavailableStreak >= 2 || targetUnavailableWithoutSave >= 5) {
                error.message = `BOSS 候选卡连续或反复不可点击（目标状态 ${targetState}，卡序号 ${cardIndex}），`+
                  '已暂停采集；请检查浏览器窗口与页面提示';
                throw error;
              }
              this.progress({skipped:this.status.skipped+1,
                lastFailureCode:error.code,
                lastError:`BOSS 候选卡当前不可点击（${targetState}，卡序号 ${cardIndex}），已确认岗位和无官方弹窗，跳过一次`});
              continue;
            }
            if (error.code === 'BOSS_CANDIDATE_TIMEOUT' && error.blankCanvas) {
              blankCanvasStreak++;
              this.progress({skipped:this.status.skipped+1,
                lastFailureCode:error.code,lastError:error.message});
              if (blankCanvasStreak >= 2) {
                error.message = `连续 ${blankCanvasStreak} 份 BOSS 简历画布未加载；已暂停采集`;
                throw error;
              }
              continue;
            }
            blankCanvasStreak = 0;
            if (/^BOSS_(VERIFICATION|RATE_LIMITED|LOGIN|PAGE|SEARCH_|RECOMMENDED_JOB|RESUME_DIALOG|CANDIDATE_TIMEOUT|CARD_IDENTITY|STORAGE|CDP_(?!TARGET_UNAVAILABLE))/.test(error.code || '')) throw error;
            candidateErrorStreak++;
            if (candidateErrorStreak >= 5) {
              error.message = `连续 ${candidateErrorStreak} 张 BOSS 候选卡处理失败，已暂停采集；请检查招聘页面状态`;
              throw error;
            }
            this.progress({skipped:this.status.skipped+1,
              lastFailureCode:error.code || 'BOSS_CANDIDATE_ERROR',
              lastError:error.message || '候选人处理失败'});
          } finally {
            if (opened && !this.stopRequested && !signal?.aborted) {
              this.progress({phase:'closing_resume'});
              try { await this.closeOfficialModal(); }
              catch (closeError) {
                if (closeError.code === 'BOSS_CDP_TIMEOUT') {
                  this.markTimeoutQuarantine(chosen.value,identity);
                }
                if (processingError) {
                  processingError.closeFailureCode = closeError.code;
                  processingError.message += `；官方弹窗关闭未确认：${closeError.message}`;
                  throw processingError;
                }
                throw closeError;
              }
            }
            this.progress({phase:'reading_candidates'});
          }
        }
        if (this.status.saved >= targetCount || this.stopRequested || signal?.aborted) break;
        // A long-lived BOSS page may retain more than 1000 candidate cards.
        // Process every bounded window before asking the platform to scroll
        // again; otherwise the first 1000 would hide all later cards forever.
        if (this.advanceCardWindowIfNeeded()) continue;
        if (attemptedThisRound === 0) noNewRounds++;
        else noNewRounds = 0;
        noSaveRounds = this.status.saved > savedBeforeRound ? 0 : noSaveRounds+1;
        if (noNewRounds >= 3) break;
        await this.assertCandidateListJob(title,chosen.value,expectedPagePath,signal);
        this.progress({phase:'scrolling_candidates'});
        await this.scrollCards();
        this.rewindCardWindowAfterScroll();
        this.progress({scrollRounds:this.status.scrollRounds+1});
        await this.wait(2000);
      }
      const state = this.stopRequested || signal?.aborted ? 'stopped'
        : this.status.saved >= targetCount ? 'completed' : 'partial';
      const completionReason=state==='partial'
        ? this.now()-started>=runtimeLimitMs
          ? `已达到本次 ${runtimeLimitMs/60_000} 分钟运行上限`
          : this.status.scrollRounds>=MAX_SCROLL_ROUNDS
            ? `已达到本次 ${MAX_SCROLL_ROUNDS} 轮滚动上限`
            : noNewRounds>=3
              ? '连续 3 轮未发现新的候选卡，已结束本次采集'
              : noSaveRounds>=12
                ? '连续 12 轮没有新的完整简历，已结束本次采集'
                : '当前官方结果已处理完毕'
        : '';
      this.progress({state,phase:state,completionReason,
        finishedAt:new Date().toISOString()});
      return this.getStatus();
    } catch (error) {
      if (error.code==='BOSS_VERIFICATION_REQUIRED' && this.runIdentity &&
          this.lastCandidateWindow && this.lastCandidateWindow.cards.length) {
        this.resumeCheckpoint={...this.runIdentity,
          window:this.lastCandidateWindow};
      } else {
        this.resumeCheckpoint=null;
      }
      const pausedAtPhase = safePhase(error.pausedAtPhase || this.status.phase);
      const targetState = /^[a-z_]{1,40}$/.test(error.targetState || '')
        ? error.targetState : '';
      const targetReason = /^[a-z_]{1,40}$/.test(error.reason || '')
        ? error.reason : '';
      this.progress({state:'paused',phase:'paused',
        pausedAtPhase,
        pausedAtStage:error.stage ? safePhase(error.stage) : '',
        lastTargetState:targetState,
        lastTargetReason:targetReason,
        lastFailureCode:error.code || 'BOSS_UNEXPECTED_ERROR',
        lastError:error.message || 'BOSS 采集暂停',finishedAt:new Date().toISOString()});
      return this.getStatus();
    } finally {
      // Detach only this CDP WebSocket; never close or navigate the user tab.
      if (this.session) {
        try { await this.session.close(); } catch (_) { /* Already detached. */ }
      }
      this.session = null;
      if (typeof this.ocr?.destroy === 'function') {
        try { await this.ocr.destroy(); } catch (_) { /* Release best effort. */ }
      }
    }
  }
}

module.exports = { BossRawRecommendCollector, normalizeTitle, chooseExactJob,
  officialResumeUrl, candidateIdFromUrl, hashText, jobResumeSignature, joinScreenText,
  repeatedScreenText,verifiedCardName, verifiedCardPosition, FRAME, EXPRESSIONS,
  buildExpressions };
