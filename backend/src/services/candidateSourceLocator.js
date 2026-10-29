'use strict';

const crypto = require('node:crypto');
const { idFromOfficialUrl, platformLocator } = require('../utils/platformLocator');
const { hiringJobTitle } = require('../utils/candidateDisplay');

function locatorError(status, message) {
  return Object.assign(new Error(message), { publicStatus: status });
}

async function prepareBossSearchPage(session, title, wait) {
  const { ensureOfficialSearchPage } = require('./bossOfficialSearchNavigation');
  const { BossRawSearchCollector } = require('./bossRawSearchCollector');
  await ensureOfficialSearchPage({ session, wait });
  // Reuse the collector's official search submission and result checks. This
  // locator only opens a candidate after the exact job search is confirmed.
  const collector = new BossRawSearchCollector({ store: null, jobService: null,
    queue: null, ocr: null, quarantine: null, wait });
  collector.session = session;
  await collector.selectJob(title);
}

async function scanBossSearchForCandidate(session, title, id, wait,
  { createCollector = () => {
    const { BossRawSearchCollector } = require('./bossRawSearchCollector');
    return new BossRawSearchCollector({ store: null, jobService: null,
      queue: null, ocr: null, quarantine: null, wait });
  } } = {}) {
  const collector=createCollector();
  collector.session=session;
  await collector.selectJob(title);
  const expression=bossCardProbe(id,title);
  let found=await session.evaluate(expression,{timeoutMs:12000});
  for (let page=0;page<8 && found?.state==='not_in_current_list';page++) {
    const count=found.cardCount;
    // Reuse the collector's guarded official scroll/load-more flow. It
    // verifies the job, filters, iframe, button and list identity before any
    // click; the locator itself never guesses a card by position or name.
    await collector.scrollCards();
    found=await session.evaluate(expression,{timeoutMs:12000});
    if (found?.state==='not_in_current_list' && found.cardCount<=count) break;
  }
  return found;
}

function bossCardProbe(id, title, allowOpenDialog = false) {
  return String.raw`(() => {
    const id=${JSON.stringify(id)}, title=${JSON.stringify(title)};
    const outer=new URL(location.href);
    const search=outer.pathname==='/web/chat/search';
    const recommend=/^\/web\/(?:chat|boss)\/recommend\/?$/.test(outer.pathname);
    if (outer.origin!=='https://www.zhipin.com' || (!search && !recommend))
      return {state:'wrong_page'};
    const frameSelector=search?'iframe[src*="/web/frame/search/"]':
      'iframe[src*="/web/frame/recommend/"]';
    const frame=document.querySelector(frameSelector), doc=frame?.contentDocument;
    if (!doc) return {state:'frame_unavailable'};
    let frameUrl;
    try { frameUrl=new URL(frame.contentWindow.location.href); }
    catch (_) { return {state:'frame_unavailable'}; }
    if (frameUrl.origin!=='https://www.zhipin.com' ||
        frameUrl.pathname.replace(/\/$/,'')!==(search?'/web/frame/search':'/web/frame/recommend'))
      return {state:'frame_changed'};
    const current=search?doc.querySelector('input.search-input')?.value:
      doc.querySelector('.ui-dropmenu-label')?.textContent?.split(/[_＿]/)[0];
    if (String(current||'').normalize('NFKC').replace(/\s+/g,' ').trim()!==title)
      return {state:'wrong_job'};
    if (!${allowOpenDialog} && (doc.querySelector('.dialog-wrap.active') ||
        document.querySelector('div[data-type="boss-dialog"].active')))
      return {state:'dialog_open'};
    const cardSelector=search?'li.geek-info-card':'li.card-item';
    const cards=[...doc.querySelectorAll(cardSelector)];
    const matches=[];
    for (const card of cards) {
      const links=[...card.querySelectorAll(':scope > a[ka="search_click_open_resume"]')];
      if (links.length!==1) continue;
      const attribute=['data-expect','data-geek-id']
        .find(key=>links[0].getAttribute(key)===id);
      if (attribute) matches.push({attribute});
    }
    return {state:matches.length===1?'ready':matches.length?'ambiguous':'not_in_current_list',
      search,frameSelector,cardSelector,attribute:matches[0]?.attribute||'',
      cardCount:cards.length};
  })()`;
}

