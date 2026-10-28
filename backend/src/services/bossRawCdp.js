const { getCdpTabs } = require('./visibleChromeCdp');
const WebSocket = require('ws');

const RECRUITER_URL = /^https:\/\/www\.zhipin\.com\/web\/(?:boss|chat)(?:\/|\?|$)/i;
const VERIFY_URL = /captcha|\/verify(?:\.html)?(?:\/|\?|$)|\/security-check/i;
const DEFAULT_TIMEOUT_MS = 5000;
const PNG_PREFIX = 'data:image/png;base64,';
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_CANVAS_PIXELS = 16 * 1024 * 1024;
const MAX_IMAGE_BYTES = 24 * 1024 * 1024;

function cdpError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function safeRecruiterUrl(value) {
  return typeof value === 'string' && RECRUITER_URL.test(value) && !VERIFY_URL.test(value);
}

function validPageEndpoint(value, port) {
  try {
    const url = new URL(value);
    return url.protocol === 'ws:' && url.hostname === '127.0.0.1' &&
      url.port === String(port) && /^\/devtools\/page\/[A-Za-z0-9-]+$/.test(url.pathname) &&
      !url.search && !url.hash;
  } catch {
    return false;
  }
}

function decodePng(encoded) {
  if (typeof encoded !== 'string' || !encoded ||
      encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw cdpError('BOSS_CDP_IMAGE_INVALID', 'BOSS 简历图片编码无效');
  }
  const image = Buffer.from(encoded, 'base64');
  if (image.length < 24 || image.length > MAX_IMAGE_BYTES ||
      !image.subarray(0, 8).equals(PNG_SIGNATURE) ||
      image.readUInt32BE(8) !== 13 || image.toString('ascii', 12, 16) !== 'IHDR' ||
      !image.readUInt32BE(16) || !image.readUInt32BE(20) ||
      image.readUInt32BE(16) * image.readUInt32BE(20) > MAX_CANVAS_PIXELS) {
    throw cdpError('BOSS_CDP_IMAGE_INVALID', 'BOSS 简历 PNG 图片无效');
  }
  return image;
}

class BossRawCdpSession {
  constructor(socket,{owned=false}={}) {
    this.socket = socket;
    this.owned = owned === true;
    this.verifiedWindowId = null;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.pageDomainEnabled = false;
    socket.addEventListener('message', event => this.receive(event.data));
    socket.addEventListener('close', () => this.failPending('BOSS_CDP_DISCONNECTED', 'BOSS 浏览器连接已断开'));
    socket.addEventListener('error', () => this.failPending('BOSS_CDP_DISCONNECTED', 'BOSS 浏览器连接已断开'));
  }

