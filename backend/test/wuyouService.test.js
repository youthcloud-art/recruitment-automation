const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { WuyouService, isWuyouUrl, parseLlmJson, nameFromResumeText, safeResumeUrl } = require('../src/services/wuyouService');

test('51Job heading is not treated as candidate name and source URL keeps safe resume ID', () => {
  assert.equal(nameFromResumeText('个人信息\n张三\n工作经历\n成本核算'), '张三');
  assert.equal(nameFromResumeText('个人信息\n工作经历\n成本核算'), null);
  assert.equal(nameFromResumeText('通知\n张三\n工作经历\n网络运维'), null);
  assert.equal(nameFromResumeText('通知\n姓名：张三\n工作经历\n网络运维'), '张三');
  assert.equal(safeResumeUrl('https://ehire.51job.com/Revision/talent/resume/detail?resumeId=abc123&token=secret'),
    'https://ehire.51job.com/Revision/talent/resume/detail?resumeId=abc123');
});

test('51Job read-only status does not persist a browser session', async () => {
  let saved = 0;
  const service = new WuyouService({ sessionSaver: async () => { saved++; } });
  service.browser = { isConnected: () => true };
  service.context = {};
  service.page = {
    isClosed: () => false,
    url: () => 'https://ehire.51job.com/Revision/talent/search',
    locator: selector => selector === 'body'
      ? { innerText: async () => '人才搜索' }
      : { first: () => ({ isVisible: async () =>
        selector === '.talent_search_keywords_input input' }) }
  };
  service.verificationVisible = async () => false;
  const status = await service.getStatus({ persistSession: false });
  assert.equal(status.status, 'ready');
  assert.equal(saved, 0);
});

test('51Job URL allowlist and AI JSON parsing', () => {
  assert.equal(isWuyouUrl('https://ehire.51job.com/candidate/detail/1'), true);
  assert.equal(isWuyouUrl('https://ehire.51job.com.evil.test/candidate/1'), false);
  assert.equal(isWuyouUrl('http://ehire.51job.com/candidate/1'), false);
  assert.deepEqual(parseLlmJson('```json\n{"name":"测试候选人"}\n```'), { name: '测试候选人' });
  assert.throws(() => parseLlmJson('无法解析'), /可用/);
});

test('51Job page diagnostics expose structure and state without candidate details', async () => {
  const service = new WuyouService();
  const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  try {
    const page = await browser.newPage();
    service.page = page;
    service.requireLogin = async () => {};
    await page.route('https://ehire.51job.com/**', route => route.fulfill({
      contentType: 'text/html', body: '<meta charset="utf-8"><body>' +
        '<div class="talent_search_keywords_input"><input value="成本核算经理"></div>' +
        '<div class="main_container eh-talent-search">' +
        '<div class="job-list-wrapper"><div class="resume-card"><div class="el-card">' +
        '<span class="name">侧栏候选人</span></div></div></div>' +
        '<div class="talent-search-container"><div class="list-box"><div class="virtual_list">' +
        '<div class="resume-card candidate-privatealice"><div class="el-card">' +
        '<span class="name">私密候选人</span><span>alice.private@example.com</span>' +
        '</div></div></div></div></div></div>' +
        '<p>暂无数据。请完成安全验证。</p></body>'
    }));
    await page.goto('https://ehire.51job.com/Revision/talent/search');
    const diagnostics = await service.getPageDiagnostics();
    assert.equal(diagnostics.cards, 1);
    assert.equal(diagnostics.populatedCards, 1);
    assert.equal(diagnostics.names, 1);
    assert.equal(diagnostics.resultListPresent, true);
    assert.equal(diagnostics.layoutCounts.resultVirtualLists, 1);
    assert.equal(diagnostics.layoutCounts.scrollerResumeNodes, 2);
    assert.equal(diagnostics.layoutCounts.scrollerCardNodes, 4);
    assert.equal(diagnostics.listStructure.resultListChildren[0].tag, 'div');
    assert.ok(diagnostics.likelyResultStructures.length > 0);
    assert.ok(diagnostics.likelyResultStructures.some(item =>
      item.ancestors.some(ancestor => ancestor.classes.includes('resume-card'))));
    assert.equal(diagnostics.pageMessages.noResults, true);
    assert.equal(diagnostics.pageMessages.verificationRequired, true);
    assert.equal(diagnostics.pageMessages.permissionRequired, false);
    assert.doesNotMatch(JSON.stringify(diagnostics), /私密候选人|侧栏候选人|alice\.private|candidate-privatealice/);
  } finally {
    await browser.close();
  }
});

test('51Job start coalesces concurrent requests', async () => {
  const service = new WuyouService();
  let release;
  let starts = 0;
  service.startBrowser = () => {
    starts++;
    return new Promise(resolve => { release = resolve; });
  };
  const first = service.start();
  const second = service.start();
  assert.equal(starts, 1);
  release({ status: 'waiting_login' });
  assert.deepEqual(await first, { status: 'waiting_login' });
  assert.deepEqual(await second, { status: 'waiting_login' });
  assert.equal(service.startPromise, null);
});

test('51Job start retries a browser-closed launch with bundled Chromium', async () => {
  const oldChannel = process.env.PLAYWRIGHT_CHANNEL;
  process.env.PLAYWRIGHT_CHANNEL = 'chrome';
  const launches = [];
  const page = {
    on() {},
    async goto() {},
    async waitForLoadState() {},
    isClosed: () => false,
    url: () => 'https://ehire.51job.com/',
    locator: selector => selector === 'body'
      ? { innerText: async () => '扫码登录 短信登录' }
      : { first: () => ({ isVisible: async () => false }) }
  };
  const browser = {
    isConnected: () => true,
    newContext: async () => ({ newPage: async () => page }),
    close: async () => {}
  };
  const service = new WuyouService({ browserType: {
    launch: async options => {
      launches.push(options.channel);
      if (launches.length === 1) {
        throw new Error('browserType.launch: Target page, context or browser has been closed');
      }
      return browser;
    }
  } });
  try {
    const result = await service.start();
    assert.deepEqual(launches, ['chrome', undefined]);
    assert.equal(result.status, 'waiting_login');
    assert.equal(result.hasBrowser, true);
  } finally {
    await service.stop();
    if (oldChannel === undefined) delete process.env.PLAYWRIGHT_CHANNEL;
    else process.env.PLAYWRIGHT_CHANNEL = oldChannel;
  }
});

