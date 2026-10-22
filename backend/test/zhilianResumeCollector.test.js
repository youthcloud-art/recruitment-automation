const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { ZhilianResumeCollector } = require('../src/services/zhilianResumeCollector');
const ZhilianService = require('../src/services/zhilianService');

test('visible 智联简历弹窗 can be parsed, saved and deduplicated', async () => {
  const saved = [];
  const collector = new ZhilianResumeCollector({
    llmService: { chatWithLLM: async () => '```json\n{"name":"测试候选人","skills":["SQL"],"workExperience":"invalid","id":"do-not-use"}\n```' },
    resumeStore: {
      getResumes: () => saved,
      addResume: async record => {
        const value = { id: 'generated-id', ...record };
        saved.push(value);
        return value;
      }
    }
  });
  const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  try {
    const page = await browser.newPage();
    await page.route('https://rd.zhaopin.com/**', route => route.fulfill({
      contentType: 'text/html',
      body: '<meta charset="utf-8"><body><div class="search-resume-item">候选人列表</div><div class="km-modal__wrapper new-shortcut-resume__modal"><div class="new-resume-detail--inner"><h1>测试候选人</h1><p>工作经历：软件开发三年，负责系统设计、代码评审和交付，持续维护多个业务系统。</p><p>教育经历：计算机科学本科，学习数据库与程序设计，完成毕业项目。</p><p>技能特长：JavaScript、SQL 和自动化测试，熟悉团队协作流程。</p></div></div></body>'
    }));
    await page.goto('https://rd.zhaopin.com/search');
    const captured = await collector.captureVisibleResume(page);
    assert.match(captured.text, /工作经历/);
    const first = await collector.save(captured);
    assert.equal(first.saved, true);
    assert.equal(first.resume.id, 'generated-id');
    assert.equal(first.resume.source, 'zlzp');
    assert.deepEqual(first.resume.workExperience, []);
    assert.deepEqual(first.resume.skills, ['SQL']);
    assert.equal((await collector.save(captured)).duplicate, true);
    assert.equal(saved.length, 1);
  } finally {
    await browser.close();
  }
});

test('智联再次采集同一候选人的页面动态文字变动不会新增简历', async () => {
  const saved = [];
  let llmCalls = 0;
  const collector = new ZhilianResumeCollector({
    llmService: { chatWithLLM: async () => {
      llmCalls++;
      return '{"name":"测试候选人","age":"35","education":"本科"}';
    } },
    resumeStore: {
      getResumes: () => saved,
      addResume: async record => {
        const value = { ...record, id: `synthetic-${saved.length + 1}` };
        saved.push(value);
        return value;
      }
    }
  });
  const body = ('工作经历：负责成本核算和财务报表。教育经历：财务专业本科。').repeat(30);
  const first = { text: `测试候选人\n浏览标识：12\n${body}`,
    url: 'https://rd.zhaopin.com/search', title: '测试页面' };
  const second = { ...first, text: `测试候选人\n浏览标识：13\n${body}` };
  assert.equal((await collector.save(first)).saved, true);
  const result = await collector.save(second);
  assert.equal(result.saved, false);
  assert.equal(result.duplicate, true);
  assert.equal(result.resume.id, 'synthetic-1');
  assert.equal(saved.length, 1);
  assert.equal(llmCalls, 2);
});

test('智联 AI 临时不可用时保存原文，恢复后可补齐结构化字段', async () => {
  const saved = [];
  let available = false;
  const collector = new ZhilianResumeCollector({
    llmService: { chatWithLLM: async () => {
      if (!available) throw new Error('temporary API failure');
      return '{"name":"测试候选人","expectedPosition":"项目经理主管"}';
    } },
    resumeStore: {
      getResumes: () => saved,
      addResume: async record => {
        const resume = { id: 'candidate-1', ...record };
        saved.push(resume);
        return { created: true, resume };
      },
      updateCandidateMetadata: (id, changes) => {
        Object.assign(saved.find(item => item.id === id), changes);
        return saved.find(item => item.id === id);
      }
    },
    evaluationQueue: { enqueue: () => ({ queued: true }) }
  });
  const captured = { text: '个人信息和完整工作经历、教育经历、项目经历。'.repeat(10),
    url: 'https://rd.zhaopin.com/search', title: '智联招聘' };
  const first = await collector.save(captured,
    { jobRequirements: '项目经理主管：五年以上项目管理经验' });
  assert.equal(first.saved, true);
  assert.equal(first.resume.parseStatus, 'needs_review');
  assert.equal(first.resume.captureJobRequirements, '项目经理主管：五年以上项目管理经验');
  assert.equal(first.resume.name, '未识别姓名');
  assert.equal(first.resume.originalText, captured.text);
  available = true;
  const second = await collector.save(captured);
  assert.equal(second.saved, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.resume.name, '测试候选人');
  assert.equal(second.resume.parseStatus, 'completed');
  assert.equal(saved.length, 1);
});

test('智联 AI 解析超时有上限，完整原文仍入库', async () => {
  const saved = [];
  const collector = new ZhilianResumeCollector({
    llmService: { chatWithLLM: () => new Promise(() => {}) },
    parseTimeoutMs: 10,
    resumeStore: {
      getResumes: () => saved,
      addResume: async record => {
        const resume = { id: 'timeout-record', ...record };
        saved.push(resume);
        return { created: true, resume };
      }
    }, evaluationQueue: { enqueue: () => ({ queued: true }) }
  });
  const record = await collector.save({ text: '完整工作经历和教育经历。'.repeat(10),
    url: 'https://rd.zhaopin.com/search', title: '简历详情' });
  assert.equal(record.saved, true);
  assert.equal(record.resume.parseStatus, 'needs_review');
  assert.equal(saved.length, 1);
});

test('智联候选人卡片打开简历后保存并关闭弹窗', async () => {
  const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  try {
    const page = await browser.newPage();
    await page.route('https://rd.zhaopin.com/**', route => route.fulfill({
      contentType: 'text/html',
      body: `<meta charset="utf-8"><body>
        <div class="search-resume-item resume-item-exp" onclick="document.querySelector('.new-shortcut-resume__modal').style.display='block'">打开候选人</div>
        <div class="new-shortcut-resume__modal" style="display:none">
          <div class="new-resume-detail--inner">张某，软件开发工程师。工作经历：从事软件开发三年，负责系统设计、代码评审和项目交付，维护多个业务系统。教育经历：计算机科学本科，学习数据库与程序设计。技能特长：JavaScript、SQL、自动化测试。</div>
        </div><script>document.addEventListener('keydown', event => { if (event.key === 'Escape') document.querySelector('.new-shortcut-resume__modal').style.display='none'; });</script>
      </body>`
    }));
    await page.goto('https://rd.zhaopin.com/search');
    const service = new ZhilianService();
    service.page = page;
    service.resumeCollector = new ZhilianResumeCollector({
      llmService: { chatWithLLM: async () => '{"name":"张某","expectedPosition":"软件开发工程师"}' },
      resumeStore: { getResumes: () => [], addResume: async value => ({ id: 'resume-1', ...value }) }
    });
    const card = await page.$('.search-resume-item');
    assert.equal(await service.processResumeWithFrontend(card, 1), true);
    assert.equal(service.browsingStatus.collectedCount, 1);
    assert.equal(service.browsingStatus.candidates[0].name, '张某');
    assert.equal(await page.locator('.new-shortcut-resume__modal').isVisible(), false);
  } finally {
    await browser.close();
  }
});