  receive(raw) {
    let message;
    try { message = JSON.parse(raw); } catch { return; }
    if (!message || !Number.isInteger(message.id)) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) {
      // CDP errors can include private page content. Keep them out of logs.
      pending.reject(cdpError('BOSS_CDP_COMMAND_FAILED', 'BOSS 浏览器命令未完成'));
    } else {
      pending.resolve(message.result || {});
    }
  }

  failPending(code, message) {
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(cdpError(code, message));
    }
    this.pending.clear();
  }

  send(method, params = {}, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (this.closed || this.socket.readyState !== 1) {
      return Promise.reject(cdpError('BOSS_CDP_DISCONNECTED', 'BOSS 浏览器连接已断开'));
    }
    if (!/^[A-Za-z]+\.[A-Za-z]+$/.test(method) || !Number.isInteger(timeoutMs) ||
        timeoutMs < 100 || timeoutMs > 120000) {
      return Promise.reject(cdpError('BOSS_CDP_INVALID_COMMAND', 'BOSS 浏览器命令参数无效'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(cdpError('BOSS_CDP_TIMEOUT', 'BOSS 浏览器命令超时'));
      }, timeoutMs);
      this.pending.set(id, { timer, resolve, reject });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(cdpError('BOSS_CDP_DISCONNECTED', 'BOSS 浏览器连接已断开'));
      }
    });
  }

  async evaluate(expression, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (typeof expression !== 'string' || !expression.trim() || expression.length > 50000) {
      throw cdpError('BOSS_CDP_INVALID_EXPRESSION', 'BOSS 页面读取表达式无效');
    }
    const response = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      silent: true
    }, { timeoutMs });
    if (response.exceptionDetails || response.result?.subtype === 'error') {
      throw cdpError('BOSS_CDP_EVALUATION_FAILED', 'BOSS 页面读取失败');
    }
    return response.result?.value;
  }

  async assertRecruiterReady() {
    let state;
    try { state = await this.evaluate(`(() => {
      const url = location.href;
      const docs = [document];
      for (let depth = 0; depth < 3; depth++) {
        const current = [...docs];
        for (const doc of current) {
          for (const frame of doc.querySelectorAll('iframe')) {
            try {
              if (frame.contentDocument && !docs.includes(frame.contentDocument)) {
                docs.push(frame.contentDocument);
              }
            } catch (_) {}
          }
        }
      }
      const login = docs.some(doc => !!doc.querySelector(
        'input[placeholder*="手机号"], input[placeholder*="手机号码"]'));
      const verify = docs.some(doc => !!doc.querySelector(
        '.geetest_panel, .geetest_holder, .captcha-container, .captcha-wrap, #captcha, [class*="security-verify"]'));
      const rateLimited = docs.some(doc => /请求过于频繁|操作过于频繁|访问过于频繁|访问受限|获取验证码过于频繁|请稍后再试/
        .test(doc.body?.innerText || ''));
      return { url, login, verify, rateLimited };
    })()`, { timeoutMs: 12000 }); }
    catch (error) { error.stage = 'read_recruiter_state'; throw error; }
    // A redirect can occur between locating the owned tab and this read.
    // Classify the official verification/login page before rejecting its
    // non-recruiter URL so the caller keeps the correct human-action state.
    const currentUrl = String(state?.url || '');
    const code = state?.verify || VERIFY_URL.test(currentUrl)
      ? 'BOSS_VERIFICATION_REQUIRED'
      : state?.rateLimited ? 'BOSS_RATE_LIMITED'
        : state?.login || /^https:\/\/www\.zhipin\.com\/web\/user(?:[/?#]|$)/i.test(currentUrl)
          ? 'BOSS_LOGIN_REQUIRED'
          : !safeRecruiterUrl(currentUrl) ? 'BOSS_PAGE_UNAVAILABLE' : '';
    if (code) throw cdpError(code, 'BOSS 页面需要人工确认，已停止自动操作');
    return state.url;
  }

  async assertUsableRecruiterWindow({ frameSelector = 'iframe[src*="/web/frame/recommend/"]' } = {}) {
    if (!['iframe[src*="/web/frame/recommend/"]',
      'iframe[src*="/web/frame/search/"]'].includes(frameSelector)) {
      throw cdpError('BOSS_CDP_INVALID_TARGET', 'BOSS 招聘窗口选择器无效');
    }
    await this.assertRecruiterReady();
    let windowInfo;
    try { windowInfo = await this.send('Browser.getWindowForTarget', {}, { timeoutMs: 8000 }); }
    catch (error) { error.stage = 'read_window_bounds'; throw error; }
    if (this.owned && this.verifiedWindowId != null &&
        windowInfo?.windowId !== this.verifiedWindowId) {
      throw cdpError('BOSS_CDP_WINDOW_UNAVAILABLE',
        'BOSS 专用 Chrome 标签页已移到其他窗口，已暂停采集');
    }
    const windowState = windowInfo?.bounds?.windowState;
    if (windowState === 'minimized') {
      throw cdpError('BOSS_CDP_WINDOW_MINIMIZED',
        'BOSS 专用 Chrome 窗口已最小化；请恢复窗口后重新开始采集');
    }
    if (!['normal', 'maximized', 'fullscreen'].includes(windowState)) {
      throw cdpError('BOSS_CDP_WINDOW_UNAVAILABLE',
        'BOSS 专用 Chrome 窗口状态无法确认，已暂停采集');
    }
    const geometry = await this.evaluate(`(() => {
      const frame = document.querySelector(${JSON.stringify(frameSelector)});
      const rect = frame?.getBoundingClientRect();
      if (!rect) return { state: 'frame_unavailable' };
      const visibleWidth = Math.max(0, Math.min(innerWidth, rect.right) - Math.max(0, rect.left));
      const visibleHeight = Math.max(0, Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top));
      return { state: 'ready', viewportWidth: innerWidth, viewportHeight: innerHeight,
        frameWidth: rect.width, visibleWidth, visibleHeight,
        frameFullyVisible: rect.left >= -2 && rect.right <= innerWidth + 2 };
    })()`, { timeoutMs: 8000 });
    if (geometry?.state !== 'ready' ||
        !Number.isFinite(geometry.viewportWidth) || !Number.isFinite(geometry.viewportHeight) ||
        !Number.isFinite(geometry.frameWidth) || !Number.isFinite(geometry.visibleWidth) ||
        !Number.isFinite(geometry.visibleHeight)) {
      throw cdpError('BOSS_CDP_WINDOW_UNAVAILABLE',
        'BOSS 招聘页面可视区域无法确认，已暂停采集');
    }
    if (geometry.viewportWidth < 900 || geometry.viewportHeight < 600 ||
        geometry.visibleWidth < 700 || geometry.visibleHeight < 400 ||
        !geometry.frameFullyVisible) {
      throw cdpError('BOSS_CDP_VIEWPORT_TOO_SMALL',
        'BOSS 招聘窗口可视区域不足；请恢复并放大专用 Chrome 窗口，确保推荐列表完整显示后重试');
    }
    if (this.owned) {
      if (!Number.isSafeInteger(windowInfo.windowId) || windowInfo.windowId<=0) {
        throw cdpError('BOSS_CDP_WINDOW_UNAVAILABLE',
          'BOSS 专用 Chrome 窗口身份无法确认，已暂停采集');
      }
      if (this.verifiedWindowId==null) this.verifiedWindowId=windowInfo.windowId;
    }
    return true;
  }

  async restoreMinimizedOwnedWindow({expectedUrl}={}) {
    if (!this.owned || !Number.isSafeInteger(this.verifiedWindowId) ||
        this.verifiedWindowId<=0 || !safeRecruiterUrl(expectedUrl)) {
      throw cdpError('BOSS_CDP_WINDOW_RESTORE_UNAVAILABLE',
        'BOSS 专用 Chrome 窗口身份不足，无法自动恢复');
    }
    if (await this.assertRecruiterReady()!==expectedUrl) throw cdpError(
      'BOSS_PAGE_UNAVAILABLE','BOSS 页面地址已变化，无法自动恢复窗口');
    const before=await this.send('Browser.getWindowForTarget',{}, {timeoutMs:8000});
    if (before?.windowId!==this.verifiedWindowId) throw cdpError(
      'BOSS_CDP_WINDOW_RESTORE_UNAVAILABLE','BOSS 专用 Chrome 窗口已变化，无法自动恢复');
    if (before?.bounds?.windowState!=='minimized') return {attempted:false};
    // One command only. Its ACK can time out after Chrome applied the change;
    // observe the same owned window rather than sending setWindowBounds again.
    let ackError=null;
    try { await this.send('Browser.setWindowBounds',{
      windowId:this.verifiedWindowId,bounds:{windowState:'normal'}
    },{timeoutMs:8000}); }
    catch (error) {ackError=error;}
    let lastWindowState='unknown';
    for (let poll=0;poll<8;poll++) {
      await new Promise(resolve=>setTimeout(resolve,250));
      let after;
      try { after=await this.send('Browser.getWindowForTarget',{}, {timeoutMs:8000}); }
      catch (_) { continue; }
      if (after?.windowId!==this.verifiedWindowId) throw cdpError(
        'BOSS_CDP_WINDOW_RESTORE_UNCERTAIN',
        'BOSS 窗口恢复时标签页移到其他窗口，已暂停采集');
      lastWindowState=after?.bounds?.windowState || 'unknown';
      if (['normal','maximized','fullscreen'].includes(lastWindowState)) {
        if (await this.assertRecruiterReady()!==expectedUrl) throw cdpError(
          'BOSS_PAGE_UNAVAILABLE','BOSS 窗口恢复后页面地址已变化，已暂停采集');
        return {attempted:true,ackUncertain:!!ackError};
      }
      if (lastWindowState!=='minimized') break;
    }
    throw cdpError('BOSS_CDP_WINDOW_RESTORE_UNCERTAIN',
      lastWindowState==='minimized'
        ? 'BOSS 专用 Chrome 窗口仍处于最小化，已暂停采集；请在服务器桌面手动恢复窗口'
        : 'BOSS 专用 Chrome 窗口恢复结果无法确认，已暂停采集；请手动恢复窗口');
  }

  async restoreInitialMinimizedOwnedWindow({expectedUrl}={}) {
    // At task start there has not yet been a visible-window preflight, so the
    // usual restore path has no recorded window ID. Only an owned CDP target
    // with the exact recruiter URL may establish that ID while minimized.
    if (!this.owned || this.verifiedWindowId != null ||
        !safeRecruiterUrl(expectedUrl) ||
        await this.assertRecruiterReady() !== expectedUrl) {
      throw cdpError('BOSS_CDP_WINDOW_RESTORE_UNAVAILABLE',
        'BOSS 初始窗口身份无法确认，已暂停采集');
    }
    const before = await this.send('Browser.getWindowForTarget', {}, { timeoutMs: 8000 });
    if (!Number.isSafeInteger(before?.windowId) || before.windowId <= 0 ||
        before?.bounds?.windowState !== 'minimized') {
      throw cdpError('BOSS_CDP_WINDOW_RESTORE_UNAVAILABLE',
        'BOSS 初始窗口状态已变化，已暂停采集');
    }
    this.verifiedWindowId = before.windowId;
    return this.restoreMinimizedOwnedWindow({expectedUrl});
  }

  async assertOrRestoreInitialRecruiterWindow({frameSelector}={}) {
    try {
      return await this.assertUsableRecruiterWindow({frameSelector});
    } catch (error) {
      if (error.code !== 'BOSS_CDP_WINDOW_MINIMIZED') throw error;
      const expectedUrl = await this.assertRecruiterReady();
      await this.restoreInitialMinimizedOwnedWindow({expectedUrl});
      return this.assertUsableRecruiterWindow({frameSelector});
    }
  }

  targetExpression({ selector, frameSelector, identityAttribute, identityValue, scroll = false }) {
    if (typeof selector !== 'string' || !selector.trim() || selector.length > 500 ||
        (frameSelector != null && (typeof frameSelector !== 'string' || !frameSelector.trim() || frameSelector.length > 500)) ||
        (identityAttribute != null && !/^(?:id|value|textContent|data-[a-zA-Z0-9_-]+)$/.test(identityAttribute)) ||
        (identityAttribute != null && (typeof identityValue !== 'string' || identityValue.length > 5000)) ||
        (identityAttribute == null && identityValue != null)) {
      throw cdpError('BOSS_CDP_INVALID_TARGET', 'BOSS 点击目标参数无效');
    }
    const input = JSON.stringify({ selector, frameSelector, identityAttribute,
      identityValue, scroll });
    return `(() => {
      const spec = ${input};
      const frame = spec.frameSelector ? document.querySelector(spec.frameSelector) : null;
      if (spec.frameSelector && (!frame || !frame.contentDocument)) return { state: 'frame_unavailable' };
      const doc = frame ? frame.contentDocument : document;
      let matches;
      try { matches = [...doc.querySelectorAll(spec.selector)]; }
      catch (_) { return { state: 'invalid_selector' }; }
      if (spec.identityAttribute) matches = matches.filter(element =>
        spec.identityAttribute === 'textContent'
          ? (element.textContent || '').replace(/\\s+/g, ' ').trim() ===
            spec.identityValue.replace(/\\s+/g, ' ').trim()
          : element.getAttribute(spec.identityAttribute) === spec.identityValue);
      if (matches.length !== 1) return { state: matches.length ? 'ambiguous' : 'missing' };
      const element = matches[0];
      if (spec.scroll) { element.scrollIntoView({ block: 'center', inline: 'nearest' }); return { state: 'scrolled' }; }
      const rect = element.getBoundingClientRect();
      const style = doc.defaultView.getComputedStyle(element);
      if (!rect.width || !rect.height || style.display === 'none' ||
          style.visibility === 'hidden' || style.pointerEvents === 'none') return { state: 'hidden' };
      const isCard = element.matches('li.card-item, li.geek-info-card, .candidate-card-wrap, [class*="candidate-card"]');
      // The recruiter sidebar may cover the left half of this wide iframe.
      // Probe only points inside the exact card, including its visible right
      // side; elementFromPoint and the greet/button exclusions remain required.
      const points = isCard
        ? [[.75, .5], [.85, .5], [.75, .25], [.75, .75], [.9, .5],
          [.5, .5], [.5, .25], [.25, .5], [.25, .25], [.25, .75]]
        : [[.25, .5], [.5, .5], [.25, .25], [.5, .25], [.75, .25], [.25, .75], [.75, .75]];
      let point = null;
      for (const [fx, fy] of points) {
        const px = rect.left + rect.width * fx;
        const py = rect.top + rect.height * fy;
        if (px < 0 || py < 0 || px >= doc.defaultView.innerWidth ||
            py >= doc.defaultView.innerHeight) continue;
        const hit = doc.elementFromPoint(px, py);
        if (!hit || !(hit === element || element.contains(hit))) continue;
        if (hit.closest('.btn-greet, [ka*="greet"], [class*="btn-greet"]')) continue;
        if (isCard && hit.closest('button, a, [role="button"], input, textarea')) continue;
        point = { x: px, y: py };
        break;
      }
      if (!point) return { state: 'obscured' };
      let x = point.x;
      let y = point.y;
      let frameOrigin = 0;
      if (frame) {
        const outer = frame.getBoundingClientRect();
        const frameStyle = getComputedStyle(frame);
        if (!outer.width || !outer.height || frameStyle.display === 'none' ||
            frameStyle.visibility === 'hidden' || frameStyle.transform !== 'none') return { state: 'frame_unavailable' };
        x = outer.left + frame.clientLeft + point.x;
        y = outer.top + frame.clientTop + point.y;
        const outerHit = document.elementFromPoint(x, y);
        if (outerHit !== frame && !frame.contains(outerHit)) return { state: 'obscured' };
        frameOrigin = frame.contentWindow.performance.timeOrigin;
      }
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return { state: 'out_of_view' };
      return { state: 'ready', x, y, origin: performance.timeOrigin, frameOrigin };
    })()`;
  }

  async scrollUnique(options) {
    await this.assertRecruiterReady();
    const state = await this.evaluate(this.targetExpression({ ...options, scroll: true }));
    if (state?.state !== 'scrolled') {
      const error=cdpError('BOSS_CDP_TARGET_UNAVAILABLE',
        `BOSS 目标不可滚动：${state?.state || 'unknown'}`);
      error.stage='pre_scroll_probe';
      error.targetState=state?.state || 'unknown';
      throw error;
    }
    return true;
  }

  async captureCanvasPng({ frameSelector = null, frameSelectors = null,
    canvasSelector = 'canvas#resume', canvasIndex = 0,
    timeoutMs = 10000 } = {}) {
    const selectors = frameSelectors == null ? (frameSelector ? [frameSelector] : []) : frameSelectors;
    if (typeof canvasSelector !== 'string' || !canvasSelector.trim() ||
        canvasSelector.length > 500 ||
        !Array.isArray(selectors) || selectors.length > 3 ||
        selectors.some(selector => typeof selector !== 'string' ||
          !selector.trim() || selector.length > 500) ||
        (frameSelectors != null && frameSelector != null) ||
        !Number.isInteger(canvasIndex) || canvasIndex < 0 || canvasIndex > 20) {
      throw cdpError('BOSS_CDP_INVALID_TARGET', 'BOSS Canvas 选择器无效');
    }
    await this.assertRecruiterReady();
    const result = await this.evaluate(`(() => {
      let doc = document;
      for (const selector of ${JSON.stringify(selectors)}) {
        const frame = doc.querySelector(selector);
        if (!frame?.contentDocument) return { state: 'frame_unavailable' };
        doc = frame.contentDocument;
      }
      const canvas = doc.querySelectorAll(${JSON.stringify(canvasSelector)})[${canvasIndex}];
      if (!canvas || canvas.tagName !== 'CANVAS') return { state: 'missing' };
      if (!canvas.width || !canvas.height || canvas.width * canvas.height > ${MAX_CANVAS_PIXELS}) {
        return { state: 'dimensions' };
      }
      try { return { state: 'ready', dataUrl: canvas.toDataURL('image/png') }; }
      catch (_) { return { state: 'unreadable' }; }
    })()`, { timeoutMs });
    if (result?.state !== 'ready' || typeof result.dataUrl !== 'string' ||
        !result.dataUrl.startsWith(PNG_PREFIX)) {
      throw cdpError('BOSS_CDP_CANVAS_UNAVAILABLE',
        `BOSS 简历 Canvas 不可读取：${result?.state || 'unknown'}`);
    }
    try { return decodePng(result.dataUrl.slice(PNG_PREFIX.length)); }
    catch { throw cdpError('BOSS_CDP_CANVAS_INVALID', 'BOSS 简历 Canvas 图片无效'); }
  }

  // On the official search resume dialog the single Canvas can retain its
  // pixels while the enclosing resume viewport scrolls over content below it.
  // Capture only the visible intersection of that verified iframe and pane;
  // this is the screen the recruiter sees, with no navigation or interaction.
  async captureSearchResumeViewportPng({ expectedResumeUrl, expectedTop,
    timeoutMs = 15000 } = {}) {
    let expected;
    try { expected = new URL(expectedResumeUrl); } catch (_) {}
    if (!expected || expected.protocol !== 'https:' ||
        expected.hostname !== 'www.zhipin.com' ||
        !/^\/web\/frame\/c-resume\//.test(expected.pathname) ||
        !Number.isFinite(expectedTop) || expectedTop < 0) {
      throw cdpError('BOSS_CDP_INVALID_TARGET', 'BOSS 搜索简历区域身份无效');
    }
    const outerUrl = await this.assertRecruiterReady();
    await this.assertUsableRecruiterWindow({
      frameSelector:'iframe[src*="/web/frame/search/"]'
    });
    const geometryExpression = `(() => {
      if (document.visibilityState!=='visible') return {state:'hidden'};
      const dialogs=[...document.querySelectorAll(
        'div[data-type="boss-dialog"].active.dialog-wrap')];
      if (dialogs.length!==1) return {state:'dialog_unavailable'};
      const wrappers=[...dialogs[0].querySelectorAll(':scope > '
        + '.boss-popup__wrapper.boss-dialog.boss-dialog__wrapper.dialog-lib-resume')];
      if (wrappers.length!==1) return {state:'dialog_unavailable'};
      const panes=[...wrappers[0].querySelectorAll('.resume-detail-wrap')];
      if (panes.length!==1 || Math.abs(panes[0].scrollTop-${expectedTop})>2)
        return {state:'pane_changed'};
      const frames=[...panes[0].querySelectorAll(
        'iframe[src*="/web/frame/c-resume/"]')];
      if (frames.length!==1 || !frames[0].contentDocument ||
          frames[0].contentWindow.location.href!==${JSON.stringify(expected.href)})
        return {state:'frame_changed'};
      const canvases=[...frames[0].contentDocument.querySelectorAll('canvas#resume')];
      if (canvases.length!==1 || canvases[0].width<=300 ||
          canvases[0].height<=150 ||
          canvases[0].width*canvases[0].height>${MAX_CANVAS_PIXELS})
        return {state:'canvas_unavailable'};
      const pane=panes[0].getBoundingClientRect();
      const frame=frames[0].getBoundingClientRect();
      const x=Math.max(0,pane.left,frame.left);
      const y=Math.max(0,pane.top,frame.top);
      const right=Math.min(innerWidth,pane.right,frame.right);
      const bottom=Math.min(innerHeight,pane.bottom,frame.bottom);
      const width=right-x,height=bottom-y;
      if (width<500 || height<300 || width*height>${MAX_CANVAS_PIXELS})
        return {state:'out_of_view'};
      const hit=document.elementFromPoint(x+width/2,y+height/2);
      if (hit!==frames[0] && !frames[0].contains(hit))
        return {state:'obscured'};
      return {state:'ready',clip:{x,y,width,height,scale:1},
        outerOrigin:performance.timeOrigin,
        resumeOrigin:frames[0].contentWindow.performance.timeOrigin,
        scrollTop:panes[0].scrollTop};
    })()`;
    const before = await this.evaluate(geometryExpression, { timeoutMs });
    if (before?.state !== 'ready') throw cdpError('BOSS_CDP_REGION_UNAVAILABLE',
      `BOSS 搜索简历可见区域不可确认：${before?.state || 'unknown'}`);
    if (!this.pageDomainEnabled) {
      await this.send('Page.enable', {}, { timeoutMs });
      this.pageDomainEnabled = true;
    }
    const screenshot = await this.send('Page.captureScreenshot', {
      format:'png',fromSurface:true,captureBeyondViewport:false,
      clip:before.clip
    }, { timeoutMs });
    const after = await this.evaluate(geometryExpression, { timeoutMs });
    if (after?.state !== 'ready' ||
        after.outerOrigin !== before.outerOrigin ||
        after.resumeOrigin !== before.resumeOrigin ||
        Math.abs(after.scrollTop-before.scrollTop)>2 ||
        ['x','y','width','height'].some(key=>
          Math.abs(after.clip[key]-before.clip[key])>2) ||
        await this.assertRecruiterReady() !== outerUrl) {
      throw cdpError('BOSS_CDP_REGION_UNSTABLE',
        'BOSS 搜索简历在截图期间发生变化');
    }
    const image=decodePng(screenshot.data);
    if (Math.abs(image.readUInt32BE(16)-before.clip.width)>2 ||
        Math.abs(image.readUInt32BE(20)-before.clip.height)>2) {
      throw cdpError('BOSS_CDP_REGION_MISMATCH',
        'BOSS 搜索简历画面未被正确裁切');
    }
    return image;
  }

  async captureRegionPng({ frameSelector, selector, timeoutMs = 20000 } = {}) {
    if (typeof frameSelector !== 'string' || !frameSelector.trim() ||
        frameSelector.length > 500 || typeof selector !== 'string' ||
        !selector.trim() || selector.length > 500) {
      throw cdpError('BOSS_CDP_INVALID_TARGET', 'BOSS 简历区域选择器无效');
    }
    let initialUrl;
    try { initialUrl = await this.assertRecruiterReady(); }
    catch (error) { error.stage = 'capture_preflight'; throw error; }
    const geometryExpression = `(() => {
      const frame = document.querySelector(${JSON.stringify(frameSelector)});
      if (!frame?.contentDocument) return { state: 'frame_unavailable' };
      const frameUrl = new URL(frame.getAttribute('src') || '', location.href);
      if (frameUrl.origin !== 'https://www.zhipin.com' ||
          !/^\\/web\\/frame\\/recommend\\/?$/.test(frameUrl.pathname)) return { state: 'wrong_frame' };
      const doc = frame.contentDocument;
      const overlay = doc.querySelector('.dialog-wrap.active');
      const target = doc.querySelector(${JSON.stringify(selector)});
      if (!overlay || !target || (target !== overlay && !overlay.contains(target))) {
        return { state: 'not_resume_overlay' };
      }
      const style = doc.defaultView.getComputedStyle(target);
      const outer = frame.getBoundingClientRect();
      const rect = target.getBoundingClientRect();
      if (!rect.width || !rect.height || style.display === 'none' ||
          style.visibility === 'hidden' || getComputedStyle(frame).transform !== 'none') {
        return { state: 'hidden' };
      }
      const x1 = Math.max(0, outer.left + frame.clientLeft,
        outer.left + frame.clientLeft + rect.left);
      const y1 = Math.max(0, outer.top + frame.clientTop,
        outer.top + frame.clientTop + rect.top);
      const x2 = Math.min(innerWidth, outer.right,
        outer.left + frame.clientLeft + rect.right);
      const y2 = Math.min(innerHeight, outer.bottom,
        outer.top + frame.clientTop + rect.bottom);
      const width = x2 - x1;
      const height = y2 - y1;
      if (width < 200 || height < 200 || width * height > ${MAX_CANVAS_PIXELS}) {
        return { state: 'out_of_view' };
      }
      const hit = document.elementFromPoint(x1 + width / 2, y1 + height / 2);
      if (hit !== frame && !frame.contains(hit)) return { state: 'obscured' };
      return { state: 'ready', clip: { x: x1, y: y1, width, height, scale: 1 },
        origin: performance.timeOrigin, frameOrigin: frame.contentWindow.performance.timeOrigin };
    })()`;
    let geometry;
    try { geometry = await this.evaluate(geometryExpression, { timeoutMs }); }
    catch (error) { error.stage = 'capture_geometry'; throw error; }
    if (geometry?.state !== 'ready') {
      throw cdpError('BOSS_CDP_REGION_UNAVAILABLE',
        geometry?.state === 'out_of_view'
          ? 'BOSS 简历区域已移出可视窗口；请恢复并放大专用 Chrome 窗口后重试'
          : `BOSS 简历区域不可截图：${geometry?.state || 'unknown'}`);
    }
    if (!this.pageDomainEnabled) {
      try { await this.send('Page.enable', {}, { timeoutMs }); }
      catch (error) { error.stage = 'capture_enable'; throw error; }
      this.pageDomainEnabled = true;
    }
    let screenshot;
    try { screenshot = await this.send('Page.captureScreenshot', {
      format: 'png', fromSurface: true, captureBeyondViewport: false,
      clip: geometry.clip
    }, { timeoutMs }); }
    catch (error) { error.stage = 'capture_screenshot'; throw error; }
    let after;
    try { after = await this.evaluate(geometryExpression, { timeoutMs }); }
    catch (error) { error.stage = 'capture_postflight'; throw error; }
    let afterUrl;
    try { afterUrl = await this.assertRecruiterReady(); }
    catch (error) { error.stage = 'capture_postflight_state'; throw error; }
    if (after?.state !== 'ready' || after.origin !== geometry.origin ||
        after.frameOrigin !== geometry.frameOrigin || afterUrl !== initialUrl) {
      throw cdpError('BOSS_CDP_REGION_UNSTABLE', 'BOSS 简历区域在截图期间发生变化');
    }
    const image = decodePng(screenshot.data);
    if (Math.abs(image.readUInt32BE(16) - geometry.clip.width) > 2 ||
        Math.abs(image.readUInt32BE(20) - geometry.clip.height) > 2) {
      throw cdpError('BOSS_CDP_REGION_MISMATCH', 'BOSS 简历截图范围未被浏览器正确裁切');
    }
    return image;
  }

  async scrollOfficialResume({ frameSelector, deltaY, timeoutMs = 5000 } = {}) {
    if (typeof frameSelector !== 'string' || !frameSelector.trim() ||
        frameSelector.length > 500 || !Number.isFinite(deltaY) ||
        Math.abs(deltaY) < 1 || Math.abs(deltaY) > 900) {
      throw cdpError('BOSS_CDP_INVALID_TARGET', 'BOSS 简历滚动参数无效');
    }
    const initialUrl = await this.assertRecruiterReady();
    const inspect = `(() => {
      const outer = document.querySelector(${JSON.stringify(frameSelector)});
      if (!outer?.contentDocument) return { state: 'frame_unavailable' };
      const outerUrl = new URL(outer.getAttribute('src') || '', location.href);
      if (outerUrl.origin !== 'https://www.zhipin.com' ||
          !/^\\/web\\/frame\\/recommend\\/?$/.test(outerUrl.pathname)) return { state: 'wrong_frame' };
      const doc = outer.contentDocument;
      const overlay = doc.querySelector('.dialog-wrap.active');
      if (!overlay) return { state: 'not_resume_overlay' };
      const panes = [...overlay.querySelectorAll('.resume-detail-wrap')];
      if (panes.length !== 1) return { state: 'resume_pane_unavailable' };
      const pane = panes[0];
      const resumeFrames = [...pane.querySelectorAll('iframe[src*="c-resume"]')];
      if (resumeFrames.length !== 1 || !resumeFrames[0].contentDocument) {
        return { state: 'resume_frame_unavailable' };
      }
      const resumeFrame = resumeFrames[0];
      const resumeUrl = new URL(resumeFrame.getAttribute('src') || '', outerUrl.href);
      if (resumeUrl.origin !== 'https://www.zhipin.com' ||
          !/^\\/web\\/frame\\/c-resume\\/?$/.test(resumeUrl.pathname)) {
        return { state: 'wrong_resume_frame' };
      }
      const paneStyle = doc.defaultView.getComputedStyle(pane);
      const paneRect = pane.getBoundingClientRect();
      const frameRect = outer.getBoundingClientRect();
      const max = Math.max(0, pane.scrollHeight - pane.clientHeight);
      if (max < 20 || paneStyle.display === 'none' ||
          paneStyle.visibility === 'hidden' ||
          !/^(?:auto|scroll|overlay)$/.test(paneStyle.overflowY) ||
          getComputedStyle(outer).transform !== 'none') return { state: 'not_scrollable' };
      const innerX = paneRect.left + paneRect.width / 2;
      const innerY = paneRect.top + Math.min(paneRect.height / 2, 350);
      const hit = doc.elementFromPoint(innerX, innerY);
      if (!hit || !(hit === pane || pane.contains(hit)) ||
          hit.closest('.btn-greet, [ka*="greet"]')) return { state: 'obscured' };
      const x = frameRect.left + outer.clientLeft + innerX;
      const y = frameRect.top + outer.clientTop + innerY;
      const outerHit = document.elementFromPoint(x, y);
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight ||
          (outerHit !== outer && !outer.contains(outerHit))) return { state: 'out_of_view' };
      return { state: 'ready', x, y, before: pane.scrollTop, max,
        url: location.href,
        origin: performance.timeOrigin,
        frameOrigin: outer.contentWindow.performance.timeOrigin,
        resumeOrigin: resumeFrame.contentWindow.performance.timeOrigin,
        outerUrl: outer.getAttribute('src') || '',
        resumeUrl: resumeFrame.getAttribute('src') || '' };
    })()`;
    let result;
    try { result = await this.evaluate(inspect, { timeoutMs }); }
    catch (error) { error.stage = 'pre_scroll_probe'; throw error; }
    if (result?.state !== 'ready') {
      throw cdpError('BOSS_CDP_SCROLL_UNAVAILABLE',
        `BOSS 官方简历不可滚动：${result?.state || 'unknown'}`);
    }
    if (result.url !== initialUrl) {
      const error = cdpError('BOSS_CDP_REGION_UNSTABLE', 'BOSS 简历滚动前页面发生变化');
      error.stage = 'pre_scroll_probe';
      throw error;
    }
    const desired = Math.max(0, Math.min(result.max, result.before + deltaY));
    if (Math.abs(desired - result.before) < 1) {
      return { before: result.before, after: result.before, max: result.max };
    }
    let ackTimedOut = false;
    try {
      await this.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: result.x, y: result.y,
        deltaX: 0, deltaY
      }, { timeoutMs });
    } catch (error) {
      // The wheel event may already have been delivered before its CDP ack
      // timed out. Never send a second wheel to "retry" an uncertain action.
      if (error.code !== 'BOSS_CDP_TIMEOUT') {
        error.stage = 'wheel_ack';
        throw error;
      }
      ackTimedOut = true;
    }
    await new Promise(resolve => setTimeout(resolve, ackTimedOut ? 500 : 250));
    let after;
    try {
      after = await this.evaluate(inspect, {
        timeoutMs: Math.min(30000, Math.max(timeoutMs, 20000))
      });
    } catch (error) {
      const uncertain = cdpError('BOSS_CDP_SCROLL_UNCERTAIN',
        'BOSS 滚轮已发送，但未能确认简历位置；已暂停采集');
      uncertain.stage = 'post_wheel_observation';
      uncertain.cause = error;
      throw uncertain;
    }
    if (after?.origin !== result.origin ||
        after.state !== 'ready' ||
        after.url !== initialUrl ||
        after.frameOrigin !== result.frameOrigin ||
        after.resumeOrigin !== result.resumeOrigin ||
        after.outerUrl !== result.outerUrl ||
        after.resumeUrl !== result.resumeUrl) {
      const error = cdpError('BOSS_CDP_REGION_UNSTABLE', 'BOSS 简历滚动时页面发生变化');
      error.stage = 'post_wheel_observation';
      throw error;
    }
    if (Math.abs(after.before - result.before) < 1 ||
        (after.before - result.before) * deltaY < 0) {
      const error = cdpError(ackTimedOut ? 'BOSS_CDP_SCROLL_UNCERTAIN' : 'BOSS_CDP_SCROLL_STALLED',
        ackTimedOut ? 'BOSS 滚轮回执超时且未确认位置变化；已暂停采集'
          : 'BOSS 简历未按预期滚动');
      error.stage = 'post_wheel_observation';
      throw error;
    }
    return { before: result.before, after: after.before, max: after.max,
      ackTimedOut };
  }

  async setOfficialResumeScrollTop({ frameSelector, targetTop, timeoutMs = 12000 } = {}) {
    if (typeof frameSelector !== 'string' || !frameSelector.trim() ||
        frameSelector.length > 500 || !Number.isInteger(targetTop) || targetTop < 0) {
      throw cdpError('BOSS_CDP_INVALID_TARGET', 'BOSS 简历定位参数无效');
    }
    const initialUrl = await this.assertRecruiterReady();
    const inspect = `(() => {
      const outer = document.querySelector(${JSON.stringify(frameSelector)});
      if (!outer?.contentDocument) return { state: 'frame_unavailable' };
      const outerUrl = new URL(outer.getAttribute('src') || '', location.href);
      if (outerUrl.origin !== 'https://www.zhipin.com' ||
          !/^\\/web\\/frame\\/recommend\\/?$/.test(outerUrl.pathname)) return { state: 'wrong_frame' };
      const doc = outer.contentDocument;
      const overlay = doc.querySelector('.dialog-wrap.active');
      if (!overlay) return { state: 'not_resume_overlay' };
      const panes = [...overlay.querySelectorAll('.resume-detail-wrap')];
      if (panes.length !== 1) return { state: 'resume_pane_unavailable' };
      const pane = panes[0];
      const frames = [...pane.querySelectorAll('iframe[src*="c-resume"]')];
      if (frames.length !== 1 || !frames[0].contentDocument) {
        return { state: 'resume_frame_unavailable' };
      }
      const resumeFrame = frames[0];
      const resumeUrl = new URL(resumeFrame.getAttribute('src') || '', outerUrl.href);
      if (resumeUrl.origin !== 'https://www.zhipin.com' ||
          !/^\\/web\\/frame\\/c-resume\\/?$/.test(resumeUrl.pathname)) {
        return { state: 'wrong_resume_frame' };
      }
      const style = doc.defaultView.getComputedStyle(pane);
      const rect = pane.getBoundingClientRect();
      const max = Math.max(0, pane.scrollHeight - pane.clientHeight);
      if (!rect.width || !rect.height || style.display === 'none' ||
          style.visibility === 'hidden' ||
          !/^(?:auto|scroll|overlay)$/.test(style.overflowY)) {
        return { state: 'not_scrollable' };
      }
      return { state: 'ready', url: location.href, top: pane.scrollTop, max,
        scrollBehavior: style.scrollBehavior || '',
        scrollSnapType: style.scrollSnapType || '',
        clientHeight: pane.clientHeight, scrollHeight: pane.scrollHeight,
        origin: performance.timeOrigin,
        frameOrigin: outer.contentWindow.performance.timeOrigin,
        resumeOrigin: resumeFrame.contentWindow.performance.timeOrigin,
        outerSrc: outer.getAttribute('src') || '',
        resumeSrc: resumeFrame.getAttribute('src') || '' };
    })()`;
    let before;
    try { before = await this.evaluate(inspect, { timeoutMs }); }
    catch (error) { error.stage = 'pre_scroll_probe'; throw error; }
    if (before?.state !== 'ready' || before.url !== initialUrl) {
      const error = cdpError('BOSS_CDP_SCROLL_UNAVAILABLE',
        `BOSS 官方简历定位不可用：${before?.state || 'page_changed'}`);
      error.stage = 'pre_scroll_probe';
      throw error;
    }
    if (![before.top, before.max, before.origin, before.frameOrigin,
      before.resumeOrigin].every(Number.isFinite) || before.max < 0 ||
      before.max > MAX_CANVAS_PIXELS || typeof before.outerSrc !== 'string' ||
      typeof before.resumeSrc !== 'string') {
      throw cdpError('BOSS_CDP_SCROLL_UNAVAILABLE', 'BOSS 简历滚动状态无效');
    }
    if (targetTop > before.max) {
      throw cdpError('BOSS_CDP_INVALID_TARGET', 'BOSS 简历目标位置超过滚动范围');
    }
    if (Math.abs(before.top - targetTop) < 1) {
      return { before: before.top, after: before.top, max: before.max,
        ackTimedOut: false };
    }
    const setExpression = `(() => {
      const outer = document.querySelector(${JSON.stringify(frameSelector)});
      const doc = outer?.contentDocument;
      const overlay = doc?.querySelector('.dialog-wrap.active');
      const panes = [...(overlay?.querySelectorAll('.resume-detail-wrap') || [])];
      if (panes.length !== 1) return { state: 'resume_pane_unavailable' };
      const pane = panes[0];
      const frames = [...pane.querySelectorAll('iframe[src*="c-resume"]')];
      if (frames.length !== 1 || !frames[0].contentDocument) {
        return { state: 'resume_frame_unavailable' };
      }
      const outerUrl = new URL(outer.getAttribute('src') || '', location.href);
      const resumeUrl = new URL(frames[0].getAttribute('src') || '', outerUrl.href);
      if (outerUrl.origin !== 'https://www.zhipin.com' ||
          !/^\\/web\\/frame\\/recommend\\/?$/.test(outerUrl.pathname) ||
          resumeUrl.origin !== 'https://www.zhipin.com' ||
          !/^\\/web\\/frame\\/c-resume\\/?$/.test(resumeUrl.pathname) ||
          performance.timeOrigin !== ${before.origin} ||
          outer.contentWindow.performance.timeOrigin !== ${before.frameOrigin} ||
          frames[0].contentWindow.performance.timeOrigin !== ${before.resumeOrigin} ||
          outer.getAttribute('src') !== ${JSON.stringify(before.outerSrc)} ||
          frames[0].getAttribute('src') !== ${JSON.stringify(before.resumeSrc)} ||
          location.href !== ${JSON.stringify(initialUrl)}) return { state: 'changed' };
      const max = Math.max(0, pane.scrollHeight - pane.clientHeight);
      const style = doc.defaultView.getComputedStyle(pane);
      const rect = pane.getBoundingClientRect();
      if (${targetTop} > max || max > ${MAX_CANVAS_PIXELS} ||
          !rect.width || !rect.height || style.display === 'none' ||
          style.visibility === 'hidden' ||
          !/^(?:auto|scroll|overlay)$/.test(style.overflowY) ||
          Math.abs(pane.scrollTop - ${before.top}) > 2) return { state: 'range_changed' };
      if (typeof pane.scrollTo !== 'function') return { state: 'scroll_api_unavailable' };
      const current = pane.scrollTop;
      // BOSS sets scroll-behavior:smooth on this pane. A direct scrollTop
      // assignment can stay at the old position, so request one instantaneous
      // scroll without changing the page's CSS or retrying the action.
      pane.scrollTo({ top: ${targetTop}, left: pane.scrollLeft, behavior: 'instant' });
      return { state: 'ready', before: current, after: pane.scrollTop, max };
    })()`;
    let ackTimedOut = false;
    let setResult = null;
    try {
      setResult = await this.evaluate(setExpression, { timeoutMs });
      if (setResult?.state !== 'ready') {
        const error = cdpError('BOSS_CDP_REGION_UNSTABLE',
          `BOSS 简历定位前页面发生变化：${setResult?.state || 'unknown'}`);
        error.stage = 'set_scroll';
        throw error;
      }
    } catch (error) {
      if (error.code !== 'BOSS_CDP_TIMEOUT') {
        if (!error.stage) error.stage = 'set_scroll';
        throw error;
      }
      // Runtime.evaluate may have already changed scrollTop. Observe only.
      ackTimedOut = true;
    }
    await new Promise(resolve => setTimeout(resolve, ackTimedOut ? 500 : 250));
    let after;
    try {
      after = await this.evaluate(inspect, {
        timeoutMs: Math.min(30000, Math.max(timeoutMs, 20000))
      });
    } catch (error) {
      const uncertain = cdpError('BOSS_CDP_SCROLL_UNCERTAIN',
        'BOSS 简历定位命令已发送，但未能确认位置；已暂停采集');
      uncertain.stage = 'post_scroll_observation';
      uncertain.cause = error;
      throw uncertain;
    }
    if (after?.state !== 'ready' || after.url !== initialUrl ||
        after.origin !== before.origin ||
        after.frameOrigin !== before.frameOrigin ||
        after.resumeOrigin !== before.resumeOrigin ||
        after.outerSrc !== before.outerSrc ||
        after.resumeSrc !== before.resumeSrc) {
      const error = cdpError('BOSS_CDP_REGION_UNSTABLE', 'BOSS 简历定位时页面发生变化');
      error.stage = 'post_scroll_observation';
      throw error;
    }
    if (Math.abs(after.top - targetTop) > 2) {
      const error = cdpError('BOSS_CDP_SCROLL_UNCERTAIN',
        'BOSS 简历未到达指定位置；已暂停采集');
      error.stage = 'post_scroll_observation';
      // Numeric/CSS-only diagnostics reveal whether the assignment worked
      // immediately then got restored by the site or never changed at all.
      error.diagnostic = {
        targetTop, beforeTop: before.top,
        immediateTop: Number.isFinite(setResult?.after) ? setResult.after : null,
        observedTop: after.top, max: after.max,
        scrollBehavior: after.scrollBehavior,
        scrollSnapType: after.scrollSnapType,
        clientHeight: after.clientHeight,
        scrollHeight: after.scrollHeight,
        ackTimedOut
      };
      throw error;
    }
    return { before: before.top, after: after.top, max: after.max,
      ackTimedOut };
  }

  async revealOfficialResumeClose({ frameSelector, timeoutMs = 8000 } = {}) {
    if (typeof frameSelector !== 'string' || !frameSelector.trim() ||
        frameSelector.length > 500) {
      throw cdpError('BOSS_CDP_INVALID_TARGET', 'BOSS 简历关闭按钮选择器无效');
    }
    const initialUrl = await this.assertRecruiterReady();
    const inspect = `(() => {
      const outer = document.querySelector(${JSON.stringify(frameSelector)});
      if (!outer?.contentDocument) return { state: 'frame_unavailable' };
      const outerUrl = new URL(outer.getAttribute('src') || '', location.href);
      if (outerUrl.origin !== 'https://www.zhipin.com' ||
          !/^\\/web\\/frame\\/recommend\\/?$/.test(outerUrl.pathname)) return { state: 'wrong_frame' };
      const doc = outer.contentDocument;
      const overlay = doc.querySelector('.dialog-wrap.active');
      if (!overlay) return { state: 'not_resume_overlay' };
      const frames = [...overlay.querySelectorAll('iframe[src*="c-resume"]')];
      const closes = [...overlay.querySelectorAll('.close-btn')];
      if (frames.length !== 1 || closes.length !== 1 || !frames[0].contentDocument) {
        return { state: 'resume_dialog_unavailable' };
      }
      const resumeUrl = new URL(frames[0].getAttribute('src') || '', outerUrl.href);
      if (resumeUrl.origin !== 'https://www.zhipin.com' ||
          !/^\\/web\\/frame\\/c-resume\\/?$/.test(resumeUrl.pathname)) {
        return { state: 'wrong_resume_frame' };
      }
      const close = closes[0];
      const style = doc.defaultView.getComputedStyle(close);
      const rect = close.getBoundingClientRect();
      const frameRect = outer.getBoundingClientRect();
      if (!rect.width || !rect.height || style.display === 'none' ||
          style.visibility === 'hidden' || getComputedStyle(outer).transform !== 'none') {
        return { state: 'hidden' };
      }
      const innerX = rect.left + rect.width / 2;
      const innerY = rect.top + rect.height / 2;
      const hit = doc.elementFromPoint(innerX, innerY);
      if (!hit || !(hit === close || close.contains(hit))) return { state: 'obscured' };
      const x = frameRect.left + outer.clientLeft + innerX;
      const y = frameRect.top + outer.clientTop + innerY;
      const root = document.scrollingElement || document.documentElement;
      const max = Math.max(0, root.scrollWidth - root.clientWidth);
      const topHit = x >= 0 && x < innerWidth && y >= 0 && y < innerHeight
        ? document.elementFromPoint(x, y) : null;
      const visible = x >= 8 && x <= innerWidth - 8 && y >= 8 && y <= innerHeight - 8 &&
        (topHit === outer || outer.contains(topHit));
      return { state: 'ready', url: location.href, x, y, visible,
        viewportWidth: innerWidth, viewportHeight: innerHeight,
        before: root.scrollLeft, max,
        origin: performance.timeOrigin,
        frameOrigin: outer.contentWindow.performance.timeOrigin,
        resumeOrigin: frames[0].contentWindow.performance.timeOrigin,
        outerSrc: outer.getAttribute('src') || '',
        resumeSrc: frames[0].getAttribute('src') || '' };
    })()`;
    let before;
    try { before = await this.evaluate(inspect, { timeoutMs }); }
    catch (error) { error.stage = 'pre_reveal_probe'; throw error; }
    if (before?.state !== 'ready' || before.url !== initialUrl ||
        ![before.x,before.y,before.before,before.max,before.origin,
          before.frameOrigin,before.resumeOrigin].every(Number.isFinite)) {
      const error = cdpError('BOSS_CDP_TARGET_UNAVAILABLE',
        `BOSS 官方简历关闭按钮不可用：${before?.state || 'page_changed'}`);
      error.stage = 'pre_reveal_probe';
      throw error;
    }
    if (before.visible) return { before: before.before, after: before.before,
      max: before.max, visible: true };
    if (before.y < 8 || before.y > before.viewportHeight - 8 ||
        !Number.isFinite(before.viewportWidth) || before.max > 2000) {
      throw cdpError('BOSS_CDP_TARGET_UNAVAILABLE', 'BOSS 简历关闭按钮不在可安全显示的区域');
    }
    const target = Math.max(0, Math.min(before.max,
      before.before + Math.ceil(before.x - (before.viewportWidth - 20))));
    if (!Number.isFinite(target) || Math.abs(target - before.before) > 400 ||
        target === before.before) {
      throw cdpError('BOSS_CDP_TARGET_UNAVAILABLE', 'BOSS 简历关闭按钮无法通过有限水平滚动显示');
    }
    const setExpression = `(() => {
      const outer = document.querySelector(${JSON.stringify(frameSelector)});
      const doc = outer?.contentDocument;
      const overlay = doc?.querySelector('.dialog-wrap.active');
      const closes = [...(overlay?.querySelectorAll('.close-btn') || [])];
      const frames = [...(overlay?.querySelectorAll('iframe[src*="c-resume"]') || [])];
      const root = document.scrollingElement || document.documentElement;
      if (!outer?.contentDocument || closes.length !== 1 || frames.length !== 1 ||
          !frames[0].contentDocument ||
          location.href !== ${JSON.stringify(initialUrl)} ||
          performance.timeOrigin !== ${before.origin} ||
          outer.contentWindow.performance.timeOrigin !== ${before.frameOrigin} ||
          frames[0].contentWindow.performance.timeOrigin !== ${before.resumeOrigin} ||
          outer.getAttribute('src') !== ${JSON.stringify(before.outerSrc)} ||
          frames[0].getAttribute('src') !== ${JSON.stringify(before.resumeSrc)} ||
          Math.abs(root.scrollLeft - ${before.before}) > 2 ||
          ${target} > root.scrollWidth - root.clientWidth) return { state: 'changed' };
      root.scrollLeft = ${target};
      return { state: 'ready', after: root.scrollLeft };
    })()`;
    let ackTimedOut = false;
    try {
      const setResult = await this.evaluate(setExpression, { timeoutMs });
      if (setResult?.state !== 'ready') {
        throw cdpError('BOSS_CDP_TARGET_UNSTABLE', 'BOSS 简历关闭按钮位置发生变化');
      }
    } catch (error) {
      if (error.code !== 'BOSS_CDP_TIMEOUT') {
        error.stage = 'horizontal_scroll';
        throw error;
      }
      ackTimedOut = true;
    }
    await new Promise(resolve => setTimeout(resolve, ackTimedOut ? 500 : 250));
    let after;
    try { after = await this.evaluate(inspect, { timeoutMs: Math.max(timeoutMs, 15000) }); }
    catch (error) {
      const uncertain = cdpError('BOSS_CDP_TARGET_UNSTABLE',
        'BOSS 简历关闭按钮水平滚动后未能确认位置');
      uncertain.stage = 'post_reveal_probe';
      uncertain.cause = error;
      throw uncertain;
    }
    if (after?.state !== 'ready' || after.url !== initialUrl || !after.visible ||
        after.origin !== before.origin || after.frameOrigin !== before.frameOrigin ||
        after.resumeOrigin !== before.resumeOrigin ||
        after.outerSrc !== before.outerSrc || after.resumeSrc !== before.resumeSrc) {
      const error = cdpError('BOSS_CDP_TARGET_UNSTABLE',
        'BOSS 简历关闭按钮仍未安全显示在窗口中');
      error.stage = 'post_reveal_probe';
      throw error;
    }
    return { before: before.before, after: after.before,
      max: after.max, visible: true, ackTimedOut };
  }

  async clickUnique(options) {
    const initialUrl = await this.assertRecruiterReady();
    const expression = this.targetExpression(options);
    let first = await this.evaluate(expression);
    if (options.selector === 'li.card-item' && first?.state === 'obscured') {
      // A fixed menu or a brief repaint may mask the card immediately after
      // scrollIntoView. No mouse event has been sent: wait once, verify the
      // page identity, and read the same exact card again.
      await new Promise(resolve => setTimeout(resolve, 500));
      if (await this.assertRecruiterReady() !== initialUrl) {
        throw cdpError('BOSS_CDP_TARGET_UNSTABLE', 'BOSS 候选卡所在页面已变化，已停止操作');
      }
      first = await this.evaluate(expression);
    }
    if (first?.state !== 'ready') {
      const error = cdpError('BOSS_CDP_TARGET_UNAVAILABLE',
        `BOSS 点击目标不可用：${first?.state || 'unknown'}`);
      error.stage = 'pre_click_probe';
      error.targetState = first?.state || 'unknown';
      throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
    const second = await this.evaluate(expression);
    const recheckedUrl = await this.assertRecruiterReady();
    const reason = second?.state !== 'ready' ? 'target_not_ready'
      : second.origin !== first.origin || second.frameOrigin !== first.frameOrigin
        ? 'document_changed'
        : recheckedUrl !== initialUrl ? 'url_changed'
          : Math.abs(second.x - first.x) > 3 || Math.abs(second.y - first.y) > 3
            ? 'position_moved' : '';
    if (reason) {
      const error = cdpError('BOSS_CDP_TARGET_UNSTABLE',
        'BOSS 点击目标发生变化，已停止操作');
      error.stage = 'pre_click_recheck';
      error.reason = reason;
      error.targetState = second?.state || 'unknown';
      throw error;
    }
    let pressError = null;
    try {
      await this.send('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: second.x, y: second.y,
        button: 'left', buttons: 1, clickCount: 1
      });
    } catch (error) {
      pressError = error;
    } finally {
      // A timed-out press may have reached Chrome. Always release once so the
      // browser is not left with a held button; never retry the press.
      try {
        await this.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased', x: second.x, y: second.y,
          button: 'left', buttons: 0, clickCount: 1
        });
      } catch (error) { if (!pressError) pressError = error; }
    }
    if (pressError) {
      const uncertain = cdpError('BOSS_CDP_CLICK_UNCERTAIN',
        'BOSS 点击命令未得到确认，已停止自动操作');
      uncertain.stage = 'click_ack';
      uncertain.cause = pressError;
      throw uncertain;
    }
    return true;
  }

  close() {
    if (this.closed) return;
    this.failPending('BOSS_CDP_DISCONNECTED', 'BOSS 浏览器连接已断开');
    try { this.socket.close(); } catch {}
  }
}

