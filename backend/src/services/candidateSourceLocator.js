'use strict';

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

async function locateBossCandidate(session, candidate, { wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const locator=platformLocator(candidate);
  if (candidate?.source!=='boss' || !locator.id || locator.status!=='platform_card')
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
  const before=await session.evaluate(expression,{timeoutMs:12000});
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
  await page.goto(locator.url,{waitUntil:'domcontentloaded',timeout:30000});
  if (idFromOfficialUrl(candidate.source,page.url())!==locator.id)
    throw locatorError(409,'平台跳转后不是目标简历；请在服务器浏览器确认登录或官方安全验证');
  if (candidate.source==='zlzp') {
    const detail=page.locator('.new-shortcut-resume__modal .new-resume-detail--inner, .new-resume-detail--inner').first();
    if (!await detail.isVisible({timeout:10000}).catch(()=>false))
      throw locatorError(409,'智联已打开目标简历地址，但详情尚未显示；请在服务器浏览器检查登录和页面');
  }
  return {platform:candidate.source,recordId:locator.id,verified:'official_url'};
}

module.exports={locateBossCandidate,locateOfficialCandidate,bossCardProbe,bossDialogProbe};
