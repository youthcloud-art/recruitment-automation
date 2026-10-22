const crypto = require('crypto');
const fs = require('fs');
const { chromium } = require('playwright');
const resumeModel = require('../models/resumeModel');
const resumeParserService = require('./resumeParserService');
const { RecruitmentPipelineService } = require('./recruitmentPipelineService');
const { loadBrowserSession, saveBrowserSession } = require('./browserSessionStore');
const { launchVisibleChromeCdp } = require('./visibleChromeCdp');
const { isQcwyPageLabel } = require('../utils/candidateDisplay');

const HOME_URL = 'https://ehire.51job.com/';
const TALENT_SEARCH_URL = 'https://ehire.51job.com/Revision/talent/search';
const TALENT_SEARCH_PATH = '/Revision/talent/search';
const MAX_RESUME_LENGTH = 100000;
const MAX_BATCH_SIZE = 30;
const MAX_BATCH_ATTEMPTS = 120;
const MAX_SCROLL_ROUNDS = 80;
const RESULT_LIST_SELECTOR = '.talent-search-container .list-box .virtual_list';
const CARD_SELECTOR = `${RESULT_LIST_SELECTOR} .resume-card`;
const RESULT_SCROLLER = '.main_container.eh-talent-search';
const RESUME_DETAIL_SELECTOR = '.talent_resume_detail_wrap.eh_body_min_width_resume';
const RESUME_MARKERS = ['工作经历', '工作经验', '教育经历', '教育背景', '求职意向',
  '项目经历', '个人信息', '职业经历', '技能特长'];
const DETAIL_NAVIGATION_TIMEOUT = 15000;
const DETAIL_CONTENT_TIMEOUT = 15000;

function isWuyouUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      (url.hostname === '51job.com' || url.hostname.endsWith('.51job.com'));
  } catch (_) {
    return false;
  }
}

function parseLlmJson(value) {
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const content = fenced ? fenced[1] : value.slice(value.indexOf('{'), value.lastIndexOf('}') + 1);
  if (!content || !content.trim().startsWith('{')) {
    throw new Error('AI 未返回可用的简历结构化数据');
  }
  const parsed = JSON.parse(content);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('AI 返回的简历格式不正确');
  }
  return parsed;
}

const NAME_LABELS = new Set(['姓名', '名字', '个人信息', '基本信息', '求职意向', '工作经历',
  '教育经历', '项目经历', '技能特长', '人才简历', '简历详情', '人才搜索', '保密',
  '通知']);

function validName(value) {
  const name = String(value || '').trim();
  return /^[\u4e00-\u9fff]{2,4}$/.test(name) && !NAME_LABELS.has(name) &&
    !/(下载|打印|复制|分享|沟通|发送|查看|收藏|编辑|举报|反馈)/.test(name) &&
    !/(信息|经历|经验|背景|简历|职位|岗位|学历|工作|教育|专业|技能|搜索|推荐)$/.test(name);
}

