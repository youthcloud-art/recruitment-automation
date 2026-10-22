const logger = require('../utils/logger');
const CanvasOcrService = require('./canvasOcrService');
const DragSelectionService = require('./dragSelectionService');
const crypto = require('crypto');
const resumeModel = require('../models/resumeModel');
const resumeParserService = require('./resumeParserService');
const { openVisibleChromeCdp, attachExistingVisibleChromeCdp, getCdpTabs } = require('./visibleChromeCdp');
const { ActiveJobService } = require('./activeJobService');
const { postCaptureEvaluationQueue } = require('./postCaptureEvaluationQueue');
const { BossCollectionCheckpoint, taskSignature } = require('./bossCollectionCheckpoint');
const { assessBossResumeText, isTrustedBossResumeSource } = require('./bossResumeQuality');

const SEARCH_CARD_SELECTORS = [
  'li.geek-info-card', 'li.card-item', 'div.card-container',
  '.candidate-card-wrap', '[class*="candidate-card"]'
];
const SEARCH_INPUT_SELECTOR = 'input.search-input, input[placeholder*="搜索"], input[placeholder*="关键词"]';
const MAX_SEARCH_SCROLL_ROUNDS = 60;
const MAX_STALLED_SCROLL_ROUNDS = 3;
const MAX_NO_SAVE_SCROLL_ROUNDS = 12;
const MAX_SEARCH_RUNTIME_MS = 90 * 60 * 1000;
// Includes opening the card, locating its official resume frame, copy and OCR.
// On expiry we detach CDP to cancel pending Playwright calls; Chrome remains open.
const CANDIDATE_EXTRACTION_TIMEOUT_MS = 2 * 60 * 1000;
const BOSS_LOGIN_URL = 'https://www.zhipin.com/web/user/?ka=header-login';
const RECRUITER_URL = /^https:\/\/www\.zhipin\.com\/web\/(boss|chat)(?:\/|\?|$)/i;
const VERIFICATION_URL = /captcha|\/verify(?:\.html)?(?:\/|\?|$)|\/security-check/i;
const RECRUITER_MENU = 'a[ka="menu-geek-search"], a[href="/web/chat/job/list"], '
  + 'dl.menu-geeksearch';

async function boundedRead(promise, timeoutMs = 1500) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function resumeFingerprint(content) {
  return crypto.createHash('sha256')
    .update(String(content || '').normalize('NFKC').replace(/\s+/g, ' ').trim())
    .digest('hex');
}

class BossZhipinService {
  constructor(io = null) {
    this.browser = null;
    this.page = null;
    this.cdpPort = 19222;
    this.chromeWindowOpened = false;
    this.chromeTabUrl = null;
    this.attachSuspended = false;
    this.shutdownRequested = false;
    this.isLoggedIn = false;
    this.currentStatus = 'idle'; // idle, navigating, logging_in, browsing
    this.popupHandler = null;
    this.io = io; // Socket.IO实例，用于发送页面切换保护消息
    
    // 候选人浏览状态跟踪
    this.browsingStatus = {
      isActive: false,
      mode: null, // 'recommended', 'search', 'communication'
      candidates: [],
      processedCount: 0,
      likedCount: 0,
      dislikedCount: 0,
      currentIndex: 0,
      filters: {},
      startTime: null
    };
    
    // 简历处理状态跟踪
    this.resumeProcessingStatus = {
      isActive: false,
      resumes: [],
      processingCount: 0,
      completedCount: 0,
      failedCount: 0,
      currentIndex: 0,
      settings: {},
      startTime: null,
      currentStatus: 'idle' // 'idle', 'collecting', 'quality_checking', 'parsing', 'storing', 'completed'
    };
    
    // 页面切换调度器
    this.pageSwitchTimeout = null;
    
    // Canvas截图和OCR服务
    this.canvasOcrService = new CanvasOcrService();
    
    // 拖拽选区复制服务
    this.dragSelectionService = new DragSelectionService();
    this.canvasCopyTimeoutMs = { hook: 30000, drag: 15000 };
    this.candidateExtractionTimeoutMs = CANDIDATE_EXTRACTION_TIMEOUT_MS;
    this.activeCandidateAttempt = null;
    this.collectionCheckpoint = new BossCollectionCheckpoint();
    this.collectionSignature = null;
    this.browsingTaskPromise = null;
  }

  saveCollectionProgress(state = 'running') {
    if (!this.collectionSignature) return null;
    return this.collectionCheckpoint.save({
      signature: this.collectionSignature,
      state,
      mode: this.browsingStatus.mode,
      filters: this.browsingStatus.filters,
      targetCount: this.browsingStatus.targetCount,
      processedCount: this.browsingStatus.processedCount,
      nextKeywordIndex: this.browsingStatus.nextKeywordIndex || 0,
      keywordsCompleted: this.browsingStatus.keywordsCompleted || 0,
      currentKeyword: this.browsingStatus.currentKeyword || '',
      keywordErrors: (this.browsingStatus.keywordErrors || []).slice(-20),
      stalledKeywords: (this.browsingStatus.stalledKeywords || []).slice(-20),
      completionReason: this.browsingStatus.completionReason || '',
      lastError: this.browsingStatus.lastError || ''
    });
  }

  async readVisibleTabs() {
    return getCdpTabs({ profileName: 'boss', port: this.cdpPort });
  }

  setCandidatePhase(phase, attempt = this.activeCandidateAttempt) {
    if (attempt && attempt !== this.activeCandidateAttempt) return;
    this.browsingStatus.currentPhase = phase;
    this.browsingStatus.phaseStartedAt = new Date().toISOString();
  }

  beginCandidateAttempt(index) {
    const attempt = {
      controller: new AbortController(),
      expired: false,
      cancelled: false,
      timer: null
    };
    this.activeCandidateAttempt = attempt;
    this.browsingStatus.currentIndex = index;
    this.browsingStatus.attemptedCount = (this.browsingStatus.attemptedCount || 0) + 1;
    this.browsingStatus.candidateStartedAt = new Date().toISOString();
    this.browsingStatus.candidateDeadlineAt = new Date(
      Date.now() + this.candidateExtractionTimeoutMs).toISOString();
    this.setCandidatePhase('opening_candidate', attempt);
    attempt.timer = setTimeout(() => {
      if (this.activeCandidateAttempt !== attempt || !this.browsingStatus.isActive) return;
      attempt.expired = true;
      attempt.controller.abort();
      this.browsingStatus.isActive = false;
      this.browsingStatus.lastError = 'BOSS 单份简历提取超时，已暂停采集并保留浏览器窗口';
      this.browsingStatus.completionReason = this.browsingStatus.lastError;
      this.browsingStatus.lastFailureCode = 'BOSS_CANDIDATE_TIMEOUT';
      this.setCandidatePhase('candidate_timeout', attempt);
      this.saveCollectionProgress('paused');
      void this.canvasOcrService.destroy().catch(error =>
        logger.warn(`BOSS 超时后停止 OCR 失败: ${error.message}`));
      // Do not race an uncancellable extraction promise: disconnect the CDP
      // transport so its outstanding browser command rejects. Never close the
      // user's visible Chrome process or start another candidate in parallel.
      void this.detachAutomation({ status: 'candidate_timeout', suspend: true })
        .catch(error => logger.warn(`BOSS 超时后断开自动化连接失败: ${error.message}`));
    }, this.candidateExtractionTimeoutMs);
    return attempt;
  }

  assertCandidateActive() {
    const attempt = this.activeCandidateAttempt;
    if (!attempt || (!attempt.expired && !attempt.cancelled)) return;
    const error = new Error(attempt.expired
      ? 'BOSS 单份简历提取超时，已暂停采集'
      : 'BOSS 简历提取已取消');
    error.code = attempt.expired ? 'BOSS_CANDIDATE_TIMEOUT' : 'BOSS_CANDIDATE_CANCELLED';
    throw error;
  }

  finishCandidateAttempt(attempt) {
    clearTimeout(attempt?.timer);
    if (this.activeCandidateAttempt !== attempt) return;
    this.activeCandidateAttempt = null;
    if (!attempt.expired) {
      this.browsingStatus.currentPhase = this.browsingStatus.isActive ? 'searching' : 'idle';
      this.browsingStatus.phaseStartedAt = new Date().toISOString();
    }
    this.browsingStatus.candidateDeadlineAt = null;
  }

  /**
   * 执行候选人浏览任务 - 按照文档规范流程
   */
  /**
   * 执行候选人浏览任务
   * @param {string} mode - 浏览模式：'recommended'、'search'、'communication'
   * @param {object} filters - 搜索筛选条件（仅在search模式下使用）
   * @param {number} targetCount - 目标浏览候选人数量
   */
  async executeBrowsingTask(mode, filters, targetCount = 3) {
    try {
      if (this.shutdownRequested || this.attachSuspended) {
        this.browsingStatus.isActive = false;
        return;
      }
      logger.info(`开始执行候选人浏览任务，模式: ${mode}`);
      
      // 检查浏览器状态
      if (!this.browser || !this.page) {
        // Login checks disconnect CDP. Collection may only attach to the
        // existing recruiter tab, never open another login/home page.
        const tabs = await this.readVisibleTabs().catch(() => []);
        if (this.shutdownRequested) {
          this.browsingStatus.isActive = false;
          return;
        }
        const recruiterTab = tabs.find(tab => RECRUITER_URL.test(tab.url));
        if (!recruiterTab) {
          this.currentStatus = tabs.some(tab => VERIFICATION_URL.test(tab.url))
            ? 'verification_required' : tabs.length ? 'waiting_login' : 'disconnected';
          this.isLoggedIn = false;
          this.browsingStatus.isActive = false;
          this.saveCollectionProgress('paused');
          return;
        }
        await this.initializeBrowser();
        if (this.shutdownRequested) {
          await this.suspendAutomation('disconnected');
          return;
        }
      }
      
      // 检查登录状态
      const isLoggedIn = await this.checkLoginStatus({ allowAttach: true, keepAttached: true });
      if (!isLoggedIn) {
        logger.warn('用户尚未登录，无法执行浏览任务');
        this.browsingStatus.isActive = false;
        if (!['verification_required', 'rate_limited', 'page_unavailable', 'unstable_page', 'disconnected']
          .includes(this.currentStatus)) this.currentStatus = 'waiting_login';
        this.browsingStatus.lastError = 'BOSS 登录状态尚未确认，已保留任务进度';
        this.saveCollectionProgress('paused');
        return;
      }
      this.currentStatus = 'browsing';
      
      if (mode === 'recommended') {
        // 推荐牛人流程：直接在当前页面查找并点击"推荐牛人"按钮
        await this.browseRecommendedCandidates(targetCount);
      } else if (mode === 'search') {
        // 搜索牛人流程：直接在当前页面点击"搜索牛人"按钮，不需要额外导航
        const keywords = String(filters.position || filters.keywords || '').split(/[,，、\n]/)
          .map(value => value.trim()).filter(Boolean).slice(0, 20);
        if (!keywords.length) keywords.push('');
        for (let index = this.browsingStatus.nextKeywordIndex || 0;
          index < keywords.length && this.browsingStatus.isActive; index++) {
          const keyword = keywords[index];
          this.browsingStatus.currentKeyword = keyword;
          this.browsingStatus.nextKeywordIndex = index;
          this.saveCollectionProgress();
          const remaining = targetCount - this.browsingStatus.processedCount;
          if (remaining <= 0) break;
          try {
            // 每个关键词都可补足剩余目标，避免后续关键词无结果时提前少采。
            await this.searchCandidates({ ...filters, position: keyword, keywords: keyword }, remaining);
            this.browsingStatus.keywordsCompleted++;
            if (this.browsingStatus.timeLimitReached) break;
            this.browsingStatus.nextKeywordIndex = index + 1;
            this.saveCollectionProgress();
          } catch (error) {
            this.browsingStatus.keywordErrors.push(`${keyword}: ${error.message}`);
            this.browsingStatus.lastError = `${keyword || '默认关键词'}搜索失败: ${error.message}`;
            logger.warn(`关键词 ${keyword} 搜索失败: ${error.message}`);
            if (error.code && error.code.startsWith('BOSS_')) throw error;
            // A broken page or selector must not be reported as a successful
            // keyword. Continue with other terms, but keep the failure visible.
            this.browsingStatus.nextKeywordIndex = index + 1;
            this.saveCollectionProgress();
          }
        }
      } else if (mode === 'communication') {
        // 沟通版块浏览：直接在当前页面查找并点击"沟通"按钮
        await this.browseCommunicationCandidates(targetCount);
      }
      
      // 浏览完成
      const stoppedByUser = this.browsingStatus.completionReason === '用户已停止采集';
      const candidateTimedOut = this.currentStatus === 'candidate_timeout' ||
        this.browsingStatus.lastFailureCode === 'BOSS_CANDIDATE_TIMEOUT';
      this.browsingStatus.isActive = false;
      if (!this.browsingStatus.completionReason) {
        this.browsingStatus.completionReason = this.browsingStatus.processedCount >= targetCount
          ? '已达到目标新增简历份数'
          : this.browsingStatus.keywordErrors?.length
            ? '部分搜索失败，已保留错误；可调整页面后重新采集'
            : this.browsingStatus.stalledKeywords?.length
              ? '部分关键词连续滚动无新增简历，已停止该关键词；可调整关键词后继续'
              : '没有更多可访问的新候选人，可调整关键词后继续';
      }
      this.saveCollectionProgress(this.browsingStatus.timeLimitReached || stoppedByUser || candidateTimedOut
        ? 'paused' : 'completed');
      if (!['waiting_login', 'verification_required', 'rate_limited',
        'unstable_page', 'disconnected', 'candidate_timeout'].includes(this.currentStatus)) {
        this.currentStatus = 'idle';
      }
      logger.info('候选人浏览任务完成');
      
    } catch (error) {
      if (error.code === 'BOSS_CANDIDATE_CANCELLED' &&
          this.browsingStatus.completionReason === '用户已停止采集') {
        this.browsingStatus.isActive = false;
        this.saveCollectionProgress('paused');
        return;
      }
      logger.error('候选人浏览任务失败:', error);
      this.browsingStatus.isActive = false;
      this.browsingStatus.lastError = error.message;
      this.saveCollectionProgress('paused');
      if (!['waiting_login', 'verification_required', 'rate_limited',
        'unstable_page', 'disconnected', 'page_unavailable',
        'candidate_timeout'].includes(this.currentStatus)) {
        this.currentStatus = 'error';
      }
      throw error;
    } finally {
      if (this.browser) {
        const status = this.currentStatus;
        await this.detachAutomation({
          status,
          keepLogin: status === 'idle' && this.isLoggedIn,
          suspend: status !== 'idle'
        });
      }
    }
  }