test('51Job start waits for a restored SPA session to redirect before reporting login state', async () => {
  let currentUrl = 'about:blank';
  let delayedChecks = 0;
  const page = {
    on() {},
    isClosed: () => false,
    url: () => currentUrl,
    goto: async () => { currentUrl = 'https://ehire.51job.com/Revision/talent/search'; },
    waitForLoadState: async () => {},
    waitForTimeout: async () => {
      delayedChecks++;
      currentUrl = 'https://ehire.51job.com/Revision/login';
    },
    locator: selector => selector === 'body'
      ? { innerText: async () => currentUrl.includes('/login') ? '扫码登录 短信登录' : '人才搜索' }
      : { first: () => ({ isVisible: async () =>
        selector === '.talent_search_keywords_input input' && !currentUrl.includes('/login') }) }
  };
  const browser = {
    isConnected: () => true,
    newContext: async () => ({
      newPage: async () => page,
      storageState: async () => ({ cookies: [], origins: [] })
    }),
    close: async () => {}
  };
  const service = new WuyouService({ browserType: { launch: async () => browser } });
  try {
    const result = await service.start();
    assert.equal(delayedChecks, 1);
    assert.equal(result.status, 'waiting_login');
    assert.equal(result.isLoggedIn, false);
    assert.equal(result.url, 'https://ehire.51job.com/Revision/login');
  } finally {
    await service.stop();
  }
});

test('normal Chrome CDP restores saved session only in a newly opened unauthenticated window', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qcwy-session-test-'));
  const file = path.join(directory, 'state.json');
  fs.writeFileSync(file, JSON.stringify({
    cookies: [{ name: 'test', value: 'local-only', domain: '.51job.com', path: '/' }],
    origins: [{ origin: 'https://ehire.51job.com',
      localStorage: [{ name: 'test', value: 'local-only' }] }]
  }));
  try {
    const makeService = launched => {
      const events = { cookies: 0, scripts: 0, navigations: 0, saved: 0 };
      const page = {
        on() {}, url: () => 'https://ehire.51job.com/Revision/login',
        locator: () => ({ first: () => ({ waitFor: async () => {} }) }),
        evaluate: async () => false,
        goto: async () => { events.navigations++; }
      };
      const context = {
        addCookies: async cookies => { events.cookies += cookies.length; },
        addInitScript: async () => { events.scripts++; }
      };
      const service = new WuyouService({ useVisibleCdp: true,
        sessionLoader: async () => file,
        sessionSaver: async () => { events.saved++; },
        visibleChromeLauncher: async options => {
          assert.deepEqual(options, { profileName: 'qcwy',
            initialUrl: 'https://ehire.51job.com/Revision/talent/search', port: 19224 });
          return { launched, page, context, browser: { isConnected: () => true } };
        }
      });
      let calls = 0;
      service.getStatus = async () => {
        calls++;
        return { status: calls >= 3 && launched ? 'ready' : 'waiting_login',
          isLoggedIn: calls >= 3 && launched, verificationRequired: false };
      };
      return { service, events };
    };
    const fresh = makeService(true);
    assert.equal((await fresh.service.start()).status, 'ready');
    assert.deepEqual(fresh.events, { cookies: 1, scripts: 1, navigations: 1, saved: 1 });
    const existing = makeService(false);
    assert.equal((await existing.service.start()).status, 'waiting_login');
    assert.deepEqual(existing.events, { cookies: 0, scripts: 0, navigations: 0, saved: 0 });
  } finally {
    fs.unlinkSync(file);
    fs.rmdirSync(directory);
  }
});

test('talent search uses its own input and refuses success when the result list is missing', async () => {
  const service = new WuyouService();
  const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    service.page = page;
    service.requireLogin = async () => {};
    await context.route('https://ehire.51job.com/**', route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/Revision/talent/search') {
        return route.fulfill({ contentType: 'text/html', body: '<meta charset="utf-8"><body><div class="talent_search_keywords_input"><input placeholder="输入关键词搜索" onkeydown="if(event.key === \'Enter\') document.body.dataset.submitted = this.value"></div></body>' });
      }
      return route.fulfill({ contentType: 'text/html', body: '<meta charset="utf-8"><body><input id="job-search" placeholder="搜索职位"></body>' });
    });

    await page.goto('https://ehire.51job.com/Revision/navigate');
    await assert.rejects(service.search('会计'), /人才搜索结果列表未出现/);
    assert.equal(new URL(page.url()).pathname, '/Revision/talent/search');
    assert.equal(await page.locator('.talent_search_keywords_input input').inputValue(), '会计');
    assert.equal(await page.locator('body').getAttribute('data-submitted'), '会计');
    assert.equal(await page.locator('#job-search').count(), 0);
    await assert.rejects(service.search('x'.repeat(31)), /30 字/);
  } finally {
    await browser.close();
  }
});

test('talent search waits for virtual results to refresh before collecting', async () => {
  const service = new WuyouService();
  const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  try {
    const page = await browser.newPage();
    service.browser = browser;
    service.context = page.context();
    service.page = page;
    service.requireLogin = async () => {};
    await page.route('https://ehire.51job.com/**', route => route.fulfill({
      contentType: 'text/html', body: '<meta charset="utf-8">' +
        '<div class="talent_search_keywords_input"><input onkeydown="if(event.key === \'Enter\') setTimeout(() => document.querySelector(\'.talent-search-container .list-box .virtual_list .name\').textContent = \'新候选人\', 200)"></div>' +
        '<div class="job-list-wrapper"><div class="name">侧栏名称</div></div>' +
        '<div class="talent-search-container"><div class="list-box"><div class="virtual_list">' +
        '<div class="resume-card"><div class="el-card"><span class="name">旧候选人</span></div></div>' +
        '</div></div></div>'
    }));
    await page.goto('https://ehire.51job.com/Revision/talent/search');
    const result = await service.search('成本核算经理');
    assert.equal(result.submitted, true);
    assert.equal(await page.locator('.talent-search-container .list-box .virtual_list .name').innerText(), '新候选人');
  } finally {
    await browser.close();
  }
});

test('real talent result list ignores sidebar cards and virtual placeholders', async () => {
  const service = new WuyouService();
  const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  try {
    const page = await browser.newPage();
    service.page = page;
    service.requireLogin = async () => {};
    const cards = Array.from({ length: 13 }, (_, index) => index === 0 || index === 12
      ? '<div class="resume-card"></div>'
      : `<div class="resume-card"><div class="el-card"><span class="name">候选人${index}</span>` +
        '<p>有制造业成本核算经验，熟悉材料人工与制造费用归集。</p></div></div>').join('');
    await page.route('https://ehire.51job.com/**', route => route.fulfill({
      contentType: 'text/html', body: '<meta charset="utf-8">' +
        '<div class="main_container eh-talent-search">' +
        '<div class="job-list-wrapper"><div class="resume-card"><div class="el-card">' +
        '<span class="name">侧栏候选人</span><p>此侧栏卡片不属于人才搜索结果。</p>' +
        '</div></div></div>' +
        `<div class="talent-search-container"><div class="list-box"><div class="virtual_list">${cards}` +
        '</div></div></div></div>'
    }));
    await page.goto('https://ehire.51job.com/Revision/talent/search');
    assert.equal(await service.hasCardList({ wait: true }), true);
    const visible = await service.visibleCards();
    assert.equal(visible.length, 11);
    assert.equal(visible[0].index, 1);
    assert.equal(visible[0].displayName, '候选人1');
    assert.equal(visible.at(-1).index, 11);
    assert.ok(visible.every(card => !card.text.includes('侧栏候选人')));
    const diagnostics = await service.getPageDiagnostics();
    assert.equal(diagnostics.cards, 13);
    assert.equal(diagnostics.populatedCards, 11);
    assert.equal(diagnostics.names, 11);
  } finally {
    await browser.close();
  }
});

