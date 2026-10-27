'use strict';

const crypto = require('node:crypto');
const { idFromOfficialUrl, platformLocator } = require('../utils/platformLocator');
const { hiringJobTitle } = require('../utils/candidateDisplay');

function locatorError(status, message) {
  return Object.assign(new Error(message), { publicStatus: status });
}

function bossCardProbe(id, title) {
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
    if (doc.querySelector('.dialog-wrap.active') ||
        document.querySelector('div[data-type="boss-dialog"].active'))
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
    const dialogs=[...(frame?.querySelectorAll('.dialog-wrap.active')||[])];
    if (dialogs.length!==1) return {state:'dialog_unavailable'};
    const frames=[...dialogs[0].querySelectorAll('iframe[src*="/web/frame/c-resume/"]')];
    if (frames.length!==1) return {state:'detail_unavailable'};
    let url;
    try {url=new URL(frames[0].src);} catch (_) {return {state:'detail_unavailable'};}
    if (url.origin!=='https://www.zhipin.com' ||
        url.pathname.replace(/\/$/,'')!=='/web/frame/c-resume')
      return {state:'detail_unavailable'};
    const pageId=url.searchParams.get('expectId')||url.searchParams.get('geekId')||'';
    return {state:pageId && pageId!==${JSON.stringify(expectedId)}?'identity_conflict':'ready'};
  })()`;
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
    const options=[...doc.querySelectorAll(
      '.job-selecter-options li.job-item, .ui-dropmenu-list li.job-item')]
      .map(el=>({value:el.getAttribute('value')||'',
        label:normalize(el.querySelector('.label')?.textContent||el.textContent)}))
      .filter(option=>option.label===title && /^[A-Za-z0-9_-]{1,128}$/.test(option.value));
    return {state:'ready',selected,jobId:live.searchParams.get('jobid')||'',options};
  })()`;
}

async function selectBossPostedJob(session, title, wait) {
  const expression=bossJobProbe(title);
  const initial=await session.evaluate(expression,{timeoutMs:12000});
  if (initial?.state!=='ready' || initial.options?.length!==1)
    throw locatorError(409,`BOSS 没有唯一可核实的“${title}”在招岗位；请在官方页面切换到该岗位后重试`);
  const chosen=initial.options[0];
  if (initial.selected===title && initial.jobId===chosen.value) return;
  const frameSelector='iframe[src*="/web/frame/recommend/"]';
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

async function locateBossCandidate(session, candidate, { wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const locator=platformLocator(candidate);
  if (candidate?.source!=='boss' || !locator.id ||
      !['platform_card','official_url'].includes(locator.status))
    throw locatorError(422,'这份 BOSS 简历没有可用于候选卡定位的已核实平台编号');
  const title=hiringJobTitle(candidate);
  if (!title || title==='招聘岗位待核实')
    throw locatorError(422,'这份简历的招聘岗位尚未核实，无法安全定位');
  const current=await session.assertRecruiterReady();
  const search=new URL(current).pathname==='/web/chat/search';
  const frameSelector=search?'iframe[src*="/web/frame/search/"]':
    'iframe[src*="/web/frame/recommend/"]';
  await session.assertUsableRecruiterWindow({frameSelector});
  const expression=bossCardProbe(locator.id,title);
  let before=await session.evaluate(expression,{timeoutMs:12000});
  if (before?.state==='wrong_job' && !search) {
    await selectBossPostedJob(session,title,wait);
    before=await session.evaluate(expression,{timeoutMs:12000});
  }
  if (before?.state!=='ready') {
    const messages={wrong_page:'请先在 BOSS 服务器浏览器打开对应岗位的搜索或推荐结果页',
      wrong_job:`BOSS 当前列表并非“${title}”，请切换到该岗位后重试`,
      not_in_current_list:'该候选人不在 BOSS 当前已加载的结果列表；请在官方页面加载原岗位结果后重试',
      ambiguous:'BOSS 当前列表出现重复平台编号，未执行定位',
      dialog_open:'请先关闭 BOSS 当前简历弹窗后重试'};
    throw locatorError(409,messages[before?.state]||'BOSS 列表尚未准备好，请在服务器浏览器确认后重试');
  }
  const selector=`${before.cardSelector}:has(> a[ka="search_click_open_resume"][${before.attribute}="${locator.id}"])`;
  await session.scrollUnique({selector,frameSelector:before.frameSelector});
  const after=await session.evaluate(expression,{timeoutMs:12000});
  if (after?.state!=='ready' || after.search!==before.search ||
      after.attribute!==before.attribute || await session.assertRecruiterReady()!==current)
    throw locatorError(409,'BOSS 候选列表在定位时变化，未执行点击；请刷新后重试');
  await session.clickUnique({selector,frameSelector:before.frameSelector});
  for (let attempt=0;attempt<12;attempt++) {
    const modal=await session.evaluate(bossDialogProbe(locator.id,search),{timeoutMs:12000});
    if (modal?.state==='ready') return {platform:'boss',recordId:locator.id,verified:'exact_card'};
    if (modal?.state==='identity_conflict')
      throw locatorError(409,'BOSS 打开的简历编号与目标不一致，已停止定位，请人工核对');
    await wait(400);
  }
  throw locatorError(409,'BOSS 候选卡已点击，但未能核实官方简历弹窗；请在服务器浏览器人工核对');
}

async function locateOfficialCandidate(page, candidate) {
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
    const found=await findZhilianCard(page,locator.id);
    if (found==='ambiguous')
      throw locatorError(409,'智联当前结果中有重复的简历号，未执行定位；请在平台人工核对');
    if (Number.isInteger(found)) {
      const card=page.locator('div.search-resume-item.resume-item-exp').nth(found);
      const links=card.locator('a[href]');
      const count=await links.count();
      if (!count || count>20)
        throw locatorError(409,'智联已找到目标候选卡，但没有唯一可核对的官方简历链接');
      let selected=-1;
      for (let index=0;index<count;index++) {
        const href=await links.nth(index).getAttribute('href');
        try {
          if (idFromOfficialUrl('zlzp',new URL(href,page.url()).href)===locator.id) {
            if (selected!==-1)
              throw locatorError(409,'智联候选卡出现多个相同编号链接，未执行定位');
            selected=index;
          }
        } catch (error) { if (error.publicStatus) throw error; }
      }
      if (selected===-1 && count!==1)
        throw locatorError(409,'智联候选卡有多个操作链接且无法确定简历入口，未执行定位');
      const link=links.nth(selected===-1?0:selected);
      await link.click({timeout:10000});
      if (idFromOfficialUrl('zlzp',page.url())!==locator.id ||
          !await waitForZhilianDetail(page,12000))
        throw locatorError(409,'智联候选卡已打开，但未能核实对应编号的详情；请在官方页面人工核对');
      return {platform:'zlzp',recordId:locator.id,verified:'exact_card'};
    }
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
  bossFingerprintProbe,cardFingerprint,searchScope};