  /** 初始化可见浏览器；登录与安全验证由用户在浏览器中完成。 */
  async initializeBrowser() {
    try {
      if (this.shutdownRequested || this.attachSuspended) {
        throw new Error('BOSS 自动化连接已暂停，需人工确认后重新启动');
      }
      if (this.browser && this.page && !this.page.isClosed() && this.browser.isConnected()) return true;
      logger.info('正在连接本应用专用的 Boss 直聘 Chrome 窗口...');
      const session = await attachExistingVisibleChromeCdp({
        profileName: 'boss', port: this.cdpPort
      });
      if (this.shutdownRequested || this.attachSuspended) {
        await session.browser.close().catch(() => {});
        throw new Error('BOSS 自动化连接已停止');
      }
      // A successful login can open the recruiter UI in a second tab. Never
      // create a new tab or navigate back to the login page from this path.
      const recruiterPage = session.context.pages().find(page => !page.isClosed() &&
        RECRUITER_URL.test(page.url()));
      if (!recruiterPage) {
        await session.browser.close().catch(() => {});
        throw new Error('BOSS 招聘页面未打开，已断开自动化连接');
      }
      this.browser = session.browser;
      this.page = recruiterPage;
      this.chromeWindowOpened = true;
      this.chromeTabUrl = this.page.url().split(/[?#]/)[0];
      logger.info('已连接 Boss 直聘 Chrome 窗口');
      return true;
    } catch (error) {
      logger.error('启动 Boss 直聘自动化浏览器失败:', error);
      this.attachSuspended = true;
      this.isLoggedIn = false;
      this.currentStatus = 'disconnected';
      this.browsingStatus.isActive = false;
      throw error;
    }
  }

  /**
   * 设置弹窗处理 - 已禁用
   */
  async setupPopupHandling() {
    // 弹窗处理功能已被禁用
    logger.info('弹窗处理功能已被禁用');
    return;
    
    /* 已禁用的弹窗处理代码
    try {
      // 监听页面弹窗事件
      this.page.on('dialog', async (dialog) => {
        logger.info(`检测到弹窗: ${dialog.type()} - ${dialog.message()}`);
        await dialog.dismiss(); // 自动关闭弹窗
      });

      // 监听新页面打开事件
      this.page.on('popup', async (popup) => {
        logger.info('检测到新页面弹窗，正在关闭...');
        await popup.close();
      });

      // 监听页面跳转事件
      this.page.on('framenavigated', async (frame) => {
        if (frame === this.page.mainFrame()) {
          logger.info('页面发生跳转，重新设置弹窗处理...');
          await this.setupPopupHandling();
        }
      });

      logger.info('弹窗处理设置完成');
    } catch (error) {
      logger.error('设置弹窗处理失败:', error);
    }
    */
  }

  /**
   * 智能关闭弹窗 - 已禁用
   */
  async closePopups() {
    // 弹窗处理功能已被禁用
    logger.info('弹窗处理功能已被禁用');
    return false;
    
    /* 已禁用的弹窗处理代码
    try {
      if (!this.page) {
        return false;
      }

      logger.info('正在检查并关闭弹窗...');
      let popupCount = 0;

      // 1. 关闭常见的模态弹窗
      const modalSelectors = [
        '[class*="modal"]',
        '[class*="popup"]',
        '[class*="dialog"]',
        '[class*="overlay"]',
        '[class*="mask"]',
        '.ant-modal',
        '.ant-popover',
        '.ant-tooltip',
        '.el-dialog',
        '.el-popover',
        '.el-tooltip'
      ];

      for (const selector of modalSelectors) {
        try {
          const modals = await this.page.locator(selector).all();
          for (const modal of modals) {
            const isVisible = await modal.isVisible();
            if (isVisible) {
              // 尝试点击关闭按钮
              const closeButtons = await modal.locator('[class*="close"], [class*="cancel"], .close, .cancel, .ant-modal-close, .el-dialog__close').all();
              if (closeButtons.length > 0) {
                await closeButtons[0].click();
                popupCount++;
                logger.info(`关闭弹窗: ${selector}`);
              }
            }
          }
        } catch (error) {
          // 忽略单个选择器的错误
        }
      }

      // 2. 关闭通知提示
      const notificationSelectors = [
        '[class*="notification"]',
        '[class*="message"]',
        '[class*="toast"]',
        '.ant-notification',
        '.ant-message',
        '.el-notification',
        '.el-message'
      ];

      for (const selector of notificationSelectors) {
        try {
          const notifications = await this.page.locator(selector).all();
          for (const notification of notifications) {
            const isVisible = await notification.isVisible();
            if (isVisible) {
              await notification.click();
              popupCount++;
              logger.info(`关闭通知: ${selector}`);
            }
          }
        } catch (error) {
          // 忽略单个选择器的错误
        }
      }

      // 3. 关闭广告弹窗
      const adSelectors = [
        '[class*="ad"]',
        '[class*="banner"]',
        '[class*="promotion"]',
        '.ad-close',
        '.banner-close',
        '.promotion-close'
      ];

      for (const selector of adSelectors) {
        try {
          const ads = await this.page.locator(selector).all();
          for (const ad of ads) {
            const isVisible = await ad.isVisible();
            if (isVisible) {
              await ad.click();
              popupCount++;
              logger.info(`关闭广告: ${selector}`);
            }
          }
        } catch (error) {
          // 忽略单个选择器的错误
        }
      }

      // 4. 处理 ESC 键关闭弹窗
      try {
        await this.page.keyboard.press('Escape');
        logger.info('尝试使用 ESC 键关闭弹窗');
      } catch (error) {
        // 忽略 ESC 键错误
      }

      if (popupCount > 0) {
        logger.info(`成功关闭 ${popupCount} 个弹窗`);
      } else {
        logger.info('未发现需要关闭的弹窗');
      }

      return popupCount > 0;
    } catch (error) {
      logger.error('关闭弹窗失败:', error);
      return false;
    }
    */
  }

  /**
   * 确保页面就绪（关闭弹窗并等待页面稳定）
   */
  async ensurePageReady() {
    try {
      if (!this.page) {
        return false;
      }

      logger.info('确保页面就绪...');
      
      // 等待页面加载完成
      await this.page.waitForLoadState('networkidle', { timeout: 10000 });
      
      // 关闭弹窗 - 已禁用
      // await this.closePopups();
      
      // 等待页面稳定
      await this.page.waitForTimeout(1000);
      
      logger.info('页面已就绪');
      return true;
    } catch (error) {
      logger.error('确保页面就绪失败:', error);
      return false;
    }
  }

  /**
   * 打开 Boss 直聘官网
   */
  async openBossZhipinWebsite() {
    try {
      if (!this.page) {
        throw new Error('浏览器未初始化');
      }

      logger.info('正在打开 Boss 直聘官网...');
      this.currentStatus = 'navigating';
      
      // 打开 Boss 直聘官网
      await this.page.goto('https://www.zhipin.com/', {
        waitUntil: 'networkidle',
        timeout: 30000
      });

      // 等待页面加载完成
      await this.page.waitForLoadState('domcontentloaded');
      
      // 确保页面就绪
      await this.ensurePageReady();
      
      logger.info('Boss 直聘官网打开成功');
      this.currentStatus = 'idle';
      return true;
    } catch (error) {
      logger.error('打开 Boss 直聘官网失败:', error);
      this.currentStatus = 'idle';
      throw error;
    }
  }

  /**
   * 导航到招聘页面（点击"我要招聘"）
   */
  async navigateToRecruitmentPage() {
    try {
      if (!this.page) {
        throw new Error('浏览器未初始化');
      }

      logger.info('正在导航到招聘页面...');
      this.currentStatus = 'navigating';
      
      // 确保页面就绪
      await this.ensurePageReady();
      
      // 查找"我要招聘"按钮
      const recruitmentButton = await this.page.locator('text=我要招聘').first();
      
      if (!recruitmentButton) {
        throw new Error('未找到"我要招聘"按钮');
      }

      // 点击"我要招聘"按钮
      await recruitmentButton.click();
      
      // 等待页面跳转
      await this.page.waitForLoadState('networkidle');
      
      // 确保新页面就绪
      await this.ensurePageReady();
      
      logger.info('成功导航到招聘页面');
      this.currentStatus = 'idle';
      return true;
    } catch (error) {
      logger.error('导航到招聘页面失败:', error);
      this.currentStatus = 'idle';
      throw error;
    }
  }

  /**
   * 选择 App 扫码登录方式
   */
  async selectAppLoginMethod() {
    try {
      if (!this.page) {
        throw new Error('浏览器未初始化');
      }

      logger.info('正在选择 App 扫码登录方式...');
      this.currentStatus = 'logging_in';
      
      // 确保页面就绪
      await this.ensurePageReady();
      
      // 查找 App 扫码登录选项
      const appLoginOption = await this.page.locator('text=App扫码登录').first();
      
      if (!appLoginOption) {
        throw new Error('未找到 App 扫码登录选项');
      }

      // 点击 App 扫码登录
      await appLoginOption.click();
      
      // 等待登录页面加载
      await this.page.waitForLoadState('networkidle');
      
      // 确保新页面就绪
      await this.ensurePageReady();
      
      logger.info('已选择 App 扫码登录方式，等待用户扫码...');
      this.currentStatus = 'logging_in';
      return true;
    } catch (error) {
      logger.error('选择 App 扫码登录方式失败:', error);
      this.currentStatus = 'idle';
      throw error;
    }
  }

  /**
   * 检测登录状态
   */
  async getRecruitmentPageState(frame = null) {
    if (!this.page || this.page.isClosed?.() ||
        (typeof this.browser?.isConnected === 'function' && !this.browser.isConnected())) {
      return 'disconnected';
    }

    const url = this.page.url();
    if (/\/web\/user(?:\/|\?|$)|\/login(?:\/|\?|$)/i.test(url)) return 'waiting_login';
    if (VERIFICATION_URL.test(url)) return 'verification_required';
    if (!RECRUITER_URL.test(url)) {
      return 'page_unavailable';
    }

    const inspect = async target => target.evaluate(() => {
      const heading = document.querySelector('h1, h2, .verify-title, .captcha-title')?.textContent || '';
      const visible = element => element && element.getClientRects().length > 0 &&
        window.getComputedStyle(element).visibility !== 'hidden';
      const verification = [...document.querySelectorAll(
        '.geetest_panel, .geetest_holder, .captcha-container, .captcha-wrap, #captcha, [class*="security-verify"]'
      )].some(visible) || /安全验证|人机验证|滑块验证|行为验证|访问验证/.test(heading);
      const loginInput = document.querySelector('input[placeholder*="手机号"], input[placeholder*="手机号码"]');
      const body = document.body?.innerText || '';
      const rateLimited = /请求过于频繁|操作过于频繁|访问过于频繁|访问受限|请稍后再试/.test(body);
      return { verification, login: visible(loginInput), rateLimited };
    }).catch(() => null);

    const mainState = await inspect(this.page);
    if (!mainState) return 'unstable_page';
    if (mainState?.verification) return 'verification_required';
    if (mainState?.login) return 'waiting_login';
    if (mainState?.rateLimited) return 'rate_limited';
    if (frame && frame !== this.page && !frame.isDetached?.()) {
      const frameState = await inspect(frame);
      if (!frameState) return 'unstable_page';
      if (frameState?.verification) return 'verification_required';
      if (frameState?.login) return 'waiting_login';
      if (frameState?.rateLimited) return 'rate_limited';
    }
    return 'ready';
  }

  async assertCollectorReady(frame = null) {
    const state = await this.getRecruitmentPageState(frame);
    if (state === 'ready') return;
    const errors = {
      waiting_login: ['BOSS_LOGIN_REQUIRED', 'BOSS 登录已失效，请在浏览器中重新登录后再启动采集'],
      verification_required: ['BOSS_VERIFICATION_REQUIRED', 'BOSS 页面要求人工安全验证，已暂停采集'],
      rate_limited: ['BOSS_RATE_LIMITED', 'BOSS 页面提示访问频繁，已暂停采集，请稍后由人工确认后继续'],
      disconnected: ['BOSS_BROWSER_DISCONNECTED', 'BOSS 浏览器连接已断开，已停止采集'],
      unstable_page: ['BOSS_PAGE_UNSTABLE', 'BOSS 页面持续变化或菜单未稳定，已断开自动化连接']
    };
    const [code, message] = errors[state] || ['BOSS_PAGE_UNAVAILABLE', 'BOSS 页面不可用，已停止采集'];
    await this.suspendAutomation(state);
    const error = new Error(message);
    error.code = code;
    throw error;
  }

  async detachAutomation({ status = 'idle', keepLogin = false, suspend = false } = {}) {
    const browser = this.browser;
    const page = this.page;
    try {
      if (page && !page.isClosed?.()) this.chromeTabUrl = page.url().split(/[?#]/)[0];
    } catch {}
    this.browser = null;
    this.page = null;
    this.appPage = null;
    this.chromeWindowOpened = status !== 'disconnected';
    this.isLoggedIn = keepLogin && this.isLoggedIn;
    this.currentStatus = status;
    this.attachSuspended = suspend;
    // connectOverCDP Browser.close() closes its WebSocket transport, not the
    // externally launched Chrome process or any visible tabs.
    if (typeof browser?.close === 'function') await browser.close().catch(error =>
      logger.warn(`断开 BOSS 自动化连接失败: ${error.message}`));
  }

  async suspendAutomation(status) {
    this.browsingStatus.isActive = false;
    await this.detachAutomation({ status, suspend: true });
  }

  async observeStableRecruiterPage() {
    const page = this.page;
    if (!page || page.isClosed?.() ||
        (typeof this.browser?.isConnected === 'function' && !this.browser.isConnected())) {
      return 'disconnected';
    }
    const initialUrl = page.url();
    if (VERIFICATION_URL.test(initialUrl)) return 'verification_required';
    if (!RECRUITER_URL.test(initialUrl)) return 'waiting_login';
    const mainFrame = page.mainFrame?.();
    let navigations = 0;
    const onNavigation = frame => {
      if (!mainFrame || frame === mainFrame) navigations++;
    };
    page.on?.('framenavigated', onNavigation);
    try {
      let stableMenuReads = 0;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt) await new Promise(resolve => setTimeout(resolve, 600));
        if (page.isClosed?.() ||
            (typeof this.browser?.isConnected === 'function' && !this.browser.isConnected())) {
          return 'disconnected';
        }
        const state = await boundedRead(this.getRecruitmentPageState(), 1500);
        if (!state) return 'unstable_page';
        if (state !== 'ready') return state;
        if (navigations || page.url() !== initialUrl) return 'unstable_page';
        // The recruiter shell can keep an inactive copy of the search menu in
        // the DOM. Checking only the first match rejects a valid logged-in
        // page when another matching menu item is actually visible.
        const hasMenu = await boundedRead(page.locator(RECRUITER_MENU)
          .evaluateAll(elements => elements.some(element =>
            element.getClientRects().length > 0 &&
            window.getComputedStyle(element).visibility !== 'hidden'
          )).catch(() => false), 2500);
        if (navigations || page.url() !== initialUrl) return 'unstable_page';
        stableMenuReads = hasMenu ? stableMenuReads + 1 : 0;
        if (stableMenuReads >= 2) return 'ready';
      }
      return 'unstable_page';
    } catch {
      return 'unstable_page';
    } finally {
      page.off?.('framenavigated', onNavigation);
    }
  }

  async checkLoginStatus({ allowAttach = false, keepAttached = false } = {}) {
    if (this.attachSuspended || this.shutdownRequested) return false;
    try {
      if (this.page && (this.page.isClosed?.() ||
          (typeof this.browser?.isConnected === 'function' && !this.browser.isConnected()))) {
        this.browser = null;
        this.page = null;
        this.isLoggedIn = false;
      }
      // Passive polling must never attach to Chrome or probe its DOM. A URL
      // redirect to login/verification while already attached is enough to
      // disconnect promptly and leave the site to the user.
      if (this.page && !allowAttach && !keepAttached) {
        const url = this.page.url();
        if (VERIFICATION_URL.test(url)) {
          await this.suspendAutomation('verification_required');
          return false;
        }
        if (!RECRUITER_URL.test(url)) {
          await this.suspendAutomation('waiting_login');
          return false;
        }
        return this.isLoggedIn;
      }
      if (!this.page) {
        if (!this.chromeWindowOpened) return false;
        const tabs = await this.readVisibleTabs();
        if (this.shutdownRequested) return false;
        const recruiterTab = tabs.find(tab => RECRUITER_URL.test(tab.url));
        const verificationTab = tabs.find(tab => VERIFICATION_URL.test(tab.url));
        this.chromeTabUrl = (recruiterTab || verificationTab || tabs[0])?.url?.split(/[?#]/)[0] || null;
        if (!recruiterTab) {
          this.isLoggedIn = false;
          this.currentStatus = verificationTab ? 'verification_required' : 'waiting_login';
          return false;
        }
        if (!allowAttach && !keepAttached) return this.isLoggedIn;
        await this.initializeBrowser();
        if (this.shutdownRequested) {
          await this.suspendAutomation('disconnected');
          return false;
        }
      }

      const state = await this.observeStableRecruiterPage();
      if (this.shutdownRequested) {
        await this.suspendAutomation('disconnected');
        return false;
      }
      if (state !== 'ready') {
        await this.suspendAutomation(state);
        return false;
      }
      this.isLoggedIn = true;
      this.currentStatus = 'idle';
      if (!keepAttached) await this.detachAutomation({ status: 'idle', keepLogin: true });
      return true;
    } catch (error) {
      logger.error('检测 BOSS 登录状态失败:', error);
      if (this.browser) await this.suspendAutomation('unstable_page');
      else {
        this.currentStatus = 'disconnected';
        this.isLoggedIn = false;
        // The CDP connection failed; the visible Chrome window may still be
        // open. Keep its last known URL and require an explicit stop/start
        // before another attach attempt.
        this.attachSuspended = true;
      }
      return false;
    }
  }

  /**
   * 等待用户扫码登录
   */
  async waitForUserLogin(timeout = 300000) { // 5分钟超时
    try {
      if (!this.page) {
        throw new Error('浏览器未初始化');
      }

      logger.info('等待用户扫码登录...');
      
      const startTime = Date.now();
      
      while (Date.now() - startTime < timeout) {
        // 确保页面就绪
        await this.ensurePageReady();
        
        // 检查登录状态
        const isLoggedIn = await this.checkLoginStatus();
        
        if (isLoggedIn) {
          logger.info('用户登录成功！');
          this.currentStatus = 'idle';
          return true;
        }
        
        // 等待5秒后再次检查
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        // 检查是否超时
        if (Date.now() - startTime >= timeout) {
          throw new Error('等待用户登录超时');
        }
      }
      
      throw new Error('等待用户登录超时');
    } catch (error) {
      logger.error('等待用户登录失败:', error);
      this.currentStatus = 'idle';
      throw error;
    }
  }

  /**
   * 获取当前状态
   */
  getCurrentStatus() {
    const connected = this.browser &&
      (typeof this.browser.isConnected !== 'function' || this.browser.isConnected());
    const livePage = connected && this.page && !this.page.isClosed?.();
    return {
      status: this.currentStatus,
      isLoggedIn: this.isLoggedIn,
      hasBrowser: !!connected || (!this.browser && this.chromeWindowOpened),
      hasPage: !!livePage || (!this.browser && this.chromeWindowOpened),
      currentUrl: livePage
        ? this.page.url().split(/[?#]/)[0] : this.chromeTabUrl
    };
  }

  /**
   * 启动候选人浏览
   */
  async startBrowsing(mode, filters = {}, targetCount = 3, { resume = false } = {}) {
    try {
      if (this.attachSuspended) {
        throw new Error('BOSS 页面需要人工确认；请停止自动化连接，确认招聘页面稳定后重新启动');
      }
      if (this.browsingStatus.isActive) {
        throw new Error('BOSS 候选人采集正在进行，请先停止当前任务');
      }
      if (this.browsingTaskPromise) {
        throw new Error('BOSS 上次采集仍在退出中，请等待当前页面操作完成后再启动');
      }
      if (this.resumeProcessingStatus.isActive) {
        throw new Error('BOSS 收藏简历处理正在进行，请先等待当前任务完成');
      }
      if (!['recommended', 'search', 'communication'].includes(mode)) {
        throw new Error('BOSS 采集模式无效');
      }
      targetCount = Math.min(500, Math.max(1, Number.parseInt(targetCount, 10) || 3));
      try {
        this.activeJobSnapshot = new ActiveJobService().current();
      } catch (error) {
        logger.warn(`读取当前岗位配置失败，采集后自动评估将不可用: ${error.message}`);
        this.activeJobSnapshot = null;
      }
      if (!this.activeJobSnapshot?.title || !this.activeJobSnapshot?.jobRequirements) {
        throw new Error('请先保存岗位条件，再启动 BOSS 简历采集');
      }
      if (mode === 'search' && !String(filters.position || filters.keywords || '').trim()) {
        filters = { ...filters, position: this.activeJobSnapshot.searchKeywords ||
          this.activeJobSnapshot.title };
      }
      const signature = taskSignature({ mode, filters, targetCount,
        job: this.activeJobSnapshot });
      const previous = resume ? this.collectionCheckpoint.load() : null;
      if (resume && (!previous || previous.signature !== signature ||
          previous.state === 'completed')) {
        throw new Error('上次 BOSS 任务与当前岗位、筛选条件或目标份数不一致，无法续采；可新建任务');
      }
      this.collectionSignature = signature;
      this.currentStatus = 'browsing';
      
      // 初始化浏览状态
      this.browsingStatus = {
        isActive: true,
        mode: mode,
        candidates: [],
        processedCount: previous?.processedCount || 0,
        likedCount: 0,
        dislikedCount: 0,
        currentIndex: 0,
        filters: filters,
        targetCount: targetCount,
        currentKeyword: previous?.currentKeyword || '',
        nextKeywordIndex: previous?.nextKeywordIndex || 0,
        keywordsCompleted: previous?.keywordsCompleted || 0,
        keywordErrors: previous?.keywordErrors || [],
        stalledKeywords: previous?.stalledKeywords || [],
        lastError: '',
        completionReason: '',
        currentPhase: 'starting',
        phaseStartedAt: new Date().toISOString(),
        candidateStartedAt: null,
        candidateDeadlineAt: null,
        attemptedCount: 0,
        skippedCount: 0,
        lastFailureCode: '',
        seenCandidateIds: new Set(),
        startTime: new Date().toISOString()
      };
      this.saveCollectionProgress();
      
      logger.info(`开始候选人浏览，模式: ${mode}`, filters);
      
      // 异步执行浏览任务，不阻塞响应
      const task = this.executeBrowsingTask(mode, filters, targetCount).catch(error => {
        logger.error('候选人浏览任务执行失败:', error);
        this.browsingStatus.isActive = false;
        this.browsingStatus.lastError = error.message;
        if (!['waiting_login', 'verification_required', 'rate_limited', 'unstable_page',
          'disconnected', 'candidate_timeout']
          .includes(this.currentStatus)) {
          this.currentStatus = 'error';
        }
      });
      this.browsingTaskPromise = task;
      task.finally(() => {
        if (this.browsingTaskPromise === task) this.browsingTaskPromise = null;
      });
      
      return true;
    } catch (error) {
      logger.error('启动候选人浏览失败:', error);
      this.browsingStatus.isActive = false;
      if (!this.attachSuspended) this.currentStatus = 'error';
      throw error;
    }
  }

  /**
   * 浏览推荐牛人 - 按照文档规范流程
   * @param {number} targetCount - 目标浏览候选人数量
   */
  async browseRecommendedCandidates(targetCount = 3) {
    await this.assertCollectorReady();
    if (!/\/web\/(?:boss|chat)\/recommend(?:[/?#]|$)/i.test(this.page.url())) {
      // One intentional menu click only. Repeated navigation caused platform
      // redirects and must never be used as a recovery mechanism.
      let menu = null;
      for (const selector of ['a[ka="menu-geek-recommend"]',
        'dl.menu-recommend', 'a[href*="/web/chat/recommend"]',
        'a[href*="/web/boss/recommend"]']) {
        const candidate = this.page.locator(selector).first();
        if (await candidate.isVisible().catch(() => false)) {
          menu = candidate;
          break;
        }
      }
      if (!menu) {
        throw this.recommendedJobError('BOSS 推荐牛人入口不可见，已暂停采集',
          'BOSS_RECOMMEND_MENU_UNAVAILABLE');
      }
      await menu.click({ timeout: 5000, noWaitAfter: true });
    }
    let frame = null;
    for (let attempt = 0; attempt < 12; attempt++) {
      await this.assertCollectorReady();
      frame = await this.getRecommendedFrame();
      if (frame) break;
      await this.page.waitForTimeout(500);
    }
    if (!frame) throw this.recommendedJobError(
      'BOSS 推荐岗位区域未加载，已暂停采集', 'BOSS_RECOMMEND_FRAME_UNAVAILABLE');
    const selection = await this.selectRecommendedJob(frame, this.activeJobSnapshot?.title);
    await this.browseRecommendedCandidateList(targetCount, selection.frame, selection);
  }

  recommendedJobError(message, code = 'BOSS_RECOMMENDED_JOB_MISMATCH') {
    this.currentStatus = 'page_unavailable';
    const error = new Error(message);
    error.code = code;
    return error;
  }

  async getRecommendedFrame() {
    if (!this.page || this.page.isClosed?.()) return null;
    const iframe = await this.page.$('iframe[src*="/web/frame/recommend/"]')
      .catch(() => null);
    if (!iframe) return null;
    const frame = await iframe.contentFrame().catch(() => null);
    return frame && !frame.isDetached?.() ? frame : null;
  }

  async readRecommendedJobState(frame) {
    if (!frame || frame.isDetached?.()) return null;
    const state = await frame.evaluate(() => {
      const selected = document.querySelector('.job-selecter-wrap');
      const options = [...document.querySelectorAll('.job-list .job-item')]
        .map(element => ({
          value: element.getAttribute('value') || '',
          label: (element.querySelector('.label')?.textContent ||
            element.textContent || '').replace(/\s+/g, ' ').trim()
        }));
      return {
        selectedLabel: (selected?.innerText || '').replace(/\s+/g, ' ').trim(),
        options
      };
    }).catch(() => null);
    if (!state) return null;
    try { state.jobId = new URL(frame.url()).searchParams.get('jobid') || ''; }
    catch { state.jobId = ''; }
    return state;
  }

  recommendedJobTitle(label) {
    return String(label || '').split(/\s*[_＿]\s*/)[0].replace(/\s+/g, ' ').trim();
  }

  async assertRecommendedJob(frame, expectedTitle, expectedJobId) {
    const state = await this.readRecommendedJobState(frame);
    if (!state || this.recommendedJobTitle(state.selectedLabel) !== expectedTitle ||
        state.jobId !== expectedJobId) {
      throw this.recommendedJobError(
        `BOSS 推荐岗位与当前岗位“${expectedTitle}”不一致，已暂停采集`);
    }
    return state;
  }

  async selectRecommendedJob(initialFrame, title) {
    const expectedTitle = String(title || '').replace(/\s+/g, ' ').trim();
    if (!expectedTitle) throw this.recommendedJobError(
      '请先设置岗位条件，再采集 BOSS 推荐简历', 'BOSS_RECOMMENDED_JOB_REQUIRED');
    let frame = initialFrame;
    let state = null;
    for (let attempt = 0; attempt < 12; attempt++) {
      frame = await this.getRecommendedFrame() || frame;
      state = await this.readRecommendedJobState(frame);
      if (state?.selectedLabel && state.options?.length) break;
      await this.page.waitForTimeout(500);
    }
    if (!state?.selectedLabel || !state.options?.length) throw this.recommendedJobError(
      'BOSS 推荐岗位下拉未加载，已暂停采集', 'BOSS_RECOMMEND_FRAME_UNAVAILABLE');
    const matches = state.options.filter(option =>
      this.recommendedJobTitle(option.label) === expectedTitle && option.value);
    if (matches.length !== 1) throw this.recommendedJobError(
      `BOSS 企业账号下未找到唯一的“${expectedTitle}”岗位，已暂停采集`,
      'BOSS_RECOMMENDED_JOB_UNAVAILABLE');
    const expectedJobId = matches[0].value;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(expectedJobId)) {
      throw this.recommendedJobError('BOSS 推荐岗位标识无效，已暂停采集');
    }
    if (this.recommendedJobTitle(state.selectedLabel) !== expectedTitle ||
        state.jobId !== expectedJobId) {
      const selector = frame.locator('.job-selecter-wrap').first();
      if (!await selector.isVisible().catch(() => false)) {
        throw this.recommendedJobError('BOSS 推荐岗位切换控件不可见，已暂停采集');
      }
      await selector.click({ timeout: 4000, noWaitAfter: true });
      const option = frame.locator(`.job-list .job-item[value="${expectedJobId}"]`);
      if (await option.count() !== 1 || !await option.first()
        .waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)) {
        throw this.recommendedJobError('BOSS 推荐岗位选项无法唯一确认，已暂停采集');
      }
      await option.first().click({ timeout: 4000, noWaitAfter: true });
    }
    let stableReads = 0;
    for (let attempt = 0; attempt < 16; attempt++) {
      await this.assertCollectorReady();
      frame = await this.getRecommendedFrame();
      if (frame) {
        state = await this.readRecommendedJobState(frame);
        if (state && this.recommendedJobTitle(state.selectedLabel) === expectedTitle &&
            state.jobId === expectedJobId) {
          stableReads++;
          if (stableReads >= 2) {
            logger.info(`BOSS 推荐岗位已确认：${expectedTitle}`);
            return { frame, title: expectedTitle, jobId: expectedJobId };
          }
        } else {
          stableReads = 0;
        }
      } else {
        stableReads = 0;
      }
      await this.page.waitForTimeout(500);
    }
    throw this.recommendedJobError(
      `BOSS 未能确认推荐候选人列表属于“${expectedTitle}”，已暂停采集`);
  }

  /**
   * 搜索牛人 - 完整流程实现
   * @param {object} filters - 筛选条件对象
   * @param {number} targetCount - 目标浏览候选人数量
   */
  async clickSearchMenuOnce() {
    // BOSS can replace its whole left menu while Playwright is waiting for a
    // locator to become stable. A locator click then times out before sending
    // any pointer event. Inspect the actual hit target and send one trusted
    // click at its current coordinates; never force-click through an overlay.
    const selector = 'a[ka="menu-geek-search"], dl.menu-geeksearch a';
    let point = null;
    let stableSamples = 0;
    let previousOrigin = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      await this.assertCollectorReady();
      const sample = await this.page.evaluate(searchSelector => {
        const menu = document.querySelector(searchSelector);
        if (!menu) return { state: 'missing' };
        const rect = menu.getBoundingClientRect();
        const style = getComputedStyle(menu);
        if (!rect.width || !rect.height || style.display === 'none' ||
            style.visibility === 'hidden' || style.pointerEvents === 'none') {
          return { state: 'hidden' };
        }
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const hit = document.elementFromPoint(x, y);
        if (!hit || !(hit === menu || menu.contains(hit))) {
          return { state: 'obscured' };
        }
        return { state: 'ready', x, y, origin: performance.timeOrigin };
      }, selector).catch(() => ({ state: 'changing' }));
      if (sample.state === 'ready' && sample.origin === previousOrigin) {
        stableSamples++;
      } else {
        stableSamples = sample.state === 'ready' ? 1 : 0;
      }
      previousOrigin = sample.origin;
      if (stableSamples >= 2) {
        point = sample;
        break;
      }
      if (attempt < 9) await this.page.waitForTimeout(500);
    }
    if (!point) {
      this.currentStatus = 'page_unavailable';
      const error = new Error('BOSS 搜索菜单尚未稳定显示或被遮挡，已停止采集；请在浏览器中确认搜索入口');
      error.code = 'BOSS_SEARCH_MENU_UNAVAILABLE';
      throw error;
    }
    // A single pointer action avoids Playwright locator auto-retries across
    // BOSS SPA redraws. The caller checks that the search page really opened.
    await this.page.mouse.click(point.x, point.y, { delay: 40 });
  }

  async searchCandidates(filters, targetCount = 3) {
    try {
      logger.info('开始搜索牛人...', filters);
      await this.assertCollectorReady();

      // A recruiter SPA may render search in #searchContent's iframe or in
      // the main document. Reuse an already open search view across keywords.
      // Never treat the recommend iframe as search or repeatedly click menus.
      let searchContext = await this.getSearchContext();
      if (!searchContext) {
        try {
          await this.clickSearchMenuOnce();
        } catch (cause) {
          if (cause.code?.startsWith('BOSS_')) throw cause;
          this.currentStatus = 'page_unavailable';
          const error = new Error('BOSS 搜索菜单当前不可点击，已停止采集；请在浏览器中确认是否有弹窗或验证');
          error.code = 'BOSS_SEARCH_MENU_UNAVAILABLE';
          error.cause = cause;
          throw error;
        }
        for (let attempt = 0; attempt < 8; attempt++) {
          await this.assertCollectorReady();
          searchContext = await this.getSearchContext();
          if (searchContext) break;
          if (attempt < 7) await this.page.waitForTimeout(750);
        }
      }
      if (!searchContext) {
        this.currentStatus = 'page_unavailable';
        const error = new Error('点击 BOSS 搜索菜单后仍未出现搜索输入框，已停止采集；请在浏览器中确认搜索页是否打开');
        error.code = 'BOSS_SEARCH_PAGE_UNAVAILABLE';
        throw error;
      }
      await this.assertCollectorReady(searchContext);
      await this.ensureResumeDialogClosed(searchContext);

      // Search submission may replace the SPA iframe. Recover its current
      // search view at most once, without clicking the menu or changing URLs.
      const searchRecovery = { used: false };
      searchContext = await this.applyFiltersInIframe(searchContext, filters,
        searchRecovery) || searchContext;

      await this.executeSearchInIframe(searchContext);

      searchContext = await this.confirmSubmittedSearch(searchContext,
        String(filters.position || filters.keywords || '').trim(), searchRecovery);
      await this.processSearchResults(searchContext, targetCount);
      
    } catch (error) {
      logger.error('搜索牛人失败:', error);
      throw error;
    }
  }

  /**
   * 导航到沟通页面
   * @returns {Promise<boolean>} 导航是否成功
   */
  async navigateToCommunicationPage() {
    try {
      logger.info('开始导航到沟通页面...');
      
      // 直接点击"沟通"按钮，导航到沟通界面
      await this.page.click('text=沟通');
      await this.page.waitForTimeout(2000);
      
      // 选择"全部"选项
      await this.page.click('text=全部');
      await this.page.waitForTimeout(1000);
      
      // 选择"未读"选项
      await this.page.click('text=未读');
      await this.page.waitForTimeout(2000);
      
      logger.info('成功导航到沟通页面');
      return true;
      
    } catch (error) {
      logger.error('导航到沟通页面失败:', error);
      return false;
    }
  }

  /**
   * 浏览沟通版块候选人 - 按照文档规范流程
   * @param {number} targetCount - 目标浏览候选人数量
   */
  async browseCommunicationCandidates(targetCount = 3) {
    try {
      logger.info('开始浏览沟通版块候选人...');
      
      // 使用导航方法导航到沟通页面
      const navigationSuccess = await this.navigateToCommunicationPage();
      if (!navigationSuccess) {
        throw new Error('导航到沟通页面失败');
      }
      
      // 按照文档规范：后续操作与推荐牛人流程保持一致
      await this.browseRecommendedCandidateList(targetCount);
      
    } catch (error) {
      logger.error('浏览沟通版块候选人失败:', error);
      throw error;
    }
  }

  /**
   * 按照文档规范浏览推荐候选人列表
   * 系统识别页面上的候选人卡片，按顺序从上到下依次点击候选人卡片
   * 当页面候选人浏览完毕时，自动向下滚动刷新更多候选人
   */
  async browseRecommendedCandidateList(targetCount = 3, frame = null, selection = null) {
    if (!selection?.title || !selection?.jobId || !frame) {
      throw this.recommendedJobError('BOSS 推荐岗位尚未核验，已暂停采集');
    }
    await this.assertCollectorReady(frame);
    await this.assertRecommendedJob(frame, selection.title, selection.jobId);
    await this.processSearchResults(frame, targetCount, {
      mode: 'recommended', expectedTitle: selection.title,
      expectedJobId: selection.jobId
    });
  }

  /**
   * 分析页面结构，帮助定位候选人卡片 - 增强反爬虫对策
   */
  async analyzePageStructure() {
    try {
      logger.info('开始分析页面结构...');
      
      // 获取页面URL
      const currentUrl = this.page.url();
      logger.info(`当前页面URL: ${currentUrl}`);
      
      // 模拟人类行为 - 随机鼠标移动
      await this.simulateHumanBehavior();
      
      // 等待页面完全加载，使用多种策略
      await this.waitForPageFullyLoaded();
      
      // 尝试触发页面内容加载
      await this.triggerContentLoading();
      
      // 首先检测是否有iframe
      const iframeAnalysis = await this.detectAndAnalyzeIframes();
      
      // 如果在iframe中找到了候选人卡片，优先使用iframe结果
      if (iframeAnalysis.hasIframes && iframeAnalysis.candidateCards && iframeAnalysis.candidateCards.length > 0) {
        logger.info('使用iframe中的候选人卡片数据');
        
        // 开始自动化处理iframe中的候选人卡片
        await this.processCandidateCardsInIframe(iframeAnalysis.relevantFrame, iframeAnalysis.candidateCards);
        
        const result = {
          success: true,
          pageType: 'iframe_candidates',
          candidateCount: iframeAnalysis.candidateCards.length,
          iframeSrc: iframeAnalysis.iframeSrc,
          candidateElements: iframeAnalysis.candidateCards,
          frame: iframeAnalysis.relevantFrame,
          message: `在iframe中发现 ${iframeAnalysis.candidateCards.length} 个候选人卡片`
        };
        
        logger.info('页面结构分析完成（iframe模式）:', result.message);
        return result;
      }
      
      // 如果没有找到相关iframe或iframe中没有候选人卡片，继续常规页面分析
      logger.info('继续常规页面分析...');
      
      // 分析页面中可能的候选人相关元素
      const pageAnalysis = await this.page.evaluate(() => {
        const analysis = {
          title: document.title,
          url: window.location.href,
          possibleCandidateElements: [],
          allDivs: [],
          pageContent: {
            hasRecommendButton: false,
            hasUserList: false,
            hasCandidateList: false,
            mainContent: ''
          }
        };
        
        // 检查页面是否有推荐相关按钮或内容
        const recommendButtons = document.querySelectorAll('*');
        for (let element of recommendButtons) {
          const text = element.textContent || '';
          if (text.includes('推荐') || text.includes('牛人') || text.includes('候选人')) {
            analysis.pageContent.hasRecommendButton = true;
            break;
          }
        }
        
        // 获取页面主要内容区域的文本
        const mainContent = document.querySelector('body');
        if (mainContent) {
          analysis.pageContent.mainContent = mainContent.textContent.substring(0, 500);
        }
        
        // 查找所有div元素，记录前20个的类名
        const allDivElements = document.querySelectorAll('div');
        analysis.allDivs = Array.from(allDivElements).slice(0, 20).map(div => ({
          className: div.className,
          id: div.id,
          textContent: (div.textContent || '').substring(0, 50)
        }));
        
        // 查找可能包含候选人信息的元素 - 扩展选择器
        const possibleSelectors = [
          // 主要候选人卡片根节点（用户指定的锚点）
          '<li data-vb753c1ac class="card-item">',
          'li[data-v-b753c1ac].card-item',
          'li.card-item[data-v-b753c1ac]',
          
          // Boss直聘特定选择器
          'div.candidate-card-wrap',
          '.candidate-card-wrap',
          'div[data-v-355e62b0]',
          'div[data-v-5b6c77c0]',
          'div[data-v-b753c1ac]',
          'div[data-v-355e62b0][data-v-5b6c77c0][data-v-b753c1ac]',
          
          // 通用候选人相关选择器
          'div[class*="candidate"]',
          'div[class*="user"]',
          'div[class*="talent"]',
          'div[class*="geek"]',
          'div[class*="card"]',
          'div[class*="item"]',
          'div[class*="list"]',
          'div[class*="person"]',
          'div[class*="resume"]',
          'div[class*="profile"]',
          
          // 列表项选择器
          'li[class*="user"]',
          'li[class*="talent"]',
          'li[class*="geek"]',
          'li[class*="candidate"]',
          'li[class*="item"]',
          
          // 链接选择器
          'a[class*="user"]',
          'a[class*="talent"]',
          'a[class*="candidate"]',
          'a[class*="geek"]',
          
          // 属性选择器
          '[ka*="user"]',
          '[ka*="card"]',
          '[ka*="talent"]',
          '[data-ka*="user"]',
          '[data-ka*="card"]',
          
          // Vue组件选择器（具体的data-v属性）
          '[data-v-355e62b0]',
          '[data-v-5b6c77c0]',
          '[data-v-b753c1ac]',
          'div[data-v-355e62b0][class*="card"]',
          'div[data-v-5b6c77c0][class*="wrap"]',
          'div[data-v-b753c1ac][class*="wrap"]',
          
          // 通用容器选择器
          '.user-card',
          '.talent-card',
          '.resume-card',
          '.profile-card'
        ];
        
        possibleSelectors.forEach(selector => {
          try {
            const elements = document.querySelectorAll(selector);
            if (elements.length > 0) {
              analysis.possibleCandidateElements.push({
                selector: selector,
                count: elements.length,
                sampleClasses: Array.from(elements).slice(0, 3).map(el => el.className),
                sampleText: Array.from(elements).slice(0, 3).map(el => (el.textContent || '').substring(0, 50))
              });
            }
          } catch (error) {
            // 忽略错误，继续分析
          }
        });
        
        return analysis;
      });
      
      logger.info('页面分析结果:', JSON.stringify(pageAnalysis, null, 2));
      
      // 记录页面内容信息
      logger.info('页面内容分析:');
      logger.info(`- 是否有推荐相关内容: ${pageAnalysis.pageContent.hasRecommendButton}`);
      logger.info(`- 页面主要内容: ${pageAnalysis.pageContent.mainContent}`);
      
      // 记录所有div元素信息
      logger.info('页面div元素分析:');
      pageAnalysis.allDivs.forEach((div, index) => {
        logger.info(`- Div ${index + 1}: 类名="${div.className}", ID="${div.id}", 内容="${div.textContent}"`);
      });
      
      // 如果找到可能的候选人元素，记录详细信息并开始自动化处理
      if (pageAnalysis.possibleCandidateElements.length > 0) {
        logger.info('发现可能的候选人元素:');
        pageAnalysis.possibleCandidateElements.forEach(element => {
          logger.info(`- 选择器: ${element.selector}, 数量: ${element.count}`);
          logger.info(`  示例类名: ${element.sampleClasses.join(', ')}`);
          logger.info(`  示例文本: ${element.sampleText.join(', ')}`);
        });
        
        // 开始自动化处理候选人卡片
        await this.processCandidateCards(pageAnalysis.possibleCandidateElements);
        
      } else {
        logger.warn('未发现明显的候选人元素，尝试重新分析...');
        
        // 重试机制 - 再次尝试分析
        await this.retryPageAnalysis();
      }
      
      // 额外的页面状态检查
      await this.checkPageState();
      
    } catch (error) {
      logger.error('页面结构分析失败:', error);
      // 尝试恢复
      await this.recoverFromAnalysisFailure();
    }
  }
  
  /**
   * 自动化处理候选人卡片
   */
  async processCandidateCards(candidateElements) {
    try {
      logger.info('开始自动化处理候选人卡片...');
      
      // 检查是否已停止浏览
      if (!this.browsingStatus.isActive) {
        logger.info('浏览已停止，终止候选人卡片处理');
        return;
      }
      
      // 选择最有可能的候选人卡片选择器
      const bestSelector = this.selectBestCandidateSelector(candidateElements);
      if (!bestSelector) {
        logger.warn('未找到合适的候选人卡片选择器');
        return;
      }
      
      logger.info(`使用选择器: ${bestSelector.selector}`);
      
      // 获取所有候选人卡片
      const candidateCards = await this.page.$$(bestSelector.selector);
      logger.info(`找到 ${candidateCards.length} 个候选人卡片`);
      
      // 限制处理数量，避免过度操作
      const maxCards = Math.min(candidateCards.length, 5);
      logger.info(`将处理前 ${maxCards} 个候选人卡片`);
      
      // 依次处理每个候选人卡片
      for (let i = 0; i < maxCards; i++) {
        // 在每次处理前检查是否已停止浏览
        if (!this.browsingStatus.isActive) {
          logger.info('浏览已停止，终止候选人卡片处理');
          break;
        }
        
        try {
          logger.info(`处理第 ${i + 1} 个候选人卡片...`);
          await this.processSingleCandidateCard(candidateCards[i], i);
          
          // 处理间隔，避免操作过快
          await this.page.waitForTimeout(2000);
          
        } catch (error) {
          logger.error(`处理第 ${i + 1} 个候选人卡片失败:`, error.message);
          continue;
        }
      }
      
      logger.info('候选人卡片自动化处理完成');
      
    } catch (error) {
      logger.error('候选人卡片处理失败:', error);
    }
  }
  
  /**
   * 选择最佳的候选人卡片选择器
   */
  selectBestCandidateSelector(candidateElements) {
    // 优先选择包含'card-item'的选择器
    const cardItemSelector = candidateElements.find(el => 
      el.selector.includes('card-item') && el.count > 0
    );
    
    if (cardItemSelector) {
      return cardItemSelector;
    }
    
    // 其次选择数量最多的选择器
    return candidateElements.reduce((best, current) => {
      return current.count > best.count ? current : best;
    }, candidateElements[0]);
  }
  
  /**
   * 处理单个候选人卡片
   */
  async processSingleCandidateCard(cardElement, index) {
    try {
      logger.info(`点击第 ${index + 1} 个候选人卡片...`);
      
      // 滚动到卡片位置
      await cardElement.scrollIntoViewIfNeeded();
      await this.page.waitForTimeout(1000);
      
      // 点击候选人卡片
      await cardElement.click();
      await this.page.waitForTimeout(3000);
      
      // 等待简历页面加载
      await this.waitForResumePageLoad();
      
      // 复制简历内容
      const resumeContent = await this.extractResumeContentFromPage();
      
      if (resumeContent) {
        logger.info(`成功提取第 ${index + 1} 个候选人的简历内容`);
        
        // 上传简历到应用
        await this.uploadResumeToApp(resumeContent, index);
        
      } else {
        logger.warn(`第 ${index + 1} 个候选人简历内容提取失败`);
      }
      
      // 返回到候选人列表页面
      await this.returnToCandidateList();
      
    } catch (error) {
      logger.error(`处理单个候选人卡片失败:`, error.message);
      throw error;
    }
  }
  
  /**
   * 等待简历页面加载
   */
  async waitForResumePageLoad() {
    try {
      // 等待页面跳转或弹窗出现
      await this.page.waitForTimeout(2000);
      
      // 检查是否有简历相关内容
      const resumeIndicators = [
        '.resume-content',
        '.profile-content',
        '.user-detail',
        '[class*="resume"]',
        '[class*="profile"]',
        '[class*="detail"]'
      ];
      
      for (const selector of resumeIndicators) {
        try {
          await this.page.waitForSelector(selector, { timeout: 3000 });
          logger.info(`简历页面加载完成，找到元素: ${selector}`);
          return;
        } catch (error) {
          // 继续尝试下一个选择器
        }
      }
      
      logger.info('简历页面加载完成（通用等待）');
      
    } catch (error) {
      logger.warn('等待简历页面加载失败:', error.message);
    }
  }
  
  /**
   * 从页面提取简历内容（优先使用Hook方式）
   */
  async extractResumeContentFromPage() {
    try {
      this.assertCandidateActive();
      logger.info('开始从主页面提取简历内容（优先使用Hook方式）');
      
      // 方法1：优先尝试Hook方式复制（针对Canvas简历）
      try {
        logger.info('尝试使用Hook方式复制主页面Canvas简历');
        
        // 检查页面中是否有canvas#resume元素
        const hasCanvas = await this.page.locator('canvas#resume').count();
        this.assertCandidateActive();
        if (hasCanvas > 0) {
          logger.info('发现主页面canvas#resume元素，使用Hook方式复制');
          
          const hookText = await this.runCanvasCopyWithDeadline(signal =>
            this.dragSelectionService.copyResumeByHook(this.page, {
              frameSelector: null, // 主页面不需要iframe切换
              canvasSelector: 'canvas#resume',
              margin: 5,
              dragSteps: 30,
              waitTime: 500,
              signal
            }), this.canvasCopyTimeoutMs.hook, '主页面 Hook');
          
          if (hookText && hookText.trim()) {
            const quality = assessBossResumeText(hookText);
            if (quality.valid) {
              logger.info(`主页面Hook方式复制成功，获取到 ${hookText.length} 个字符的内容`);
              return hookText;
            }
            logger.warn(`BOSS 主页面 Hook 文本缺少简历证据: ${quality.reason}`);
          } else {
            logger.warn('主页面Hook方式复制未获取到有效内容');
          }
        } else {
          logger.info('主页面未发现canvas#resume元素，跳过Hook方式');
        }
      } catch (hookError) {
        this.assertCandidateActive();
        logger.warn('主页面Hook方式复制失败:', hookError.message);
      }
      
      // 方法2：使用传统的选择器方式提取简历内容
      logger.info('使用传统选择器方式提取简历内容');
      const resumeContent = await this.page.evaluate(() => {
        // 优先检测resume-detail-wrap组件（在线简历内容）
        const resumeDetailWrap = document.querySelector('.resume-detail-wrap');
        if (resumeDetailWrap) {
          // 克隆元素以避免修改原DOM
          const clonedElement = resumeDetailWrap.cloneNode(true);
          
          // 移除不需要的组件内容
          const excludeSelectors = [
            '.resume-warning',
            '.resume-anonymous-geek-card.v2'
          ];
          
          excludeSelectors.forEach(selector => {
            const elementsToRemove = clonedElement.querySelectorAll(selector);
            elementsToRemove.forEach(el => el.remove());
          });
          
          const content = clonedElement.textContent.trim();
          if (content.length >= 60) {
            return {
              content: content,
              source: '.resume-detail-wrap (在线简历)'
            };
          }
        }
        
        // 尝试其他方式获取简历内容
        const contentSelectors = [
          '.resume-content',
          '.profile-content', 
          '.user-detail',
          '.candidate-detail',
          '.talent-detail'
        ];
        
        for (const selector of contentSelectors) {
          const element = document.querySelector(selector);
          if (element && element.textContent.trim().length >= 60) {
            return {
              content: element.textContent.trim(),
              source: selector
            };
          }
        }
        
        return null;
      });
      this.assertCandidateActive();
      
      if (resumeContent) {
        const quality = assessBossResumeText(resumeContent.content);
        if (isTrustedBossResumeSource(resumeContent.source) && quality.valid) {
          logger.info(`简历内容提取成功，来源: ${resumeContent.source}，长度: ${resumeContent.content.length}`);
          return resumeContent.content;
        }
        logger.warn(`BOSS 主页面文本不是可信简历正文，来源: ${resumeContent.source}，原因: ${quality.reason || '来源不是简历容器'}`);
      }
      
      this.assertCandidateActive();
      return await this.extractCanvasOcrContent(this.page);
      
    } catch (error) {
      if (error.code?.startsWith('BOSS_')) throw error;
      logger.error('提取简历内容失败:', error);
      return null;
    }
  }
  
  /**
   * 从主页面的canvas#resume元素中提取文字内容
   */

  
  /**
   * 上传简历到应用
   */
  async uploadResumeToApp(resumeContent, candidateIndex) {
    try {
      logger.info(`开始上传第 ${candidateIndex + 1} 个候选人的简历到应用...`);
      
      // 检查是否已停止浏览
      if (!this.browsingStatus.isActive) {
        logger.info('浏览已停止，终止简历上传');
        return;
      }
      
      // 检查浏览器连接状态，如果断开则尝试重启
      if (!this.browser || !this.browser.isConnected()) {
        logger.warn('浏览器连接已断开，尝试重新初始化浏览器...');
        try {
          await this.initializeBrowser();
          logger.info('浏览器重新初始化成功');
        } catch (restartError) {
          logger.error('浏览器重启失败:', restartError);
          return;
        }
      }
      
      // 检查是否已有应用页面，如果没有则在同一浏览器窗口中创建新标签页
      if (!this.appPage || this.appPage.isClosed()) {
        // 直接使用浏览器创建新页面，确保在同一窗口的不同标签页中
        this.appPage = await this.browser.newPage();
        
        // 设置页面不会被自动关闭
        this.appPage.on('close', () => {
          logger.warn('应用页面被意外关闭，将在下次使用时重新创建');
          this.appPage = null;
        });
        
        // 导航到应用页面，添加超时控制
        await this.appPage.goto('http://localhost:3000', { 
          waitUntil: 'networkidle',
          timeout: 15000
        });
        await this.appPage.waitForTimeout(1500);
        logger.info('在同一浏览器窗口中创建应用页面并导航到 http://localhost:3000');
      } else {
        // 如果应用页面已存在，切换到应用页面并刷新到首页
        try {
          await this.appPage.bringToFront();
          // 检查当前URL，如果不在首页则导航到首页
          const currentUrl = this.appPage.url();
          if (!currentUrl.includes('localhost:3000') || currentUrl !== 'http://localhost:3000/') {
            await this.appPage.goto('http://localhost:3000', { 
              waitUntil: 'networkidle',
              timeout: 10000
            });
          }
          await this.appPage.waitForTimeout(1000);
          logger.info('切换到现有应用页面');
        } catch (navError) {
          logger.warn('切换到应用页面失败，尝试重新创建页面:', navError.message);
          this.appPage = await this.browser.newPage();
          
          // 设置页面关闭监听
          this.appPage.on('close', () => {
            logger.warn('应用页面被意外关闭，将在下次使用时重新创建');
            this.appPage = null;
          });
          
          await this.appPage.goto('http://localhost:3000', { 
            waitUntil: 'networkidle',
            timeout: 15000
          });
          await this.appPage.waitForTimeout(1500);
          logger.info('重新创建应用页面成功');
        }
      }
      
      // 点击简历列表菜单项
      try {
        const resumeListButton = await this.appPage.$('text=简历列表');
        if (resumeListButton) {
          await resumeListButton.click();
          await this.appPage.waitForTimeout(1000);
          logger.info('成功导航到简历列表页面');
        }
      } catch (menuError) {
        logger.warn('点击简历列表菜单失败:', menuError.message);
      }
      
      // 点击上传简历按钮
      const uploadButton = await this.appPage.$('text=上传简历');
      if (uploadButton) {
        await uploadButton.click();
        await this.appPage.waitForTimeout(1000);
        logger.info('点击上传简历按钮');
      }
      
      // 选择文本粘贴选项
      const textPasteOption = await this.appPage.$('text=文本粘贴');
      if (textPasteOption) {
        await textPasteOption.click();
        await this.appPage.waitForTimeout(500);
        logger.info('选择文本粘贴选项');
      }
      
      // 在简历文本区域粘贴内容
      const resumeTextArea = await this.appPage.$('textarea[placeholder*="简历文本"], textarea[placeholder*="粘贴"], .ant-input');
      if (resumeTextArea) {
        await resumeTextArea.fill(resumeContent);
        await this.appPage.waitForTimeout(500);
        logger.info('简历内容已粘贴到文本区域');
      }
      
      // 选择简历来源为Boss直聘
      try {
        const sourceDropdown = await this.appPage.$('.ant-select-selector');
        if (sourceDropdown) {
          await sourceDropdown.click();
          await this.appPage.waitForTimeout(500);
          
          // 选择Boss直聘选项
          const bossZhipinOption = await this.appPage.$('text=Boss直聘');
          if (bossZhipinOption) {
            await bossZhipinOption.click();
            await this.appPage.waitForTimeout(500);
            logger.info('选择简历来源为Boss直聘');
          }
        }
      } catch (sourceError) {
        logger.warn('选择简历来源失败:', sourceError.message);
      }
      
      // 点击解析文本按钮
      const parseButton = await this.appPage.$('text=解析文本');
      if (parseButton) {
        await parseButton.click();
        await this.appPage.waitForTimeout(2000); // 减少等待时间
        logger.info('点击解析文本按钮，等待解析完成');
        
        // 调用确认添加逻辑，确保简历成功入库
        const addSuccess = await this.clickConfirmWithRetry(this.appPage);
        if (addSuccess) {
          logger.info(`第 ${candidateIndex + 1} 个候选人的简历添加成功`);
          // 等待一下确保操作完全完成
          await this.appPage.waitForTimeout(1500);
        } else {
          logger.error(`第 ${candidateIndex + 1} 个候选人的简历添加失败`);
        }
      } else {
        logger.error('未找到解析文本按钮');
      }
      
      logger.info(`第 ${candidateIndex + 1} 个候选人的简历处理完成`);
      
      // 简历处理完成后，应用页面和Boss直聘页面都保持打开状态，便于后续操作
      
    } catch (error) {
      logger.error('上传简历到应用失败:', error);
      
      // 检查是否是连接相关错误
      if (error.message.includes('Target closed') ||
          error.message.includes('Protocol error') ||
          error.message.includes('Session closed') ||
          error.message.includes('Navigation timeout')) {
        logger.error('检测到连接或超时问题，尝试恢复连接');
        await this.recoverFromConnectionError();
      }
    }
  }
  
  /**
   * 返回到候选人列表页面
   */
  async returnToCandidateList() {
    try {
      // 检查是否已停止浏览
      if (!this.browsingStatus.isActive) {
        logger.info('浏览已停止，终止返回操作');
        return;
      }
      
      // 优先尝试点击空白位置返回
      try {
        // 点击页面左上角空白区域
        await this.page.click('body', { position: { x: 50, y: 50 } });
        await this.page.waitForTimeout(1000);
        
        // 检查是否成功返回到列表页面
        const listIndicators = [
          '.card-item',
          '[class*="candidate"]',
          '[class*="list"]'
        ];
        
        for (const selector of listIndicators) {
          const elements = await this.page.$$(selector);
          if (elements.length > 1) {
            logger.info('通过点击空白位置成功返回候选人列表');
            return;
          }
        }
      } catch (error) {
        logger.warn('点击空白位置返回失败，尝试其他方式:', error.message);
      }
      
      // 尝试点击返回按钮
      const backButtons = [
        '.back-btn',
        '.return-btn', 
        '[class*="back"]',
        '[class*="return"]',
        '.close-btn',
        '[class*="close"]'
      ];
      
      for (const selector of backButtons) {
        try {
          const backBtn = await this.page.$(selector);
          if (backBtn) {
            await backBtn.click();
            await this.page.waitForTimeout(2000);
            logger.info('通过返回按钮返回候选人列表');
            return;
          }
        } catch (error) {
          // 继续尝试下一个选择器
        }
      }
      
      // 尝试按ESC键关闭
      try {
        await this.page.keyboard.press('Escape');
        await this.page.waitForTimeout(1000);
        logger.info('通过ESC键返回候选人列表');
        return;
      } catch (error) {
        logger.warn('ESC键返回失败:', error.message);
      }
      
      // 最后使用浏览器后退
      await this.page.goBack();
      await this.page.waitForTimeout(2000);
      logger.info('通过浏览器后退返回候选人列表');
      
    } catch (error) {
      logger.error('返回候选人列表失败:', error);
    }
  }
  
  /**
   * 处理iframe中的候选人卡片
   */
  async processCandidateCardsInIframe(frame, candidateCards) {
    try {
      logger.info('开始处理iframe中的候选人卡片...');
      
      // 检查是否已停止浏览
      if (!this.browsingStatus.isActive) {
        logger.info('浏览已停止，终止iframe中候选人卡片处理');
        return;
      }
      
      if (!frame) {
        logger.error('iframe frame对象无效');
        return;
      }
      
      // 限制处理数量
      const maxCards = Math.min(candidateCards.length, 5);
      logger.info(`将处理iframe中前 ${maxCards} 个候选人卡片`);
      
      // 在iframe中查找实际的卡片元素
      const cardElements = await frame.$$('li.card-item');
      
      for (let i = 0; i < Math.min(maxCards, cardElements.length); i++) {
        // 在每次处理前检查是否已停止浏览
        if (!this.browsingStatus.isActive) {
          logger.info('浏览已停止，终止iframe中候选人卡片处理');
          break;
        }
        
        try {
          logger.info(`处理iframe中第 ${i + 1} 个候选人卡片...`);
          await this.processSingleCandidateCardInIframe(frame, cardElements[i], i);
          
          // 处理间隔
          await this.page.waitForTimeout(2000);
          
        } catch (error) {
          logger.error(`处理iframe中第 ${i + 1} 个候选人卡片失败:`, error.message);
          continue;
        }
      }
      
      logger.info('iframe中候选人卡片处理完成');
      
    } catch (error) {
      logger.error('处理iframe中候选人卡片失败:', error);
    }
  }
  
  /**
   * 处理iframe中的单个候选人卡片
   */
  async processSingleCandidateCardInIframe(frame, cardElement, index) {
    try {
      logger.info(`点击iframe中第 ${index + 1} 个候选人卡片...`);
      
      // 在iframe中滚动到卡片位置
      await cardElement.scrollIntoViewIfNeeded();
      await frame.waitForTimeout(1000);
      
      // 点击候选人卡片
      await cardElement.click();
      await frame.waitForTimeout(3000);
      
      // 等待简历页面在iframe中加载
      await this.waitForResumePageLoadInIframe(frame);
      
      // 从iframe中提取简历内容
      const resumeContent = await this.extractResumeContentFromIframe(frame);
      
      if (resumeContent) {
        logger.info(`成功从iframe提取第 ${index + 1} 个候选人的简历内容`);
        
        // 上传简历到应用
        await this.uploadResumeToApp(resumeContent, index);
        
      } else {
        logger.warn(`iframe中第 ${index + 1} 个候选人简历内容提取失败`);
      }
      
      // 在iframe中返回到候选人列表
      await this.returnToCandidateListInIframe(frame);
      
    } catch (error) {
      logger.error(`处理iframe中单个候选人卡片失败:`, error.message);
      throw error;
    }
  }
  
  /**
   * 等待iframe中简历页面加载
   */
  async waitForResumePageLoadInIframe(frame) {
    try {
      await frame.waitForTimeout(2000);
      
      const resumeIndicators = [
        '.resume-content',
        '.profile-content',
        '.user-detail',
        '[class*="resume"]',
        '[class*="profile"]',
        '[class*="detail"]'
      ];
      
      for (const selector of resumeIndicators) {
        try {
          await frame.waitForSelector(selector, { timeout: 3000 });
          logger.info(`iframe简历页面加载完成，找到元素: ${selector}`);
          return;
        } catch (error) {
          // 继续尝试下一个选择器
        }
      }
      
      logger.info('iframe简历页面加载完成（通用等待）');
      
    } catch (error) {
      logger.warn('等待iframe简历页面加载失败:', error.message);
    }
  }
  
  /**
   * 从iframe中提取简历内容
   */
  async extractResumeContentFromIframe(frame) {
    try {
      this.assertCandidateActive();
      // 首先尝试提取canvas#resume中的文字内容
      this.setCandidatePhase('copying_canvas_resume');
      const canvasContent = await this.extractCanvasResumeContent(frame, { skipOcr: true });
      this.assertCandidateActive();
      if (canvasContent) {
        const quality = assessBossResumeText(canvasContent);
        if (quality.valid) {
          logger.info(`从canvas#resume提取简历内容成功，长度: ${canvasContent.length}`);
          return canvasContent;
        }
        logger.warn(`BOSS Canvas 复制内容缺少简历证据，尝试页面正文或 OCR: ${quality.reason}`);
      }
      
      // 如果canvas提取失败，使用原有的选择器方式
      let resumeContent;
      this.setCandidatePhase('reading_resume_text');
      try { resumeContent = await frame.evaluate(() => {
        // 优先检测resume-detail-wrap组件（在线简历内容）
        const resumeDetailWrap = document.querySelector('.resume-detail-wrap');
        if (resumeDetailWrap) {
          // 克隆元素以避免修改原DOM
          const clonedElement = resumeDetailWrap.cloneNode(true);
          
          // 移除不需要的组件内容
          const excludeSelectors = [
            '.resume-warning',
            '.resume-anonymous-geek-card.v2'
          ];
          
          excludeSelectors.forEach(selector => {
            const elementsToRemove = clonedElement.querySelectorAll(selector);
            elementsToRemove.forEach(el => el.remove());
          });
          
          const content = clonedElement.textContent.trim();
          if (content.length >= 60) {
            return {
              content: content,
              source: '.resume-detail-wrap (iframe在线简历)'
            };
          }
        }
        
        // 尝试其他方式获取简历内容
        const contentSelectors = [
          '.resume-content',
          '.profile-content', 
          '.user-detail',
          '.candidate-detail',
          '.talent-detail'
        ];
        
        for (const selector of contentSelectors) {
          const element = document.querySelector(selector);
          if (element && element.textContent.trim().length >= 60) {
            return {
              content: element.textContent.trim(),
              source: selector
            };
          }
        }
        
        return null;
      }); } catch (error) {
        logger.warn(`读取 BOSS 简历页面文字失败，尝试 Canvas OCR: ${error.message}`);
      }
      this.assertCandidateActive();
      
      if (resumeContent) {
        const quality = assessBossResumeText(resumeContent.content);
        if (isTrustedBossResumeSource(resumeContent.source) && quality.valid) {
          logger.info(`iframe简历内容提取成功，来源: ${resumeContent.source}，长度: ${resumeContent.content.length}`);
          return resumeContent.content;
        }
        logger.warn(`BOSS iframe 文本不是可信简历正文，来源: ${resumeContent.source}，原因: ${quality.reason || '来源不是简历容器'}；尝试 Canvas OCR`);
      }
      
      return await this.extractCanvasOcrContent(frame);
      
    } catch (error) {
      if (error.code?.startsWith('BOSS_')) throw error;
      logger.error('从iframe提取简历内容失败:', error);
      return null;
    }
  }
  
  /**
   * 查找包含简历内容的特定iframe
   */
  async findResumeIframe(page) {
    try {
      this.assertCandidateActive();
      // 查找所有iframe元素
      const iframes = await page.$$('iframe');
      this.assertCandidateActive();
      
      for (const iframe of iframes) {
        this.assertCandidateActive();
        // 获取iframe的src属性
        const src = await iframe.getAttribute('src');
        this.assertCandidateActive();
        
        let resumeFrameUrl;
        try { resumeFrameUrl = new URL(src, 'https://www.zhipin.com'); }
        catch (_) { continue; }
        // Resume dialogs can originate from search or recommendation and the
        // query parameters can change order. Only use the official BOSS frame.
        if (resumeFrameUrl.origin === 'https://www.zhipin.com' &&
            /^\/web\/frame\/c-resume\/?$/.test(resumeFrameUrl.pathname)) {
          logger.info(`找到简历iframe，src: ${src}`);
          
          // 获取iframe的contentFrame
          const frame = await iframe.contentFrame();
          this.assertCandidateActive();
          if (frame) {
            // 等待iframe内容加载
            await frame.waitForTimeout(1000);
            this.assertCandidateActive();
            return frame;
          }
        }
      }
      
      logger.warn('未找到包含简历内容的iframe');
      return null;
      
    } catch (error) {
      if (error.code?.startsWith('BOSS_')) throw error;
      logger.error('查找简历iframe失败:', error);
      return null;
    }
  }

  // Browser automation promises have no built-in deadline here. Abort the
  // copy attempt before continuing to the next extraction strategy.
  async runCanvasCopyWithDeadline(copy, timeoutMs, label) {
    this.assertCandidateActive();
    const controller = new AbortController();
    const parentSignal = this.activeCandidateAttempt?.controller.signal;
    const abortWithCandidate = () => controller.abort();
    if (parentSignal?.aborted) controller.abort();
    else parentSignal?.addEventListener('abort', abortWithCandidate, { once: true });
    let timer;
    try {
      const content = await Promise.race([
        Promise.resolve().then(() => copy(controller.signal)),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error(`BOSS ${label}复制超过${timeoutMs}毫秒`));
          }, timeoutMs);
        })
      ]);
      this.assertCandidateActive();
      return content;
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', abortWithCandidate);
    }
  }