test('typed keyword with stale visible cards is submitted before collection', async () => {
  const service = new WuyouService();
  const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  try {
    const page = await browser.newPage();
    service.browser = browser;
    service.context = page.context();
    service.page = page;
    service.requireLogin = async () => {};
    await page.route('https://ehire.51job.com/**', route => route.fulfill({
      contentType: 'text/html', body: '<meta charset="utf-8">' +
        '<div class="talent_search_keywords_input"><input ' +
        'onkeydown="if (event.key === \'Enter\') {' +
        'document.body.dataset.submitted = this.value;' +
        'setTimeout(() => document.querySelector(\'.virtual_list .name\').textContent = \'新候选人\', 200)' +
        '}"></div>' +
        '<div class="talent-search-container"><div class="list-box"><div class="virtual_list">' +
        '<div class="resume-card"><div class="el-card"><span class="name">旧候选人</span>' +
        '<p>制造业成本核算岗位经验丰富，熟悉月结与分析。</p></div></div>' +
        '</div></div></div>'
    }));
    await page.goto('https://ehire.51job.com/Revision/talent/search');
    await page.locator('.talent_search_keywords_input input').fill('成本核算经理');
    assert.equal(await page.locator('.virtual_list .name').innerText(), '旧候选人');
    assert.equal(await page.locator('body').getAttribute('data-submitted'), null);
    const result = await service.search('成本核算经理');
    assert.equal(result.submitted, true);
    assert.equal(await page.locator('body').getAttribute('data-submitted'), '成本核算经理');
    assert.equal(await page.locator('.virtual_list .name').innerText(), '新候选人');
  } finally {
    await browser.close();
  }
});

test('login, visible candidate links and resume details are distinguished', async () => {
  const saved = [];
  const service = new WuyouService({
    parser: { parseResumeText: () => ({ name: '测试候选人', skills: ['SQL'],
      workExperience: [], parseStatus: 'completed' }) },
    resumeStore: {
      getResumes: () => saved,
      addResume: async resume => {
        const record = { id: 'generated-record-id', ...resume };
        saved.push(record);
        return record;
      }
    }
  });
  const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    service.browser = browser;
    service.context = context;
    service.page = page;
    await page.route('https://ehire.51job.com/**', route => {
      const path = new URL(route.request().url()).pathname;
      if (path.includes('login')) {
        return route.fulfill({ contentType: 'text/html', body: '<meta charset="utf-8"><body>扫码登录 短信登录</body>' });
      }
      if (path.includes('candidate/detail')) {
        return route.fulfill({ contentType: 'text/html', body: '<meta charset="utf-8"><body><h1>测试候选人</h1><p>工作经历：软件开发三年，负责系统设计与交付，持续维护多个业务系统并协调需求。</p><p>教育经历：计算机科学本科，学习数据库与程序设计，完成毕业项目。</p><p>技能特长：JavaScript、SQL 和自动化测试，能够独立完成项目开发与上线，熟悉团队协作和代码评审流程。</p></body>' });
      }
      if (path.includes('candidate/frame')) {
        return route.fulfill({ contentType: 'text/html', body: '<body><iframe src="/candidate/detail/1"></iframe></body>' });
      }
      return route.fulfill({ contentType: 'text/html', body: '<meta charset="utf-8"><body><a href="/candidate/detail/1">候选人一</a><a href="/candidate/search">搜索</a><a href="https://ehire.51job.com.evil.test/candidate/detail/2">外站</a></body>' });
    });

    await page.goto('https://ehire.51job.com/Revision/login');
    assert.equal((await service.getStatus()).isLoggedIn, false);
    await page.goto('https://ehire.51job.com/candidate/list');
    assert.equal((await service.getStatus()).isLoggedIn, true);
    assert.deepEqual((await service.scanCandidateLinks()).map(link => link.url), ['https://ehire.51job.com/candidate/detail/1']);
    await assert.rejects(service.captureVisibleResume(page), /不是简历详情/);
    await page.goto('https://ehire.51job.com/candidate/detail/1');
    assert.match(await page.locator('body').innerText(), /工作经历/);
    const captured = await service.captureVisibleResume(page);
    assert.match(captured.text, /工作经历/);
    assert.equal(captured.url, 'https://ehire.51job.com/candidate/detail/1');
    const first = await service.collectCurrent();
    assert.equal(first.saved, true);
    assert.equal(first.resume.id, 'generated-record-id');
    assert.equal(first.resume.source, 'qcwy');
    assert.equal(first.resume.parseMethod, 'local');
    assert.deepEqual(first.resume.skills, ['SQL']);
    assert.deepEqual(first.resume.workExperience, []);
    assert.equal((await service.collectCurrent()).duplicate, true);
    assert.equal(saved.length, 1);
    await page.goto('https://ehire.51job.com/candidate/frame/1');
    const framed = await service.captureVisibleResume(page);
    assert.equal(framed.url, 'https://ehire.51job.com/candidate/detail/1');
  } finally {
    await browser.close();
  }
});