function bossDialogProbe(expectedId, search) {
  return String.raw`(() => {
    const frame=${search ? 'document' : 'document.querySelector(\'iframe[src*="/web/frame/recommend/"]\')?.contentDocument'};
    const dialogs=[...(frame?.querySelectorAll('div[data-type="boss-dialog"].active.dialog-wrap')||[])];
    if (dialogs.length!==1) return {state:'dialog_unavailable'};
    const frames=[...dialogs[0].querySelectorAll('iframe[src*="/web/frame/c-resume/"]')];
    if (frames.length!==1) return {state:'detail_unavailable'};
    let url;
    try {url=new URL(frames[0].src);} catch (_) {return {state:'detail_unavailable'};}
    if (url.origin!=='https://www.zhipin.com' ||
        url.pathname.replace(/\/$/,'')!=='/web/frame/c-resume')
      return {state:'detail_unavailable'};
    const pageId=url.searchParams.get('expectId')||url.searchParams.get('geekId')||'';
    if (pageId) return {state:pageId===${JSON.stringify(expectedId)}?
      'ready':'identity_conflict'};
    // Some official BOSS detail frames omit a candidate ID in their URL.
    // In that case a unique card click can still be verified, but only after
    // the official detail has rendered and the exact card remains in place.
    const detail=frames[0].contentDocument;
    const text=(detail?.body?.innerText||'').trim();
    const canvas=detail?.querySelector('canvas#resume');
    return {state:text.length>=80 || (canvas?.width>300 && canvas?.height>150)?
      'ready_card_only':'detail_unavailable'};
  })()`;
}