async function connectOwnedBossPage({ port = 19222, preferredUrl = null } = {},
  { readTabs = getCdpTabs, fetchImpl = fetch,
    WebSocketImpl = WebSocket } = {}) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535 ||
      (preferredUrl != null && !safeRecruiterUrl(preferredUrl))) {
    throw cdpError('BOSS_CDP_INVALID_TARGET', 'BOSS 浏览器端口或页面无效');
  }
  if (typeof WebSocketImpl !== 'function') {
    throw cdpError('BOSS_CDP_UNAVAILABLE', '当前 Node.js 不支持 WebSocket');
  }
  // getCdpTabs verifies the saved browser identity before any page attachment.
  const ownedTabs = await readTabs({ profileName: 'boss', port });
  const allowed = ownedTabs.filter(tab => safeRecruiterUrl(tab.url) &&
    (!preferredUrl || tab.url === preferredUrl));
  if (allowed.length !== 1) {
    throw cdpError('BOSS_CDP_PAGE_UNAVAILABLE', '未找到唯一的 BOSS 招聘后台页面');
  }
  const response = await fetchImpl(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(3000)
  });
  if (!response.ok) throw cdpError('BOSS_CDP_PAGE_UNAVAILABLE', '无法读取 BOSS 浏览器标签页');
  const targets = await response.json();
  const matches = targets.filter(target => target.type === 'page' &&
    target.url === allowed[0].url && validPageEndpoint(target.webSocketDebuggerUrl, port));
  if (matches.length !== 1) {
    throw cdpError('BOSS_CDP_PAGE_UNAVAILABLE', 'BOSS 招聘后台页面已变化');
  }
  const socket = new WebSocketImpl(matches[0].webSocketDebuggerUrl);
  try {
    await new Promise((resolve, reject) => {
      if (socket.readyState === 1) return resolve();
      const timer = setTimeout(() => finish(cdpError('BOSS_CDP_TIMEOUT', 'BOSS 浏览器连接超时')),
        5000);
      function finish(error) {
        clearTimeout(timer);
        socket.removeEventListener('open', onOpen);
        socket.removeEventListener('error', onError);
        socket.removeEventListener('close', onClose);
        if (error) reject(error); else resolve();
      }
      const onOpen = () => finish();
      const onError = () => finish(cdpError('BOSS_CDP_DISCONNECTED', 'BOSS 浏览器连接失败'));
      const onClose = () => finish(cdpError('BOSS_CDP_DISCONNECTED', 'BOSS 浏览器连接已断开'));
      socket.addEventListener('open', onOpen, { once: true });
      socket.addEventListener('error', onError, { once: true });
      socket.addEventListener('close', onClose, { once: true });
    });
    // Runtime.evaluate can use the page's default context without enabling
    // Runtime. Keep connection passive: enabling that domain may itself be
    // observable by this site and has correlated with unexpected reloads.
    return new BossRawCdpSession(socket,{owned:true});
  } catch (error) {
    try { socket.close(); } catch {}
    throw error;
  }
}

module.exports = { BossRawCdpSession, connectOwnedBossPage };