  /**
   * 从canvas#resume元素中提取文字内容（优先使用Hook方式）
   */
  async extractCanvasResumeContent(frame, { skipOcr = false } = {}) {
    try {
      this.assertCandidateActive();
      logger.info('开始从canvas#resume提取简历内容（优先使用Hook方式）');
      
      // 方法1：优先使用Hook方式复制（推荐）
      try {
        logger.info('开始使用Hook方式复制技术');
        
        const hookText = await this.runCanvasCopyWithDeadline(signal =>
          this.dragSelectionService.copyResumeByHook(this.page, {
            frame,
            frameSelector: '/web/frame/c-resume/?source=search',
            canvasSelector: 'canvas#resume',
            margin: 5,
            dragSteps: 30,
            waitTime: 500,
            signal
          }), this.canvasCopyTimeoutMs.hook, 'Hook');
        
        if (hookText && hookText.trim()) {
          const quality = assessBossResumeText(hookText);
          if (quality.valid) {
            logger.info(`Hook方式复制成功，获取到 ${hookText.length} 个字符的内容`);
            return hookText;
          }
          logger.warn(`Hook方式复制的文本缺少简历证据: ${quality.reason}`);
          throw new Error('Hook方式复制未获取到可信简历正文');
        } else {
          logger.warn('Hook方式复制未获取到有效内容');
          throw new Error('Hook方式复制未获取到有效内容');
        }
      } catch (hookError) {
        this.assertCandidateActive();
        logger.warn('Hook方式复制失败，尝试传统拖拽选区方式:', hookError);
        
        // 方法2：备选使用传统拖拽选区复制
        try {
          logger.info('开始使用传统拖拽选区复制技术');
          
          if (typeof this.dragSelectionService.copyResumeByDragSelection !== 'function') {
            throw new Error('传统拖拽复制方法未实现');
          }
          const dragText = await this.runCanvasCopyWithDeadline(signal =>
            this.dragSelectionService.copyResumeByDragSelection(this.page, {
              frameSelector: 'iframe[src*="c-resume"]',
              canvasSelector: 'canvas#resume',
              margin: 5,
              dragSteps: 30,
              waitTime: 500,
              checkPermissions: true,
              signal
            }), this.canvasCopyTimeoutMs.drag, '拖拽');
          
          if (dragText && dragText.trim()) {
            const quality = assessBossResumeText(dragText);
            if (quality.valid) {
              logger.info(`传统拖拽选区复制成功，获取到 ${dragText.length} 个字符的内容`);
              return dragText;
            }
            logger.warn(`拖拽选区复制的文本缺少简历证据: ${quality.reason}`);
            throw new Error('拖拽选区复制未获取到可信简历正文');
          } else {
            logger.warn('传统拖拽选区复制未获取到有效内容');
            throw new Error('传统拖拽选区复制未获取到有效内容');
          }
        } catch (dragError) {
          this.assertCandidateActive();
          logger.warn('传统拖拽选区复制也失败，尝试 Canvas OCR:', dragError.message);
        }
      }

      this.assertCandidateActive();
      return skipOcr ? null : await this.extractCanvasOcrContent(frame);
    } catch (error) {
      if (error.code?.startsWith('BOSS_')) throw error;
      logger.error('从canvas#resume提取内容失败:', error);
      return null;
    }
  }