test('多关键词采集跨关键词跳过同一链接，并在达到份数后结束', async () => {
  const service = new WuyouService();
  service.requireLogin = async () => {};
  service.page = { waitForTimeout: async () => {} };
  service.search = async keyword => ({ submitted: true, keyword });
  let scanned = 0;
  service.scanCandidateLinks = async () => {
    scanned++;
    return scanned === 1
      ? [{ url: 'https://ehire.51job.com/candidate/1' }]
      : [{ url: 'https://ehire.51job.com/candidate/1' },
        { url: 'https://ehire.51job.com/candidate/2' }];
  };
  service.context = { newPage: async () => ({
    url: '', goto: async function(url) { this.url = url; },
    isClosed: () => false, close: async () => {}
  }) };
  service.collectPage = async tab => ({ saved: true, resume: { sourceUrl: tab.url } });
  await service.startKeywordBatch({ keywords: 'Java, Node', targetCount: 2 });
  for (let attempt = 0; service.batch.running && attempt < 20; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(service.batch.saved, 2);
  assert.equal(service.batch.processed, 2);
  assert.equal(service.batch.keywordsCompleted, 2);
});

test('virtual result card waits for a blank popup and loading skeleton before saving', async () => {
  const saved = [];
  const service = new WuyouService({
    parser: { parseResumeText: () => ({ name: '测试候选人', workExperience: [],
      educationExperience: [], skills: ['成本核算'] }) },
    resumeStore: {
      getResumes: () => saved,
      addResume: async candidate => {
        const resume = { id: 'candidate-1', ...candidate };
        saved.push(resume);
        return { resume, created: true };
      }
    }
  });
  const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    service.browser = browser;
    service.context = context;
    service.page = page;
    service.requireLogin = async () => {};
    service.batch = { ...service.emptyBatch(), running: true, targetCount: 1 };
    await context.route('https://ehire.51job.com/**', route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/resume/detail')) return route.fulfill({ contentType: 'text/html', body:
        '<meta charset="utf-8"><div class="talent_resume_detail_wrap eh_body_min_width_resume">' +
        '正在加载候选人简历</div><script>setTimeout(() => {' +
        'document.querySelector(".talent_resume_detail_wrap").textContent = ' +
        '"测试候选人 工作经历：三年制造业成本核算，负责材料人工制造费用归集和月度差异分析。' +
        '教育经历：本科会计专业，参加库存盘点与年度预算工作。' +
        '项目经历：负责 ERP 成本模块维护、BOM 核对、工时分析和月度制造费用分摊，' +
        '能独立编制成本分析报告并协助财务月结。";' +
        '}, 300)</script>' });
      return route.fulfill({ contentType: 'text/html', body:
        '<meta charset="utf-8"><div class="main_container eh-talent-search">' +
        '<div class="job-list-wrapper"><div class="resume-card"><div class="el-card">' +
        '<span class="name" onclick="window.open(\'/Revision/talent/resume/detail?resumeId=wrong\')">侧栏候选人</span>' +
        '<p>此侧栏内容不应当被采集为候选人简历。</p></div></div></div>' +
        '<div class="talent-search-container"><div class="list-box"><div class="virtual_list">' +
        '<div class="resume-card"></div><div class="resume-card">' +
        '<div class="el-card"><span class="name" onclick="const tab = window.open(\'about:blank\');' +
        'setTimeout(() => { tab.location.href = \'/Revision/talent/resume/detail?resumeId=1\'; }, 300)">测试候选人</span>' +
        '<p>成本核算经理，制造业三年工作经验，本科，会计，负责材料和人工核算。</p></div>' +
        '</div></div></div></div></div>' });
    });
    await page.goto('https://ehire.51job.com/Revision/talent/search');
    assert.equal(await service.hasCardList({ wait: true }), true);
    assert.equal((await service.visibleCards()).length, 1);
    await service.runCardBatch(1, new Set());
    assert.equal(service.batch.saved, 1, JSON.stringify(service.batch.errors));
    assert.equal(service.batch.processed, 1);
    assert.equal(saved[0].parseMethod, 'local');
    assert.equal(saved[0].source, 'qcwy');
    assert.equal(saved[0].sourceUrl, 'https://ehire.51job.com/Revision/talent/resume/detail?resumeId=1');
    assert.equal(service.page, page);
    assert.equal(context.pages().length, 1);
  } finally {
    await browser.close();
  }
});

test('incomplete 51Job detail reports only structural counts after a bounded wait', async () => {
  const service = new WuyouService();
  const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  try {
    const page = await browser.newPage();
    await page.route('https://ehire.51job.com/**', route => route.fulfill({
      contentType: 'text/html', body: '<meta charset="utf-8">' +
        '<div class="talent_resume_detail_wrap eh_body_min_width_resume">' +
        '私密候选人 alice.private@example.com 正在加载简历</div>'
    }));
    await page.goto('https://ehire.51job.com/Revision/talent/resume/detail?resumeId=1');
    await assert.rejects(service.captureVisibleResume(page, { contentTimeout: 500 }), error => {
      assert.match(error.message, /简历详情内容不足.*0 个简历区块.*详情容器可见/);
      assert.doesNotMatch(error.message, /私密候选人|alice\.private/);
      return true;
    });
  } finally {
    await browser.close();
  }
});

function makeVirtualCardBatch(rounds, outcomes = {}) {
  const service = new WuyouService();
  let round = 0;
  let resolvePopup;
  const attempts = new Map();
  const opened = [];
  const evaluated = [];
  const searchPage = {
    isClosed: () => false,
    waitForTimeout: async () => {},
    waitForEvent: event => {
      assert.equal(event, 'popup');
      return new Promise(resolve => { resolvePopup = resolve; });
    },
    locator: () => ({
      nth: index => ({
        locator: () => ({
          first: () => ({
            isVisible: async () => true,
            click: async () => {
              const card = rounds[round].find(item => item.index === index);
              assert.ok(card, `no card at index ${index} in round ${round}`);
              const outcome = outcomes[card.key] || {};
              const attempt = (attempts.get(card.key) || 0) + 1;
              attempts.set(card.key, attempt);
              const detail = {
                key: card.key,
                attempt,
                closed: false,
                url: () => outcome.urls?.[attempt - 1] || outcome.url ||
                  `https://ehire.51job.com/Revision/talent/resume/detail?resumeId=${card.key}`,
                waitForURL: async () => {},
                waitForLoadState: async () => {},
                isClosed() { return this.closed; },
                async close() { this.closed = true; }
              };
              opened.push(detail);
              resolvePopup(detail);
            }
          })
        })
      })
    })
  };
  if (Object.values(outcomes).some(outcome => outcome?.stalePosition)) {
    searchPage.evaluate = async (_callback, { index }) => {
      const card = rounds[round].find(item => item.index === index);
      if (!card) return null;
      return { stableId: card.stableId, virtualIndex: card.virtualIndex,
        text: outcomes[card.key]?.stalePosition ? `${card.text} moved` : card.text };
    };
  }
  service.page = searchPage;
  service.batch = { ...service.emptyBatch(), running: true, targetCount: 30 };
  service.visibleCards = async () => rounds[round];
  service.scrollResults = async () => {
    if (round >= rounds.length - 1) return false;
    round++;
    return true;
  };
  service.verificationVisible = async page => Boolean(outcomes[page?.key]?.verification);
  service.collectPage = async detail => {
    const outcome = outcomes[detail.key] || {};
    const error = outcome.errors?.[detail.attempt - 1] || outcome.error;
    if (error) throw new Error(error);
    return outcome.duplicate
      ? { saved: false, duplicate: true, resume: { id: detail.key } }
      : { saved: true, duplicate: false, resume: { id: detail.key } };
  };
  service.evaluateCaptured = async resume => { evaluated.push(resume.id); service.batch.evaluated++; };
  return { service, searchPage, opened, evaluated };
}

