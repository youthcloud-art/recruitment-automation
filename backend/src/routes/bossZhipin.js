const express = require('express');
const router = express.Router();
const BossZhipinService = require('../services/bossZhipinService');
const { BossRawRecommendCollector } = require('../services/bossRawRecommendCollector');
const { BossRawSearchCollector } = require('../services/bossRawSearchCollector');
const { BossCardQuarantine } = require('../services/bossCardQuarantine');
const { connectOwnedBossPage } = require('../services/bossRawCdp');
const { ensureOfficialSearchPage } = require('../services/bossOfficialSearchNavigation');
const { getCdpTabs } = require('../services/visibleChromeCdp');
const { ActiveJobService } = require('../services/activeJobService');
const logger = require('../utils/logger');

// 创建 Boss 直聘服务实例
let bossZhipinService = null;
let rawCollector = null;
let rawTask = null;
let rawStarting = false;
let rawRequestedMode = 'recommended';
let io = null;
let startupPromise = null;

function rawStatusToBrowsing(status, requestedMode = 'recommended', resumeInfo = null) {
  const state = status?.state || 'idle';
  const saved = status?.saved || 0;
  return {
    status: state === 'running' ? 'browsing' : state,
    isActive: state === 'running',
    mode: requestedMode,
    requestedMode,
    candidates: [],
    processedCount: saved,
    collectedCount: saved,
    likedCount: 0,
    dislikedCount: 0,
    currentIndex: status?.attempted || 0,
    attemptedCount: status?.attempted || 0,
    skippedCount: status?.skipped || 0,
    currentCardIndex: Number.isInteger(status?.currentCardIndex)
      ? status.currentCardIndex : -1,
    lastCardIndex: Number.isInteger(status?.lastCardIndex)
      ? status.lastCardIndex : -1,
    lastTargetState: status?.lastTargetState || '',
    lastTargetReason: status?.lastTargetReason || '',
    scrollRounds: status?.scrollRounds || 0,
    windowRestoreCount: status?.windowRestoreCount || 0,
    targetCount: status?.targetCount || 0,
    maxRuntimeMinutes: status?.maxRuntimeMinutes || 0,
    currentPhase: status?.phase || state,
    pausedAtPhase: status?.pausedAtPhase || '',
    pausedAtStage: status?.pausedAtStage || '',
    // Candidate-level skips are nonfatal warnings while the task continues.
    // Expose fatal fields only for a paused task so the UI does not report a
    // stale skip as a stopped collection after later successful saves.
    lastFailureCode: state === 'paused' ? status?.lastFailureCode || '' : '',
    lastError: state === 'paused' ? status?.lastError || '' : '',
    lastSkippedCode: state === 'paused' ? '' : status?.lastFailureCode || '',
    lastSkippedMessage: state === 'paused' ? '' : status?.lastError || '',
    completionReason: status?.completionReason || (state === 'completed' ? '已达到目标新增简历份数'
      : state === 'partial' ? `当前${requestedMode === 'search' ? '搜索结果' : '推荐列表'}没有更多可完整读取的新简历`
        : state === 'stopped' ? '用户已停止采集'
          : state === 'paused' ? status?.lastError || '平台页面需要人工确认' : ''),
    resumeAvailable: !!resumeInfo,
    filters: resumeInfo?.filters || null,
    evaluationQueue: status?.evaluationQueue || null
  };
}

