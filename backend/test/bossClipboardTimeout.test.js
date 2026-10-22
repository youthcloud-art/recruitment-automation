const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const DragSelectionService = require('../src/services/dragSelectionService');
const BossZhipinService = require('../src/services/bossZhipinService');

function browserPage({ grabbedText = '', selectedText = '' } = {}) {
  return {
    evaluate: (evaluator, argument) => vm.runInNewContext(
      `(${evaluator.toString()})(argument)`, {
        argument,
        navigator: { clipboard: { readText: () => new Promise(() => {}) } },
        window: {
          __grabbed_text: grabbedText,
          getSelection: () => ({ toString: () => selectedText })
        },
        setTimeout,
        clearTimeout,
        console
      }
    )
  };
}

test('未决的浏览器剪贴板请求在截止时间后让位给 Hook 文本', async () => {
  const service = new DragSelectionService();
  const text = '工作经历：维护网络与服务器，处理故障，保障生产系统稳定。'.repeat(3);
  const start = Date.now();
  const result = await service.readCopiedTextAttempt(browserPage({ grabbedText: text }), 30, 250);
  assert.equal(result.success, true);
  assert.equal(result.content, text);
  assert.equal(result.method, 'global variable');
  assert.ok(Date.now() - start < 250);
});

test('剪贴板读取未决且无选中内容时报告超时，避免反复触发权限等待', async () => {
  const service = new DragSelectionService();
  const result = await service.readCopiedTextAttempt(browserPage(), 20, 250);
  assert.equal(result.success, false);
  assert.equal(result.clipboardTimedOut, true);
});

test('Playwright 页面求值自身未决时，Node 侧截止时间仍可返回', async () => {
  const service = new DragSelectionService();
  const page = { evaluate: () => new Promise(() => {}) };
  await assert.rejects(service.readCopiedTextAttempt(page, 20, 35), /BOSS 剪贴板读取超过35毫秒/);
});

test('复制前快照阻止旧候选人简历被关联到新卡片', async () => {
  const oldResume = '工作经历：旧候选人的成本核算和预算分析。教育经历：会计本科。'.repeat(3);
  const newResume = '工作经历：新候选人的制造业成本核算和财务分析。教育经历：财务本科。'.repeat(3);
  const state = { clipboardText: oldResume, globalText: '', selectedText: '' };
  const page = {
    evaluate: (evaluator, argument) => vm.runInNewContext(
      `(${evaluator.toString()})(argument)`, {
        argument,
        navigator: { clipboard: { readText: async () => state.clipboardText } },
        window: {
          get __grabbed_text() { return state.globalText; },
          getSelection: () => ({ toString: () => state.selectedText })
        },
        setTimeout, clearTimeout, console
      })
  };
  const service = new DragSelectionService();
  const baseline = await service.snapshotCopySources(page);
  assert.equal(baseline.clipboardKnown, true);
  const stale = await service.readCopiedTextAttempt(page, 30, 250, baseline);
  assert.equal(stale.success, false);
  assert.equal(stale.staleContent, true);
  state.clipboardText = newResume;
  const fresh = await service.readCopiedTextAttempt(page, 30, 250, baseline);
  assert.equal(fresh.success, true);
  assert.equal(fresh.content, newResume);
});

test('已确认的简历 iframe 不会重新选择其它候选人的 iframe', async () => {
  const service = new DragSelectionService();
  const frame = { locator: () => ({ count: async () => 0 }) };
  const page = {
    waitForSelector: () => { throw new Error('不应重新查询 iframe'); },
    $$: () => { throw new Error('不应重新枚举 iframe'); }
  };
  await assert.rejects(service.copyResumeByHook(page, { frame }),
    /iframe中未找到canvas#resume元素/);
});

test('Hook 与传统拖拽复制均未决时有界回退到 Canvas OCR', async () => {
  const service = new BossZhipinService();
  service.page = {};
  service.canvasCopyTimeoutMs = { hook: 25, drag: 25 };
  const signals = [];
  service.dragSelectionService.copyResumeByHook = (_page, options) => {
    signals.push(options.signal);
    return new Promise(() => {});
  };
  service.dragSelectionService.copyResumeByDragSelection = (_page, options) => {
    signals.push(options.signal);
    return new Promise(() => {});
  };
  const text = '工作经历：负责网络、服务器运维与故障处理。教育经历：计算机本科。'.repeat(3);
  let ocrCalls = 0;
  service.canvasOcrService.captureAndRecognizeCanvas = async () => {
    ocrCalls++;
    return text;
  };
  service.assertCollectorReady = async () => {};
  const frame = {
    locator: () => ({ first: () => ({ isVisible: async () => true }) })
  };
  const result = await service.extractCanvasResumeContent(frame);
  assert.equal(result, text);
  assert.equal(ocrCalls, 1);
  assert.equal(signals.length, 2);
  assert.ok(signals.every(signal => signal.aborted));
});