test('virtual scrolling saves fresh cards once and reports exact progress across recycled rows', async () => {
  const cards = keys => keys.map((key, index) => ({ index, key, text: `候选人 ${key}` }));
  const { service, searchPage, opened, evaluated } = makeVirtualCardBatch([
    cards(['a', 'b']), cards(['b', 'c']), cards(['c', 'd'])
  ], { b: { duplicate: true } });
  service.batch.targetCount = 3;
  await service.runCardBatch(3, new Set(), '成本核算经理：本科及以上，三年以上成本核算经验');
  assert.deepEqual(opened.map(page => page.key), ['a', 'b', 'c', 'd']);
  assert.deepEqual(evaluated, ['a', 'c', 'd']);
  assert.equal(service.batch.total, 4);
  assert.equal(service.batch.processed, 4);
  assert.equal(service.batch.saved, 3);
  assert.equal(service.batch.skipped, 1);
  assert.equal(service.batch.evaluated, 3);
  assert.equal(service.batch.errors.length, 0);
  assert.ok(opened.every(page => page.closed));
  assert.equal(service.page, searchPage);
  service.finishBatch();
  assert.equal(service.batch.stopReason, 'target_reached');
});

test('temporary popup failures do not block a later valid resume from reaching the target', async () => {
  const cards = ['blank', 'incomplete', 'valid'].map((key, index) => ({ index, key, text: key }));
  const { service, searchPage, opened } = makeVirtualCardBatch([cards], {
    blank: { url: 'about:blank' },
    incomplete: { error: '简历详情内容不足（43 字，0 个简历区块），已跳过' }
  });
  service.batch.targetCount = 1;
  await service.runCardBatch(1, new Set());
  assert.equal(service.batch.total, 3);
  assert.equal(service.batch.processed, 1);
  assert.equal(service.batch.saved, 1);
  assert.equal(service.batch.skipped, 0);
  assert.equal(service.batch.failed, 0);
  assert.equal(service.batch.retries, 2);
  assert.equal(service.batch.staleSnapshots, 0);
  assert.equal(service.batch.errors.length, 0);
  assert.ok(opened.every(page => page.closed));
  assert.equal(service.page, searchPage);
});

test('a blank popup is retried once and then saved when navigation succeeds', async () => {
  const cards = [{ index: 0, key: 'retry-blank', text: '候选人' }];
  const { service, opened } = makeVirtualCardBatch([cards], {
    'retry-blank': { urls: ['about:blank',
      'https://ehire.51job.com/Revision/talent/resume/detail?resumeId=retry-blank'] }
  });
  service.batch.targetCount = 1;
  await service.runCardBatch(1, new Set());
  assert.equal(service.batch.total, 1);
  assert.equal(service.batch.processed, 1);
  assert.equal(service.batch.retries, 1);
  assert.equal(service.batch.saved, 1);
  assert.equal(service.batch.skipped, 0);
  assert.equal(service.batch.failed, 0);
  assert.equal(opened.length, 2);
  assert.ok(opened.every(page => page.closed));
});

test('an incomplete detail retries once and never counts a skeleton as saved', async () => {
  const cards = [{ index: 0, key: 'retry-skeleton', text: '候选人' }];
  const { service, opened } = makeVirtualCardBatch([cards], {
    'retry-skeleton': { errors: ['简历详情内容不足（43 字，0 个简历区块），已跳过', null] }
  });
  service.batch.targetCount = 1;
  await service.runCardBatch(1, new Set());
  assert.equal(service.batch.total, 1);
  assert.equal(service.batch.processed, 1);
  assert.equal(service.batch.retries, 1);
  assert.equal(service.batch.saved, 1);
  assert.equal(service.batch.skipped, 0);
  assert.equal(service.batch.failed, 0);
  assert.equal(opened.length, 2);
});

test('a permanently blank popup fails after one retry and leaves the target unmet', async () => {
  const cards = [{ index: 0, key: 'always-blank', text: '候选人' }];
  const { service, opened } = makeVirtualCardBatch([cards], {
    'always-blank': { url: 'about:blank' }
  });
  service.batch.targetCount = 1;
  await service.runCardBatch(1, new Set());
  service.finishBatch();
  assert.equal(service.batch.total, 1);
  assert.equal(service.batch.processed, 1);
  assert.equal(service.batch.retries, 1);
  assert.equal(service.batch.failed, 1);
  assert.equal(service.batch.skipped, 1);
  assert.equal(service.batch.saved, 0);
  assert.equal(service.batch.stopReason, 'results_exhausted');
  assert.equal(service.batch.errors.length, 1);
  assert.match(service.batch.errors[0], /空白页/);
  assert.equal(opened.length, 2);
  assert.ok(opened.every(page => page.closed));
});

test('a stale virtual snapshot refreshes once and scrolls without failing its other cards', async () => {
  const stale = Array.from({ length: 80 }, (_, index) => `stale-${index}`);
  const cards = keys => keys.map((key, index) => ({ index, key, text: `候选人 ${key}` }));
  const outcomes = Object.fromEntries(stale.map(key => [key, { stalePosition: true }]));
  const { service, opened } = makeVirtualCardBatch([
    cards(stale), cards(['valid-after-scroll'])
  ], outcomes);
  service.batch.targetCount = 1;
  await service.runCardBatch(1, new Set());
  assert.equal(service.batch.saved, 1);
  assert.equal(service.batch.scrollRounds, 1);
  assert.equal(service.batch.retries, 0);
  assert.equal(service.batch.staleSnapshots, 2);
  assert.equal(service.batch.processed, 1);
  assert.equal(service.batch.failed, 0);
  assert.deepEqual(opened.map(page => page.key), ['valid-after-scroll']);
  service.finishBatch();
  assert.equal(service.batch.stopReason, 'target_reached');
});

test('verification in a detail popup pauses collection and leaves that tab open for a person', async () => {
  const cards = ['verify', 'later'].map((key, index) => ({ index, key, text: key }));
  const { service, opened } = makeVirtualCardBatch([cards], {
    verify: { verification: true }
  });
  await service.runCardBatch(2, new Set());
  assert.deepEqual(opened.map(page => page.key), ['verify']);
  assert.equal(service.batch.pausedForVerification, true);
  assert.equal(service.stopRequested, true);
  assert.equal(service.batch.processed, 1);
  assert.equal(service.batch.saved, 0);
  assert.equal(service.batch.skipped, 0);
  assert.equal(opened[0].closed, false);
  assert.equal(service.page, opened[0]);
  assert.match(service.batch.errors[0], /人工验证/);
});