  async extractCanvasOcrContent(frame) {
    try {
      this.assertCandidateActive();
      // OCR only a visible resume canvas after text extraction fails. An
      // official verification/login page must pause collection, not be OCR'd.
      const canvasVisible = await frame.locator('canvas#resume').first().isVisible()
        .catch(() => false);
      this.assertCandidateActive();
      if (!canvasVisible) return null;
      await this.assertCollectorReady(frame);
      this.assertCandidateActive();
      try {
        this.setCandidatePhase('recognizing_canvas_resume');
        const ocrText = await this.canvasOcrService.captureAndRecognizeCanvas(frame, 'canvas#resume');
        this.assertCandidateActive();
        await this.assertCollectorReady(frame);
        this.assertCandidateActive();
        const quality = assessBossResumeText(ocrText);
        if (quality.valid) {
          logger.info(`Canvas OCR 提取到 ${ocrText.trim().length} 个字符`);
          return ocrText.trim();
        }
        logger.warn(`Canvas OCR 缺少可信简历正文，未作为简历入库: ${quality.reason}`);
      } catch (ocrError) {
        if (ocrError.code?.startsWith('BOSS_')) throw ocrError;
        logger.warn(`Canvas OCR 失败，未作为简历入库: ${ocrError.message}`);
      }
      return null;
    } catch (error) {
      if (error.code?.startsWith('BOSS_')) throw error;
      logger.warn(`Canvas OCR 不可用，未作为简历入库: ${error.message}`);
      return null;
    }
  }




  



  
  /**
   * 在iframe中返回到候选人列表
   */
  async returnToCandidateListInIframe(frame) {
    try {
      const backButtons = [
        '.back-btn',
        '.return-btn', 
        '[class*="back"]',
        '[class*="return"]'
      ];
      
      for (const selector of backButtons) {
        try {
          const backBtn = await frame.$(selector);
          if (backBtn) {
            await backBtn.click();
            await frame.waitForTimeout(2000);
            logger.info('通过返回按钮返回iframe候选人列表');
            return;
          }
        } catch (error) {
          // 继续尝试下一个选择器
        }
      }
      
      // iframe中可能需要特殊的返回处理
      logger.info('iframe中未找到返回按钮，等待页面自动刷新');
      await frame.waitForTimeout(2000);
      
    } catch (error) {
      logger.error('iframe中返回候选人列表失败:', error);
    }
  }
  
