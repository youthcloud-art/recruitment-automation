'use strict';

const express = require('express');
const { localApiAccess } = require('../middleware/localApiAccess');
const resumeModel = require('../models/resumeModel');
const { locateBossCandidate, locateBossCandidateByFingerprint,
  locateOfficialCandidate } = require('../services/candidateSourceLocator');
const { platformLocator } = require('../utils/platformLocator');

const PLATFORMS = {
  boss: { label: 'BOSS 直聘', profileName: 'boss', port: 19222, domain: 'zhipin.com' },
  zhilian: { label: '智联招聘', profileName: 'zhilian', port: 19223, domain: 'zhaopin.com' },
  wuyou: { label: '前程无忧', profileName: 'qcwy', port: 19224, domain: '51job.com' }
};
const KEYS = new Set(['Enter', 'Tab', 'Backspace', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Control+A']);
const CLIENT_ID = /^[A-Za-z0-9_-]{16,80}$/;
const LOCK_MS = 60000;

function defaultTargets() {
  return {
    boss: require('./bossZhipin').getBrowserConsoleTarget(),
    zhilian: require('./zhilian').getBrowserConsoleTarget(),
    wuyou: require('./wuyou').getBrowserConsoleTarget()
  };
}

function running(target = {}) {
  const service = target.service;
  return Boolean(target.running || service?.batch?.running || service?.browsingStatus?.isActive ||
    service?.resumeProcessingStatus?.isActive || service?.isCollecting ||
    ['browsing', 'processing', 'collecting'].includes(service?.currentStatus));
}

function available(target = {}) {
  const service = target.service;
  return Boolean(service && (service.chromeWindowOpened || (service.page && !service.page.isClosed())));
}

function trustedPage(page, platform) {
  try {
    if (!page || page.isClosed()) return false;
    const url = new URL(page.url());
    const domain = PLATFORMS[platform].domain;
    return url.protocol === 'https:' && (url.hostname === domain || url.hostname.endsWith(`.${domain}`));
  } catch { return false; }
}

function fail(status, message) { throw Object.assign(new Error(message), { publicStatus: status }); }

function fields(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some(key => !allowed.includes(key))) fail(400, '控制参数无效');
}

function identity(platform, clientId) {
  if (!Object.hasOwn(PLATFORMS, platform) || typeof clientId !== 'string' || !CLIENT_ID.test(clientId)) {
    fail(400, '平台或操作会话无效');
  }
}

function createBrowserConsoleRouter({ environment = process.env, getTargets = defaultTargets,
  now = Date.now,
  disconnectTimeoutMs = 5000,
  attachExisting = options => require('../services/visibleChromeCdp').attachExistingVisibleChromeCdp(options),
  readOwnedTabs = options => require('../services/visibleChromeCdp').getCdpTabs(options) } = {}) {
  const router = express.Router();
  let lock = null;
  let pending = false;
  const frames = new Map();
  const currentLock = () => lock && lock.expiresAt > now() ? lock : null;
  const ownedAvailable = async (platform, target) => {
    if (available(target)) return true;
    try {
      const tabs = await readOwnedTabs(PLATFORMS[platform]);
      return tabs.some(tab => {
        const url = new URL(tab.url);
        const domain = PLATFORMS[platform].domain;
        return url.protocol === 'https:' &&
          (url.hostname === domain || url.hostname.endsWith(`.${domain}`));
      });
    } catch { return false; }
  };
  const owns = (platform, clientId) => currentLock()?.clientId === clientId && currentLock()?.platform === platform;
  const requireLock = (platform, clientId) => {
    identity(platform, clientId);
    if (!owns(platform, clientId)) fail(409, '请先获取操作权；其他同事可能正在使用，空闲 60 秒后释放');
  };
  const respond = (res, data) => res.json({ success: true, data });
  const errorResponse = (res, error) => res.status(error.publicStatus || 503)
    .json({ success: false, message: error.publicStatus ? error.message : '平台画面暂不可用，请确认服务器浏览器已打开后重试' });

  // Raw CDP failures have deliberately terse internal messages. Give the
  // operator a safe recovery action instead of hiding every locator failure
  // behind the same generic screenshot error.
  const bossLocatorRecovery = {
    BOSS_CDP_PAGE_UNAVAILABLE: 'BOSS 专用浏览器未找到唯一的招聘后台标签页；请保留一个已登录的“搜索牛人”页后重试',
    BOSS_CDP_WINDOW_MINIMIZED: 'BOSS 专用 Chrome 已最小化；请恢复并最大化窗口后重试定位',
    BOSS_CDP_WINDOW_UNAVAILABLE: 'BOSS 招聘窗口或结果区域暂不可用；请恢复窗口并等待岗位结果卡片显示后重试',
    BOSS_CDP_VIEWPORT_TOO_SMALL: 'BOSS 招聘窗口显示区域不足；请最大化专用 Chrome 后重试定位',
    BOSS_VERIFICATION_REQUIRED: 'BOSS 需要在官方页面完成人工安全验证；完成后回到岗位结果页重试',
    BOSS_LOGIN_REQUIRED: 'BOSS 登录已失效；请在专用 Chrome 正常登录后重试',
    BOSS_PAGE_UNAVAILABLE: 'BOSS 当前不在可用的招聘结果页；请打开对应岗位的“搜索牛人”结果后重试',
    BOSS_CDP_TIMEOUT: 'BOSS 页面响应超时；请确认官方结果卡片已加载，稍后重试',
    BOSS_CDP_DISCONNECTED: 'BOSS 浏览器连接中断；请确认专用 Chrome 仍打开后重试',
    BOSS_CDP_UNAVAILABLE: 'BOSS 浏览器控制接口不可用；请检查服务器专用 Chrome 是否仍在运行',
    BOSS_CDP_EVALUATION_FAILED: 'BOSS 官方页面结构已变化，无法读取当前候选卡；请刷新“搜索牛人”结果页后重试',
    BOSS_CDP_COMMAND_FAILED: 'BOSS 官方页面操作未完成；请保持专用 Chrome 显示并重试',
    BOSS_CDP_TARGET_UNAVAILABLE: 'BOSS 目标候选卡在当前页面不可操作；请在官方结果页加载该卡片后重试',
    BOSS_CDP_TARGET_UNSTABLE: 'BOSS 候选卡位置在操作时变化；请等待结果页稳定后重试',
    BOSS_CDP_CLICK_UNCERTAIN: 'BOSS 候选卡点击结果无法确认；请在服务器浏览器核对当前弹窗后重试',
    BOSS_RATE_LIMITED: 'BOSS 官方页面提示访问频繁；请按平台提示等待后重试'
  };

  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store, private');
    res.set('Pragma', 'no-cache');
    res.set('X-Content-Type-Options', 'nosniff');
    if (environment.COMPANY_DEPLOYMENT !== 'true') return res.status(404).json({ success: false });
    next();
  }, localApiAccess);

  async function withPage(platform, callback) {
    const target = getTargets()[platform];
    if (!await ownedAvailable(platform, target))
      fail(409, '请先在对应招聘平台页面启动浏览器，再打开服务器画面');
    let attached;
    try {
      let page = target.service.page;
      if (!trustedPage(page, platform)) {
        // Login initially opens an owned Chrome window without a service.page.
        // Attach only to that existing, identity-verified browser; never launch
        // another browser, navigate a URL or select a non-platform tab.
        attached = await attachExisting(PLATFORMS[platform]);
        page = attached.context.pages().find(candidate => trustedPage(candidate, platform));
      }
      if (!trustedPage(page, platform)) fail(409, '没有可显示的官方平台窗口，请检查平台登录页');
      return await callback(page, target);
    } finally {
      // connectOverCDP browser.close disconnects this temporary attachment. It
      // does not close the externally launched dedicated Chrome process.
      if (attached) {
        // A stalled CDP disconnect must not keep the global manual-control
        // lock busy forever after an otherwise completed lookup/screenshot.
        let timer;
        try {
          await Promise.race([
            attached.browser.close().catch(() => {}),
            new Promise(resolve => { timer = setTimeout(resolve, disconnectTimeoutMs); })
          ]);
        } finally { clearTimeout(timer); }
      }
    }
  }

  // Locate a persisted candidate in the server-owned platform browser. This
  // never accepts a URL or platform ID from the client: both are read from the
  // local resume record, and collection/manual browser control stay exclusive.
  router.post('/locate-candidate', async (req, res) => {
    try {
      fields(req.body, ['candidateId']);
      const id = req.body?.candidateId;
      if (typeof id !== 'string' || !/^resume_[A-Za-z0-9_\-]{8,100}$/.test(id))
        fail(400, '本机候选人编号无效');
      const candidate = resumeModel.getResumeById(id);
      if (!candidate || !['boss', 'zlzp', 'qcwy'].includes(candidate.source))
        fail(404, '未找到对应平台的候选人记录');
      const platform = {boss:'boss',zlzp:'zhilian',qcwy:'wuyou'}[candidate.source];
      if (pending || currentLock() || running(getTargets()[platform]))
        fail(409, '平台浏览器正在采集或由同事操作，请稍后再定位');
      pending = true;
      try {
        const target = getTargets()[platform];
      if (!await ownedAvailable(platform, target))
        fail(409, '请先在采集页面启动对应平台的服务器浏览器');
        let result;
        if (platform === 'boss') {
          const session = await require('../services/bossRawCdp').connectOwnedBossPage();
          try {
            result = platformLocator(candidate).id
              ? await locateBossCandidate(session, candidate)
              : await locateBossCandidateByFingerprint(session, candidate);
          }
          finally { session.close(); }
          if (result.recovered) {
            const existing = resumeModel.findDuplicateResume({source:'boss',
              sourceCandidateId:result.recordId});
            if (existing && existing.id !== candidate.id)
              fail(409,'该 BOSS 平台编号已属于其他候选人，未补录；请人工核对');
            const latest = resumeModel.getResumeById(candidate.id);
            if (!latest || (platformLocator(latest).id &&
                platformLocator(latest).id !== result.recordId))
              fail(409,'本机候选记录在定位期间已变化，未补录');
            if (!platformLocator(latest).id) resumeModel.updateCandidateMetadata(candidate.id, {
              sourceCandidateId: result.recordId, sourceCandidateIdSource:'platform_card'
            });
          }
        } else {
          const position = candidate.capturePositionId
            ? resumeModel.getPositionById(candidate.capturePositionId) : null;
          const searchTerms = [candidate.sourceSearchKeyword,
            ...String(position?.searchKeywords || '').split(/[,，、\n]/),
            candidate.captureJobTitle].map(value => String(value || '').trim())
            .filter((value, index, values) => value && values.indexOf(value) === index)
            .slice(0, 5);
          result = await withPage(platform, page => locateOfficialCandidate(page, candidate,
            { searchTerms }));
        }
        respond(res, result);
      } finally { pending = false; }
    } catch (error) {
      if (!error.publicStatus && error.code === 'BOSS_CDP_TARGET_UNAVAILABLE') {
        const state = /^(?:missing|ambiguous|hidden|obscured|out_of_view|frame_unavailable|invalid_selector|unknown)$/.test(error.targetState || '')
          ? error.targetState : 'unknown';
        error.publicStatus = 409;
        error.message = `BOSS 候选卡当前不可操作（${state}）；请在官方结果页加载该卡片后重试`;
      } else if (!error.publicStatus && Object.hasOwn(bossLocatorRecovery, error.code)) {
        error.publicStatus = 409;
        error.message = bossLocatorRecovery[error.code];
      } else if (!error.publicStatus && /^BOSS_[A-Z0-9_]+$/.test(error.code || '')) {
        // A stable, data-free code is actionable without disclosing browser
        // internals, resume details, cookies or the original exception text.
        error.publicStatus = 409;
        error.message = `BOSS 定位暂停（${error.code}）；请在官方页面确认状态后重试`;
      }
      errorResponse(res, error);
    }
  });

  router.get('/status', async (_req, res) => {
    try {
      const targets = getTargets();
      const active = currentLock();
      const platforms = await Promise.all(Object.entries(PLATFORMS).map(async ([id, metadata]) => ({
        id, label: metadata.label, available: await ownedAvailable(id, targets[id]),
        running: running(targets[id])
      })));
      respond(res, {
        enabled: true,
        platforms,
        lock: { held: Boolean(active), expiresAt: active?.expiresAt || null }
      });
    } catch (error) { errorResponse(res, error); }
  });

  router.post('/session', async (req, res) => {
    try {
      fields(req.body, ['platform', 'clientId']);
      const { platform, clientId } = req.body;
      identity(platform, clientId);
      if (pending) fail(409, '正在核对候选人，请稍后再获取浏览器操作权');
      if (currentLock() && lock.clientId !== clientId) fail(409, '其他同事正在操作服务器浏览器，请稍后重试');
      if (!await ownedAvailable(platform, getTargets()[platform]))
        fail(409, '请先在对应招聘平台页面启动浏览器');
      lock = { platform, clientId, expiresAt: now() + LOCK_MS };
      respond(res, { platform, expiresAt: lock.expiresAt });
    } catch (error) { errorResponse(res, error); }
  });

  router.post('/release', (req, res) => {
    try {
      fields(req.body, ['clientId']);
      if (typeof req.body.clientId !== 'string' || !CLIENT_ID.test(req.body.clientId)) fail(400, '操作会话无效');
      if (currentLock() && lock.clientId !== req.body.clientId) fail(409, '不能释放其他同事的操作权');
      lock = null;
      frames.clear();
      respond(res, { released: true });
    } catch (error) { errorResponse(res, error); }
  });

  router.post('/restore-window', async (req, res) => {
    try {
      fields(req.body, ['platform', 'clientId']);
      const { platform, clientId } = req.body;
      requireLock(platform, clientId);
      if (pending) fail(409, '浏览器正在处理其他操作，请稍后重试');
      if (running(getTargets()[platform])) fail(409, '平台正在采集，请先暂停后恢复窗口');
      pending = true;
      try {
        await withPage(platform, async (page, target) => {
          requireLock(platform, clientId);
          if (running(target)) fail(409, '平台正在采集，请先暂停后恢复窗口');
          const session = await page.context().newCDPSession(page);
          try {
            const { windowId } = await session.send('Browser.getWindowForTarget');
            await session.send('Browser.setWindowBounds', {
              windowId, bounds: { windowState: 'maximized' }
            });
            if (owns(platform, clientId)) lock.expiresAt = now() + LOCK_MS;
            respond(res, { restored: true });
          } finally { await session.detach().catch(() => {}); }
        });
      } finally { pending = false; }
    } catch (error) { errorResponse(res, error); }
  });

  router.get('/screenshot', async (req, res) => {
    try {
      fields(req.query, ['platform', 'clientId']);
      const { platform, clientId } = req.query;
      requireLock(platform, clientId);
      if (pending) fail(409, '画面正在刷新，请稍后重试');
      pending = true;
      try {
        await withPage(platform, async page => {
          const image = await page.screenshot({ type: 'png', fullPage: false, scale: 'css', timeout: 5000 });
          requireLock(platform, clientId);
          if (image.length < 24 || !image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
            fail(503, '平台未返回有效画面');
          }
          const width = image.readUInt32BE(16);
          const height = image.readUInt32BE(20);
          if (!width || !height || width > 8192 || height > 8192) fail(503, '平台画面尺寸不可用');
          frames.set(platform, { width, height, at: now(), url: page.url() });
          respond(res, { image: `data:image/png;base64,${image.toString('base64')}`, width, height });
        });
      } finally { pending = false; }
    } catch (error) { errorResponse(res, error); }
  });

  router.post('/action', async (req, res) => {
    try {
      const { platform, clientId, action } = req.body || {};
      requireLock(platform, clientId);
      const extras = { click: ['x', 'y'], type: ['text'], key: ['key'], scroll: ['deltaY', 'x', 'y'] };
      if (!Object.hasOwn(extras, action)) fail(400, '不支持的浏览器操作');
      fields(req.body, ['platform', 'clientId', 'action', ...extras[action]]);
      if (action === 'type' && (typeof req.body.text !== 'string' || !req.body.text.length ||
          req.body.text.length > 512 || /[\u0000-\u001f\u007f]/.test(req.body.text))) fail(400, '输入内容需为 1～512 个可见字符');
      if (action === 'key' && !KEYS.has(req.body.key)) fail(400, '不允许该快捷键');
      if (action === 'click' && (!Number.isFinite(req.body.x) || !Number.isFinite(req.body.y))) {
        fail(400, '点击位置无效');
      }
      if (action === 'scroll' && (!Number.isFinite(req.body.deltaY) || Math.abs(req.body.deltaY) > 800)) {
        fail(400, '滚动距离需在 -800～800 之间');
      }
      if (pending) fail(409, '画面正在刷新，请稍后重试');
      if (running(getTargets()[platform])) fail(409, '平台正在采集，请先停止采集再人工操作');
      pending = true;
      try {
        await withPage(platform, async (page, target) => {
          requireLock(platform, clientId);
          if (running(target) || running(getTargets()[platform])) fail(409, '平台正在采集，请先停止采集再人工操作');
          const frame = frames.get(platform);
          if (!frame || now() - frame.at > 15000 || frame.url !== page.url()) fail(409, '画面已变化，请刷新后再操作');
          const x = req.body.x ?? frame.width / 2;
          const y = req.body.y ?? frame.height / 2;
          if (['click', 'scroll'].includes(action) &&
              (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= frame.width || y >= frame.height)) {
            fail(400, '点击或滚动位置超出当前画面');
          }
          if (action === 'click') await page.mouse.click(x, y, { button: 'left', clickCount: 1 });
          if (action === 'type') await page.keyboard.insertText(req.body.text);
          if (action === 'key') await page.keyboard.press(req.body.key);
          if (action === 'scroll') { await page.mouse.move(x, y); await page.mouse.wheel(0, req.body.deltaY); }
          if (owns(platform, clientId)) lock.expiresAt = now() + LOCK_MS;
          respond(res, { performed: true });
        });
      } finally { pending = false; }
    } catch (error) { errorResponse(res, error); }
  });

  return router;
}

module.exports = { createBrowserConsoleRouter };