async function inspectRawLogin() {
  let session;
  try {
    session = await connectOwnedBossPage();
    await session.assertRecruiterReady();
    return { isLoggedIn: true, status: 'idle' };
  } catch (error) {
    const tabs = await getCdpTabs({ profileName: 'boss', port: 19222 }).catch(() => []);
    const verification = tabs.some(tab => /captcha|\/verify(?:\.html)?(?:[/?#]|$)|\/security-check/i.test(tab.url || ''));
    const login = tabs.some(tab => /https:\/\/www\.zhipin\.com\/web\/user(?:[/?#]|$)/i.test(tab.url || ''));
    return { isLoggedIn: false, status: verification || error.code === 'BOSS_VERIFICATION_REQUIRED'
      ? 'verification_required' : error.code === 'BOSS_RATE_LIMITED'
        ? 'rate_limited' : login ? 'waiting_login' : 'page_unavailable' };
  } finally {
    if (session) {
      try { session.close(); } catch (_) { /* CDP detached. */ }
    }
  }
}

// 设置Socket.IO实例
router.setIO = function(socketIO) {
  io = socketIO;
};

/**
 * 启动 Boss 直聘智能寻聘
 */
router.post('/start', async (req, res) => {
  try {
    logger.info('收到启动 Boss 直聘智能寻聘请求');
    
    // Repeated clicks must reuse the same visible login window so a phone
    // verification already in progress is not lost.
    if (!startupPromise) {
      startupPromise = (async () => {
        if (!bossZhipinService) bossZhipinService = new BossZhipinService(io);
        await bossZhipinService.initializeFullProcess();
        const raw = await inspectRawLogin();
        bossZhipinService.isLoggedIn = raw.isLoggedIn;
        bossZhipinService.currentStatus = raw.status;
        return bossZhipinService.getCurrentStatus();
      })().finally(() => { startupPromise = null; });
    }
    const status = await startupPromise;
    
    res.json({
      success: true,
      message: status.isLoggedIn ? 'Boss 直聘招聘端已登录' : 'Boss 直聘登录页已打开，请在浏览器中完成登录',
      data: {
        status: status.status,
        nextStep: status.isLoggedIn ? 'ready' : 'waiting_for_login'
      }
    });
    
  } catch (error) {
    logger.error('启动 Boss 直聘智能寻聘失败:', error);
    res.status(500).json({
      success: false,
      message: '启动失败: ' + error.message,
      error: error.message
    });
  }
});

/**
 * 获取当前状态
 */
router.get('/status', async (req, res) => {
  try {
    if (!bossZhipinService) {
      return res.json({
        success: true,
        data: {
          status: 'not_initialized',
          isLoggedIn: false,
          hasBrowser: false,
          hasPage: false
        }
      });
    }
    
    const status = bossZhipinService.getCurrentStatus();
    
    res.json({
      success: true,
      data: status
    });
    
  } catch (error) {
    logger.error('获取 Boss 直聘状态失败:', error);
    res.status(500).json({
      success: false,
      message: '获取状态失败: ' + error.message,
      error: error.message
    });
  }
});

/**
 * 检查登录状态
 */
router.post('/check-login', async (req, res) => {
  try {
    if (!bossZhipinService) {
      return res.status(400).json({
        success: false,
        message: 'Boss 直聘服务未初始化'
      });
    }
    // A collection already owns this Chrome tab. A parallel login probe adds
    // a second CDP connection and can overwrite the visible browsing state.
    // The collector itself checks login/verification at every guarded step.
    if (rawStarting || rawTask || rawCollector?.getStatus().state === 'running') {
      return res.json({success:true,data:{
        isLoggedIn:Boolean(bossZhipinService.isLoggedIn),
        status:rawStarting && !rawTask ? 'starting' : 'browsing',
        hasBrowser:true,hasPage:true
      }});
    }
    
    // A single-page raw CDP probe does not initialize all Playwright frames.
    // It preserves the visible recruiter tab and never requests SMS itself.
    const raw = await inspectRawLogin();
    bossZhipinService.isLoggedIn = raw.isLoggedIn;
    bossZhipinService.currentStatus = raw.status;
    const currentStatus = bossZhipinService.getCurrentStatus();
    
    res.json({
      success: true,
      data: {
        isLoggedIn: raw.isLoggedIn,
        status: currentStatus.status,
        hasBrowser: currentStatus.hasBrowser,
        hasPage: currentStatus.hasPage
      }
    });
    
  } catch (error) {
    logger.error('检查登录状态失败:', error);
    res.status(500).json({
      success: false,
      message: '检查登录状态失败: ' + error.message,
      error: error.message
    });
  }
});

/**
 * 等待用户登录
 */
router.post('/wait-login', async (req, res) => {
  try {
    if (!bossZhipinService) {
      return res.status(400).json({
        success: false,
        message: 'Boss 直聘服务未初始化'
      });
    }
    
    res.json({
      success: true,
      message: '请在 Chrome 窗口完成扫码或短信登录，完成后点击“检查登录状态”',
      data: {
        status: 'waiting_for_login'
      }
    });
    
  } catch (error) {
    logger.error('等待用户登录失败:', error);
    res.status(500).json({
      success: false,
      message: '等待用户登录失败: ' + error.message,
      error: error.message
    });
  }
});

/**
 * 停止服务
 */
router.post('/stop', async (req, res) => {
  try {
    if (rawStarting) return res.status(409).json({success:false,
      message:'BOSS 采集正在启动，请稍后再停止服务'});
    rawCollector?.stop();
    if (bossZhipinService) {
      await bossZhipinService.closeBrowser();
      bossZhipinService = null;
      
      res.json({
        success: true,
        message: 'Boss 直聘智能寻聘已停止'
      });
    } else {
      res.json({
        success: true,
        message: 'Boss 直聘智能寻聘未运行'
      });
    }
    
  } catch (error) {
    logger.error('停止 Boss 直聘智能寻聘失败:', error);
    res.status(500).json({
      success: false,
      message: '停止失败: ' + error.message,
      error: error.message
    });
  }
});

// Legacy debug steps navigated/reloaded the user's BOSS tab. Keep the endpoint
// fail-closed so old clients cannot bypass the explicit login-check workflow.
router.post('/execute-step', (_req, res) => res.status(410).json({
  success: false,
  message: '旧版单步浏览器操作已停用；请使用启动、人工登录确认和采集入口'
}));

/**
 * 启动候选人浏览
 */
router.post('/start-browsing', async (req, res) => {
  try {
    if (!bossZhipinService) {
      return res.status(400).json({
        success: false,
        message: 'Boss 直聘服务未初始化'
      });
    }
    if (rawStarting || rawTask || rawCollector?.getStatus().state === 'running') {
      return res.status(409).json({success:false,message:'BOSS 简历采集已在进行'});
    }
    // Reserve the only recruiter tab before the asynchronous login probe. Two
    // rapid start requests must never create independent CDP collectors.
    rawStarting = true;
    try {
    const rawLogin = await inspectRawLogin();
    bossZhipinService.isLoggedIn = rawLogin.isLoggedIn;
    bossZhipinService.currentStatus = rawLogin.status;
    if (!rawLogin.isLoggedIn) {
      return res.status(409).json({
        success: false,
        message: rawLogin.status === 'verification_required'
          ? 'BOSS 页面需要人工安全验证，请在已打开的 Chrome 中处理后再试'
          : '请先在 BOSS 直聘窗口完成登录，再点击“检查登录状态”'
      });
    }
    const { mode, filters, targetCount, resume, maxRuntimeMinutes } = req.body;
    if (!['recommended','search'].includes(mode)) {
      return res.status(422).json({success:false,
        message:'当前 BOSS 原生采集仅支持在招岗位推荐和官方搜索页'});
    }
    if (mode !== 'search' && maxRuntimeMinutes != null) {
      return res.status(422).json({success:false,
        message:'自定义最长运行时间仅适用于 BOSS 官方搜索；在招岗位推荐最长 90 分钟'});
    }
    const runtimeMinutes=mode === 'search'
      ? maxRuntimeMinutes == null ? 90 : Number(maxRuntimeMinutes) : 90;
    if (!Number.isInteger(runtimeMinutes) || runtimeMinutes < 1 ||
        runtimeMinutes > (mode === 'search' ? 180 : 90)) {
      return res.status(422).json({success:false,
        message:'BOSS 官方搜索最长运行时间须为 1～180 分钟'});
    }
    const job = new ActiveJobService().current();
    if (!job?.title || !job.jobRequirements) {
      return res.status(422).json({success:false,message:'请先保存岗位条件再开始采集'});
    }
    if (mode === 'search') {
      const keyword = String(filters?.position || filters?.keywords || '').trim();
      if (keyword !== job.title) {
        return res.status(422).json({success:false,
          message:'BOSS 搜索页当前只接受与已保存岗位名称完全一致的单个关键词'});
      }
      const unsupported=Object.entries(filters || {}).filter(([key,value])=>
        !['position','keywords'].includes(key) && value != null &&
        value !== '' && value !== '不限' && value !== false);
      if (unsupported.length) return res.status(422).json({success:false,
        message:`BOSS 搜索页的 ${unsupported.map(([key])=>key).join('、')} 筛选尚未验证；`+
          '请先在平台页面人工确认，或仅用岗位关键词采集后按岗位要求评估'});
    }
    const count = Number(targetCount);
    if (!Number.isInteger(count) || count < 1 || count > 500) {
      return res.status(422).json({success:false,message:'目标简历份数需为 1～500'});
    }
    if (resume === true) {
      if (mode !== 'search' || rawRequestedMode !== 'search' ||
          !rawCollector?.canResume?.()) return res.status(422).json({success:false,
        message:'当前 BOSS 采集没有可安全续接的人工验证断点，请新建任务'});
      try {
        rawCollector.validateResumeRequest({job,targetCount:count,
          runtimeLimitMs:runtimeMinutes*60_000});
      } catch (error) {
        return res.status(422).json({success:false,message:error.message});
      }
    } else {
      if (mode === 'search') await ensureOfficialSearchPage();
      rawCollector = mode === 'search'
        ? new BossRawSearchCollector() : new BossRawRecommendCollector();
    }
    rawRequestedMode = mode;
    const service = bossZhipinService;
    // Both paths verify their own official iframe before candidate actions.
    // Search checks the exact current keyword and official resume link;
    // recommendation checks the exact posted job and iframe jobid.
    const task = rawCollector.collect({targetCount:count,
      maxRuntimeMs:runtimeMinutes*60_000,resume:resume===true});
    rawTask = task;
    task.then(result => {
      if (['BOSS_LOGIN_REQUIRED','BOSS_VERIFICATION_REQUIRED','BOSS_RATE_LIMITED']
        .includes(result.lastFailureCode)) service.isLoggedIn = false;
      service.currentStatus = result.state !== 'paused' ? 'idle'
        : result.lastFailureCode === 'BOSS_VERIFICATION_REQUIRED'
          ? 'verification_required'
          : result.lastFailureCode === 'BOSS_RATE_LIMITED'
            ? 'rate_limited'
            : result.lastFailureCode === 'BOSS_LOGIN_REQUIRED'
              ? 'waiting_login' : 'page_unavailable';
    }, error => {
      logger.error(`BOSS 原生采集任务失败: ${error.message}`);
      service.currentStatus = 'error';
    }).finally(() => { if (rawTask === task) rawTask = null; });
    bossZhipinService.currentStatus = 'browsing';
    
    res.json({
      success: true,
      message: resume === true
        ? '正在核验人工验证后的原岗位和完整候选列表；一致后继续采集'
        : mode === 'search'
        ? '已从 BOSS 官方搜索结果开始采集；平台细分筛选未应用，入库后按岗位要求评估'
        : '已开始按当前在招岗位采集推荐候选人',
      data: {
        mode,
        requestedMode: mode,
        filters,
        targetCount: count,
        maxRuntimeMinutes: runtimeMinutes,
        status: 'browsing'
      }
    });
    } finally {
      rawStarting = false;
    }
    
  } catch (error) {
    logger.error('启动候选人浏览失败:', error);
    const needsBrowserAction = ['BOSS_SEARCH_PAGE_REQUIRED',
      'BOSS_SEARCH_PAGE_UNAVAILABLE', 'BOSS_VERIFICATION_REQUIRED',
      'BOSS_CDP_WINDOW_MINIMIZED', 'BOSS_CDP_VIEWPORT_TOO_SMALL'].includes(error.code);
    res.status(needsBrowserAction ? 409 : 500).json({
      success: false,
      message: '启动候选人浏览失败: ' + error.message,
      error: error.message
    });
  }
});

/**
 * 停止候选人浏览
 */
router.post('/stop-browsing', async (req, res) => {
  try {
    if (rawStarting) return res.status(409).json({success:false,
      message:'BOSS 采集正在启动，请稍后再停止'});
    if (rawCollector) {
      rawCollector.stop();
      return res.json({success:true,message:'已请求停止 BOSS 采集，当前简历处理完成后停止'});
    }
    if (!bossZhipinService) {
      return res.status(400).json({
        success: false,
        message: 'Boss 直聘服务未初始化'
      });
    }
    
    await bossZhipinService.stopBrowsing();
    
    res.json({
      success: true,
      message: '候选人浏览已停止'
    });
    
  } catch (error) {
    logger.error('停止候选人浏览失败:', error);
    res.status(500).json({
      success: false,
      message: '停止候选人浏览失败: ' + error.message,
      error: error.message
    });
  }
});

/**
 * 重置候选人浏览状态
 */
router.post('/reset-browsing', async (req, res) => {
  try {
    if (rawStarting) return res.status(409).json({success:false,
      message:'BOSS 采集正在启动，请稍后再重置状态'});
    if (rawCollector) {
      if (rawTask) return res.status(409).json({success:false,
        message:'BOSS 简历采集尚未结束，请先停止'});
      rawCollector = null;
      rawRequestedMode = 'recommended';
      return res.json({success:true,message:'BOSS 采集状态已重置'});
    }
    if (!bossZhipinService) {
      return res.status(400).json({
        success: false,
        message: 'Boss 直聘服务未初始化'
      });
    }
    
    await bossZhipinService.resetBrowsingStatus();
    
    res.json({
      success: true,
      message: '候选人浏览状态已重置'
    });
    
  } catch (error) {
    logger.error('重置候选人浏览状态失败:', error);
    res.status(500).json({
      success: false,
      message: '重置候选人浏览状态失败: ' + error.message,
      error: error.message
    });
  }
});

router.get('/card-quarantine', (req,res) => {
  try { return res.json({success:true,data:new BossCardQuarantine().summary()}); }
  catch (_) { return res.status(500).json({success:false,
    message:'BOSS 暂缓候选卡记录无法读取，请检查本地数据目录'}); }
});

router.post('/reset-card-quarantine', (req,res) => {
  if (rawStarting || rawTask || rawCollector?.getStatus().state === 'running') {
    return res.status(409).json({success:false,message:'请先停止当前 BOSS 采集'});
  }
  try {
    const cleared=new BossCardQuarantine().clear();
    return res.json({success:true,data:{cleared},
      message:`已手动解除 ${cleared} 条 BOSS 候选卡暂缓记录`});
  } catch (_) {
    return res.status(500).json({success:false,
      message:'BOSS 暂缓候选卡记录无法清除，请检查本地数据目录'});
  }
});

/**
 * 获取候选人浏览状态
 */
router.get('/browsing-status', async (req, res) => {
  try {
    if (rawCollector) return res.json({success:true,
      data:rawStatusToBrowsing(rawCollector.getStatus(),rawRequestedMode,
        rawCollector.getResumeInfo?.())});
    if (!bossZhipinService) {
      return res.json({
        success: true,
        data: {
          status: 'not_initialized',
          candidates: [],
          processedCount: 0,
          likedCount: 0,
          dislikedCount: 0,
          currentIndex: 0,
          isActive: false
        }
      });
    }
    
    // 获取实际的浏览状态数据
    const browsingStatus = bossZhipinService.getBrowsingStatus();
    
    res.json({
      success: true,
      data: browsingStatus
    });
    
  } catch (error) {
    logger.error('获取候选人浏览状态失败:', error);
    res.status(500).json({
      success: false,
      message: '获取候选人浏览状态失败: ' + error.message,
      error: error.message
    });
  }
});

/**
 * 处理候选人操作
 */
router.post('/candidate-action', (_req, res) => res.status(501).json({
  success: false,
  message: 'BOSS 候选人收藏或跳过操作尚未接入平台，未执行任何操作'
}));

// The former BOSS resume-processing and navigation routes used the legacy
// Playwright attachment, which could reload the recruiter's active tab and
// report a misleading zero-resume success. The raw-CDP collector owns BOSS
// capture through /start-browsing and /browsing-status only.
const retiredBossFlow = message => (_req, res) => res.status(410).json({
  success: false,
  code: 'BOSS_LEGACY_FLOW_DISABLED',
  message
});
router.post('/start-resume-processing', retiredBossFlow(
  '旧版 BOSS 简历处理已停用；请在候选人采集页面启动官方推荐简历采集'));
router.post('/stop-resume-processing', retiredBossFlow(
  '旧版 BOSS 简历处理已停用；请使用停止采集入口'));
router.get('/resume-processing-status', retiredBossFlow(
  '旧版 BOSS 简历处理状态已停用；请查看候选人采集进度'));
router.post('/process-resume', retiredBossFlow(
  '旧版 BOSS 单份简历操作已停用；请查看已入库候选人'));
router.post('/navigate-to-communication', retiredBossFlow(
  '旧版 BOSS 页面导航已停用；请在招聘平台窗口自行操作'));
router.post('/navigate-to-mode', retiredBossFlow(
  '旧版 BOSS 页面导航已停用；请使用候选人采集入口'));

router.getBrowserConsoleTarget = () => ({
  service: bossZhipinService,
  running: Boolean(rawStarting || rawTask || rawCollector?.getStatus().state === 'running')
});

module.exports = router;
