const { connectOwnedBossPage } = require('./bossRawCdp');

const RECOMMEND_URL = 'https://www.zhipin.com/web/chat/recommend';
const SEARCH_FRAME = 'iframe[src*="/web/frame/search/"]';
const RECOMMEND_FRAME = 'iframe[src*="/web/frame/recommend/"]';

function navigationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isSearchPage(value) {
  try {
    const url = new URL(value);
    return url.origin === 'https://www.zhipin.com' &&
      url.pathname === '/web/chat/search' && !url.hash &&
      (url.search === '' || ([...url.searchParams.keys()].length === 1 &&
        [...url.searchParams.keys()][0] === '_security_check'));
  } catch (_) { return false; }
}

async function ensureOfficialSearchPage({ connect = connectOwnedBossPage,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const session = await connect();
  try {
    const before = await session.assertRecruiterReady();
    if (isSearchPage(before)) return { navigated: false, url: before };
    if (before !== RECOMMEND_URL) throw navigationError('BOSS_SEARCH_PAGE_REQUIRED',
      'BOSS 当前不在推荐页或搜索页；请在招聘后台打开“搜索”后重试');
    // The official menu is in the outer recruiter document. Check that the
    // existing authenticated window is visible, then click this menu once.
    await session.assertUsableRecruiterWindow({ frameSelector: RECOMMEND_FRAME });
    await session.clickUnique({ selector: 'a[ka="menu-geek-search"]' });
    for (let attempt = 0; attempt < 20; attempt++) {
      await wait(500);
      const url = await session.assertRecruiterReady();
      if (isSearchPage(url)) {
        const ready = await session.evaluate(`(() => {
          const frame=document.querySelector(${JSON.stringify(SEARCH_FRAME)});
          if (!frame?.contentDocument) return false;
          try { const url=new URL(frame.contentWindow.location.href);
            return url.origin==='https://www.zhipin.com' &&
              url.pathname==='/web/frame/search/';
          } catch (_) { return false; }
        })()`);
        if (ready) return { navigated: true, url };
      } else if (url !== before) {
        throw navigationError('BOSS_SEARCH_PAGE_REQUIRED',
          'BOSS 点击官方搜索菜单后进入其他页面；请在浏览器中确认平台状态');
      }
    }
    throw navigationError('BOSS_SEARCH_PAGE_UNAVAILABLE',
      'BOSS 官方搜索页未加载完成；请在浏览器中确认平台状态');
  } finally { session.close(); }
}

module.exports = { ensureOfficialSearchPage, isSearchPage };
