const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { setTimeout: sleep } = require('node:timers/promises');
const { chromium } = require('playwright');

function installedChromePath({ environment = process.env, platform = process.platform,
  fileExists = fs.existsSync } = {}) {
  const candidates = [
    environment.CHROME_EXECUTABLE_PATH,
    platform === 'win32' && path.win32.join(environment.PROGRAMFILES || 'C:\\Program Files',
      'Google', 'Chrome', 'Application', 'chrome.exe'),
    platform === 'win32' && path.win32.join(environment['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)',
      'Google', 'Chrome', 'Application', 'chrome.exe'),
    platform === 'win32' && environment.LOCALAPPDATA && path.win32.join(environment.LOCALAPPDATA,
      'Google', 'Chrome', 'Application', 'chrome.exe'),
    platform === 'darwin' && '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    platform === 'linux' && '/usr/bin/google-chrome'
  ].filter(Boolean);
  const found = candidates.find(candidate => fileExists(candidate));
  if (!found) throw new Error('未找到已安装的 Google Chrome；请安装 Chrome 或设置 CHROME_EXECUTABLE_PATH');
  return found;
}

async function cdpIdentity(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1500)
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.webSocketDebuggerUrl || null;
  } catch {
    return null;
  }
}

function startChrome({ chromePath, profileDir, initialUrl, port }) {
  if (process.platform === 'win32') {
    // A directly spawned Chrome inherits the backend's listening socket on
    // Windows. Killing Node then leaves port 5001 owned by a dead PID until
    // every Chrome process exits. Start-Process creates Chrome independently;
    // the short-lived PowerShell launcher releases any inherited handles.
    const launcher = path.join(__dirname, 'launchVisibleChrome.ps1');
    const result = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-File', launcher,
      '-ChromePath', chromePath,
      '-ProfileDir', profileDir,
      '-Port', String(port),
      '-InitialUrl', initialUrl
    ], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 4096
    });
    if (result.error || result.status !== 0) {
      throw new Error(`Chrome 启动失败: ${(result.stderr || result.error?.message || '未知错误').trim()}`);
    }
    const pid = Number.parseInt(result.stdout.trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('Chrome 启动后未返回进程编号');
    return { pid };
  }

  const child = spawn(chromePath, [
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window',
    initialUrl
  ], { stdio: 'ignore', detached: true, windowsHide: false });
  child.on('error', () => {});
  child.unref();
  return child;
}

/** Open a dedicated normal Chrome window without attaching automation yet. */
async function openVisibleChromeCdp({ profileName, initialUrl, port }) {
  if (!/^[a-z0-9-]+$/i.test(profileName)) throw new Error('无效的 Chrome 配置目录名称');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('无效的 CDP 端口');
  if (!/^https:\/\//i.test(initialUrl)) throw new Error('Chrome 初始页面必须是 HTTPS 地址');
  const profileDir = path.resolve(__dirname, '../../../.local/browser-profiles', profileName);
  fs.mkdirSync(profileDir, { recursive: true });
  const identityFile = path.join(profileDir, '.codex-cdp-session.json');

  let launched = false;
  let processHandle = null;
  let identity = await cdpIdentity(port);
  if (identity) {
    let savedIdentity = null;
    try { savedIdentity = JSON.parse(fs.readFileSync(identityFile, 'utf8')); } catch {}
    if (savedIdentity?.port !== port || savedIdentity?.webSocketDebuggerUrl !== identity) {
      throw new Error(`CDP 端口 ${port} 已被其他 Chrome 占用；不会连接到非本应用的浏览器`);
    }
  } else {
    const chromePath = installedChromePath();
    processHandle = startChrome({ chromePath, profileDir, initialUrl, port });
    launched = true;
    for (let attempt = 0; attempt < 40; attempt++) {
      identity = await cdpIdentity(port);
      if (identity) break;
      await sleep(500);
    }
    if (!identity) throw new Error('Chrome 已启动，但本地 CDP 连接未就绪');
    fs.writeFileSync(identityFile, JSON.stringify({ port, webSocketDebuggerUrl: identity }), 'utf8');
    // Employer login pages can take 20–30 seconds to render on this machine.
    // Leave ordinary Chrome alone until the user can see the login window.
    await sleep(25000);
  }

  const tabs = await getCdpTabs({ profileName, port });
  return { port, profileDir, processHandle, launched, tabs };
}

async function readOwnedCdpSession({ profileName, port }) {
  const profileDir = path.resolve(__dirname, '../../../.local/browser-profiles', profileName);
  const identityFile = path.join(profileDir, '.codex-cdp-session.json');
  let savedIdentity = null;
  try { savedIdentity = JSON.parse(fs.readFileSync(identityFile, 'utf8')); } catch {}
  const identity = await cdpIdentity(port);
  if (!identity || savedIdentity?.port !== port || savedIdentity?.webSocketDebuggerUrl !== identity) {
    throw new Error(`CDP 端口 ${port} 未连接到本应用的 Chrome 窗口`);
  }
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(3000)
  });
  if (!response.ok) throw new Error('无法读取本地 Chrome 标签状态');
  const targets = await response.json();
  return {
    webSocketDebuggerUrl: identity,
    tabs: targets.filter(target => target.type === 'page').map(target => ({
      url: target.url,
      title: target.title
    }))
  };
}

async function getCdpTabs(options) {
  return (await readOwnedCdpSession(options)).tabs;
}

/** Attach to the same dedicated window once login is complete. */
async function launchVisibleChromeCdp(options) {
  const opened = await openVisibleChromeCdp(options);
  const { port, initialUrl } = options;

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 15000 });
  const context = browser.contexts()[0];
  if (!context) throw new Error('Chrome CDP 未返回默认浏览器会话');
  const pages = context.pages();
  const page = pages.find(candidate => !candidate.isClosed() && candidate.url() === initialUrl) ||
    pages.find(candidate => !candidate.isClosed() && /^https?:\/\//.test(candidate.url())) ||
    pages.find(candidate => !candidate.isClosed()) || await context.newPage();
  return { ...opened, browser, context, page };
}

/** Attach only to a live, owned Chrome session; never launch or navigate it. */
async function attachExistingVisibleChromeCdp(options,
  { browserType = chromium, readSession = readOwnedCdpSession } = {}) {
  const { tabs, webSocketDebuggerUrl } = await readSession(options);
  // Reuse the exact owned endpoint that was just verified against the saved
  // Chrome identity. Passing an HTTP URL makes Playwright fetch /json/version/
  // a second time before opening its WebSocket, which is unnecessary here.
  const browser = await browserType.connectOverCDP(webSocketDebuggerUrl, { timeout: 15000 });
  try {
    const context = browser.contexts()[0];
    if (!context) throw new Error('Chrome CDP 未返回默认浏览器会话');
    return { browser, context, tabs };
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  }
}

module.exports = { openVisibleChromeCdp, launchVisibleChromeCdp,
  attachExistingVisibleChromeCdp, getCdpTabs, installedChromePath };