  /**
   * 检测和分析iframe
   */
  async detectAndAnalyzeIframes() {
    try {
      logger.info('检测页面中的iframe...');
      
      // 等待iframe加载
      await this.page.waitForTimeout(2000);
      
      // 查找所有iframe
      const iframes = await this.page.$$('iframe');
      logger.info(`发现 ${iframes.length} 个iframe`);
      
      if (iframes.length === 0) {
        logger.info('未发现iframe，继续常规页面分析');
        return { hasIframes: false };
      }
      
      // 分析每个iframe
      for (let i = 0; i < iframes.length; i++) {
        const iframe = iframes[i];
        
        try {
          // 获取iframe的src属性
          const src = await iframe.getAttribute('src');
          logger.info(`iframe ${i + 1} src: ${src}`);
          
          // 检查src是否包含候选人相关关键字
          if (src && this.isRelevantIframe(src)) {
            logger.info(`发现相关iframe: ${src}`);
            
            // 等待iframe内容加载
            await this.page.waitForTimeout(3000);
            
            // 获取iframe的frame对象
            const frame = await iframe.contentFrame();
            if (frame) {
              logger.info('成功获取iframe frame对象');
              
              // 在iframe内查找候选人卡片
              const candidateCards = await this.findCandidateCardsInFrame(frame);
              
              if (candidateCards.length > 0) {
                logger.info(`在iframe中发现 ${candidateCards.length} 个候选人卡片`);
                return {
                  hasIframes: true,
                  relevantFrame: frame,
                  candidateCards: candidateCards,
                  iframeSrc: src
                };
              }
            }
          }
        } catch (error) {
          logger.warn(`分析iframe ${i + 1} 时出错:`, error.message);
        }
      }
      
      return { hasIframes: true, relevantFrame: null };
      
    } catch (error) {
      logger.error('iframe检测失败:', error);
      return { hasIframes: false };
    }
  }
  
  /**
   * 判断iframe是否相关（包含候选人列表或详情页）
   */
  isRelevantIframe(src) {
    const keywords = [
      'geek', 'talent', 'candidate', 'resume', 'user',
      '牛人', '候选人', '简历', '人才',
      'recommend', 'list', 'detail'
    ];
    
    return keywords.some(keyword => 
      src.toLowerCase().includes(keyword.toLowerCase())
    );
  }
  
  /**
   * 在iframe中查找候选人卡片
   */
  async findCandidateCardsInFrame(frame) {
    try {
      // 等待iframe内容加载
      await frame.waitForTimeout(2000);
      
      // 在iframe中查找候选人卡片
      const candidateCards = await frame.evaluate(() => {
        const cards = [];
        
        // 主要选择器：li.card-item
        const cardItems = document.querySelectorAll('li.card-item');
        
        cardItems.forEach((card, index) => {
          cards.push({
            index: index,
            className: card.className,
            textContent: (card.textContent || '').substring(0, 100),
            hasDataV: card.hasAttribute('data-v-b753c1ac')
          });
        });
        
        return cards;
      });
      
      logger.info(`iframe中找到 ${candidateCards.length} 个候选人卡片`);
      return candidateCards;
      
    } catch (error) {
      logger.warn('在iframe中查找候选人卡片失败:', error.message);
      return [];
    }
  }
  
  /**
   * 重试页面分析
   */
  async retryPageAnalysis() {
    try {
      // A changing BOSS page must be left to the user. Reloading here can
      // repeat an official verification redirect and invalidate their login.
      await this.assertCollectorReady();
    } catch (error) {
      logger.warn('BOSS 页面分析已暂停，等待人工确认:', error.message);
    }
  }
  
  /**
   * 尝试不同的页面交互
   */
  async tryDifferentInteractions() {
    try {
      // 尝试点击不同的标签或按钮
      const interactionSelectors = [
        'a[href*="recommend"]',
        'button[class*="recommend"]',
        'div[class*="tab"]',
        'li[class*="tab"]',
        '.nav-item',
        '.menu-item'
      ];
      
      for (const selector of interactionSelectors) {
        try {
          const element = await this.page.$(selector);
          if (element) {
            await element.click();
            await this.page.waitForTimeout(2000);
            break;
          }
        } catch (error) {
          // 继续尝试下一个
        }
      }
      
    } catch (error) {
      logger.warn('页面交互尝试失败:', error);
    }
  }
  
  /**
   * 检查页面状态
   */
  async checkPageState() {
    try {
      const pageState = await this.page.evaluate(() => {
        return {
          readyState: document.readyState,
          hasJavaScript: typeof window.jQuery !== 'undefined' || typeof window.Vue !== 'undefined',
          totalElements: document.querySelectorAll('*').length,
          hasAsyncContent: document.querySelectorAll('[data-v-355e62b0], [data-v-5b6c77c0], [data-v-b753c1ac]').length > 0,
          currentUrl: window.location.href,
          pageTitle: document.title
        };
      });
      
      logger.info('页面状态检查:', JSON.stringify(pageState, null, 2));
      
    } catch (error) {
      logger.warn('页面状态检查失败:', error);
    }
  }
  
  /**
   * 从分析失败中恢复
   */
  async recoverFromAnalysisFailure() {
    logger.warn('BOSS 页面分析失败，已断开自动化连接，等待人工确认');
    await this.suspendAutomation('unstable_page');
  }

  /**
   * 模拟人类行为 - 随机鼠标移动和滚动
   */
  async simulateHumanBehavior() {
    try {
      // 随机鼠标移动
      const viewport = await this.page.viewportSize();
      const randomX = Math.floor(Math.random() * viewport.width);
      const randomY = Math.floor(Math.random() * viewport.height);
      
      await this.page.mouse.move(randomX, randomY, { steps: 10 });
      await this.page.waitForTimeout(Math.random() * 1000 + 500);
      
      // 随机小幅滚动
      await this.page.mouse.wheel(0, Math.random() * 200 - 100);
      await this.page.waitForTimeout(Math.random() * 500 + 200);
      
    } catch (error) {
      logger.warn('模拟人类行为失败:', error);
    }
  }
  
  /**
   * 等待页面完全加载 - 多种策略
   */
  async waitForPageFullyLoaded() {
    try {
      // 策略1: 等待网络空闲
      await this.page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      
      // 策略2: 等待DOM内容加载
      await this.page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
      
      // 策略3: 等待特定时间
      await this.page.waitForTimeout(3000);
      
      // 策略4: 等待页面中有内容出现
      await this.page.waitForFunction(() => {
        return document.querySelectorAll('div').length > 10;
      }, { timeout: 5000 }).catch(() => {});
      
    } catch (error) {
      logger.warn('等待页面加载失败:', error);
    }
  }
  
  /**
   * 尝试触发页面内容加载
   */
  async triggerContentLoading() {
    try {
      // 滚动到页面顶部
      await this.page.evaluate(() => window.scrollTo(0, 0));
      await this.page.waitForTimeout(1000);
      
      // 缓慢滚动到页面中部
      await this.page.evaluate(() => {
        const scrollHeight = document.body.scrollHeight;
        window.scrollTo(0, scrollHeight / 3);
      });
      await this.page.waitForTimeout(2000);
      
      // 尝试点击可能的加载按钮或区域
      const loadTriggers = [
        'button[class*="load"]',
        'div[class*="load"]',
        'a[class*="more"]',
        '.load-more',
        '.show-more'
      ];
      
      for (const selector of loadTriggers) {
        try {
          const element = await this.page.$(selector);
          if (element) {
            await element.click();
            await this.page.waitForTimeout(1000);
            break;
          }
        } catch (error) {
          // 忽略错误，继续尝试下一个
        }
      }
      
    } catch (error) {
      logger.warn('触发内容加载失败:', error);
    }
  }

  /**
   * 滚动页面加载更多候选人
   */
  async scrollToLoadMoreCandidates() {
    try {
      // 当页面候选人浏览完毕时，自动向下滚动刷新更多候选人
      await this.page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
      });
      await this.page.waitForTimeout(3000); // 等待新内容加载
      