test('a detail popup redirected to login pauses and leaves the login tab open', async () => {
  const cards = ['login', 'later'].map((key, index) => ({ index, key, text: key }));
  const { service, opened } = makeVirtualCardBatch([cards], {
    login: { url: 'https://ehire.51job.com/Revision/login' }
  });
  await service.runCardBatch(2, new Set());
  assert.deepEqual(opened.map(page => page.key), ['login']);
  assert.equal(service.batch.stopReason, 'login_required');
  assert.equal(service.stopRequested, true);
  assert.equal(service.batch.processed, 1);
  assert.equal(service.batch.saved, 0);
  assert.equal(service.batch.skipped, 0);
  assert.equal(opened[0].closed, false);
  assert.equal(service.page, opened[0]);
});

test('identical visible cards without stable IDs are processed as separate candidates', async () => {
  const service = new WuyouService();
  const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    service.browser = browser;
    service.context = context;
    service.page = page;
    service.batch = { ...service.emptyBatch(), running: true, targetCount: 2 };
    const openedIds = [];
    service.collectPage = async detail => {
      const id = new URL(detail.url()).searchParams.get('resumeId');
      openedIds.push(id);
      return { saved: true, resume: { id } };
    };
    service.scrollResults = async () => false;
    await context.route('https://ehire.51job.com/**', route => {
      if (new URL(route.request().url()).pathname.endsWith('/resume/detail')) {
        return route.fulfill({ contentType: 'text/html', body: '<body>工作经历 教育经历</body>' });
      }
      const card = id => '<div class="resume-card"><div class="el-card">' +
        `<span class="name" onclick="window.open('/Revision/talent/resume/detail?resumeId=${id}')">候选人</span>` +
        '<p>制造业成本核算岗位经验丰富，熟悉月结与分析。</p></div></div>';
      return route.fulfill({ contentType: 'text/html', body: '<meta charset="utf-8">' +
        '<div class="main_container eh-talent-search"><div class="talent-search-container">' +
        `<div class="list-box"><div class="virtual_list">${card('one')}${card('two')}` +
        '</div></div></div></div>' });
    });
    await page.goto('https://ehire.51job.com/Revision/talent/search');
    const cards = await service.visibleCards();
    assert.equal(cards.length, 2);
    assert.equal(cards[0].text, cards[1].text);
    assert.notEqual(cards[0].key, cards[1].key);
    await service.runCardBatch(2, new Set());
    assert.deepEqual(openedIds, ['one', 'two']);
    assert.equal(service.batch.total, 2);
    assert.equal(service.batch.processed, 2);
    assert.equal(service.batch.saved, 2);
  } finally {
    await browser.close();
  }
});

test('51Job preserves distinct official resume IDs and deduplicates the same ID after content changes', async () => {
  const saved = [];
  const service = new WuyouService({
    parser: { parseResumeText: text => ({ name: '测试候选人', skills: ['成本核算'], rawText: text }) },
    resumeStore: {
      getResumes: () => saved,
      addResume: async candidate => {
        const resume = { id: `saved-${saved.length + 1}`, ...candidate };
        saved.push(resume);
        return { resume, created: true };
      }
    }
  });
  let capture = { text: '姓名：测试候选人\n工作经历：制造业成本核算三年。\n教育经历：会计学本科。',
    url: 'https://ehire.51job.com/Revision/talent/resume/detail?resumeId=one&token=secret',
    title: '简历详情' };
  service.captureVisibleResume = async () => capture;
  assert.equal((await service.collectPage({})).saved, true);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].originalText, capture.text);
  assert.equal(saved[0].sourceUrl,
    'https://ehire.51job.com/Revision/talent/resume/detail?resumeId=one');
  assert.equal(saved[0].parseMethod, 'local');
  assert.equal(saved[0].sourceCandidateId, 'one');

  capture = { ...capture, url: 'https://ehire.51job.com/Revision/talent/resume/detail?resumeId=two' };
  assert.equal((await service.collectPage({})).saved, true);
  capture = { ...capture, text: capture.text + '\n项目经历：ERP 成本模块上线。',
    url: 'https://ehire.51job.com/Revision/talent/resume/detail?resumeId=one' };
  assert.equal((await service.collectPage({})).duplicate, true);
  assert.equal(saved.length, 2);
});

test('51Job page chrome cannot populate new name, position or desired position metadata', async () => {
  let stored;
  const service = new WuyouService({
    parser: { parseResumeText: () => ({ name: '通知', position: '通知',
      expectedPosition: { position: '通知', city: '上海' } }) },
    resumeStore: { getResumes: () => [], addResume: async value => {
      stored = value;
      return { resume: value, created: true };
    } }
  });
  service.captureVisibleResume = async () => ({ text: '通知\n工作经历：网络运维\n教育经历：本科',
    url: 'https://ehire.51job.com/Revision/talent/resume/detail?resumeId=sample',
    title: '简历详情', nameHint: '通知' });
  await service.collectPage({});
  assert.equal(stored.name, '未识别姓名');
  assert.equal(stored.position, '');
  assert.equal(stored.expectedPosition.position, '');
  assert.equal(stored.expectedPosition.city, '上海');
  assert.match(stored.originalText, /^通知/);
});

test('verified talent card name enriches a previously anonymous matching resume', async () => {
  const existing = { id: 'same-candidate', source: 'qcwy', name: '未识别姓名',
    captureJobRequirements: '岗位名称：磁轴销售工程师\n工作地点：惠州' };
  let update;
  const service = new WuyouService({ resumeStore: {
    findWuyouDuplicate: () => existing,
    updateCandidateMetadata: async (_id, changes) => {
      update = changes;
      return { ...existing, ...changes };
    }
  } });
  service.captureVisibleResume = async () => ({
    text: '工作经历：磁轴销售三年。\n教育经历：大专。',
    url: 'https://ehire.51job.com/Revision/talent/resume/detail?resumeId=same-candidate',
    title: '简历详情', nameHint: '通知'
  });
  const result = await service.collectPage({}, existing.captureJobRequirements, '张三');
  assert.equal(result.duplicate, true);
  assert.equal(result.resume.name, '张三');
  assert.equal(update.nameSource, 'qcwy_card');
  assert.equal(update.captureJobTitle, '磁轴销售工程师');
});