async function closeExistingBossDialog(session, search, title, id, wait) {
  // A previous exact-card lookup can leave the official detail open. Close
  // only the unique BOSS resume dialog, then re-check the saved job and card
  // before opening anything else. Never infer identity from the old dialog.
  const frameSelector=search ? undefined : 'iframe[src*="/web/frame/recommend/"]';
  const selector=search
    ? 'div[data-type="boss-dialog"].active.dialog-wrap > .boss-popup__wrapper.boss-dialog.boss-dialog__wrapper.dialog-lib-resume .close-btn'
    : '.dialog-wrap.active .close-btn';
  if (!search) await session.revealOfficialResumeClose({frameSelector});
  await session.clickUnique({selector, ...(frameSelector ? {frameSelector} : {})});
  for (let attempt=0;attempt<20;attempt++) {
    const state=await session.evaluate(bossCardProbe(id,title),{timeoutMs:12000});
    if (state?.state!=='dialog_open') return state;
    await wait(500);
  }
  // The official dialog sometimes keeps its active class after a successful
  // close click. Give that verified dialog one Escape event, then reload only
  // the same owned recruiter tab if it remains stuck. No second mouse click.
  await session.send('Input.dispatchKeyEvent',{
    type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await session.send('Input.dispatchKeyEvent',{
    type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  for (let attempt=0;attempt<20;attempt++) {
    const state=await session.evaluate(bossCardProbe(id,title),{timeoutMs:12000});
    if (state?.state!=='dialog_open') return state;
    await wait(500);
  }
  const beforeReload=await session.assertRecruiterReady();
  if (new URL(beforeReload).pathname!==(search?'/web/chat/search':'/web/chat/recommend'))
    throw locatorError(409,'BOSS 官方岗位页已变化，未刷新旧弹窗');
  await session.send('Page.reload',{ignoreCache:false},{timeoutMs:12000});
  for (let attempt=0;attempt<60;attempt++) {
    await wait(500);
    let current;
    try { current=await session.assertRecruiterReady(); } catch (_) { continue; }
    if (new URL(current).pathname!==new URL(beforeReload).pathname) break;
    const state=await session.evaluate(bossCardProbe(id,title),{timeoutMs:12000})
      .catch(()=>null);
    if (state && !['dialog_open','frame_unavailable','frame_changed'].includes(state.state))
      return state;
  }
  throw locatorError(409,'BOSS 官方岗位页刷新后仍未恢复；请在服务器浏览器确认页面');
}

function bossJobProbe(title) {
  return String.raw`(() => {
    const title=${JSON.stringify(title)};
    const outer=new URL(location.href);
    if (outer.origin!=='https://www.zhipin.com' ||
        !/^\/web\/(?:chat|boss)\/recommend\/?$/.test(outer.pathname))
      return {state:'wrong_page'};
    const frame=document.querySelector('iframe[src*="/web/frame/recommend/"]');
    const doc=frame?.contentDocument;
    if (!doc) return {state:'frame_unavailable'};
    let live;
    try {live=new URL(frame.contentWindow.location.href);}
    catch (_) {return {state:'frame_unavailable'};}
    if (live.origin!=='https://www.zhipin.com' ||
        live.pathname.replace(/\/$/,'')!=='/web/frame/recommend')
      return {state:'frame_changed'};
    if (doc.querySelector('.dialog-wrap.active') ||
        document.querySelector('div[data-type="boss-dialog"].active'))
      return {state:'dialog_open'};
    const normalize=value=>String(value||'').normalize('NFKC')
      .split(/\s*[_＿]\s*/)[0].replace(/\s+/g,' ').trim();
    const selected=normalize(doc.querySelector('.ui-dropmenu-label')?.textContent);
    const availableOptions=[...doc.querySelectorAll(
      '.job-selecter-options li.job-item, .ui-dropmenu-list li.job-item')]
      .map(el=>({value:el.getAttribute('value')||'',
        label:normalize(el.querySelector('.label')?.textContent||el.textContent)}));
    const options=availableOptions.filter(option=>option.label===title &&
      /^[A-Za-z0-9_-]{1,128}$/.test(option.value));
    return {state:'ready',selected,jobId:live.searchParams.get('jobid')||'',options,
      availableTitles:[...new Set(availableOptions.map(option=>option.label).filter(Boolean))].slice(0,8),
      availableCount:availableOptions.length};
  })()`;
}

async function selectBossPostedJob(session, title, wait) {
  const expression=bossJobProbe(title);
  const frameSelector='iframe[src*="/web/frame/recommend/"]';
  let initial=await session.evaluate(expression,{timeoutMs:12000});
  if (initial?.state==='dialog_open')
    throw locatorError(409,'请先关闭 BOSS 当前简历弹窗后重试');
  if (initial?.state!=='ready')
    throw locatorError(409,'BOSS 推荐岗位列表尚未准备好；请在官方页面确认后重试');
  // The official dropdown may mount its options only after opening. Read it
  // again after one deliberate click, without guessing or switching jobs.
  let opened=false;
  if (!initial.options?.length) {
    await session.clickUnique({selector:'.ui-dropmenu-label',frameSelector});
    opened=true;
    for (let attempt=0;attempt<8;attempt++) {
      initial=await session.evaluate(expression,{timeoutMs:12000}).catch(()=>null);
      if (initial?.state==='dialog_open')
        throw locatorError(409,'BOSS 打开了简历弹窗，未切换岗位；请关闭弹窗后重试');
      if (initial?.state==='ready' && initial.options?.length) break;
      await wait(250);
    }
  }
  const matches=initial?.options?.filter(option=>option.label===title)||[];
  if (matches.length!==1) {
    const error=locatorError(409,matches.length>1?
      `BOSS 存在多个同名“${title}”在招岗位，无法确定原候选人所属岗位；请在官方页面人工选择后重试`:
      `BOSS 当前推荐页未列出“${title}”（当前选中：${initial?.selected || '未显示'}；`+
      `可见岗位：${initial?.availableTitles?.join('、') || '未加载'}）。`+
      '请在官方“搜索牛人”页打开该岗位结果，或在推荐页切换到该在招岗位后重试');
    if (!matches.length) error.code='BOSS_JOB_NOT_LISTED';
    throw error;
  }
  const chosen=matches[0];
  if (initial.selected===title && initial.jobId===chosen.value) return;
  if (!opened)
    await session.clickUnique({selector:'.ui-dropmenu-label',frameSelector});
  const selector=`.job-selecter-options li.job-item[value="${chosen.value}"]`;
  await session.scrollUnique({selector,frameSelector,identityAttribute:'value',
    identityValue:chosen.value});
  await session.clickUnique({selector,frameSelector,identityAttribute:'value',
    identityValue:chosen.value});
  let stable=0;
  for (let attempt=0;attempt<16;attempt++) {
    const state=await session.evaluate(expression,{timeoutMs:12000}).catch(()=>null);
    if (state?.state==='ready' && state.selected===title &&
        state.jobId===chosen.value && state.options?.length===1) {
      if (++stable>=2) return;
    } else stable=0;
    await wait(400);
  }
  throw locatorError(409,`BOSS 切换后未能核实“${title}”岗位，未定位候选人`);
}

function bossFingerprintProbe(title) {
  return String.raw`(() => {
    const title=${JSON.stringify(title)};
    const outer=new URL(location.href);
    const search=outer.pathname==='/web/chat/search';
    const recommend=/^\/web\/(?:chat|boss)\/recommend\/?$/.test(outer.pathname);
    if (outer.origin!=='https://www.zhipin.com' || (!search && !recommend))
      return {state:'wrong_page'};
    const frame=document.querySelector(search?'iframe[src*="/web/frame/search/"]':
      'iframe[src*="/web/frame/recommend/"]');
    const doc=frame?.contentDocument;
    if (!doc) return {state:'frame_unavailable'};
    let url;
    try {url=new URL(frame.contentWindow.location.href);}
    catch (_) {return {state:'frame_unavailable'};}
    if (url.origin!=='https://www.zhipin.com' ||
        url.pathname.replace(/\/$/,'')!==(search?'/web/frame/search':'/web/frame/recommend'))
      return {state:'frame_changed'};
    const current=search?doc.querySelector('input.search-input')?.value:
      doc.querySelector('.ui-dropmenu-label')?.textContent?.split(/[_＿]/)[0];
    if (String(current||'').normalize('NFKC').replace(/\s+/g,' ').trim()!==title)
      return {state:'wrong_job'};
    if (doc.querySelector('.dialog-wrap.active') ||
        document.querySelector('div[data-type="boss-dialog"].active'))
      return {state:'dialog_open'};
    const cards=[...doc.querySelectorAll(search?'li.geek-info-card':'li.card-item')];
    if (cards.length>1000) return {state:'list_too_large'};
    return {state:'ready',search,jobId:search?'':url.searchParams.get('jobid')||'',
      cards:cards.map(card=>{
        const links=[...card.querySelectorAll(':scope > a[ka="search_click_open_resume"]')];
        return {text:(card.textContent||'').replace(/\s+/g,' ').trim(),
          id:links.length===1?(links[0].getAttribute('data-expect')||
            links[0].getAttribute('data-geek-id')||''):''};
      })};
  })()`;
}

function searchScope(title) {
  const normalized=String(title||'').normalize('NFKC').replace(/\s+/g,' ').trim();
  return `search-${crypto.createHash('sha256').update(normalized).digest('hex').slice(0,32)}`;
}

function cardFingerprint(scope, text) {
  return crypto.createHash('sha256').update(`${scope}\n${text}`
    .normalize('NFKC').replace(/\s+/g,' ').trim()).digest('hex');
}

async function locateBossCandidateByFingerprint(session, candidate, options = {}) {
  if (candidate?.source!=='boss' || platformLocator(candidate).id ||
      !/^[a-f0-9]{64}$/.test(candidate.sourceCardFingerprint||''))
    throw locatorError(422,'这份 BOSS 旧简历缺少可用于安全补录的平台候选卡证据；请在原岗位重新采集并核对');
  const title=hiringJobTitle(candidate);
  if (!title || title==='招聘岗位待核实')
    throw locatorError(422,'招聘岗位尚未核实，无法补录 BOSS 编号');
  const current=await session.assertRecruiterReady();
  const search=new URL(current).pathname==='/web/chat/search';
  await session.assertUsableRecruiterWindow({frameSelector:search?
    'iframe[src*="/web/frame/search/"]':'iframe[src*="/web/frame/recommend/"]'});
  let snapshot=await session.evaluate(bossFingerprintProbe(title),{timeoutMs:12000});
  if (snapshot?.state==='wrong_job' && !search) {
    await selectBossPostedJob(session,title,options.wait ||
      (ms=>new Promise(resolve=>setTimeout(resolve,ms))));
    snapshot=await session.evaluate(bossFingerprintProbe(title),{timeoutMs:12000});
  }
  if (snapshot?.state!=='ready')
    throw locatorError(409,snapshot?.state==='wrong_job'?
      `请先在 BOSS 服务器浏览器切换到“${title}”结果页后重试`:
      'BOSS 当前候选列表未准备好；请打开原岗位结果并关闭已有简历弹窗');
  const scope=snapshot.search?searchScope(title):snapshot.jobId;
  if (!scope) throw locatorError(409,'BOSS 当前招聘岗位编号不可用，无法安全补录');
  const matches=snapshot.cards.filter(card=>card.text &&
    cardFingerprint(scope,card.text)===candidate.sourceCardFingerprint);
  if (matches.length!==1)
    throw locatorError(409,matches.length?'BOSS 候选卡证据重复，未补录编号':
      '原候选卡不在当前已加载的结果列表；请加载原岗位的候选人后重试');
  const { bossCardId }=require('../utils/platformLocator');
  const id=bossCardId(matches[0].id);
  if (!id || snapshot.cards.filter(card=>card.id===id).length!==1)
    throw locatorError(409,'原候选卡没有唯一、可核实的平台编号，未补录');
  if (await session.assertRecruiterReady()!==current)
    throw locatorError(409,'BOSS 页面已变化，未补录编号');
  // Recheck the exact card and official dialog using the regular locator.
  const result=await locateBossCandidate(session,{...candidate,
    sourceCandidateId:id,sourceCandidateIdSource:'platform_card'},options);
  return {...result,recovered:true};
}

async function locateBossCandidate(session, candidate, { wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  prepareSearch = prepareBossSearchPage,
  scanSearch = scanBossSearchForCandidate } = {}) {
  const locator=platformLocator(candidate);
  if (candidate?.source!=='boss' || !locator.id ||
      !['platform_card','official_url'].includes(locator.status))
    throw locatorError(422,'这份 BOSS 简历没有可用于候选卡定位的已核实平台编号');
  const title=hiringJobTitle(candidate);
  if (!title || title==='招聘岗位待核实')
    throw locatorError(422,'这份简历的招聘岗位尚未核实，无法安全定位');
  let current=await session.assertRecruiterReady();
  let search=new URL(current).pathname==='/web/chat/search';
  let frameSelector=search?'iframe[src*="/web/frame/search/"]':
    'iframe[src*="/web/frame/recommend/"]';
  await session.assertUsableRecruiterWindow({frameSelector});
  let expression=bossCardProbe(locator.id,title);
  let before=await session.evaluate(expression,{timeoutMs:12000});
  if (before?.state==='dialog_open')
    before=await closeExistingBossDialog(session,search,title,locator.id,wait);
  if (before?.state==='wrong_job') {
    if (search) {
      await prepareSearch(session,title,wait);
    } else {
      try { await selectBossPostedJob(session,title,wait); }
      catch (error) {
        if (error.code!=='BOSS_JOB_NOT_LISTED') throw error;
        await prepareSearch(session,title,wait);
      }
    }
    current=await session.assertRecruiterReady();
    search=new URL(current).pathname==='/web/chat/search';
    if (search) {
      frameSelector='iframe[src*="/web/frame/search/"]';
      await session.assertUsableRecruiterWindow({frameSelector});
      expression=bossCardProbe(locator.id,title);
    } else if (new URL(current).pathname!=='/web/chat/recommend') {
      throw locatorError(409,'BOSS 官方岗位页面已变化，未打开候选人');
    }
    before=await session.evaluate(expression,{timeoutMs:12000});
  }
  if (search && before?.state==='not_in_current_list') {
    before=await scanSearch(session,title,locator.id,wait);
    current=await session.assertRecruiterReady();
  }
  if (before?.state!=='ready') {
    const messages={wrong_page:'请先在 BOSS 服务器浏览器打开对应岗位的搜索或推荐结果页',
      wrong_job:`BOSS 当前列表并非“${title}”，请切换到该岗位后重试`,
      not_in_current_list:'该候选人不在 BOSS 当前已加载的结果列表；请在官方页面加载原岗位结果后重试',
      ambiguous:'BOSS 当前列表出现重复平台编号，未执行定位',
      dialog_open:'请先关闭 BOSS 当前简历弹窗后重试'};
    throw locatorError(409,messages[before?.state]||'BOSS 列表尚未准备好，请在服务器浏览器确认后重试');
  }
  // The search collector opens the official link itself. The surrounding
  // card can be covered by the sticky recruiter sidebar even while its link
  // remains clickable, so use the same target here after the exact-ID probe.
  const selector=search
    ? `${before.cardSelector} > a[ka="search_click_open_resume"][${before.attribute}="${locator.id}"]`
    : `${before.cardSelector}:has(> a[ka="search_click_open_resume"][${before.attribute}="${locator.id}"])`;
  await session.scrollUnique({selector,frameSelector:before.frameSelector});
  const after=await session.evaluate(expression,{timeoutMs:12000});
  if (after?.state!=='ready' || after.search!==before.search ||
      after.attribute!==before.attribute || await session.assertRecruiterReady()!==current)
    throw locatorError(409,'BOSS 候选列表在定位时变化，未执行点击；请刷新后重试');
  await session.clickUnique({selector,frameSelector:before.frameSelector});
  for (let attempt=0;attempt<12;attempt++) {
    const modal=await session.evaluate(bossDialogProbe(locator.id,search),{timeoutMs:12000});
    if (modal?.state==='ready') return {platform:'boss',recordId:locator.id,verified:'exact_card'};
    if (modal?.state==='ready_card_only') {
      const card=await session.evaluate(bossCardProbe(locator.id,title,true),
        {timeoutMs:12000});
      if (card?.state==='ready' && card.attribute===before.attribute &&
          card.search===before.search &&
          await session.assertRecruiterReady()===current)
        return {platform:'boss',recordId:locator.id,verified:'exact_card'};
      throw locatorError(409,'BOSS 官方详情已打开，但原候选卡编号或岗位发生变化，未确认对应关系');
    }
    if (modal?.state==='identity_conflict')
      throw locatorError(409,'BOSS 打开的简历编号与目标不一致，已停止定位，请人工核对');
    await wait(400);
  }
  throw locatorError(409,'BOSS 候选卡已点击，但未能核实官方简历弹窗；请在服务器浏览器人工核对');
}

async function openZhilianCandidateFromCurrentResults(page,candidate,locator) {
  const found=await findZhilianCard(page,locator.id);
  if (found==='ambiguous')
    throw locatorError(409,'智联当前结果中有重复的简历号，未执行定位；请在平台人工核对');
  const evidenceFound=found==null?await findZhilianCardByEvidence(page,candidate):found;
  if (evidenceFound==='ambiguous')
    throw locatorError(409,'智联当前结果中有多个经历相似的候选人，未执行定位；请在平台人工核对');
  if (!Number.isInteger(evidenceFound)) return null;
  const card=page.locator('div.search-resume-item.resume-item-exp').nth(evidenceFound);
  await card.click({timeout:10000});
  const detailVisible=await waitForZhilianDetail(page,12000);
  if (!detailVisible || idFromOfficialUrl('zlzp',page.url())!==locator.id) {
    await page.keyboard.press('Escape');
    try {
      await page.locator('.new-shortcut-resume__modal .new-resume-detail--inner, .new-resume-detail--inner')
        .first().waitFor({state:'hidden',timeout:3000});
    } catch {
      throw locatorError(409,'智联打开了其他候选人的详情，未能安全关闭弹窗；请在平台人工核对');
    }
    if(found==null) return null;
    throw locatorError(409,'智联候选卡已打开，但未能核实对应编号的详情；请在官方页面人工核对');
  }
  return {platform:'zlzp',recordId:locator.id,verified:'exact_card'};
}

async function zhilianResultFingerprint(page) {
  return page.locator('div.search-resume-item.resume-item-exp')
    .evaluateAll(elements=>elements.slice(0,20).map(card=>
      (card.textContent||'').replace(/\s+/g,' ').trim().slice(0,120)).join('\n'))
    .catch(()=>'');
}

async function searchZhilianForSavedCandidate(page,candidate,locator,searchTerms) {
  const terms=[...new Set(searchTerms.map(term=>String(term||'').trim())
    .filter(term=>term && term.length<=120))].slice(0,5);
  if (!terms.length) return null;
  const inputSelectors=['input[placeholder*="关键词"]','input[placeholder*="搜索"]',
    'input[placeholder*="岗位"]','input[placeholder*="职位"]',
    '.keyword-panel input[type="text"]','.search-box input','input[type="search"]'];
  let input=null;
  for (const selector of inputSelectors) {
    const candidateInput=page.locator(selector).first();
    if (await candidateInput.isVisible().catch(()=>false)) { input=candidateInput; break; }
  }
  if (!input) return null;
  const pageHint=Number.isInteger(candidate.sourceSearchPage)
    ? candidate.sourceSearchPage : 1;
  const maxPages=Math.min(5,Math.max(3,pageHint+1));
  for (const term of terms) {
    const beforeSearch=await zhilianResultFingerprint(page);
    await input.fill(term,{timeout:5000});
    await input.press('Enter',{timeout:5000});
    for(let poll=0;poll<8;poll++) {
      await page.waitForTimeout(500);
      const current=await zhilianResultFingerprint(page);
      if(current && current!==beforeSearch) break;
    }
    let prior='';
    for (let pageIndex=0;pageIndex<maxPages;pageIndex++) {
      const found=await openZhilianCandidateFromCurrentResults(page,candidate,locator);
      if (found) return found;
      let next=null;
      for(const selector of ['.next-page','.btn-next','text="下一页"','text="下页"',
        '.pagination .next','[aria-label="下一页"]']) {
        const control=page.locator(selector).first();
        if (await control.isVisible().catch(()=>false)) { next=control; break; }
      }
      if (!next ||
          !await next.isEnabled().catch(()=>false) ||
          await next.getAttribute('aria-disabled').catch(()=>null)==='true') break;
      prior=await zhilianResultFingerprint(page);
      await next.click({timeout:5000});
      let changed=false;
      for(let poll=0;poll<8;poll++) {
        await page.waitForTimeout(500);
        const current=await zhilianResultFingerprint(page);
        if(current && current!==prior){changed=true;break;}
      }
      if(!changed) break;
    }
  }
  return null;
}

async function locateOfficialCandidate(page, candidate, {searchTerms=[]}={}) {
  const locator=platformLocator(candidate);
  if (!['zlzp','qcwy'].includes(candidate?.source) || locator.status!=='official_url' ||
      !locator.url || idFromOfficialUrl(candidate.source,locator.url)!==locator.id)
    throw locatorError(422,'这份简历缺少可验证的官方个人详情链接');
  if (candidate.source==='zlzp') {
    // The search URL can be a history entry for an open modal, rather than a
    // durable deep link. Prefer the exact official card in the live result list.
    const current=page.url();
    if (idFromOfficialUrl('zlzp',current)===locator.id &&
        await waitForZhilianDetail(page,1000))
      return {platform:'zlzp',recordId:locator.id,verified:'official_detail'};
    if (await waitForZhilianDetail(page,500))
      throw locatorError(409,'智联当前打开的是另一份简历；请先关闭该弹窗后再定位');
    const inCurrent=await openZhilianCandidateFromCurrentResults(page,candidate,locator);
    if(inCurrent) return inCurrent;
    const recovered=await searchZhilianForSavedCandidate(page,candidate,locator,searchTerms);
    if(recovered) return recovered;
    throw locatorError(409,'智联原候选卡不在当前已加载的搜索结果中；请在官方页面打开原岗位结果后重试。完整简历号不能直接作为普通关键词搜索');
  }
  await page.goto(locator.url,{waitUntil:'domcontentloaded',timeout:30000});
  if (idFromOfficialUrl(candidate.source,page.url())!==locator.id)
    throw locatorError(409,'平台跳转后不是目标简历；请在服务器浏览器确认登录或官方安全验证');
  if (candidate.source==='zlzp') {
    if (!await waitForZhilianDetail(page,12000))
      throw locatorError(409,'智联搜索地址已打开，但未恢复目标简历详情；请在官方搜索结果加载该候选卡后重试定位');
  }
  return {platform:candidate.source,recordId:locator.id,verified:'official_url'};
}

async function findZhilianCardByEvidence(page,candidate) {
  const name=String(candidate?.name||candidate?.platformAlias||'').normalize('NFKC').trim();
  const companies=[...new Set((Array.isArray(candidate?.workExperience)?candidate.workExperience:[])
    .map(item=>String(item?.company||'').normalize('NFKC')
      .replace(/(?:股份)?有限公司|有限责任公司|公司$/g,'')
      .replace(/[^\p{Script=Han}A-Za-z0-9]/gu,''))
    .filter(value=>value.length>=6))].slice(0,5);
  if (!/^[\p{Script=Han}]{1,4}(?:先生|女士)$/u.test(name) || companies.length<1)
    return null;
  const matches=await page.locator('div.search-resume-item.resume-item-exp')
    .evaluateAll((elements,evidence)=>{
      if (elements.length>300) return [];
      const clean=value=>String(value||'').normalize('NFKC')
        .replace(/[^\p{Script=Han}A-Za-z0-9]/gu,'');
      return elements.flatMap((card,index)=>{
        const text=clean(card.textContent);
        if (!text.includes(evidence.name)) return [];
        const distinct=evidence.companies.filter(company=>{
          for(let i=0;i<=company.length-6;i++)
            if(text.includes(company.slice(i,i+6))) return true;
          return false;
        });
        return distinct.length>=1?[index]:[];
      });
    },{name,companies}).catch(()=>[]);
  return matches.length>1?'ambiguous':matches.length===1?matches[0]:null;
}

async function waitForZhilianDetail(page,timeout) {
  try {
    await page.locator('.new-shortcut-resume__modal .new-resume-detail--inner, .new-resume-detail--inner')
      .first().waitFor({state:'visible',timeout});
    return true;
  } catch { return false; }
}

async function findZhilianCard(page,id) {
  let current;
  try { current=new URL(page.url()); } catch { return null; }
  if (current.protocol!=='https:' || !['rd6.zhaopin.com','rd.zhaopin.com'].includes(current.hostname) ||
      current.pathname!=='/app/search') return null;
  const cards=page.locator('div.search-resume-item.resume-item-exp');
  const matches=await cards.evaluateAll((elements,expected)=>elements.flatMap((card,index)=>{
    const ids=['data-resume-id','data-resume-number','data-id']
      .map(key=>card.getAttribute(key)).filter(Boolean);
    for (const link of card.querySelectorAll('a[href]')) {
      try {
        const url=new URL(link.getAttribute('href'),location.href);
        if (url.hostname.endsWith('.zhaopin.com') && url.pathname==='/app/search')
          ids.push(url.searchParams.get('resumeNumber'));
      } catch (_) {}
    }
    return ids.includes(expected)?[index]:[];
  }),id).catch(()=>[]);
  if (matches.length>1) return 'ambiguous';
  return matches.length===1?matches[0]:null;
}

module.exports={locateBossCandidate,locateBossCandidateByFingerprint,
  locateOfficialCandidate,bossCardProbe,bossDialogProbe,bossJobProbe,
  bossFingerprintProbe,cardFingerprint,searchScope,scanBossSearchForCandidate};