      // 检查是否有加载更多按钮
      const loadMoreButton = await this.page.$('button:has-text("加载更多"), button:has-text("更多")');
      if (loadMoreButton) {
        await loadMoreButton.click();
        await this.page.waitForTimeout(2000);
      }
      
    } catch (error) {
      logger.error('滚动加载更多候选人失败:', error);
    }
  }

  /**
   * 应用搜索筛选条件
   */
  /**
   * 应用搜索筛选条件（旧版本，保留兼容性）
   * @param {object} filters - 筛选条件对象
   */
  async applySearchFiltersLegacy(filters) {
    try {
      logger.info('应用搜索筛选条件:', filters);
      
      // 等待页面加载完成
      await this.page.waitForLoadState('networkidle');
      await this.page.waitForTimeout(2000);
      
      // 学历要求筛选
      if (filters.education && filters.education !== '') {
        logger.info(`设置学历要求筛选: ${filters.education}`);
        try {
          const educationSelectors = [
            'text=学历',
            'text=学历要求',
            'text=最低学历',
            '.filter-education',
            '[data-filter="education"]'
          ];
          
          for (const selector of educationSelectors) {
            const element = await this.page.$(selector);
            if (element) {
              await element.click();
              await this.page.waitForTimeout(500);
              
              const optionElement = await this.page.$(`text=${filters.education}`);
              if (optionElement) {
                await optionElement.click();
                await this.page.waitForTimeout(500);
                logger.info(`学历要求筛选设置成功: ${filters.education}`);
                break;
              }
            }
          }
        } catch (error) {
          logger.warn('学历要求筛选设置失败:', error.message);
        }
      }
      
      // 院校要求筛选
      if (filters.university && filters.university !== '') {
        logger.info(`设置院校要求筛选: ${filters.university}`);
        try {
          const universitySelectors = [
            'text=院校',
            'text=院校要求',
            'text=毕业院校',
            'text=学校类型',
            '.filter-university',
            '[data-filter="university"]'
          ];
          
          for (const selector of universitySelectors) {
            const element = await this.page.$(selector);
            if (element) {
              await element.click();
              await this.page.waitForTimeout(500);
              
              const optionElement = await this.page.$(`text=${filters.university}`);
              if (optionElement) {
                await optionElement.click();
                await this.page.waitForTimeout(500);
                logger.info(`院校要求筛选设置成功: ${filters.university}`);
                break;
              }
            }
          }
        } catch (error) {
          logger.warn('院校要求筛选设置失败:', error.message);
        }
      }
      
      // 经验要求筛选
      if (filters.experience && filters.experience !== '') {
        logger.info(`设置经验要求筛选: ${filters.experience}`);
        try {
          const experienceSelectors = [
            'text=工作经验',
            'text=经验要求',
            'text=工作年限',
            '.filter-experience',
            '[data-filter="experience"]'
          ];
          
          for (const selector of experienceSelectors) {
            const element = await this.page.$(selector);
            if (element) {
              await element.click();
              await this.page.waitForTimeout(500);
              
              const optionElement = await this.page.$(`text=${filters.experience}`);
              if (optionElement) {
                await optionElement.click();
                await this.page.waitForTimeout(500);
                logger.info(`经验要求筛选设置成功: ${filters.experience}`);
                break;
              }
            }
          }
        } catch (error) {
          logger.warn('经验要求筛选设置失败:', error.message);
        }
      }
      
      // 年龄要求筛选
      if (filters.age && filters.age !== '') {
        logger.info(`设置年龄要求筛选: ${filters.age}`);
        try {
          const ageSelectors = [
            'text=年龄',
            'text=年龄要求',
            'text=年龄范围',
            '.filter-age',
            '[data-filter="age"]'
          ];
          
          for (const selector of ageSelectors) {
            const element = await this.page.$(selector);
            if (element) {
              await element.click();
              await this.page.waitForTimeout(500);
              
              const optionElement = await this.page.$(`text=${filters.age}`);
              if (optionElement) {
                await optionElement.click();
                await this.page.waitForTimeout(500);
                logger.info(`年龄要求筛选设置成功: ${filters.age}`);
                break;
              }
            }
          }
        } catch (error) {
          logger.warn('年龄要求筛选设置失败:', error.message);
        }
      }
      
      logger.info('筛选条件应用完成');
      
    } catch (error) {
      logger.error('应用搜索筛选条件失败:', error);
      throw error;
    }
  }
  


  /**
   * 等待iframe加载完成
   */
  async waitForIframeLoad() {
    try {
      logger.info('等待iframe加载完成...');
      await this.page.waitForTimeout(3000);
      
      // 等待iframe元素出现
      await this.page.waitForSelector('iframe', { timeout: 10000 });
      logger.info('iframe加载完成');
      
    } catch (error) {
      logger.warn('等待iframe加载超时:', error.message);
    }
  }

  /**
   * 获取搜索页面的iframe
   */
  async getSearchIframe() {
    try {
      const searchContainerIframe = await this.page.$('#searchContent iframe');
      if (searchContainerIframe) {
        const src = await searchContainerIframe.getAttribute('src') || '';
        if (!/recommend/i.test(src.split(/[?#]/)[0])) {
          const searchFrame = await searchContainerIframe.contentFrame();
          if (searchFrame && !searchFrame.isDetached?.() &&
              await searchFrame.locator(SEARCH_INPUT_SELECTOR).first().isVisible().catch(() => false)) {
            return searchFrame;
          }
        }
      }
      
      const iframes = await this.page.$$('iframe');
      
      for (let i = 0; i < iframes.length; i++) {
        const iframe = iframes[i];
        const src = await iframe.getAttribute('src') || '';
        const path = src.split(/[?#]/)[0];
        
        // The recommendation frame often contains candidate-like markup; it
        // must never be mistaken for an opened search page.
        if (/(?:search|geek|talent)/i.test(path) && !/recommend/i.test(path)) {
          const frame = await iframe.contentFrame();
          if (frame && !frame.isDetached?.() &&
              await frame.locator(SEARCH_INPUT_SELECTOR).first().isVisible().catch(() => false)) {
            return frame;
          }
        }
      }
      
      // 不猜测首个 iframe；广告或登录 iframe 可能排在搜索页之前。
      return null;
      
    } catch (error) {
      logger.error('获取搜索iframe失败:', error);
      return null;
    }
  }

  async getSearchContext() {
    const iframe = await this.getSearchIframe();
    if (iframe) return iframe;
    const url = this.page?.url?.() || '';
    const searchRoute = /\/web\/(?:boss|chat)\/[^?#]*search/i.test(url);
    const searchContainer = await this.page.locator('#searchContent').first()
      .isVisible().catch(() => false);
    if (!searchRoute && !searchContainer) return null;
    const input = this.page.locator(SEARCH_INPUT_SELECTOR).first();
    return await input.isVisible().catch(() => false) ? this.page : null;
  }

  /**
   * 在iframe中应用筛选条件
   */
  async applyFiltersInIframe(frame, filters, searchRecovery = { used: false }) {
    try {
      logger.info('在iframe中应用筛选条件:', filters);
      const keyword = String(filters.position || filters.keywords || '').trim();
      this.searchSubmittedByEnter = false;
      if (keyword) {
        const input = frame.locator(SEARCH_INPUT_SELECTOR).first();
        if (!await input.isVisible({ timeout: 5000 }).catch(() => false)) {
          throw new Error('未找到 BOSS 搜索关键词输入框');
        }
        await input.fill(keyword);
        await input.press('Enter');
        this.searchSubmittedByEnter = true;
      }
      
      // 等待筛选区域加载
      await (this.page || frame).waitForTimeout(2000);
      frame = await this.resolveCurrentSearchContext(frame, searchRecovery);
      
      // 定位筛选区域
      const filterContainer = await frame.$('div.check-params-options-content, div.check-params-options-content-1015gray, div.check-param-options-content-1013gray');
      if (!filterContainer) {
        logger.warn('未找到筛选区域容器');
        return frame;
      }
      
      logger.info('找到筛选区域容器');
      
      // 应用学历筛选
      if (filters.education && filters.education !== '不限') {
        await this.applyFilterOption(frame, filters.education, '学历');
      }
      
      // 应用院校筛选
      if (filters.university && filters.university !== '不限') {
        await this.applyFilterOption(frame, filters.university, '院校');
      }
      
      // 应用经验筛选
      if (filters.experience && filters.experience !== '不限') {
        await this.applyFilterOption(frame, filters.experience, '经验');
      }
      
      // 应用年龄筛选
      if (filters.age && filters.age !== '不限') {
        await this.applyFilterOption(frame, filters.age, '年龄');
      }
      
      logger.info('筛选条件应用完成');
      return frame;
      
    } catch (error) {
      logger.error('在iframe中应用筛选条件失败:', error);
      throw error;
    }
  }

  searchStateError(message, code = 'BOSS_SEARCH_STATE_UNCONFIRMED') {
    this.currentStatus = 'page_unavailable';
    const error = new Error(message);
    error.code = code;
    return error;
  }

  async resolveCurrentSearchContext(frame, recovery) {
    const usable = async target => Boolean(target && !target.isDetached?.() &&
      await target.locator(SEARCH_INPUT_SELECTOR).first().isVisible().catch(() => false));
    if (await usable(frame)) return frame;
    if (recovery.used) {
      throw this.searchStateError('BOSS 搜索区域再次重绘，无法确认当前关键词，已暂停采集',
        'BOSS_SEARCH_FRAME_UNAVAILABLE');
    }
    recovery.used = true;
    await this.assertCollectorReady();
    await this.page.waitForTimeout(750);
    const restored = await this.getSearchContext();
    if (!await usable(restored)) {
      throw this.searchStateError('BOSS 搜索区域重绘后未恢复可见输入框，已暂停采集',
        'BOSS_SEARCH_FRAME_UNAVAILABLE');
    }
    await this.assertCollectorReady(restored);
    return restored;
  }

  async readSearchResultState(frame) {
    return frame.evaluate(cardSelectors => {
      const visible = element => Boolean(element?.getClientRects().length &&
        window.getComputedStyle(element).visibility !== 'hidden');
      const cards = document.querySelectorAll(cardSelectors).length;
      const empty = [...document.querySelectorAll(
        '.empty-page, .empty-content, .no-result, .no-data, [class*="empty-result"]'
      )].some(element => visible(element) &&
        /暂无|没有找到|未找到|无搜索结果|无符合条件/.test(element.innerText || ''));
      const loading = [...document.querySelectorAll(
        '.loading, .ant-spin, [class*="loading-spinner"]'
      )].some(visible);
      return { cards, empty, loading };
    }, SEARCH_CARD_SELECTORS.join(', '));
  }

  async confirmSubmittedSearch(frame, keyword, recovery = { used: false }) {
    const normalized = value => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
    const expected = normalized(keyword);
    if (!expected) throw this.searchStateError('BOSS 搜索关键词为空，已暂停采集');
    let context = frame;
    for (let attempt = 0; attempt < 7; attempt++) {
      context = await this.resolveCurrentSearchContext(context, recovery);
      await this.assertCollectorReady(context);
      let actual;
      try {
        actual = normalized(await context.locator(SEARCH_INPUT_SELECTOR).first()
          .inputValue({ timeout: 2500 }));
      } catch (error) {
        if (context.isDetached?.()) {
          context = await this.resolveCurrentSearchContext(context, recovery);
          continue;
        }
        throw this.searchStateError(`BOSS 无法核验当前搜索关键词，已暂停采集: ${error.message}`);
      }
      if (actual !== expected) {
        throw this.searchStateError('BOSS 搜索框关键词与当前岗位不一致，已暂停采集',
          'BOSS_SEARCH_KEYWORD_MISMATCH');
      }
      let state;
      try { state = await this.readSearchResultState(context); }
      catch (error) {
        if (context.isDetached?.()) {
          context = await this.resolveCurrentSearchContext(context, recovery);
          continue;
        }
        throw this.searchStateError(`BOSS 无法核验搜索结果，已暂停采集: ${error.message}`);
      }
      if (!state.loading && (state.cards > 0 || state.empty)) return context;
      if (attempt < 6) await this.page.waitForTimeout(650);
    }
    throw this.searchStateError('BOSS 搜索结果未出现或仍在加载，已暂停采集');
  }

  /**
   * 应用单个筛选选项
   */
  async applyFilterOption(frame, optionText, filterType) {
    try {
      logger.info(`应用${filterType}筛选: ${optionText}`);
      
      // 等待页面稳定
      await frame.waitForTimeout(1000);
      
      // 多种选择器策略查找筛选选项
      const selectors = [
        `text=${optionText}`,
        `[title="${optionText}"]`,
        `span:has-text("${optionText}")`,
        `div:has-text("${optionText}")`,
        `li:has-text("${optionText}")`,
        `a:has-text("${optionText}")`
      ];
      
      let optionElement = null;
      for (const selector of selectors) {
        try {
          optionElement = await frame.$(selector);
          if (optionElement) {
            // 检查元素是否可见
            const isVisible = await optionElement.isVisible();
            if (isVisible) {
              break;
            } else {
              optionElement = null;
            }
          }
        } catch (e) {
          // 继续尝试下一个选择器
          continue;
        }
      }
      
      if (optionElement) {
        // 滚动到元素可见位置
        await optionElement.scrollIntoViewIfNeeded();
        await frame.waitForTimeout(500);
        
        // 点击元素
        await optionElement.click();
        await frame.waitForTimeout(1000);
        logger.info(`${filterType}筛选应用成功: ${optionText}`);
      } else {
        logger.warn(`未找到${filterType}筛选选项: ${optionText}`);
      }
      
    } catch (error) {
      logger.warn(`应用${filterType}筛选失败:`, error.message);
    }
  }

  /**
   * 在iframe中执行搜索
   */
  async executeSearchInIframe(frame) {
    try {
      if (this.searchSubmittedByEnter) {
        await frame.waitForTimeout(2000);
        return;
      }
      logger.info('在iframe中执行搜索...');
      
      // 查找搜索图标并点击
      const searchIcon = await frame.$('i.icon-search');
      if (searchIcon) {
        await searchIcon.click();
        await frame.waitForTimeout(3000);
        logger.info('搜索执行成功');
      } else {
        logger.warn('未找到搜索图标，尝试其他搜索按钮');
        const searchButton = await frame.$('button[type="submit"], .search-btn, button:has-text("搜索")');
        if (searchButton) {
          await searchButton.click();
          await frame.waitForTimeout(3000);
          logger.info('搜索执行成功');
        } else {
          throw new Error('未找到 BOSS 搜索按钮，搜索未提交');
        }
      }
      
    } catch (error) {
      logger.error('在iframe中执行搜索失败:', error);
      throw error;
    }
  }

  /**
   * 处理搜索结果中的候选人
   */
  async processSearchResults(frame, targetCount = 3, {
    mode = 'search', expectedTitle = '', expectedJobId = ''
  } = {}) {
    logger.info('开始处理搜索结果中的候选人...');
    const recommended = mode === 'recommended';
    this.setCandidatePhase('searching');
    let isMainPageList = frame === this.page;
    const startedAt = Date.parse(this.browsingStatus.startTime) || Date.now();
    const initialSaved = this.browsingStatus.processedCount;
    const seen = this.browsingStatus.seenCandidateIds || new Set();
    this.browsingStatus.seenCandidateIds = seen;
    const failures = this.browsingStatus.failedCandidateAttempts || new Map();
    this.browsingStatus.failedCandidateAttempts = failures;
    let stalledRounds = 0;
    let noSaveRounds = 0;
    let scrollRounds = 0;
    let frameRecoveryUsed = false;
    const recoverDetachedSearchFrame = async () => {
      const unavailable = () => {
        this.currentStatus = 'page_unavailable';
        const error = new Error(recommended
          ? 'BOSS 推荐区域已重绘，未能安全找回当前岗位列表；已暂停采集'
          : 'BOSS 搜索区域已重绘，未能安全找回当前结果列表；已暂停采集');
        error.code = recommended ? 'BOSS_RECOMMEND_FRAME_UNAVAILABLE'
          : 'BOSS_SEARCH_FRAME_UNAVAILABLE';
        return error;
      };
      if (frameRecoveryUsed) throw unavailable();
      frameRecoveryUsed = true;
      // Inspect the stable parent first. Never click the search menu or change
      // URLs to recover an iframe; that can trigger repeated platform redirects.
      await this.assertCollectorReady();
      await this.page.waitForTimeout(600);
      const restored = recommended ? await this.getRecommendedFrame()
        : await this.getSearchContext();
      if (!restored || restored.isDetached?.()) throw unavailable();
      await this.assertCollectorReady(restored);
      await this.ensureResumeDialogClosed(restored);
      if (recommended) await this.assertRecommendedJob(restored,
        expectedTitle, expectedJobId);
      frame = restored;
      isMainPageList = frame === this.page;
      logger.warn(recommended
        ? 'BOSS 推荐 iframe 重绘，已重新确认岗位并取得列表一次'
        : 'BOSS 搜索 iframe 重绘，已从当前页面重新取得搜索列表一次');
    };
    const isDetachedFrameError = error => frame?.isDetached?.() ||
      /frame.*detached/i.test(error?.message || '');

    while (this.browsingStatus.isActive &&
        this.browsingStatus.processedCount - initialSaved < targetCount &&
        Date.now() - startedAt < MAX_SEARCH_RUNTIME_MS &&
        scrollRounds <= MAX_SEARCH_SCROLL_ROUNDS) {
      if (frame.isDetached?.()) await recoverDetachedSearchFrame();
      await this.assertCollectorReady(frame);
      if (!frame) throw new Error('BOSS 搜索页面已失效，请重新启动采集');
      await this.ensureResumeDialogClosed(frame);
      if (recommended) await this.assertRecommendedJob(frame,
        expectedTitle, expectedJobId);

      let cardSelector = null;
      const selectors = SEARCH_CARD_SELECTORS;
      try {
        for (const selector of selectors) {
          if (await frame.locator(selector).count()) {
            cardSelector = selector;
            break;
          }
        }
      } catch (error) {
        if (!isDetachedFrameError(error)) throw error;
        await recoverDetachedSearchFrame();
        continue;
      }

      const savedBeforeRound = this.browsingStatus.processedCount;
      let discovered = 0;
      if (cardSelector) {
        const count = Math.min(await frame.locator(cardSelector).count(), 1000);
        for (let index = 0; index < count && this.browsingStatus.isActive &&
            this.browsingStatus.processedCount - initialSaved < targetCount; index++) {
          await this.assertCollectorReady(frame);
          if (frame.isDetached?.()) break;
          if (recommended) await this.assertRecommendedJob(frame,
            expectedTitle, expectedJobId);
          const card = frame.locator(cardSelector).nth(index);
          let identity;
          try {
            identity = await this.getSearchCardIdentity(card, index);
          } catch (error) {
            logger.warn(`读取 BOSS 卡片标识失败: ${error.message}`);
            continue;
          }
          if (seen.has(identity.key)) continue;
          seen.add(identity.key);
          discovered++;

          let opened = false;
          let blocked = false;
          let frameDetached = false;
          const listUrl = this.page?.url?.() || '';
          const attempt = this.beginCandidateAttempt(index + 1);
          try {
            await this.ensureResumeDialogClosed(frame);
            this.assertCandidateActive();
            // The list may reorder between identity read and click. Bind the
            // action to the same expectId again immediately before opening.
            const currentCard = await this.findSearchCardByIdentity(
              frame, cardSelector, index, identity);
            const link = currentCard.locator('a[data-expect], a[data-contact]').first();
            if (await link.count()) await link.click();
            else await currentCard.click();
            this.assertCandidateActive();
            opened = true;
            await frame.waitForTimeout(1500);
            this.assertCandidateActive();
            await this.assertCollectorReady(frame);
            this.assertCandidateActive();
            this.setCandidatePhase('extracting_resume', attempt);
            const saved = await this.extractAndImportResume(frame, index + 1, identity.candidateId);
            this.assertCandidateActive();
            if (saved) {
              this.browsingStatus.processedCount++;
              this.saveCollectionProgress();
            } else {
              this.browsingStatus.skippedCount = (this.browsingStatus.skippedCount || 0) + 1;
            }
          } catch (error) {
            if (attempt.expired || attempt.cancelled) {
              try { this.assertCandidateActive(); } catch (cancelError) { error = cancelError; }
            }
            if (['ENOSPC', 'SQLITE_FULL', 'SQLITE_IOERR', 'SQLITE_CORRUPT']
              .includes(error.code)) error.code = 'BOSS_STORAGE_ERROR';
            if (!error.code?.startsWith('BOSS_') && isDetachedFrameError(error) &&
                !attempt.expired && !attempt.cancelled) {
              frameDetached = true;
              seen.delete(identity.key);
              logger.warn('BOSS 搜索 iframe 在候选人提取时重绘，将重新取得当前搜索列表');
            } else {
              blocked = Boolean(error.code && error.code.startsWith('BOSS_'));
              this.browsingStatus.lastFailureCode = error.code || 'BOSS_CANDIDATE_ERROR';
              if (blocked) throw error;
              this.browsingStatus.skippedCount = (this.browsingStatus.skippedCount || 0) + 1;
              const attempts = (failures.get(identity.key) || 0) + 1;
              failures.set(identity.key, attempts);
              if (attempts < 2) seen.delete(identity.key);
              logger.warn(`处理 BOSS 候选人卡片失败: ${error.message}`);
              if (attempts < 2) await frame.waitForTimeout(1500);
            }
          } finally {
            let closeError = null;
            if (opened && !blocked && this.browsingStatus.isActive) {
              this.setCandidatePhase('returning_to_search', attempt);
              if (isMainPageList && this.page.url() !== listUrl) {
                try {
                  await this.page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 });
                } catch (error) { closeError = error; }
              } else {
                try { await this.closeResumeAndReturnToList(frame); }
                catch (error) { closeError = error; }
              }
            }
            let interruptionError = null;
            try { this.assertCandidateActive(); }
            catch (error) { interruptionError = error; }
            this.finishCandidateAttempt(attempt);
            if (interruptionError) throw interruptionError;
            if (closeError) throw closeError;
          }
          if (frameDetached) {
            await recoverDetachedSearchFrame();
            break;
          }
        }
      }

      if (this.browsingStatus.processedCount - initialSaved >= targetCount) break;
      stalledRounds = discovered ? 0 : stalledRounds + 1;
      noSaveRounds = this.browsingStatus.processedCount > savedBeforeRound ? 0 : noSaveRounds + 1;
      if (noSaveRounds >= MAX_NO_SAVE_SCROLL_ROUNDS) {
        const keyword = this.browsingStatus.currentKeyword || '当前关键词';
        const stalledKeywords = this.browsingStatus.stalledKeywords || [];
        if (!stalledKeywords.includes(keyword)) stalledKeywords.push(keyword);
        this.browsingStatus.stalledKeywords = stalledKeywords;
        this.saveCollectionProgress();
        logger.warn(`BOSS ${keyword} 连续 ${noSaveRounds} 轮无新增简历，停止当前关键词`);
        break;
      }
      if (stalledRounds >= MAX_STALLED_SCROLL_ROUNDS || scrollRounds >= MAX_SEARCH_SCROLL_ROUNDS) break;
      try {
        await this.scrollSearchResults(frame, cardSelector);
      } catch (error) {
        if (!isDetachedFrameError(error)) throw error;
        await recoverDetachedSearchFrame();
        continue;
      }
      scrollRounds++;
      await frame.waitForTimeout(2000);
    }

    this.browsingStatus.scrollRounds = (this.browsingStatus.scrollRounds || 0) + scrollRounds;
    if (Date.now() - startedAt >= MAX_SEARCH_RUNTIME_MS) {
      this.browsingStatus.lastError = 'BOSS 搜索达到单次运行时间上限，可从已入库结果继续采集';
      this.browsingStatus.completionReason = this.browsingStatus.lastError;
      this.browsingStatus.timeLimitReached = true;
    }
    logger.info(`BOSS 搜索结果处理完成：新增 ${this.browsingStatus.processedCount - initialSaved} 份，滚动 ${scrollRounds} 轮`);
  }

  async getSearchCardIdentity(card, index) {
    for (const attribute of ['data-expect-id', 'data-expect']) {
      const value = await card.getAttribute(attribute).catch(() => null);
      if (value) return { key: `id:${value}`, candidateId: value };
    }
    const expectLink = card.locator('a[data-expect]').first();
    const expectId = await expectLink.getAttribute('data-expect').catch(() => null);
    if (expectId) return { key: `id:${expectId}`, candidateId: expectId };
    const link = card.locator('a[href*="expectId"], a[href*="geekId"]').first();
    const href = await link.getAttribute('href').catch(() => null);
    if (href) {
      try {
        const url = new URL(href, 'https://www.zhipin.com');
        const candidateId = ['expectId', 'expectid', 'geekId', 'geekid']
          .map(key => url.searchParams.get(key)).find(Boolean);
        if (candidateId) return { key: `id:${candidateId}`, candidateId };
      } catch (_) { /* Fall back to visible card text. */ }
    }
    const cardId = await card.getAttribute('data-id').catch(() => null);
    if (cardId) return { key: `id:${cardId}`, candidateId: cardId };
    const text = (await card.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    if (text) return { key: `text:${resumeFingerprint(text)}`, candidateId: '' };
    throw new Error(`第 ${index + 1} 张候选人卡片缺少可用身份信息`);
  }

  async findSearchCardByIdentity(frame, cardSelector, index, identity) {
    const changed = () => {
      this.currentStatus = 'unstable_page';
      const error = new Error('BOSS 候选人列表在点击前重排，无法确认卡片身份，已暂停采集');
      error.code = 'BOSS_CARD_IDENTITY_CHANGED';
      return error;
    };
    let currentCard = null;
    const candidateId = String(identity?.candidateId || '');
    if (candidateId && candidateId.length <= 256 && !candidateId.includes('\0')) {
      const quoted = `"${candidateId.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
        .replace(/\n/g, '\\a ').replace(/\r/g, '\\d ').replace(/\f/g, '\\c ')}"`;
      const exactSelectors = [
        `${cardSelector}[data-expect-id=${quoted}]`,
        `${cardSelector}[data-expect=${quoted}]`,
        `${cardSelector}[data-id=${quoted}]`,
        `${cardSelector}:has(a[data-expect=${quoted}])`
      ];
      const matching = frame.locator(exactSelectors.join(', '));
      const count = await matching.count();
      if (count > 1) throw changed();
      if (count === 1) currentCard = matching.first();
    }
    if (!currentCard) currentCard = frame.locator(cardSelector).nth(index);
    let currentIdentity;
    try { currentIdentity = await this.getSearchCardIdentity(currentCard, index); }
    catch (_) { throw changed(); }
    if (currentIdentity.key !== identity.key) throw changed();
    return currentCard;
  }

  async scrollSearchResults(frame, cardSelector) {
    if (cardSelector) {
      await frame.locator(cardSelector).last().scrollIntoViewIfNeeded().catch(() => {});
    }
    await frame.evaluate(selector => {
      const cards = selector ? document.querySelectorAll(selector) : [];
      let container = cards.length ? cards[cards.length - 1].parentElement : null;
      while (container && container !== document.body && container !== document.documentElement) {
        if (container.scrollHeight > container.clientHeight + 32 &&
            /auto|scroll|overlay/.test(window.getComputedStyle(container).overflowY)) {
          container.scrollTop = container.scrollHeight;
          return;
        }
        container = container.parentElement;
      }
      const scrollingElement = document.scrollingElement || document.documentElement;
      scrollingElement.scrollTop = scrollingElement.scrollHeight;
    }, cardSelector);
  }

  /**
   * 提取并导入简历
   */
  async extractAndImportResume(frame, candidateIndex, sourceCandidateId = '') {
    try {
      logger.info(`提取第 ${candidateIndex} 个候选人简历...`);
      this.assertCandidateActive();
      
      // 等待在线简历加载
      await frame.waitForTimeout(2000);
      this.assertCandidateActive();
      
      const page = frame === this.page ? this.page : frame.page();
      let resumeContent = null;
      
      // 首先查找包含简历内容的特定iframe
      this.setCandidatePhase('locating_resume_frame');
      const resumeIframe = await this.findResumeIframe(page);
      this.assertCandidateActive();
      if (resumeIframe) {
        logger.info('找到简历iframe，开始提取iframe中的简历内容');
        this.setCandidatePhase('reading_resume_frame');
        resumeContent = await this.extractResumeContentFromIframe(resumeIframe);
        this.assertCandidateActive();
        
        if (resumeContent) {
          logger.info(`从iframe提取简历内容成功，长度: ${resumeContent.length}`);
        } else {
          logger.warn('在简历iframe中提取简历内容失败');
        }
      } else {
        logger.warn('未找到简历iframe，尝试从主页面提取简历内容');
      }
      
      // An official resume iframe means the parent page is the search list.
      // Never use that list as a fallback resume when the iframe has no text.
      if (!resumeContent && !resumeIframe) {
        logger.info('开始从主页面提取简历内容');
        this.setCandidatePhase('reading_resume_page');
        resumeContent = await this.extractResumeContentFromPage();
        this.assertCandidateActive();
        
        if (resumeContent) {
          logger.info(`从主页面提取简历内容成功，长度: ${resumeContent.length}`);
        } else {
          logger.warn('从主页面提取简历内容也失败');
        }
      }
      
      if (!resumeContent) {
        throw new Error('BOSS 简历内容未加载或不可访问');
      }
      this.assertCandidateActive();
      if (!this.browsingStatus.isActive) return false;
      // The model performs atomic/indexed deduplication. Loading the entire
      // BOSS library here would slow each later capture as the library grows.
      this.setCandidatePhase('saving_resume');
      const result = await this.saveResumeToDatabase(
        { sourceCandidateId }, resumeContent, undefined, { returnStatus: true });
      this.assertCandidateActive();
      if (!result.created) return false;
      logger.info(`第 ${candidateIndex} 个候选人简历已入库: ${result.resume.id}`);
      return result.resume;
      
    } catch (error) {
      logger.error('提取并导入简历失败:', error);
      throw error;
    }
  }

  /**
   * 复制内容到剪贴板
   */
  async copyToClipboard(content) {
    try {
      await this.page.evaluate((text) => {
        navigator.clipboard.writeText(text);
      }, content);
      logger.info('内容已复制到剪贴板');
    } catch (error) {
      logger.warn('复制到剪贴板失败:', error.message);
    }
  }

  /**
   * 导入简历到应用
   */
  async importResumeToApp(resumeContent, candidateIndex) {
    try {
      logger.info(`导入第 ${candidateIndex} 个候选人简历到应用...`);
      
      // 打开新标签页到应用前端
      const appPage = await this.browser.newPage();
      await appPage.goto('http://localhost:3000');
      await appPage.waitForTimeout(2000);
      
      // 定位到"简历列表"
      await appPage.click('text=简历列表');
      await appPage.waitForTimeout(1000);
      
      // 点击"上传简历"按钮
      await appPage.click('text=上传简历');
      await appPage.waitForTimeout(1000);
      
      // 定位Boss直聘简历文本框并粘贴内容
      const textArea = await appPage.$('textarea, .boss-resume-input, [placeholder*="Boss"], [placeholder*="简历"]');
      if (textArea) {
        await textArea.fill(resumeContent);
        await appPage.waitForTimeout(500);
        
        // 点击"解析Boss直聘简历"按钮
        await appPage.click('text=解析Boss直聘简历');
        
        // 等待解析开始（给系统一些时间开始处理）
        await appPage.waitForTimeout(3000);
        
        // 点击"确认添加"按钮，带重试机制（持续检测直到按钮可用）
        const addSuccess = await this.clickConfirmWithRetry(appPage);
        
        if (addSuccess) {
          logger.info(`第 ${candidateIndex} 个候选人简历添加成功`);
          // 等待一下确保操作完全完成
          await appPage.waitForTimeout(2000);
        } else {
          logger.error(`第 ${candidateIndex} 个候选人简历添加失败，已达到最大重试次数`);
          // 即使失败也要关闭页面，避免资源泄露
        }
      } else {
        logger.warn('未找到简历输入框');
      }
      
      // 关闭应用页面
      await appPage.close();
      
    } catch (error) {
      logger.error('导入简历到应用失败:', error);
    }
  }

  /**
   * 带重试机制的确认添加按钮点击
   * 检测"确认添加"按钮是否可用，当出现可点击按钮时立即点击，等待2秒后视为成功
   */
  async clickConfirmWithRetry(page) {
    logger.info('开始确认添加重试机制，持续检测直到按钮可用');
    
    let attemptCount = 0;
    while (true) {
      attemptCount++;
      try {
        logger.info(`第 ${attemptCount} 次尝试检测确认添加按钮状态...`);
        
        // 检查页面连接状态
        if (page.isClosed()) {
          logger.error('页面已关闭，无法继续操作');
          return false;
        }
        
        // 多种选择器策略查找确认添加按钮
        const confirmSelectors = [
          'text=确认添加',
          'button:has-text("确认添加")',
          '[class*="confirm"][class*="add"]',
          'button[type="submit"]',
          '.confirm-btn',
          '.add-btn'
        ];
        
        let confirmButton = null;
        for (const selector of confirmSelectors) {
          try {
            confirmButton = await page.$(selector);
            if (confirmButton) {
              const isVisible = await confirmButton.isVisible();
              const isEnabled = await confirmButton.isEnabled();
              if (isVisible && isEnabled) {
                logger.info(`检测到可用的确认添加按钮: ${selector}，简历解析已完成，立即点击`);
                
                // 立即点击确认添加按钮
                await confirmButton.click();
                logger.info('已点击确认添加按钮，等待2秒后视为本次简历添加成功');
                
                // 等待2秒后视为成功，准备返回Boss直聘
                await page.waitForTimeout(2000);
                logger.info('简历添加成功，准备返回Boss直聘继续下一个候选人');
                
                // 使用Promise延迟切换页面，避免在关键时刻触发连接断开
                this.schedulePageSwitch();
                
                return true;
              } else {
                // 按钮存在但不可用，记录状态并继续检测
                const visibleStatus = isVisible ? '可见' : '不可见';
                const enabledStatus = isEnabled ? '可用' : '不可用';
                logger.debug(`确认添加按钮状态: ${visibleStatus}, ${enabledStatus}`);
                confirmButton = null;
              }
            }
          } catch (e) {
            // 继续尝试下一个选择器
            continue;
          }
        }
        
        if (!confirmButton) {
          logger.debug(`第 ${attemptCount} 次检测：确认添加按钮尚未可用，简历仍在解析中`);
        }
        
        // 短暂等待后继续检测（减少等待时间，提高响应速度）
        await page.waitForTimeout(1000);
        
      } catch (error) {
        logger.warn(`第 ${attemptCount} 次检测确认添加按钮失败:`, error.message);
        
        // 检查是否是连接相关错误
        if (error.message.includes('Target closed') || 
            error.message.includes('Protocol error') ||
            error.message.includes('Session closed')) {
          logger.error('检测到连接断开，尝试恢复连接');
          const recovered = await this.recoverFromConnectionError();
          if (!recovered) {
            logger.error('连接恢复失败，停止重试');
            return false;
          }
          // 恢复成功后继续重试
          continue;
        }
        
        // 出错时也短暂等待
        await page.waitForTimeout(1000);
      }
    }
  }



  /**
   * 安全地调度页面切换，避免在WebSocket连接敏感期间进行操作
   */
  schedulePageSwitch() {
    // 清除之前的调度
    if (this.pageSwitchTimeout) {
      clearTimeout(this.pageSwitchTimeout);
    }
    
    // 激活页面切换保护机制
    if (this.io) {
      this.io.emit('activatePageSwitchProtection');
      logger.info('已发送页面切换保护激活信号');
    }
    
    // 使用更长的延迟，确保WebSocket连接稳定
    this.pageSwitchTimeout = setTimeout(async () => {
      try {
        logger.info('开始执行调度的页面切换...');
        
        // 检查连接状态，只有在连接稳定时才进行切换
        if (this.browser && this.browser.isConnected()) {
          await this.switchToBossZhipinPageSafely();
          logger.info('调度的页面切换已完成');
        } else {
          logger.warn('浏览器连接不稳定，跳过页面切换');
        }
      } catch (error) {
        logger.warn('调度的页面切换失败，但不影响后续流程:', error.message);
      } finally {
        this.pageSwitchTimeout = null;
      }
    }, 3000); // 增加到3秒延迟
  }

  /**
   * 安全的页面切换实现
   */
  async switchToBossZhipinPageSafely() {
    try {
      if (this.page && !this.page.isClosed()) {
        logger.info('正在安全切换回Boss直聘页面...');
        
        // 检查页面状态
        const pageState = await this.page.evaluate(() => {
          return {
            hidden: document.hidden,
            visibilityState: document.visibilityState,
            readyState: document.readyState
          };
        });
        
        logger.info('页面状态检查:', pageState);
        
        // 只有在页面完全加载且不可见时才进行切换
        if (pageState.readyState === 'complete' && pageState.hidden) {
          await this.page.bringToFront();
          await this.page.waitForTimeout(500);
          logger.info('已安全切换回Boss直聘页面');
        } else {
          logger.info('页面已可见或未完全加载，跳过切换操作');
        }
      } else {
        logger.warn('Boss直聘页面不可用，需要重新初始化');
        await this.reinitializeBossZhipinPage();
      }
    } catch (error) {
      logger.error('安全页面切换失败:', error.message);
      // 不抛出异常，避免影响后续流程
    }
  }

  /**
   * 重新初始化Boss直聘页面
   */
  async reinitializeBossZhipinPage() {
    logger.warn('BOSS 标签页不可用，已暂停自动化；不会重新建页或跳转');
    await this.suspendAutomation('disconnected');
  }

  /**
   * 切换回Boss直聘页面（旧版本，保持兼容性）
   */
  async switchToBossZhipinPage() {
    try {
      if (this.page && !this.page.isClosed()) {
        // 温和的页面切换，避免触发连接断开
        logger.info('正在切换回Boss直聘页面...');
        
        // 使用更温和的方式切换页面，避免强制前置
        try {
          // 先检查页面是否可见
          const isVisible = await this.page.evaluate(() => {
            return !document.hidden;
          });
          
          if (!isVisible) {
            // 只有在页面不可见时才进行切换
            await this.page.bringToFront();
          }
          
          // 减少等待时间，避免长时间阻塞
          await this.page.waitForTimeout(200);
          logger.info('已切换回Boss直聘页面');
        } catch (switchError) {
          logger.warn('页面切换过程中出现问题，但继续执行:', switchError.message);
        }
      } else {
        logger.warn('BOSS 标签页不可用，已暂停自动化；不会重新建页或跳转');
        await this.suspendAutomation('disconnected');
      }
    } catch (error) {
      logger.error('切换回Boss直聘页面失败:', error.message);
      // 即使切换失败也不抛出异常，避免影响后续流程
    }
  }

  /**
   * 关闭简历页面并返回列表
   */
  async ensureResumeDialogClosed(frame = null) {
    // A previous run may have been stopped while its official resume iframe
    // remained open. Only dismiss that exact dialog, after checking for login
    // and security challenges. An unfamiliar overlay must stop collection.
    await this.assertCollectorReady(frame);
    const page = this.page;
    const activeSelector = 'div[data-type="boss-dialog"].active';
    const blocked = (message, code = 'BOSS_RESUME_DIALOG_BLOCKED') => {
      const error = new Error(message);
      error.code = code;
      this.currentStatus = code === 'BOSS_VERIFICATION_REQUIRED'
        ? 'verification_required' : 'page_unavailable';
      return error;
    };
    if (!page || typeof page.locator !== 'function') {
      throw blocked('BOSS 搜索页面不可用，无法确认简历弹窗已关闭');
    }
    const dialog = page.locator(activeSelector).first();
    const visible = await dialog.isVisible().catch(error => {
      throw blocked(`BOSS 无法确认简历弹窗状态，已暂停采集: ${error.message}`);
    });
    if (!visible) return false;

    const iframe = dialog.locator('iframe').first();
    const src = await iframe.getAttribute('src').catch(() => '');
    if (VERIFICATION_URL.test(src) || /\/web\/user(?:\/|\?|$)|\/login(?:\/|\?|$)/i.test(src)) {
      throw blocked('BOSS 弹窗要求人工登录或安全验证，已暂停采集',
        'BOSS_VERIFICATION_REQUIRED');
    }
    let url;
    try { url = new URL(src, 'https://www.zhipin.com'); }
    catch (_) { /* Unknown overlay: do not dismiss it. */ }
    if (url?.origin !== 'https://www.zhipin.com' ||
        !/^\/web\/frame\/c-resume\/?$/.test(url.pathname)) {
      throw blocked('BOSS 页面有未识别的弹窗，已暂停采集；请在浏览器中确认');
    }
    const close = dialog.locator('.close-btn').first();
    if (!await close.isVisible().catch(() => false)) {
      throw blocked('BOSS 简历弹窗缺少可用关闭按钮，已暂停采集');
    }
    try {
      await close.click({ timeout: 3000, noWaitAfter: true });
      await dialog.waitFor({ state: 'hidden', timeout: 3000 });
    } catch (error) {
      throw blocked(`BOSS 简历弹窗未能关闭，已暂停采集: ${error.message}`);
    }
    await this.assertCollectorReady(frame);
    const remainsVisible = await page.locator(activeSelector).first().isVisible().catch(error => {
      throw blocked(`BOSS 无法确认弹窗已关闭，已暂停采集: ${error.message}`);
    });
    if (remainsVisible) {
      throw blocked('BOSS 简历弹窗仍遮挡搜索结果，已暂停采集');
    }
    logger.info('BOSS 官方简历弹窗已关闭，搜索列表可继续使用');
    return true;
  }

  async closeResumeAndReturnToList(frame) {
    this.assertCandidateActive();
    return this.ensureResumeDialogClosed(frame);
  }

  /**
   * 处理候选人详情
   */
  async processCandidateDetail() {
    try {
      // 获取候选人基本信息
      const candidateInfo = await this.extractCandidateInfo();
      
      // 检查简历质量
      const qualityScore = await this.assessResumeQuality(candidateInfo);
      
      // 更新浏览状态
      this.browsingStatus.processedCount++;
      this.browsingStatus.currentIndex++;
      
      // 添加候选人到列表
      const candidate = {
        ...candidateInfo,
        qualityScore,
        processedAt: new Date().toISOString(),
        action: null
      };
      
      // 如果质量分数达到标准，自动收藏
      if (qualityScore >= 70) {
        await this.favoriteCandidate();
        candidate.action = 'liked';
        this.browsingStatus.likedCount++;
        logger.info(`候选人 ${candidateInfo.name} 质量分数: ${qualityScore}，已自动收藏`);
      } else {
        candidate.action = 'skipped';
        this.browsingStatus.dislikedCount++;
        logger.info(`候选人 ${candidateInfo.name} 质量分数: ${qualityScore}，跳过`);
      }
      
      this.browsingStatus.candidates.push(candidate);
      
    } catch (error) {
      logger.error('处理候选人详情失败:', error);
    }
  }

  /**
   * 提取候选人信息
   */
  async extractCandidateInfo() {
    try {
      const info = await this.page.evaluate(() => {
        const name = document.querySelector('.candidate-name, [class*="name"]')?.textContent?.trim() || '';
        const position = document.querySelector('.candidate-position, [class*="position"]')?.textContent?.trim() || '';
        const company = document.querySelector('.candidate-company, [class*="company"]')?.textContent?.trim() || '';
        const experience = document.querySelector('.candidate-experience, [class*="experience"]')?.textContent?.trim() || '';
        const education = document.querySelector('.candidate-education, [class*="education"]')?.textContent?.trim() || '';
        const location = document.querySelector('.candidate-location, [class*="location"]')?.textContent?.trim() || '';
        const salary = document.querySelector('.candidate-salary, [class*="salary"]')?.textContent?.trim() || '';
        
        return { name, position, company, experience, education, location, salary };
      });
      
      return info;
    } catch (error) {
      logger.error('提取候选人信息失败:', error);
      return {};
    }
  }

  /**
   * 评估简历质量
   */
  async assessResumeQuality(candidateInfo) {
    try {
      let score = 0;
      
      // 基本信息完整性 (30分)
      if (candidateInfo.name) score += 10;
      if (candidateInfo.position) score += 10;
      if (candidateInfo.experience) score += 10;
      
      // 工作经验 (40分)
      if (candidateInfo.experience) {
        const expYears = parseInt(candidateInfo.experience.match(/\d+/)?.[0] || '0');
        if (expYears >= 3) score += 20;
        else if (expYears >= 1) score += 15;
        else score += 10;
      }
      
      // 教育背景 (20分)
      if (candidateInfo.education) {
        if (candidateInfo.education.includes('本科')) score += 15;
        else if (candidateInfo.education.includes('硕士')) score += 20;
        else if (candidateInfo.education.includes('博士')) score += 20;
        else score += 10;
      }
      
      // 地区匹配 (10分)
      if (candidateInfo.location && candidateInfo.location.includes('北京')) score += 10;
      
      return Math.min(score, 100);
    } catch (error) {
      logger.error('评估简历质量失败:', error);
      return 0;
    }
  }

  /**
   * 收藏候选人
   */
  async favoriteCandidate() {
    try {
      // 点击收藏按钮
      const favoriteBtn = await this.page.$('.favorite-btn, [class*="favorite"], [class*="star"]');
      if (favoriteBtn) {
        await favoriteBtn.click();
        await this.page.waitForTimeout(1000);
        logger.info('候选人收藏成功');
      }
    } catch (error) {
      logger.error('收藏候选人失败:', error);
    }
  }

  /**
   * 停止候选人浏览
   */
  async stopBrowsing() {
    try {
      this.browsingStatus.isActive = false;
      this.currentStatus = 'idle';
      this.browsingStatus.completionReason = '用户已停止采集';
      if (this.activeCandidateAttempt) {
        this.activeCandidateAttempt.cancelled = true;
        this.activeCandidateAttempt.controller.abort();
        this.setCandidatePhase('stopped');
        void this.canvasOcrService.destroy().catch(error =>
          logger.warn(`停止 BOSS 采集时关闭 OCR 失败: ${error.message}`));
        // Closing the CDP transport interrupts an in-flight Playwright call,
        // while leaving the separately launched Chrome and login intact.
        await this.detachAutomation({ status: 'idle', keepLogin: true });
      }
      this.saveCollectionProgress('paused');
      logger.info('候选人浏览已停止');
      return true;
    } catch (error) {
      logger.error('停止候选人浏览失败:', error);
      throw error;
    }
  }

  /**
   * 重置候选人浏览状态
   */
  async resetBrowsingStatus() {
    try {
      logger.info('正在重置Boss直聘候选人浏览状态...');
      
      // 停止当前浏览
      this.browsingStatus.isActive = false;
      this.currentStatus = 'idle';
      
      // 重置所有浏览状态数据
      this.browsingStatus = {
        isActive: false,
        mode: null,
        candidates: [],
        processedCount: 0,
        likedCount: 0,
        dislikedCount: 0,
        currentIndex: 0,
        filters: {},
        startTime: null,
        targetCount: 0
      };
      this.collectionSignature = null;
      this.collectionCheckpoint.clear();
      
      logger.info('Boss直聘候选人浏览状态已重置');
      return true;
      
    } catch (error) {
      logger.error('重置候选人浏览状态失败:', error);
      throw error;
    }
  }

  /**
   * 获取候选人浏览状态
   */
  getBrowsingStatus() {
    let checkpoint = null;
    let checkpointError = '';
    try { checkpoint = this.collectionCheckpoint.load(); }
    catch (error) { checkpointError = error.message; }
    const restored = !this.browsingStatus.startTime && checkpoint ? checkpoint : null;
    const progress = restored || this.browsingStatus;
    return {
      status: this.browsingStatus.isActive ? 'browsing' : this.currentStatus,
      mode: progress.mode,
      candidates: this.browsingStatus.candidates.slice(-10), // 只返回最近10个候选人
      processedCount: progress.processedCount,
      likedCount: this.browsingStatus.likedCount,
      dislikedCount: this.browsingStatus.dislikedCount,
      currentIndex: this.browsingStatus.currentIndex,
      filters: progress.filters,
      targetCount: progress.targetCount,
      currentKeyword: progress.currentKeyword,
      keywordsCompleted: progress.keywordsCompleted,
      keywordErrors: progress.keywordErrors,
      stalledKeywords: progress.stalledKeywords || [],
      lastError: checkpointError || progress.lastError || '',
      completionReason: progress.completionReason || '',
      currentPhase: this.browsingStatus.currentPhase || null,
      phaseStartedAt: this.browsingStatus.phaseStartedAt || null,
      candidateStartedAt: this.browsingStatus.candidateStartedAt || null,
      candidateDeadlineAt: this.browsingStatus.candidateDeadlineAt || null,
      attemptedCount: this.browsingStatus.attemptedCount || 0,
      skippedCount: this.browsingStatus.skippedCount || 0,
      lastFailureCode: this.browsingStatus.lastFailureCode || '',
      scrollRounds: this.browsingStatus.scrollRounds || 0,
      evaluationQueue: postCaptureEvaluationQueue.status(),
      startTime: this.browsingStatus.startTime,
      isActive: this.browsingStatus.isActive,
      resumeAvailable: Boolean(checkpoint && checkpoint.state !== 'completed' &&
        checkpoint.processedCount < checkpoint.targetCount && !this.browsingStatus.isActive),
      checkpointUpdatedAt: checkpoint?.updatedAt || null
    };
  }

  /**
   * 启动简历处理
   */
  async startResumeProcessing(settings = {}) {
    try {
      if (this.browsingStatus.isActive || this.resumeProcessingStatus.isActive) {
        throw new Error('BOSS 已有采集或简历处理任务正在运行');
      }
      try {
        this.activeJobSnapshot = new ActiveJobService().current();
      } catch (error) {
        logger.warn(`读取当前岗位配置失败，采集后自动评估将不可用: ${error.message}`);
        this.activeJobSnapshot = null;
      }
      this.currentStatus = 'processing_resumes';
      
      // 初始化简历处理状态
      this.resumeProcessingStatus = {
        isActive: true,
        resumes: [],
        processingCount: 0,
        completedCount: 0,
        failedCount: 0,
        currentIndex: 0,
        settings: settings,
        startTime: new Date().toISOString(),
        currentStatus: 'collecting'
      };
      
      logger.info('开始简历处理...', settings);
      
      // 异步执行简历处理任务，不阻塞响应
      this.executeResumeProcessingTask(settings).catch(error => {
        logger.error('简历处理任务执行失败:', error);
        this.resumeProcessingStatus.isActive = false;
        this.resumeProcessingStatus.currentStatus = 'idle';
        this.currentStatus = 'idle';
      });
      
      return true;
      
    } catch (error) {
      logger.error('启动简历处理失败:', error);
      if (!this.browsingStatus.isActive && !this.resumeProcessingStatus.isActive) {
        this.currentStatus = 'idle';
      }
      throw error;
    }
  }

  /**
   * 执行简历处理任务
   */
  async executeResumeProcessingTask(settings) {
    try {
      // 阶段1: 收集收藏的候选人
      this.resumeProcessingStatus.currentStatus = 'collecting';
      logger.info('开始收集收藏的候选人...');
      const favoriteCandidates = await this.getFavoriteCandidates();
      
      // 阶段2: 质量检测和处理
      this.resumeProcessingStatus.currentStatus = 'quality_checking';
      logger.info(`开始处理 ${favoriteCandidates.length} 个候选人的简历...`);
      
      for (let i = 0; i < favoriteCandidates.length; i++) {
        const candidate = favoriteCandidates[i];
        this.resumeProcessingStatus.currentIndex = i;
        
        try {
          // 阶段3: 解析简历内容
          this.resumeProcessingStatus.currentStatus = 'parsing';
          await this.processResume(candidate, settings);
          
          // 阶段4: 存储到数据库
          this.resumeProcessingStatus.currentStatus = 'storing';
          this.resumeProcessingStatus.completedCount++;
          
        } catch (error) {
          logger.error(`处理候选人 ${candidate.name} 的简历失败:`, error);
          this.resumeProcessingStatus.failedCount++;
        }
        
        this.resumeProcessingStatus.processingCount++;
      }
      
      // 处理完成
      this.resumeProcessingStatus.currentStatus = 'completed';
      this.resumeProcessingStatus.isActive = false;
      this.currentStatus = 'idle';
      logger.info('简历处理任务完成');
      
    } catch (error) {
      logger.error('简历处理任务失败:', error);
      this.resumeProcessingStatus.isActive = false;
      this.resumeProcessingStatus.currentStatus = 'idle';
      this.currentStatus = 'idle';
      throw error;
    }
  }

  /**
   * 获取收藏的候选人列表
   */
  async getFavoriteCandidates() {
    try {
      // 导航到收藏页面
      await this.page.click('text=收藏');
      await this.page.waitForTimeout(2000);
      
      // 获取收藏列表
      const candidates = await this.page.evaluate(() => {
        const items = document.querySelectorAll('.favorite-item, [class*="favorite"], [class*="collected"]');
        return Array.from(items).map(item => {
          const name = item.querySelector('.name, [class*="name"]')?.textContent?.trim() || '';
          const position = item.querySelector('.position, [class*="position"]')?.textContent?.trim() || '';
          const company = item.querySelector('.company, [class*="company"]')?.textContent?.trim() || '';
          
          return { name, position, company };
        });
      });
      
      return candidates;
    } catch (error) {
      logger.error('获取收藏候选人列表失败:', error);
      return [];
    }
  }

  /**
   * 处理单个简历
   */
  async processResume(candidate, settings) {
    try {
      logger.info(`开始处理候选人 ${candidate.name} 的简历...`);
      
      // 点击候选人查看详情
      await this.page.click(`text=${candidate.name}`);
      await this.page.waitForTimeout(2000);
      
      // 提取简历内容
      const resumeContent = await this.extractResumeContent();
      
      // 评估简历质量
      const qualityScore = await this.assessResumeQuality(candidate);
      
      // 创建简历记录
      const resume = {
        id: `resume_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        candidateInfo: candidate,
        content: resumeContent,
        qualityScore: qualityScore,
        status: 'processing',
        processedAt: new Date().toISOString(),
        saved: false
      };
      
      // 如果质量分数达到标准，自动处理
      if (qualityScore >= (settings.minQualityScore || 70)) {
        await this.saveResumeToDatabase(candidate, resumeContent, qualityScore);
        resume.status = 'completed';
        resume.saved = true;
        logger.info(`简历 ${candidate.name} 已自动入库`);
      } else {
        resume.status = 'skipped';
        logger.info(`简历 ${candidate.name} 质量分数不足，需要人工审核`);
      }
      
      // 添加到简历列表
      this.resumeProcessingStatus.resumes.push(resume);
      
    } catch (error) {
      logger.error(`处理简历 ${candidate.name} 失败:`, error);
      
      // 添加失败记录
      const failedResume = {
        id: `resume_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        candidateInfo: candidate,
        content: null,
        qualityScore: 0,
        status: 'failed',
        processedAt: new Date().toISOString(),
        saved: false,
        error: error.message
      };
      
      this.resumeProcessingStatus.resumes.push(failedResume);
      throw error;
    }
  }

  /**
   * 提取简历内容
   */
  async extractResumeContent() {
    try {
      const content = await this.page.evaluate(() => {
        // 优先检测resume-detail-wrap组件（在线简历内容）
        const resumeDetailWrap = document.querySelector('.resume-detail-wrap');
        if (resumeDetailWrap) {
          // 克隆元素以避免修改原DOM
          const clonedElement = resumeDetailWrap.cloneNode(true);
          
          // 移除不需要的组件内容
          const excludeSelectors = [
            '.resume-warning',
            '.resume-anonymous-geek-card.v2'
          ];
          
          excludeSelectors.forEach(selector => {
            const elementsToRemove = clonedElement.querySelectorAll(selector);
            elementsToRemove.forEach(el => el.remove());
          });
          
          const content = clonedElement.textContent.trim();
          if (content.length > 0) {
            return content;
          }
        }
        
        // 备用选择器
        const resumeElement = document.querySelector('.resume-content, [class*="resume"], [class*="profile"]');
        return resumeElement ? resumeElement.textContent.trim() : '';
      });
      
      return content;
    } catch (error) {
      logger.error('提取简历内容失败:', error);
      return '';
    }
  }

  /**
   * 保存简历到数据库
   */
  async saveResumeToDatabase(candidate, content, qualityScore, { returnStatus = false } = {}) {
    const quality = assessBossResumeText(content);
    if (!quality.valid) {
      const error = new Error(`BOSS 简历内容不符合入库条件: ${quality.reason}`);
      error.code = 'RESUME_CONTENT_INVALID';
      throw error;
    }
    candidate = candidate || {};
    const fingerprint = resumeFingerprint(content);
    const parsed = resumeParserService.parseResumeText(content);
    const result = await resumeModel.addResume({
      ...parsed,
      name: parsed.name || candidate.name || '未识别姓名',
      position: candidate.position || parsed.expectedPosition?.position || '',
      source: 'boss',
      platform: 'BOSS直聘',
      sourceUrl: this.page?.url() || '',
      sourceCandidateId: candidate.sourceCandidateId || '',
      sourceFingerprint: fingerprint,
      originalText: content,
      qualityScore: qualityScore ?? parsed.qualityScore,
      parseMethod: 'local',
      parseStatus: 'completed'
    }, { returnStatus: true });
    if (result.created && this.activeJobSnapshot?.jobRequirements) {
      try {
        postCaptureEvaluationQueue.enqueue(result.resume, this.activeJobSnapshot);
      } catch (error) {
        logger.warn(`BOSS 简历已入库，但自动评估排队失败: ${error.message}`);
      }
    }
    return returnStatus ? result : result.resume;
  }

  /**
   * 停止简历处理
   */
  async stopResumeProcessing() {
    try {
      this.resumeProcessingStatus.isActive = false;
      this.resumeProcessingStatus.currentStatus = 'idle';
      this.currentStatus = 'idle';
      logger.info('简历处理已停止');
      return true;
    } catch (error) {
      logger.error('停止简历处理失败:', error);
      throw error;
    }
  }

  /**
   * 获取简历处理状态
   */
  getResumeProcessingStatus() {
    return {
      status: this.resumeProcessingStatus.currentStatus,
      resumes: this.resumeProcessingStatus.resumes.slice(-10), // 只返回最近10个简历
      processingCount: this.resumeProcessingStatus.processingCount,
      completedCount: this.resumeProcessingStatus.completedCount,
      failedCount: this.resumeProcessingStatus.failedCount,
      currentIndex: this.resumeProcessingStatus.currentIndex,
      settings: this.resumeProcessingStatus.settings,
      startTime: this.resumeProcessingStatus.startTime,
      isActive: this.resumeProcessingStatus.isActive
    };
  }

  /**
   * 关闭浏览器
   */
  async closeBrowser() {
    try {
      this.shutdownRequested = true;
      this.browsingStatus.isActive = false;
      // 清理页面切换定时器
      if (this.pageSwitchTimeout) {
        clearTimeout(this.pageSwitchTimeout);
        this.pageSwitchTimeout = null;
        logger.info('页面切换定时器已清理');
      }
      await this.detachAutomation({ status: 'idle' });
      this.chromeWindowOpened = false;
      this.chromeTabUrl = null;
      if (this.canvasOcrService) await this.canvasOcrService.destroy();
      if (this.dragSelectionService) await this.dragSelectionService.cleanup();
      this.popupHandler = null;
      logger.info('已断开 BOSS 自动化连接；Chrome 登录窗口仍由用户保留');
    } catch (error) {
      logger.error('停止 BOSS 自动化连接失败:', error);
    }
  }

  /** 连接错误时暂停并断开；仅由用户确认页面后显式重新启动。 */
  async recoverFromConnectionError() {
    logger.warn('BOSS 自动化连接异常，已暂停；需人工确认页面后重新启动');
    await this.suspendAutomation('disconnected');
    return false;
  }

  /**
   * 执行完整的初始化流程
   */
  async openBossLoginWindow() {
    return openVisibleChromeCdp({
      profileName: 'boss', initialUrl: BOSS_LOGIN_URL, port: this.cdpPort
    });
  }

  async initializeFullProcess() {
    try {
      if (this.attachSuspended || this.shutdownRequested) {
        throw new Error('BOSS 自动化连接已暂停；请人工确认页面稳定后停止并重新启动');
      }
      logger.info('开始执行 Boss 直聘自动化初始化流程...');
      if (this.browser && this.page && !this.page.isClosed() &&
          this.browser.isConnected() && /^https:\/\/www\.zhipin\.com\//i.test(this.page.url())) {
        logger.info('Boss 直聘窗口已打开，保留当前页面');
        return true;
      }
      const opened = await this.openBossLoginWindow();
      const bossTab = opened.tabs.find(tab =>
        /^https:\/\/www\.zhipin\.com\/web\/(user|boss|chat)(?:\/|\?|$)/i.test(tab.url)
      );
      if (!bossTab) {
        throw new Error('Boss 直聘登录页未正常显示；请检查 Chrome 窗口和网络连接');
      }
      this.chromeWindowOpened = true;
      this.chromeTabUrl = bossTab.url.split(/[?#]/)[0];
      if (!this.isLoggedIn) this.currentStatus = 'waiting_login';
      logger.info(`Boss 直聘页面已打开: ${this.chromeTabUrl}`);
      return true;
    } catch (error) {
      logger.error('Boss 直聘自动化初始化流程失败:', error);
      throw error;
    }
  }
}

module.exports = BossZhipinService;