test('scrolling follows the real overflow container and waits for virtual cards to refresh', async () => {
  const service = new WuyouService();
  const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  try {
    const page = await browser.newPage();
    service.page = page;
    await page.route('https://ehire.51job.com/**', route => route.fulfill({
      contentType: 'text/html', body: '<meta charset="utf-8"><style>' +
        '.main_container{height:260px}.list-box{height:100px;overflow-y:auto}' +
        '.virtual_list{height:600px}.resume-card{height:80px}</style>' +
        '<div class="main_container eh-talent-search"><div class="talent-search-container">' +
        '<div class="list-box"><div class="virtual_list"><div class="resume-card" data-id="first">' +
        '<div class="el-card"><span class="name">第一位候选人</span>' +
        '<p>制造业成本核算经历丰富，熟悉 ERP 和月度成本分析。</p></div>' +
        '</div></div></div></div></div>'
    }));
    await page.goto('https://ehire.51job.com/Revision/talent/search');
    await page.evaluate(() => document.querySelector('.list-box').addEventListener('scroll', () => {
      setTimeout(() => {
        document.querySelector('.virtual_list').innerHTML =
          '<div class="resume-card" data-id="second"><div class="el-card">' +
          '<span class="name">第二位候选人</span>' +
          '<p>制造业成本核算经历丰富，熟悉 ERP 和月度成本分析。</p></div></div>';
      }, 150);
    }));
    assert.deepEqual((await service.visibleCards()).map(card => card.key), ['first']);
    assert.equal(await service.scrollResults(), true);
    assert.ok(await page.locator('.list-box').evaluate(node => node.scrollTop > 0));
    assert.deepEqual((await service.visibleCards()).map(card => card.key), ['second']);
  } finally {
    await browser.close();
  }
});

test('51Job status distinguishes login, loading, verification, permission and empty results', async () => {
  const service = new WuyouService();
  const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    service.browser = browser;
    service.context = context;
    service.page = page;
    await context.route('https://ehire.51job.com/**', route => {
      const mode = new URL(route.request().url()).searchParams.get('mode');
      const contents = {
        login: '扫码登录 短信登录',
        ready: '人才搜索 成本核算经理<div class="talent_search_keywords_input"><input></div>',
        loading: '<div class="base-page-loading">正在加载</div>',
        verification: '<div class="captcha-box">请完成安全验证</div>',
        permission: '暂无人才搜索权限，请联系管理员',
        empty: '暂无人才<div class="talent_search_keywords_input"><input></div>',
        shell: '人才搜索 页面加载中'
      };
      return route.fulfill({ contentType: 'text/html',
        body: `<meta charset="utf-8"><body>${contents[mode] || ''}</body>` });
    });
    const cases = [
      ['login', 'waiting_login'],
      ['ready', 'ready'],
      ['loading', 'loading'],
      ['verification', 'verification_required'],
      ['permission', 'permission_required'],
      ['empty', 'ready'],
      ['shell', 'loading']
    ];
    for (const [mode, expected] of cases) {
      const path = mode === 'login' ? '/Revision/login' : '/Revision/talent/search';
      await page.goto(`https://ehire.51job.com${path}?mode=${mode}`);
      const status = await service.getStatus();
      assert.equal(status.status, expected, `status for ${mode}`);
      if (mode === 'login' || mode === 'loading' || mode === 'shell') assert.equal(status.isLoggedIn, false);
      if (mode === 'ready' || mode === 'empty') assert.equal(status.isLoggedIn, true);
      if (mode === 'empty') assert.equal(status.noResults, true);
    }
  } finally {
    await browser.close();
  }
});

test('51Job education filter selects bachelor, repeats idempotently and resets to unlimited', async () => {
  const service = new WuyouService();
  const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    service.browser = browser;
    service.context = context;
    service.page = page;
    service.requireLogin = async () => {};
    const options = ['不限', '大专及以上', '本科及以上', '硕士及以上']
      .map(value => `<div class="education-option" data-value="${value}">${value}</div>`).join('');
    await page.route('https://ehire.51job.com/**', route => route.fulfill({
      contentType: 'text/html', body: '<meta charset="utf-8"><body>' +
        '<div class="talent_search_keywords_input"><input></div>' +
        '<button class="base-select-button" id="education">学历要求</button>' +
        '<div class="base-page-loading" style="display:none">正在加载</div>' +
        `<div class="el-popover" id="choices" style="display:none">${options}</div>` +
        '<script>const button = document.querySelector("#education");' +
        'const choices = document.querySelector("#choices");' +
        'button.onclick = () => { document.body.dataset.opens = ' +
        'String(Number(document.body.dataset.opens || 0) + 1); choices.style.display = "block"; };' +
        'document.querySelectorAll(".education-option").forEach(option => {' +
        'option.onclick = () => { button.textContent = option.dataset.value === "不限"' +
        ' ? "学历要求" : option.dataset.value; choices.style.display = "none";' +
        'const loading=document.querySelector(".base-page-loading");loading.style.display="block";' +
        'setTimeout(()=>{loading.style.display="none";},800); }; });' +
        '</script></body>'
    }));
    await page.goto('https://ehire.51job.com/Revision/talent/search');
    service.lastSearch = { page, keyword: '成本核算经理' };
    assert.deepEqual(await service.selectEducationFilter('本科及以上'),
      { value: '本科及以上', applied: true, changed: true });
    assert.equal(await page.locator('#education').innerText(), '本科及以上');
    assert.equal(await page.locator('body').getAttribute('data-opens'), '1');
    assert.equal(service.lastSearch, null);
    assert.deepEqual(await service.selectEducationFilter('本科及以上'),
      { value: '本科及以上', applied: true, changed: false });
    assert.equal(await page.locator('body').getAttribute('data-opens'), '1');
    assert.deepEqual(await service.selectEducationFilter('不限'),
      { value: '不限', applied: true, changed: true });
    assert.equal(await page.locator('#education').innerText(), '学历要求');
    assert.equal(await page.locator('body').getAttribute('data-opens'), '2');
  } finally {
    await browser.close();
  }
});

test('51Job education filter refuses a missing or ambiguous button', async () => {
  const service = new WuyouService();
  const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  try {
    const page = await browser.newPage();
    service.page = page;
    service.requireLogin = async () => {};
    await page.route('https://ehire.51job.com/**', route => {
      const count = Number(new URL(route.request().url()).searchParams.get('buttons'));
      return route.fulfill({ contentType: 'text/html', body: '<meta charset="utf-8"><body>' +
        '<button class="base-select-button">工作经验</button>' +
        '<button class="base-select-button">公司性质</button>' +
        '<button class="base-select-button">学历要求</button>'.repeat(count) +
        '</body>' });
    });
    for (const count of [0, 2]) {
      await page.goto(`https://ehire.51job.com/Revision/talent/search?buttons=${count}`);
      await assert.rejects(service.selectEducationFilter('本科及以上'), /学历筛选控件未能唯一定位/);
    }
    await assert.rejects(service.selectEducationFilter('高中'), /学历筛选值无效/);
  } finally {
    await browser.close();
  }
});