function nameFromResumeText(text) {
  const lines = String(text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(0, 25);
  for (const line of lines) {
    const explicit = /^(?:姓名|候选人姓名)\s*[:：]\s*([\u4e00-\u9fff]{2,4})\s*$/.exec(line);
    if (explicit && validName(explicit[1])) return explicit[1];
  }
  const personalInfo = lines.findIndex(line => /^(?:个人信息|基本信息)$/.test(line));
  if (personalInfo >= 0) {
    const nextSection = lines.findIndex((line, index) => index > personalInfo &&
      /工作经历|教育经历|求职意向|项目经历|技能特长/.test(line));
    const nearby = lines.slice(personalInfo + 1,
      Math.min(personalInfo + 6, nextSection < 0 ? lines.length : nextSection)).find(validName);
    if (nearby) return nearby;
  }
  // An arbitrary short line before the first resume section is not evidence
  // of a person's name: 51job places navigation labels such as "通知" there.
  return null;
}

function safeResumeUrl(value) {
  const original = new URL(value);
  const safe = new URL(original.origin + original.pathname);
  for (const [key, item] of original.searchParams) {
    if (/^(?:resume_?id|resume_?no|candidate_?id|cv_?id|id)$/i.test(key) &&
        /^[\w-]{1,100}$/.test(item)) safe.searchParams.set(key, item);
  }
  return safe.toString();
}

function completeResumeText(value) {
  const text = String(value || '').trim();
  if (text.length > MAX_RESUME_LENGTH) {
    throw new Error('简历详情超过本机安全长度上限，未截断保存；请人工核对该页面');
  }
  return text;
}

class WuyouService {
  constructor({ resumeStore = resumeModel, parser = resumeParserService, pipeline = null,
    browserType = chromium, visibleChromeLauncher = launchVisibleChromeCdp,
    useVisibleCdp = process.platform === 'win32' && browserType === chromium,
    sessionLoader = loadBrowserSession, sessionSaver = saveBrowserSession } = {}) {
    this.resumeStore = resumeStore;
    this.parser = parser;
    this.pipeline = pipeline || new RecruitmentPipelineService({ store: resumeStore });
    this.browserType = browserType;
    this.visibleChromeLauncher = visibleChromeLauncher;
    this.useVisibleCdp = useVisibleCdp;
    this.sessionLoader = sessionLoader;
    this.sessionSaver = sessionSaver;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.startPromise = null;
    this.lastError = null;
    this.lastSearch = null;
    this.batch = this.emptyBatch();
    this.stopRequested = false;
  }

  emptyBatch() {
    return { running: false, total: 0, processed: 0, saved: 0, skipped: 0, evaluated: 0,
      targetCount: 0, currentKeyword: '', keywordsCompleted: 0, errors: [],
      pausedForVerification: false, retries: 0, staleSnapshots: 0,
      duplicates: 0, failed: 0, educationFilter: null,
      scrollRounds: 0, stopReason: null };
  }

  trackPopups(page) {
    page.on('popup', popup => {
      popup.waitForLoadState('domcontentloaded', { timeout: 15000 })
        .then(() => {
          if (isWuyouUrl(popup.url())) {
            if (!this.batch.running) this.page = popup;
            this.trackPopups(popup);
          }
        })
        .catch(() => {});
    });
  }

  async start() {
    if (this.startPromise) return this.startPromise;
    if (this.browser && this.browser.isConnected()) {
      return this.getStatus();
    }
    const startPromise = this.startBrowser();
    this.startPromise = startPromise;
    try {
      return await startPromise;
    } finally {
      if (this.startPromise === startPromise) this.startPromise = null;
    }
  }

  async startBrowser() {
    const storedSession = await this.sessionLoader('qcwy');
    if (this.useVisibleCdp) return this.startCdpBrowser(storedSession);
    const configuredChannel = process.env.PLAYWRIGHT_CHANNEL || undefined;
    // A locally installed Chrome can occasionally exit before Playwright connects.
    // Keep the configured browser first; retry with bundled Chromium only for that
    // startup failure, preserving the saved login state in either browser.
    const channels = configuredChannel ? [configuredChannel, undefined] : [undefined];
    for (let index = 0; index < channels.length; index++) {
      try {
        this.browser = await this.browserType.launch({ channel: channels[index], headless: false });
        this.context = await this.browser.newContext({
          acceptDownloads: false,
          storageState: storedSession
        });
        this.page = await this.context.newPage();
        this.lastSearch = null;
        this.trackPopups(this.page);
        // The enterprise SPA may keep its initial document request open while loading
        // scripts. Navigation commit is enough to hand the visible window to the user.
        await this.page.goto(storedSession ? TALENT_SEARCH_URL : HOME_URL,
          { waitUntil: 'commit', timeout: 45000 });
        await this.page.waitForLoadState('domcontentloaded', { timeout: 12000 }).catch(() => {});
        this.lastError = null;
        const initial = await this.getStatus();
        // A restored 51job SPA may render the search route before its auth
        // check redirects to login. Confirm the ready state after that check.
        if (initial.status === 'ready' && typeof this.page.waitForTimeout === 'function') {
          await this.page.waitForTimeout(2500);
          return this.getStatus();
        }
        return initial;
      } catch (error) {
        const browserClosed = /Target page, context or browser has been closed|browser.*closed|process did exit/i
          .test(String(error.message || '')) || Boolean(this.browser && !this.browser.isConnected());
        await this.stop();
        if (!browserClosed || index === channels.length - 1) throw error;
      }
    }
  }

  async startCdpBrowser(storedSession) {
    const opened = await this.visibleChromeLauncher({
      profileName: 'qcwy', initialUrl: TALENT_SEARCH_URL, port: 19224
    });
    this.browser = opened.browser;
    this.context = opened.context;
    this.page = opened.page;
    this.lastSearch = null;
    this.trackPopups(this.page);
    let status = await this.getStatus();
    if (status.isLoggedIn || status.verificationRequired || !storedSession || !opened.launched) {
      return status;
    }
    // A dedicated Chrome profile keeps a newly completed interactive login.
    // Only on its first launch, and only while still unauthenticated, restore
    // the prior Playwright storage state into this profile once.
    await this.page.locator('.talent_search_keywords_input input').first()
      .waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
    status = await this.getStatus();
    if (status.isLoggedIn || status.verificationRequired) return status;
    const userTyping = await this.page.evaluate(() => {
      const focused = document.activeElement;
      return focused instanceof HTMLInputElement && Boolean(focused.value);
    }).catch(() => false);
    if (userTyping) return status;
    let saved;
    try { saved = JSON.parse(fs.readFileSync(storedSession, 'utf8')); } catch { return status; }
    if (saved.cookies?.length) await this.context.addCookies(saved.cookies);
    for (const origin of saved.origins || []) {
      if (!origin.origin || !Array.isArray(origin.localStorage)) continue;
      await this.context.addInitScript(({ expected, entries }) => {
        if (location.origin === expected) {
          for (const entry of entries) localStorage.setItem(entry.name, entry.value);
        }
      }, { expected: origin.origin, entries: origin.localStorage });
    }
    await this.page.goto(TALENT_SEARCH_URL, { waitUntil: 'commit', timeout: 45000 });
    await this.page.locator('.talent_search_keywords_input input').first()
      .waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
    status = await this.getStatus();
    if (status.status === 'ready') {
      await this.sessionSaver(this.context, 'qcwy', { force: true }).catch(() => {});
    }
    return status;
  }

  async getStatus({ persistSession = true } = {}) {
    if (this.page?.isClosed()) {
      this.page = this.context?.pages().find(page => !page.isClosed() && isWuyouUrl(page.url())) || null;
    }
    if (!this.browser || !this.browser.isConnected() || !this.page) {
      return { status: 'not_initialized', hasBrowser: false, isLoggedIn: false, url: null, batch: this.batch };
    }
    const url = this.page.url();
    const path = isWuyouUrl(url) ? new URL(url).pathname : '';
    const loginPath = path === '/' || /\/login(?:\.|\/|$)/i.test(path);
    let loginContent = false;
    let loading = false;
    let permissionRequired = false;
    let noResults = false;
    try {
      const text = await this.page.locator('body').innerText({ timeout: 5000 });
      loginContent = (text.includes('扫码登录') && (text.includes('短信登录') || text.includes('免费注册'))) ||
        (/请(?:先|重新)?登录|重新登录/.test(text) && /账号密码登录|短信登录|扫码登录/.test(text));
      permissionRequired = /暂无(?:人才搜索|简历库|人才库)?权限|没有(?:人才搜索|简历库|人才库)?权限|无权(?:访问|查看)|权限不足|请开通(?:人才搜索|简历库|人才库)|服务未开通|会员.{0,8}(?:到期|失效)/.test(text);
      noResults = /暂无(?:相关|搜索|匹配)?(?:人才|候选人|简历|结果|数据)|未找到(?:相关)?(?:人才|候选人|简历)|没有找到|无搜索结果|搜索无结果/.test(text);
      loading = await this.page.locator('.base-page-loading').first().isVisible().catch(() => false);
    } catch (_) {
      loading = true;
    }
    const verificationRequired = await this.verificationVisible(this.page);
    // The talent route can display only a loading shell at the final URL.
    // The actual keyword input is required before declaring it ready.
    const talentReady = path !== TALENT_SEARCH_PATH ||
      await this.page.locator('.talent_search_keywords_input input').first()
        .isVisible().catch(() => false);
    if (!talentReady && !loginPath && !loginContent) loading = true;
    const isLoggedIn = isWuyouUrl(url) && !loginPath && !loginContent && !loading &&
      !verificationRequired && talentReady;
    if (isLoggedIn && persistSession) await this.sessionSaver(this.context, 'qcwy').catch(() => {});
    return {
      status: verificationRequired ? 'verification_required' :
        loginPath || loginContent ? 'waiting_login' :
          permissionRequired ? 'permission_required' : loading ? 'loading' :
            isLoggedIn ? 'ready' : 'waiting_login',
      hasBrowser: true,
      isLoggedIn,
      verificationRequired,
      permissionRequired,
      noResults,
      url,
      batch: this.batch,
      error: this.lastError
    };
  }

  async getPageDiagnostics() {
    await this.requireLogin();
    const page = this.page;
    return page.evaluate(({ cardSelector, resultListSelector, resultScroller }) => {
      const count = selector => document.querySelectorAll(selector).length;
      const input = document.querySelector('.talent_search_keywords_input input');
      const scroller = document.querySelector(resultScroller);
      const list = document.querySelector(resultListSelector);
      // Diagnostics must never return candidate names, resume text, URLs or
      // arbitrary attributes. Only known UI class tokens and element counts
      // are useful for identifying a changed result-list layout.
      const safeClass = token => /^(?:el|eh|job|list|resume|talent|search|result|person|candidate|virtual|item|loading|empty|pagination|page|main|scroll|card|name|content|wrapper|filter|select)(?:[-_](?:list|wrapper|wrap|container|card|item|content|body|inner|outer|box|row|col|panel|result|holder|virtual|empty|loading|table|detail|main|resume|talent|job|search|info|head|header|footer|scroll|scroller|page|pagination|view|slot|pool|avatar|name|btn|button|tabs|tab|active|selected|disabled|text|label|title|form|input|icon|left|right|top|bottom|desc|summary|profile|basic|work|edu|exp|salary|location|city|tag))*$/i.test(token);
      const describe = node => ({
        tag: node.tagName.toLowerCase(),
        classes: Array.from(node.classList).filter(safeClass).slice(0, 4),
        children: node.children.length,
        textLength: (node.innerText || '').length
      });
      const sampleChildren = node => node ? Array.from(node.children).slice(0, 12).map(describe) : [];
      const classCounts = new Map();
      for (const node of Array.from((scroller || document.body).querySelectorAll('*')).slice(0, 3000)) {
        for (const token of node.classList) {
          if (safeClass(token)) classCounts.set(token, (classCounts.get(token) || 0) + 1);
        }
      }
      const visible = node => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const resultRoot = scroller || document.body;
      const likelyNodes = Array.from(resultRoot.querySelectorAll(
        '[class*="resume"], [class*="card"], [class*="name"], [class*="talent"], [class*="job-item"]'))
        .filter(node => visible(node) && (node.innerText || '').trim().length >= 20);
      const likelyStructures = [];
      const seenStructures = new Set();
      for (const node of likelyNodes) {
        const ancestors = [];
        for (let current = node, depth = 0; current && depth < 7; current = current.parentElement, depth++) {
          ancestors.push(describe(current));
          if (current === resultRoot) break;
        }
        const signature = ancestors.slice(0, 4)
          .map(part => `${part.tag}.${part.classes.join('.')}`).join(' > ');
        if (seenStructures.has(signature)) continue;
        seenStructures.add(signature);
        likelyStructures.push({ matches: {
          resume: Array.from(node.classList).some(token => token.includes('resume')),
          card: Array.from(node.classList).some(token => token.includes('card')),
          name: Array.from(node.classList).some(token => token.includes('name')),
          talent: Array.from(node.classList).some(token => token.includes('talent')),
          jobItem: node.classList.contains('job-item')
        }, ancestors });
        if (likelyStructures.length >= 24) break;
      }
      const bodyText = document.body?.innerText || '';
      const filterTerms = [
        ['location', /工作地点|工作城市|所在城市|现居地|所在地|城市/],
        ['education', /学历|毕业院校|学校/],
        ['experience', /工作年限|工作经验|经验年限/],
        ['age', /年龄/],
        ['filter', /筛选条件|更多筛选|高级搜索/]
      ];
      const filterControls = Array.from(document.querySelectorAll(
        'input, select, button, label, [role="combobox"], [class*="filter"], [class*="select"]'))
        .filter(node => !node.closest(resultListSelector) && visible(node))
        .map(node => {
          const ownText = Array.from(node.childNodes).filter(child => child.nodeType === Node.TEXT_NODE)
            .map(child => child.textContent).join(' ').trim();
          const hint = [node.getAttribute('placeholder') || '', node.getAttribute('aria-label') || '',
            ownText].join(' ').slice(0, 80);
          const kind = filterTerms.find(([, pattern]) => pattern.test(hint))?.[0];
          const classes = current => Array.from(current?.classList || [])
            .filter(token => /^[a-z][a-z0-9_-]{0,63}$/i.test(token)).slice(0, 6);
          return kind ? { kind, label: hint.trim(), control: describe(node),
            parent: node.parentElement && describe(node.parentElement),
            grandparent: node.parentElement?.parentElement && describe(node.parentElement.parentElement),
            ancestry: [node, node.parentElement, node.parentElement?.parentElement,
              node.parentElement?.parentElement?.parentElement].filter(Boolean)
              .map(current => ({ tag: current.tagName.toLowerCase(), classes: classes(current) })) } : null;
        }).filter(Boolean).slice(0, 30);
      const filterPanel = document.querySelector('.filter_card');
      const filterPanelText = (filterPanel?.innerText || '').slice(0, 300);
      const filterFields = filterPanel ? Array.from(filterPanel.querySelectorAll('input')).slice(0, 12)
        .map(inputNode => ({ type: inputNode.type, placeholder: (inputNode.placeholder || '').slice(0, 40),
          readonly: inputNode.readOnly,
          parentClasses: Array.from(inputNode.parentElement?.classList || []).slice(0, 5),
          grandparentClasses: Array.from(inputNode.parentElement?.parentElement?.classList || []).slice(0, 5),
          nearbyText: (inputNode.parentElement?.parentElement?.innerText || '').slice(0, 40) })) : [];
      const filterTree = filterPanel ? Array.from(filterPanel.children).slice(0, 12).map(section => ({
        node: describe(section),
        children: Array.from(section.children).slice(0, 12).map(child => ({
          node: describe(child),
          controls: Array.from(child.querySelectorAll('input, button, [role="combobox"]')).slice(0, 15)
            .map(control => ({ node: describe(control),
              kind: filterTerms.find(([, pattern]) => pattern.test(
                [control.getAttribute('placeholder') || '', control.getAttribute('aria-label') || '',
                  (control.innerText || '').slice(0, 30)].join(' ')))?.[0] || null }))
        }))
      })) : [];
      return {
        pathname: location.pathname,
        keywordPresent: Boolean(input?.value?.trim()),
        cards: count(cardSelector),
        populatedCards: count(`${cardSelector} .el-card`),
        names: count(`${cardSelector} .el-card .name`),
        visibleNames: Array.from(document.querySelectorAll(`${cardSelector} .el-card .name`))
          .filter(node => {
            const rect = node.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          }).length,
        resultScrollerPresent: Boolean(scroller),
        resultListPresent: Boolean(list),
        scrollerHeight: scroller?.scrollHeight || 0,
        scrollerViewport: scroller?.clientHeight || 0,
        loading: count('.base-page-loading, .el-loading-mask'),
        iframes: count('iframe'),
        layoutCounts: {
          jobListWrappers: count('.job-list-wrapper'),
          resultListBoxes: count('.talent-search-container .list-box'),
          resultVirtualLists: count(resultListSelector),
          virtualLists: count('.virtual_list, [class*="virtual-list"], [class*="virtual_list"]'),
          resumeClassNodes: count('[class*="resume"]'),
          candidateClassNodes: count('[class*="candidate"]'),
          listItems: count('[role="listitem"]'),
          cards: count('.el-card, [class*="card"]'),
          resultLinks: count('a[href*="resume"], a[href*="candidate"]'),
          emptyStates: count('.el-empty, [class*="empty-state"], [class*="empty_state"]'),
          scrollerResumeNodes: scroller?.querySelectorAll('[class*="resume"]').length || 0,
          scrollerCardNodes: scroller?.querySelectorAll('[class*="card"]').length || 0,
          scrollerNameNodes: scroller?.querySelectorAll('[class*="name"]').length || 0,
          scrollerJobItems: scroller?.querySelectorAll('.job-item').length || 0,
          scrollerPopulatedJobItems: scroller ? Array.from(scroller.querySelectorAll('.job-item'))
            .filter(node => (node.innerText || '').trim().length >= 20).length : 0
        },
        listStructure: {
          scrollerChildren: sampleChildren(scroller),
          scrollerGrandchildren: scroller ? Array.from(scroller.children).slice(0, 8)
            .map(node => ({ parent: describe(node), children: sampleChildren(node) })) : [],
          resultListChildren: sampleChildren(list),
          resultListGrandchildren: list ? Array.from(list.children).slice(0, 4)
            .map(node => ({ parent: describe(node), children: sampleChildren(node) })) : []
        },
        structuralClasses: Array.from(classCounts, ([name, nodes]) => ({ name, nodes }))
          .sort((a, b) => b.nodes - a.nodes).slice(0, 30),
        likelyResultStructures: likelyStructures,
        filterControls,
        filterTree,
        filterPanelText,
        filterFields,
        pageMessages: {
          noResults: /暂无(?:相关|搜索|匹配)?(?:人才|候选人|简历|结果|数据)|未找到(?:相关)?(?:人才|候选人|简历)|没有找到|无搜索结果|搜索无结果/.test(bodyText),
          permissionRequired: /暂无(?:人才搜索|简历库|人才库)?权限|没有(?:人才搜索|简历库|人才库)?权限|无权(?:访问|查看)|权限不足|请开通(?:人才搜索|简历库|人才库)|服务未开通|会员.{0,8}(?:到期|失效)/.test(bodyText),
          verificationRequired: /请完成安全验证|请拖动滑块|请进行验证|验证码|身份验证|异常访问|访问过于频繁|安全校验|captcha/i.test(bodyText),
          loginRequired: /扫码登录|短信登录|请登录|重新登录/.test(bodyText)
        }
      };
    }, { cardSelector: CARD_SELECTOR, resultListSelector: RESULT_LIST_SELECTOR,
      resultScroller: RESULT_SCROLLER });
  }

  async inspectFilterOptions(kind) {
    await this.requireLogin();
    const label = { experience: /工作经验|工作年限|经验年限/,
      education: /^学历/ }[kind];
    if (!label) throw new Error('只支持查看工作经验和学历筛选选项');
    const matches = this.page.locator('button.base-select-button').filter({ hasText: label });
    if (await matches.count() !== 1) {
      throw new Error('当前前程无忧页面没有找到该筛选按钮');
    }
    const button = matches.first();
    if (!await button.isVisible().catch(() => false)) {
      throw new Error('当前前程无忧页面没有找到该筛选按钮');
    }
    await button.click();
    try {
      await this.page.waitForTimeout(350);
      return this.page.evaluate(() => Array.from(document.querySelectorAll('.el-popover'))
        .filter(node => {
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        })
        .map(node => ({
          text: (node.innerText || '').trim().slice(0, 600),
          controls: Array.from(node.querySelectorAll('button, input, label, [role="option"]'))
            .slice(0, 35).map(control => ({
              tag: control.tagName.toLowerCase(),
              type: control.getAttribute('type') || '',
              text: (control.innerText || '').trim().slice(0, 45),
              classes: Array.from(control.classList).filter(token => /^[a-z][a-z0-9_-]{0,63}$/i.test(token))
                .slice(0, 5)
            }))
        })).slice(0, 3));
    } finally {
      await this.page.keyboard.press('Escape').catch(() => {});
    }
  }

  async selectEducationFilter(value) {
    await this.requireLogin();
    if (!['不限', '大专及以上', '本科及以上', '硕士及以上'].includes(value)) {
      throw new Error('学历筛选值无效');
    }
    if (new URL(this.page.url()).pathname !== TALENT_SEARCH_PATH) {
      this.lastSearch = null;
      await this.page.goto(TALENT_SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    }
    const matches = this.page.locator('button.base-select-button')
      .filter({ hasText: /^(?:学历要求|不限|大专及以上|本科及以上|硕士及以上)$/ });
    if (await matches.count() !== 1) throw new Error('前程无忧学历筛选控件未能唯一定位');
    const button = matches.first();
    if (!await button.isVisible().catch(() => false)) throw new Error('前程无忧学历筛选控件未出现');
    const selected = (await button.innerText()).trim();
    if (selected === value || (value === '不限' && selected === '学历要求')) {
      return { value, applied: true, changed: false };
    }
    // This control can sit underneath 51job's fixed filter/navigation panel.
    // A short hit-test avoids blocking the whole acquisition request for the
    // default Playwright 30 seconds. Do not force a click through that panel.
    try {
      await button.click({ trial: true, timeout: 2000 });
      await button.click({ timeout: 3000 });
    } catch (_) {
      throw new Error('前程无忧学历筛选按钮被页面遮挡或暂不可操作');
    }
    const popover = this.page.locator('.el-popover:visible').filter({ hasText: '本科及以上' }).last();
    try {
      await popover.waitFor({ state: 'visible', timeout: 3000 });
    } catch (_) {
      throw new Error('前程无忧学历筛选选项暂未出现');
    }
    const option = popover.getByText(value, { exact: true });
    if (await option.count() !== 1) throw new Error('前程无忧学历筛选选项不唯一');
    try {
      await option.click({ timeout: 3000 });
    } catch (_) {
      throw new Error('前程无忧学历筛选选项被页面遮挡或暂不可操作');
    }
    await this.page.waitForTimeout(400);
    const confirmed = (await button.innerText()).trim();
    if (!(confirmed === value || (value === '不限' && confirmed === '学历要求'))) {
      throw new Error('前程无忧学历筛选未能确认生效，已停止采集');
    }
    await this.page.locator('.base-page-loading, .el-loading-mask').first()
      .waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
    const status = await this.getStatus();
    if (status.verificationRequired) throw new Error('前程无忧要求人工验证，请在浏览器完成验证后重试');
    if (status.status === 'loading') throw new Error('前程无忧筛选结果仍在加载，请稍后重试');
    if (!status.isLoggedIn) throw new Error('前程无忧登录已失效，请在浏览器重新登录');
    this.lastSearch = null;
    return { value, applied: true, changed: true };
  }

  async requireLogin() {
    const status = await this.getStatus();
    if (!status.hasBrowser) throw new Error('请先启动前程无忧浏览器');
    if (status.verificationRequired) throw new Error('前程无忧要求人工验证，请在浏览器完成验证后重试');
    if (status.permissionRequired) throw new Error('当前企业账号没有人才搜索权限，请在浏览器中核对');
    if (!status.isLoggedIn) throw new Error('请先在浏览器中完成前程无忧企业账号登录');
  }

  async search(keyword) {
    await this.requireLogin();
    const value = String(keyword || '').trim();
    if (!value || value.length > 30) throw new Error('请输入 1 到 30 字的搜索关键词');

    // The dashboard has several unrelated search inputs. Only use the known
    // employer talent-search route and its keyword input.
    if (new URL(this.page.url()).pathname !== TALENT_SEARCH_PATH) {
      this.lastSearch = null;
      await this.page.goto(TALENT_SEARCH_URL, { waitUntil: 'commit', timeout: 45000 });
    }
    const input = this.page.locator('.talent_search_keywords_input input').first();
    try {
      await input.waitFor({ state: 'visible', timeout: 15000 });
    } catch (_) {
      return {
        submitted: false,
        message: '前程无忧人才搜索页未出现关键词输入框，请确认企业账号有“人才搜索”权限并在浏览器中检查页面。'
      };
    }
    if (new URL(this.page.url()).pathname !== TALENT_SEARCH_PATH) {
      return {
        submitted: false,
        message: '前程无忧没有进入人才搜索页，请检查登录状态或人才搜索权限。'
      };
    }
    // Only reuse a search this service submitted and observed. A user can type a
    // different keyword into the live browser without pressing Enter; the old
    // cards remain visible until the site's actual search completes.
    const currentKeyword = (await input.inputValue()).trim();
    const loading = await this.page.locator('.base-page-loading, .el-loading-mask')
      .first().isVisible().catch(() => false);
    if (this.lastSearch?.page === this.page && this.lastSearch.keyword === value &&
        currentKeyword === value && !loading &&
        !await this.verificationVisible(this.page) && await this.hasCardList()) {
      return { submitted: true, message: '已使用当前人才搜索结果。可在本机按岗位逐份采集和评估。' };
    }
    this.lastSearch = null;
    const watchingResults = await this.page.evaluate(({ resultListSelector, cardSelector }) => {
      const list = document.querySelector(resultListSelector);
      if (!list) return false;
      window.__wuyouResultObserver?.disconnect();
      window.__wuyouResultChanges = 0;
      window.__wuyouResultSnapshot = Array.from(document.querySelectorAll(`${cardSelector} .el-card`))
        .map(node => (node.innerText || '').trim()).join('\n');
      window.__wuyouResultObserver = new MutationObserver(() => { window.__wuyouResultChanges++; });
      window.__wuyouResultObserver.observe(list.parentElement || list, { childList: true, characterData: true,
        attributes: true, subtree: true });
      return true;
    }, { resultListSelector: RESULT_LIST_SELECTOR, cardSelector: CARD_SELECTOR }).catch(() => false);
    await input.fill(value);
    await input.press('Enter');
    if (watchingResults) {
      const updated = await this.page.waitForFunction(cardSelector => {
        const cards = Array.from(document.querySelectorAll(`${cardSelector} .el-card`));
        const changedCards = cards.some(node => node.querySelector('.name')) &&
          cards.map(node => (node.innerText || '').trim()).join('\n') !== window.__wuyouResultSnapshot;
        const empty = /暂无(?:相关|搜索|匹配)?(?:人才|候选人|简历|结果|数据)|未找到(?:相关)?(?:人才|候选人|简历)|没有找到|无搜索结果|搜索无结果/
          .test(document.body?.innerText || '');
        return window.__wuyouResultChanges > 0 && (changedCards || empty);
      }, CARD_SELECTOR, { timeout: 25000, polling: 300 }).then(() => true).catch(() => false);
      await this.page.evaluate(() => window.__wuyouResultObserver?.disconnect()).catch(() => {});
      const state = await this.getStatus();
      if (state.verificationRequired) throw new Error('前程无忧要求人工验证，请在浏览器完成验证后重试');
      if (state.permissionRequired) throw new Error('当前企业账号没有人才搜索权限，请在浏览器中核对');
      if (!state.isLoggedIn) throw new Error('前程无忧登录已失效，请在浏览器重新登录');
      if (state.noResults && !await this.hasCardList()) {
        this.lastSearch = { page: this.page, keyword: value };
        return { submitted: true, noResults: true, message: '本关键词没有可访问的候选人结果。' };
      }
      if (!updated) throw new Error('人才搜索结果未确认刷新，已停止本关键词采集，避免误用上一轮候选人');
      await this.page.waitForTimeout(900);
    } else {
      // The known talent page normally contains this list. If it disappeared,
      // do not treat the previous page's cards as a successful search.
      throw new Error('人才搜索结果列表未出现，已停止采集，请检查前程无忧页面');
    }
    this.lastSearch = { page: this.page, keyword: value };
    return { submitted: true, message: '已提交人才搜索。可在本机按岗位逐份采集和评估。' };
  }

  async verificationVisible(page = this.page) {
    if (!page || page.isClosed?.() || typeof page.evaluate !== 'function') return false;
    return page.evaluate(() => {
      const visible = node => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      if (Array.from(document.querySelectorAll('[class*="captcha"], [id*="captcha"], [class*="verify"], [id*="verify"]'))
        .some(visible)) return true;
      return /请完成安全验证|请拖动滑块|请进行验证|请完成验证/.test(document.body?.innerText || '');
    }).catch(() => false);
  }

  async loginVisible(page = this.page) {
    if (!page || page.isClosed?.()) return false;
    const url = typeof page.url === 'function' ? page.url() : page.url;
    if (!isWuyouUrl(url)) return false;
    const path = new URL(url).pathname;
    if (path === '/' || /\/login(?:\.|\/|$)/i.test(path)) return true;
    if (typeof page.locator !== 'function') return false;
    const text = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
    return (text.includes('扫码登录') && (text.includes('短信登录') || text.includes('免费注册'))) ||
      (/请(?:先|重新)?登录|重新登录/.test(text) && /账号密码登录|短信登录|扫码登录/.test(text));
  }

  recordBatchError(message) {
    const safe = String(message)
      .replace(/https?:\/\/[^\s]+/gi, '[平台页面]')
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[邮箱]')
      .replace(/(?:\+?86[- ]?)?1[3-9]\d{9}/g, '[手机号]');
    this.batch.errors.push(safe.slice(0, 200));
    if (this.batch.errors.length > 20) this.batch.errors.shift();
  }

  pauseBatch(reason, message) {
    this.batch.stopReason = reason;
    this.batch.pausedForVerification = reason === 'verification_required';
    this.stopRequested = true;
    this.recordBatchError(message);
  }

  finishBatch() {
    if (!this.batch.stopReason) {
      this.batch.stopReason = this.batch.saved >= this.batch.targetCount
        ? 'target_reached' : this.batch.processed >= MAX_BATCH_ATTEMPTS
          ? 'attempt_limit' : this.stopRequested ? 'stopped' : 'results_exhausted';
    }
    this.batch.currentKeyword = '';
    this.batch.running = false;
  }

  async visibleCards() {
    const cards = await this.page.evaluate(selector => Array.from(document.querySelectorAll(selector))
      .map((card, index) => ({
        index,
        text: (card.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 800),
        populated: Boolean(card.querySelector('.el-card .name')),
        stableId: card.getAttribute('data-id') || card.getAttribute('data-key') ||
          card.getAttribute('data-resume-id') || card.querySelector('[data-id]')?.getAttribute('data-id') || '',
        virtualIndex: card.getAttribute('data-index') || card.getAttribute('aria-posinset') ||
          card.parentElement?.getAttribute('data-index') || '',
        scrollBucket: Math.floor((document.querySelector('.main_container.eh-talent-search')?.scrollTop || 0) / 300)
      }))
      .filter(item => item.populated && item.text.length >= 20), CARD_SELECTOR);
    return cards.map(card => ({ ...card,
      key: card.stableId || crypto.createHash('sha256')
        .update(`${card.text}|${card.virtualIndex || `${card.scrollBucket}:${card.index}`}`).digest('hex') }));
  }

  async hasCardList({ wait = false } = {}) {
    if (!this.page?.locator) return false;
    // Virtual-list placeholders exist before the actual card data is rendered.
    const first = this.page.locator(`${CARD_SELECTOR} .el-card .name`).first();
    if (wait) await first.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
    return await first.isVisible().catch(() => false);
  }

  async scrollResults() {
    const state = await this.page.evaluate(({ listSelector, cardSelector, fallbackSelector }) => {
      const list = document.querySelector(listSelector);
      const candidates = [];
      for (let node = list; node; node = node.parentElement) candidates.push(node);
      const fallback = document.querySelector(fallbackSelector);
      if (fallback && !candidates.includes(fallback)) candidates.push(fallback);
      if (document.scrollingElement) candidates.push(document.scrollingElement);
      const scrollable = node => node.clientHeight > 0 &&
        node.scrollHeight > node.clientHeight + 8;
      const scroller = candidates.find(scrollable);
      if (!scroller) return { moved: false };
      const snapshot = Array.from(document.querySelectorAll(`${cardSelector} .el-card`))
        .map(node => (node.innerText || '').trim().slice(0, 160)).join('\n');
      const before = scroller.scrollTop;
      scroller.scrollTop = Math.min(scroller.scrollHeight,
        before + Math.max(300, Math.floor(scroller.clientHeight * 0.85)));
      return { moved: scroller.scrollTop > before, snapshot,
        height: scroller.scrollHeight };
    }, { listSelector: RESULT_LIST_SELECTOR, cardSelector: CARD_SELECTOR,
      fallbackSelector: RESULT_SCROLLER });
    if (!state.moved) {
      // Some lists append the next page just after the last visible scroll.
      await this.page.waitForTimeout(1200);
      return false;
    }
    // A virtual list reuses DOM rows. Wait for their content to change, rather
    // than assuming a fixed 1.4-second delay is enough for an async render.
    await this.page.waitForFunction(({ cardSelector, snapshot }) => {
      const current = Array.from(document.querySelectorAll(`${cardSelector} .el-card`))
        .map(node => (node.innerText || '').trim().slice(0, 160)).join('\n');
      return Boolean(current && current !== snapshot);
    }, { cardSelector: CARD_SELECTOR, snapshot: state.snapshot },
    { polling: 250, timeout: 6000 }).catch(() => {});
    await this.page.waitForTimeout(400 + Math.floor(Math.random() * 350));
    return true;
  }

  async scanCandidateLinks() {
    await this.requireLogin();
    // Current 51job talent results use a virtualized card list, without links.
    // These descriptors are for a count preview only; batch collection processes
    // the visible cards before scrolling because off-screen nodes are recycled.
    if (await this.hasCardList()) return this.visibleCards();
    const found = new Map();
    let unchanged = 0;
    for (let round = 0; round < 16 && found.size < MAX_BATCH_ATTEMPTS; round++) {
      const links = await this.page.evaluate(() => Array.from(document.querySelectorAll('a[href]'))
        .filter(anchor => anchor.getBoundingClientRect().width > 0)
        .map(anchor => ({ title: (anchor.innerText || '').trim().slice(0, 80), url: anchor.href }))
        .filter(link => {
          try {
            const path = new URL(link.url).pathname;
            return /resume|candidate|talent|\/cv\b/i.test(path) &&
              !/\/login|\/search|\/list/i.test(path);
          } catch (_) {
            return false;
          }
        }));
      const before = found.size;
      for (const link of links) {
        if (isWuyouUrl(link.url) && !found.has(link.url)) found.set(link.url, link);
      }
      unchanged = found.size === before ? unchanged + 1 : 0;
      if (unchanged >= 2) break;
      await this.page.evaluate(() => {
        const scrollables = [document.scrollingElement, ...document.querySelectorAll('main, [class*="list"], [class*="scroll"]')]
          .filter(Boolean)
          .filter(element => element.scrollHeight > element.clientHeight + 100);
        const target = scrollables.sort((a, b) => b.scrollHeight - a.scrollHeight)[0] || document.scrollingElement;
        if (target) target.scrollTop = target.scrollHeight;
      });
      await this.page.waitForTimeout(900 + Math.floor(Math.random() * 500));
    }
    return Array.from(found.values()).slice(0, MAX_BATCH_ATTEMPTS);
  }

  async captureVisibleResume(page, { contentTimeout = DETAIL_CONTENT_TIMEOUT } = {}) {
    if (!page || page.isClosed() || !isWuyouUrl(page.url())) {
      throw new Error('请在前程无忧企业端打开候选人的简历详情');
    }
    const markers = RESUME_MARKERS;
    const detail = page.locator(RESUME_DETAIL_SELECTOR).first();
    if (/\/Revision\/talent\/resume\/detail(?:\/|$)/i.test(new URL(page.url()).pathname)) {
      // A visible detail wrapper can still contain only the loading skeleton.
      // Wait for actual resume sections before parsing or recording a failure.
      const ready = await page.waitForFunction(({ selector, sectionNames }) => {
        const node = document.querySelector(selector);
        if (!node) return false;
        const rect = node.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const text = (node.innerText || '').trim();
        return text.length >= 80 && sectionNames.filter(section => text.includes(section)).length >= 2;
      }, { selector: RESUME_DETAIL_SELECTOR, sectionNames: markers },
      { polling: 300, timeout: contentTimeout }).then(() => true).catch(() => false);
      if (ready && isWuyouUrl(page.url())) {
        const text = (await detail.innerText({ timeout: 5000 })).trim();
        const nameHint = await detail.locator('.eh_resume_detail_perinfo_wrap [class*="name"]')
          .first().innerText({ timeout: 1000 }).catch(() => '');
        return { text: completeResumeText(text), url: page.url(),
          title: await page.title(), nameHint };
      }
      if (await this.verificationVisible(page)) throw new Error('详情页要求人工验证，采集已暂停');
      const evidence = await page.evaluate(({ selector, sectionNames }) => {
        const node = document.querySelector(selector);
        const rect = node?.getBoundingClientRect();
        const text = (node?.innerText || '').trim();
        return { present: Boolean(node), visible: Boolean(rect && rect.width > 0 && rect.height > 0),
          length: text.length, sections: sectionNames.filter(section => text.includes(section)).length,
          loading: document.querySelectorAll('.base-page-loading, .el-loading-mask').length };
      }, { selector: RESUME_DETAIL_SELECTOR, sectionNames: markers })
        .catch(() => ({ present: false, visible: false, length: 0, sections: 0, loading: 0 }));
      throw new Error(`简历详情内容不足（${evidence.length} 字，${evidence.sections} 个简历区块；` +
        `详情容器${evidence.present ? evidence.visible ? '可见' : '未显示' : '缺失'}，` +
        `加载层 ${evidence.loading} 个），已跳过`);
    }
    if (!/\/candidate\/(?:detail|frame)\/|\/resume\/detail(?:\/|$)/i.test(new URL(page.url()).pathname)) {
      throw new Error('当前页面不是简历详情');
    }
    const candidates = await Promise.all(page.frames()
      .filter(frame => frame === page.mainFrame() || isWuyouUrl(frame.url()))
      .map(async frame => {
        const text = (await frame.locator('body').innerText({ timeout: 10000 }).catch(() => '')).trim();
        const hits = markers.filter(marker => text.includes(marker)).length;
        return { text, hits, isSubframe: frame !== page.mainFrame(), url: isWuyouUrl(frame.url()) ? frame.url() : page.url() };
      }));
    const best = candidates.filter(candidate => candidate.text.length >= 80 && candidate.hits >= 2)
      .sort((a, b) => Number(b.isSubframe) - Number(a.isSubframe) || b.hits - a.hits || b.text.length - a.text.length)[0];
    if (!best) {
      throw new Error('当前页面不像简历详情，请先在前程无忧中打开一份候选人简历');
    }
    return { text: completeResumeText(best.text), url: best.url, title: await page.title() };
  }

  async collectPage(page) {
    const resume = await this.captureVisibleResume(page);
    const normalizedText = resume.text.replace(/\s+/g, ' ').trim().toLowerCase();
    const fingerprint = crypto.createHash('sha256').update(normalizedText).digest('hex');
    const sourceUrl = safeResumeUrl(resume.url);
    const canonical = new URL(sourceUrl);
    const hasStableId = canonical.searchParams.size > 0 ||
      /\/(?:resume|candidate)\/detail\/[\w-]{4,}/i.test(canonical.pathname);
    // 51job detail URLs may append short-lived tokens. The resumeId in the
    // canonical URL remains stable across sessions and browser restarts.
    // A generic detail route without an ID must not collapse different people.
    const sourceRecordKey = crypto.createHash('sha256')
      .update(hasStableId ? sourceUrl : fingerprint).digest('hex');
    const identity = { source: 'qcwy', sourceRecordKey, sourceUrl,
      sourceFingerprint: fingerprint, originalText: resume.text };
    const existing = typeof this.resumeStore.findWuyouDuplicate === 'function'
      ? this.resumeStore.findWuyouDuplicate(identity, { hasStableId })
      : this.resumeStore.getResumes().find(item =>
        item.source === 'qcwy' && (item.sourceRecordKey === sourceRecordKey ||
          (hasStableId && item.sourceUrl === sourceUrl) ||
          item.sourceFingerprint === fingerprint ||
          item.originalText?.replace(/\s+/g, ' ').trim().toLowerCase() === normalizedText));
    if (existing) return { saved: false, duplicate: true, resume: existing };
    const { rawText: _rawText, ...parsed } = this.parser.parseResumeText(resume.text);
    // Do not persist navigation chrome as structured resume metadata. Keep
    // originalText unchanged for audit and later manual identity verification.
    if (isQcwyPageLabel(parsed.position)) parsed.position = '';
    if (isQcwyPageLabel(parsed.expectedPosition)) parsed.expectedPosition = '';
    if (parsed.expectedPosition && typeof parsed.expectedPosition === 'object' &&
        isQcwyPageLabel(parsed.expectedPosition.position)) {
      parsed.expectedPosition = { ...parsed.expectedPosition, position: '' };
    }
    const result = await this.resumeStore.addResume({
      ...parsed,
      name: (validName(resume.nameHint) ? resume.nameHint.trim() : null) ||
        nameFromResumeText(resume.text) ||
        '未识别姓名',
      source: 'qcwy',
      platform: '前程无忧',
      sourceUrl,
      sourceRecordKey,
      sourceFingerprint: fingerprint,
      sourceTitle: resume.title,
      originalText: resume.text,
      parseMethod: 'local',
      parseStatus: 'completed'
    }, { returnStatus: true });
    return { saved: result.created !== false, duplicate: result.created === false,
      resume: result.resume || result };
  }

  async collectCurrent() {
    await this.requireLogin();
    return this.collectPage(this.page);
  }

  async startBatch({ targetCount = 18 } = {}) {
    await this.requireLogin();
    if (this.batch.running) throw new Error('批量采集正在进行中');
    const count = Number(targetCount);
    if (!Number.isInteger(count) || count < 1 || count > MAX_BATCH_SIZE) {
      throw new Error(`目标份数需为 1～${MAX_BATCH_SIZE}`);
    }
    if (await this.hasCardList()) {
      this.stopRequested = false;
      this.lastError = null;
      this.batch = { ...this.emptyBatch(), running: true, targetCount: count };
      this.runCardBatch(count, new Set())
        .catch(error => {
          this.lastError = error.message;
          this.recordBatchError(error.message);
        })
        .finally(() => this.finishBatch());
      return this.batch;
    }
    const links = await this.scanCandidateLinks();
    if (!links.length) {
      throw new Error('当前页面没有可识别的候选人简历链接，请打开人才搜索结果页，或逐份打开简历并点击“当前简历 AI 入库”');
    }
    this.stopRequested = false;
    this.lastError = null;
    this.batch = { ...this.emptyBatch(), running: true, total: Math.min(links.length, MAX_BATCH_ATTEMPTS),
      targetCount: count };
    this.runBatch(links).catch(error => {
      this.lastError = error.message;
      this.recordBatchError(error.message);
      this.batch.stopReason = 'error';
      this.finishBatch();
    });
    return this.batch;
  }

  async startKeywordBatch({ keywords, targetCount, jobRequirements = '', education } = {}) {
    await this.requireLogin();
    if (this.batch.running) throw new Error('批量采集正在进行中');
    const terms = (Array.isArray(keywords) ? keywords : String(keywords || '').split(/[,，、\n]/))
      .map(value => String(value).trim()).filter(Boolean).slice(0, 10);
    const count = Number(targetCount);
    if (!terms.length || terms.some(term => term.length > 30) ||
      !Number.isInteger(count) || count < 1 || count > MAX_BATCH_SIZE) {
      throw new Error(`请输入最多 10 个关键词和 1～${MAX_BATCH_SIZE} 份目标简历`);
    }
    const requirements = String(jobRequirements || '').trim();
    if (requirements.length > 5000) throw new Error('岗位要求不能超过 5000 字');
    let educationFilter = null;
    if (education !== undefined) {
      try {
        educationFilter = await this.selectEducationFilter(education);
      } catch (error) {
        const unavailable = /前程无忧学历筛选(?:控件|按钮|选项|未能确认)/.test(error.message);
        if (!unavailable || requirements.length < 5) throw error;
        // The platform UI filter is only a prefilter. If it is hidden or
        // blocked by a fixed panel, keep the actual job evaluation instead
        // of failing the entire batch, but make the skipped prefilter visible.
        const status = await this.getStatus();
        if (status.verificationRequired || status.permissionRequired ||
            status.status === 'waiting_login' || !status.isLoggedIn) throw error;
        educationFilter = { value: education, applied: false, changed: false,
          reason: '前程无忧学历界面筛选暂不可操作；本批将依据岗位要求评估学历' };
      }
    }
    this.stopRequested = false;
    this.lastError = null;
    this.batch = { ...this.emptyBatch(), running: true, targetCount: count, educationFilter };
    this.runKeywordBatch(terms, count, requirements).catch(error => {
      this.lastError = error.message;
      this.recordBatchError(error.message);
      this.batch.stopReason = 'error';
      this.finishBatch();
    });
    return this.batch;
  }

  async runKeywordBatch(terms, targetCount, jobRequirements = '') {
    const visited = new Set();
    try {
      for (const keyword of terms) {
        if (this.stopRequested || this.batch.saved >= targetCount ||
          this.batch.processed >= MAX_BATCH_ATTEMPTS) break;
        this.batch.currentKeyword = keyword;
        try {
          const search = await this.search(keyword);
          if (!search.submitted) throw new Error(search.message);
          if (search.noResults) {
            this.batch.keywordsCompleted++;
            continue;
          }
          if (await this.hasCardList({ wait: true })) {
            // Card keys without a platform ID are positional in a virtual
            // list. Keep those visit markers within one search; the database
            // handles cross-keyword duplicate resumes by canonical ID/text.
            await this.runCardBatch(targetCount, new Set(), jobRequirements);
            if (this.stopRequested) break;
            this.batch.keywordsCompleted++;
            continue;
          }
          await this.page.waitForTimeout(1200);
          if (await this.verificationVisible(this.page)) {
            this.pauseBatch('verification_required', '前程无忧要求人工验证，采集已暂停。');
            break;
          }
          const links = (await this.scanCandidateLinks())
            .filter(link => !visited.has(safeResumeUrl(link.url)));
          if (!links.length) this.recordBatchError(`${keyword}：没有可见的候选人简历结果`);
          this.batch.total += links.length;
          for (const link of links) {
            if (this.stopRequested || this.batch.saved >= targetCount ||
              this.batch.processed >= MAX_BATCH_ATTEMPTS) break;
            visited.add(safeResumeUrl(link.url));
            let tab;
            try {
              tab = await this.context.newPage();
              await tab.goto(link.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
              if (await this.verificationVisible(tab)) {
                this.pauseBatch('verification_required', '详情页要求人工验证，采集已暂停。');
                this.page = tab;
                tab = null;
                break;
              }
              if (await this.loginVisible(tab)) {
                this.pauseBatch('login_required', '详情页要求重新登录，采集已暂停。');
                this.page = tab;
                tab = null;
                break;
              }
              const result = await this.collectPage(tab);
              if (result.saved) this.batch.saved++;
              else {
                this.batch.skipped++;
                if (result.duplicate) this.batch.duplicates++;
              }
              if (result.saved) await this.evaluateCaptured(result.resume, jobRequirements);
            } catch (error) {
              this.batch.failed++;
              this.recordBatchError(`${keyword}: ${error.message}`);
            } finally {
              this.batch.processed++;
              if (tab && !tab.isClosed()) await tab.close().catch(() => {});
              if (!this.stopRequested && this.batch.saved < targetCount) {
                await this.page.waitForTimeout(1800 + Math.floor(Math.random() * 500));
              }
            }
          }
          if (this.stopRequested) break;
          this.batch.keywordsCompleted++;
        } catch (error) {
          this.recordBatchError(`${keyword}: ${error.message}`);
          if (/验证|验证码|安全校验/.test(error.message)) {
            this.pauseBatch('verification_required', '前程无忧要求人工验证，采集已暂停。');
            break;
          }
          if (/登录|登录已失效/.test(error.message)) {
            this.pauseBatch('login_required', '前程无忧登录已失效，采集已暂停。');
            break;
          }
          if (/权限|未开通|会员.*(?:到期|失效)/.test(error.message)) {
            this.pauseBatch('permission_required', '当前企业账号没有人才搜索权限，采集已暂停。');
            break;
          }
        }
      }
    } finally {
      this.finishBatch();
    }
  }

  async evaluateCaptured(resume, jobRequirements) {
    if (!resume?.id || !jobRequirements || jobRequirements.length < 5) return;
    try {
      await this.pipeline.evaluate(resume.id, jobRequirements);
      this.batch.evaluated++;
    } catch (error) {
      this.recordBatchError(`本机岗位评估失败：${error.message}`);
    }
  }

  async runCardBatch(targetCount, visited, jobRequirements = '') {
    const searchPage = this.page;
    const discovered = new Set();
    const attempts = new Map();
    let unchanged = 0;
    let retryRefreshes = 0;
    let scrolls = 0;
    try {
      // A single refresh lets a transient card be retried in place. A second
      // transient pass must scroll: virtualized rows can keep moving forever.
      for (let pass = 0; pass < MAX_SCROLL_ROUNDS * 2 && scrolls < MAX_SCROLL_ROUNDS; pass++) {
        if (this.stopRequested || this.batch.saved >= targetCount) break;
        if (this.batch.processed >= MAX_BATCH_ATTEMPTS ||
            this.batch.retries >= MAX_BATCH_ATTEMPTS) {
          this.batch.stopReason = 'attempt_limit';
          break;
        }
        if (await this.loginVisible(searchPage)) {
          this.pauseBatch('login_required',
            '前程无忧搜索页要求重新登录，采集已暂停。请在浏览器完成登录后重新启动。');
          break;
        }
        if (await this.verificationVisible(searchPage)) {
          this.pauseBatch('verification_required',
            '前程无忧要求人工验证，采集已暂停。请在浏览器完成验证后重新启动。');
          break;
        }
        const cards = await this.visibleCards();
        const fresh = cards.filter(card => !visited.has(card.key));
        unchanged = fresh.length ? 0 : unchanged + 1;
        for (const card of fresh) {
          if (!discovered.has(card.key)) {
            discovered.add(card.key);
            this.batch.total++;
          }
        }
        let retryPending = false;
        for (const card of fresh) {
          if (this.stopRequested || this.batch.saved >= targetCount ||
            this.batch.processed >= MAX_BATCH_ATTEMPTS ||
            this.batch.retries >= MAX_BATCH_ATTEMPTS) break;
          const attempt = (attempts.get(card.key) || 0) + 1;
          attempts.set(card.key, attempt);
          let detailPage;
          let keepForVerification = false;
          let candidateFinished = true;
          let staleSnapshot = false;
          try {
            if (typeof searchPage.evaluate === 'function') {
              const current = await searchPage.evaluate(({ selector, index }) => {
                const node = document.querySelectorAll(selector)[index];
                if (!node) return null;
                return { stableId: node.getAttribute('data-id') || node.getAttribute('data-key') ||
                  node.getAttribute('data-resume-id') || node.querySelector('[data-id]')?.getAttribute('data-id') || '',
                virtualIndex: node.getAttribute('data-index') || node.getAttribute('aria-posinset') ||
                  node.parentElement?.getAttribute('data-index') || '',
                text: (node.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 800) };
              }, { selector: CARD_SELECTOR, index: card.index });
              if (!current || current.text !== card.text ||
                  current.stableId !== card.stableId || current.virtualIndex !== card.virtualIndex) {
                staleSnapshot = true;
                throw new Error('虚拟列表候选人位置已变化，请重试当前卡片');
              }
            }
            const opener = searchPage.locator(CARD_SELECTOR).nth(card.index)
              .locator('.name').first();
            if (!await opener.isVisible().catch(() => false)) {
              this.batch.skipped++;
              visited.add(card.key);
              continue;
            }
            const popupPromise = searchPage.waitForEvent('popup', { timeout: 12000 });
            [detailPage] = await Promise.all([popupPromise, opener.click({ timeout: 12000 })]);
            // The popup event often fires while the new tab is still about:blank.
            // Wait for a committed 51job navigation before inspecting the URL.
            await detailPage.waitForURL(url => isWuyouUrl(url.toString()),
              { waitUntil: 'commit', timeout: DETAIL_NAVIGATION_TIMEOUT }).catch(() => {});
            if (!isWuyouUrl(detailPage.url())) {
              const location = detailPage.url() === 'about:blank' ? '仍为空白页' : '跳转到其他站点';
              throw new Error(`详情页未进入前程无忧（${location}），已跳过`);
            }
            await detailPage.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
            if (await this.verificationVisible(detailPage)) {
              keepForVerification = true;
              this.pauseBatch('verification_required',
                '详情页要求人工验证，采集已暂停。请在浏览器完成验证后重新启动。');
              this.page = detailPage;
              break;
            }
            if (await this.loginVisible(detailPage)) {
              keepForVerification = true;
              this.pauseBatch('login_required',
                '详情页要求重新登录，采集已暂停。请在浏览器完成登录后重新启动。');
              this.page = detailPage;
              break;
            }
            const result = await this.collectPage(detailPage);
            if (result.saved) {
              this.batch.saved++;
              await this.evaluateCaptured(result.resume, jobRequirements);
            } else {
              this.batch.skipped++;
              if (result.duplicate) this.batch.duplicates++;
            }
            visited.add(card.key);
          } catch (error) {
            if (detailPage && !detailPage.isClosed() && await this.verificationVisible(detailPage)) {
              keepForVerification = true;
              this.pauseBatch('verification_required',
                '详情页要求人工验证，采集已暂停。请在浏览器完成验证后重新启动。');
              this.page = detailPage;
              break;
            }
            if (detailPage && !detailPage.isClosed() && await this.loginVisible(detailPage)) {
              keepForVerification = true;
              this.pauseBatch('login_required', '前程无忧登录已失效，采集已暂停。请重新登录。');
              this.page = detailPage;
              break;
            }
            const transient = /超时|timeout|仍为空白页|简历详情内容不足|net::|Target page|浏览器已关闭/i
              .test(error.message);
            if (staleSnapshot && !this.stopRequested) {
              // One recycled DOM row invalidates the whole card snapshot. The
              // remaining indices are likely stale too, so refresh the list
              // instead of charging every old row as a separate failure.
              this.batch.staleSnapshots++;
              retryPending = true;
              candidateFinished = false;
            } else if (transient && attempt < 2 && !this.stopRequested) {
              this.batch.retries++;
              retryPending = true;
              candidateFinished = false;
            } else {
              visited.add(card.key);
              this.batch.skipped++;
              this.batch.failed++;
              this.recordBatchError(`第 ${this.batch.processed + 1} 份：${error.message}`);
            }
          } finally {
            // Progress and the 120-candidate quota count each candidate's
            // final outcome once. Temporary failures have their own retry cap.
            if (candidateFinished) this.batch.processed++;
            if (detailPage && !detailPage.isClosed() && !keepForVerification) {
              await detailPage.close().catch(() => {});
            }
            if (!staleSnapshot && !this.stopRequested && this.batch.saved < targetCount) {
              await searchPage.waitForTimeout(1800 + Math.floor(Math.random() * 500));
            }
          }
          if (staleSnapshot) break;
        }
        if (this.stopRequested || this.batch.saved >= targetCount || unchanged >= 3) break;
        if (this.batch.processed >= MAX_BATCH_ATTEMPTS ||
            this.batch.retries >= MAX_BATCH_ATTEMPTS) {
          this.batch.stopReason = 'attempt_limit';
          break;
        }
        if (retryPending && retryRefreshes < 1) {
          retryRefreshes++;
          await searchPage.waitForTimeout(900);
          continue;
        }
        retryRefreshes = 0;
        if (!await this.scrollResults()) break;
        scrolls++;
        this.batch.scrollRounds++;
      }
    } finally {
      if (!['verification_required', 'login_required'].includes(this.batch.stopReason)) {
        this.page = searchPage;
      }
    }
  }

  async runBatch(links) {
    try {
      for (const [index, link] of links.entries()) {
        if (this.stopRequested || this.batch.saved >= this.batch.targetCount ||
          this.batch.processed >= MAX_BATCH_ATTEMPTS) break;
        if (await this.loginVisible(this.page)) {
          this.pauseBatch('login_required', '前程无忧登录已失效，采集已暂停。');
          break;
        }
        if (await this.verificationVisible(this.page)) {
          this.pauseBatch('verification_required', '前程无忧要求人工验证，采集已暂停。');
          break;
        }
        let tab;
        try {
          tab = await this.context.newPage();
          await tab.goto(link.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          if (await this.verificationVisible(tab)) {
            this.pauseBatch('verification_required', '详情页要求人工验证，采集已暂停。');
            this.page = tab;
            tab = null;
            break;
          }
          if (await this.loginVisible(tab)) {
            this.pauseBatch('login_required', '详情页要求重新登录，采集已暂停。');
            this.page = tab;
            tab = null;
            break;
          }
          const result = await this.collectPage(tab);
          if (result.saved) this.batch.saved++;
          else {
            this.batch.skipped++;
            if (result.duplicate) this.batch.duplicates++;
          }
        } catch (error) {
          this.batch.failed++;
          this.recordBatchError(`第 ${index + 1} 份：${error.message}`);
        } finally {
          this.batch.processed++;
          if (tab && !tab.isClosed()) await tab.close().catch(() => {});
          if (!this.stopRequested && this.batch.saved < this.batch.targetCount) {
            await this.page.waitForTimeout(1800);
          }
        }
      }
    } finally {
      this.finishBatch();
    }
  }

  async stopBatch() {
    this.stopRequested = true;
    if (this.batch.running) this.batch.stopReason = 'stopped';
    return this.batch;
  }

  async stop() {
    this.stopRequested = true;
    this.lastSearch = null;
    const status = this.context && this.page && !this.page.isClosed?.()
      ? await this.getStatus().catch(() => null) : null;
    if (status?.isLoggedIn) {
      await this.sessionSaver(this.context, 'qcwy', { force: true }).catch(() => {});
    }
    if (this.browser) await this.browser.close().catch(() => {});
    this.browser = null;
    this.context = null;
    this.page = null;
    if (this.batch.running) this.batch.stopReason = 'stopped';
    this.batch.running = false;
    return this.getStatus();
  }
}

module.exports = { WuyouService, isWuyouUrl, parseLlmJson, nameFromResumeText, safeResumeUrl };