test('51Job keyword batch falls back to job evaluation when fixed panel blocks education filter', async () => {
  const service = new WuyouService();
  const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  try {
    const page = await browser.newPage();
    service.page = page;
    service.requireLogin = async () => {};
    service.getStatus = async () => ({ status: 'ready', isLoggedIn: true,
      verificationRequired: false, permissionRequired: false });
    await page.route('https://ehire.51job.com/**', route => route.fulfill({
      contentType: 'text/html', body: '<meta charset="utf-8"><body>' +
        '<button class="base-select-button" id="education">学历要求</button>' +
        '<div class="filter_condition_main filter_fixed filter_fixed_ai filter_com_fold" ' +
        'style="position:fixed;inset:0;z-index:999;background:white"></div></body>'
    }));
    await page.goto('https://ehire.51job.com/Revision/talent/search');
    let called = false;
    service.runKeywordBatch = async (terms, count, requirements) => {
      called = true;
      assert.deepEqual(terms, ['IT网络运维']);
      assert.equal(count, 2);
      assert.equal(requirements, '大专及以上，三年运维经验');
    };
    const batch = await service.startKeywordBatch({ keywords: ['IT网络运维'], targetCount: 2,
      education: '大专及以上', jobRequirements: '大专及以上，三年运维经验' });
    assert.equal(called, true);
    assert.equal(batch.educationFilter.applied, false);
    assert.match(batch.educationFilter.reason, /岗位要求评估学历/);
    assert.deepEqual(batch.errors, []);
    assert.equal(await page.locator('#education').innerText(), '学历要求');
  } finally {
    await browser.close();
  }
});

test('51Job keyword batch never ignores a blocked education filter without evaluation or during verification', async () => {
  const service = new WuyouService();
  service.requireLogin = async () => {};
  service.selectEducationFilter = async () => {
    throw new Error('前程无忧学历筛选按钮被页面遮挡或暂不可操作');
  };
  service.getStatus = async () => ({ status: 'ready', isLoggedIn: true,
    verificationRequired: false, permissionRequired: false });
  await assert.rejects(service.startKeywordBatch({ keywords: ['IT网络运维'], targetCount: 2,
    education: '大专及以上' }), /学历筛选按钮/);
  service.getStatus = async () => ({ status: 'verification_required', isLoggedIn: false,
    verificationRequired: true, permissionRequired: false });
  await assert.rejects(service.startKeywordBatch({ keywords: ['IT网络运维'], targetCount: 2,
    education: '大专及以上', jobRequirements: '大专及以上，三年运维经验' }), /学历筛选按钮/);
});

test('a verification challenge pauses a keyword batch with an explicit stop reason', async () => {
  const service = new WuyouService();
  service.page = { waitForTimeout: async () => {} };
  service.search = async () => ({ submitted: true });
  service.hasCardList = async () => false;
  service.verificationVisible = async () => true;
  service.scanCandidateLinks = async () => {
    throw new Error('candidate links must not be scanned through a challenge');
  };
  service.batch = { ...service.emptyBatch(), running: true, targetCount: 2 };
  await service.runKeywordBatch(['成本核算经理'], 2);
  assert.equal(service.batch.running, false);
  assert.equal(service.batch.pausedForVerification, true);
  assert.equal(service.batch.stopReason, 'verification_required');
  assert.equal(service.batch.processed, 0);
  assert.equal(service.batch.saved, 0);
  assert.equal(service.batch.keywordsCompleted, 0);
});

test('empty keyword results complete safely and explain why the target was not reached', async () => {
  const service = new WuyouService();
  service.page = { waitForTimeout: async () => {} };
  service.search = async () => ({ submitted: true });
  service.hasCardList = async () => false;
  service.verificationVisible = async () => false;
  service.scanCandidateLinks = async () => [];
  service.batch = { ...service.emptyBatch(), running: true, targetCount: 2 };
  await service.runKeywordBatch(['成本核算经理', '成本经理'], 2);
  assert.equal(service.batch.running, false);
  assert.equal(service.batch.stopReason, 'results_exhausted');
  assert.equal(service.batch.keywordsCompleted, 2);
  assert.equal(service.batch.processed, 0);
  assert.equal(service.batch.saved, 0);
  assert.equal(service.batch.errors.length, 2);
});

test('a long 51Job detail is saved in full and oversize detail fails without partial storage', async () => {
  const saved = [];
  const service = new WuyouService({
    parser: { parseResumeText: () => ({ name: '测试候选人', skills: ['成本核算'] }) },
    resumeStore: {
      getResumes: () => saved,
      addResume: async candidate => {
        const resume = { id: `long-${saved.length + 1}`, ...candidate };
        saved.push(resume);
        return { resume, created: true };
      }
    }
  });
  const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  try {
    const page = await browser.newPage();
    const prefix = '姓名：测试候选人\n工作经历：负责制造业成本核算。\n教育经历：会计学本科。\n';
    const long = prefix + '成本归集与月度结账。'.repeat(2500);
    const oversize = prefix + '成本归集与月度结账。'.repeat(13000);
    await page.route('https://ehire.51job.com/**', route => {
      const body = route.request().url().includes('oversize') ? oversize : long;
      return route.fulfill({ contentType: 'text/html',
        body: '<meta charset="utf-8"><div style="white-space:pre-wrap" class="talent_resume_detail_wrap eh_body_min_width_resume">' +
          body + '</div>' });
    });
    await page.goto('https://ehire.51job.com/Revision/talent/resume/detail?resumeId=long');
    const first = await service.collectPage(page);
    assert.equal(first.saved, true);
    assert.equal(saved[0].originalText, long);
    assert.ok(saved[0].originalText.length > 16000);
    await page.goto('https://ehire.51job.com/Revision/talent/resume/detail?resumeId=oversize');
    await assert.rejects(service.collectPage(page), /超过本机安全长度上限，未截断保存/);
    assert.equal(saved.length, 1);
  } finally {
    await browser.close();
  }
});

test('a challenge while processing cards does not mark the keyword complete', async () => {
  const service = new WuyouService();
  service.search = async () => ({ submitted: true });
  service.hasCardList = async () => true;
  service.runCardBatch = async () => {
    service.pauseBatch('verification_required', '请人工完成安全验证');
  };
  service.batch = { ...service.emptyBatch(), running: true, targetCount: 2 };
  await service.runKeywordBatch(['成本核算经理'], 2);
  assert.equal(service.batch.stopReason, 'verification_required');
  assert.equal(service.batch.keywordsCompleted, 0);
  assert.equal(service.batch.running, false);
});
