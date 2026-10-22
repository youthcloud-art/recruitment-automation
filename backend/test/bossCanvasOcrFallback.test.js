const test = require('node:test');
const assert = require('node:assert/strict');
const BossZhipinService = require('../src/services/bossZhipinService');
const CanvasOcrService = require('../src/services/canvasOcrService');

function preparedService({ visible = true, ocrText = '' } = {}) {
  const service = new BossZhipinService();
  const calls = { hook: 0, drag: 0, ocr: 0, ready: 0 };
  service.page = {};
  service.dragSelectionService.copyResumeByHook = async () => {
    calls.hook++;
    throw new Error('selection unavailable');
  };
  service.dragSelectionService.copyResumeByDragSelection = async () => {
    calls.drag++;
    throw new Error('selection unavailable');
  };
  service.canvasOcrService.captureAndRecognizeCanvas = async () => {
    calls.ocr++;
    return ocrText;
  };
  service.assertCollectorReady = async () => { calls.ready++; };
  const frame = {
    locator: selector => {
      assert.equal(selector, 'canvas#resume');
      return { first: () => ({ isVisible: async () => visible }) };
    }
  };
  return { service, frame, calls };
}

test('BOSS 复制失败后仅对可见简历 Canvas 使用内存 OCR 兜底', async () => {
  const expected = '工作经历：负责网络维护、服务器监控和故障处理。教育经历：计算机专业。'.repeat(3);
  const { service, frame, calls } = preparedService({ ocrText: `  ${expected}  ` });
  assert.equal(await service.extractCanvasResumeContent(frame), expected);
  assert.deepEqual(calls, { hook: 1, drag: 1, ocr: 1, ready: 2 });
});

test('BOSS Canvas 不可见或 OCR 文本不足时不入库', async () => {
  const hidden = preparedService({ visible: false, ocrText: 'should not be read' });
  assert.equal(await hidden.service.extractCanvasResumeContent(hidden.frame), null);
  assert.equal(hidden.calls.ocr, 0);

  const short = preparedService({ ocrText: '登录 个人中心 简历' });
  assert.equal(await short.service.extractCanvasResumeContent(short.frame), null);
  assert.equal(short.calls.ocr, 1);
});

test('BOSS 简历 iframe 有合法页面文字时优先使用文字，不运行 OCR', async () => {
  const { service, frame, calls } = preparedService({ ocrText: '不应使用 OCR' });
  const content = '工作经历：负责网络维护、服务器监控和故障处理。教育经历：计算机专业。'.repeat(3);
  frame.evaluate = async () => ({ content, source: '.resume-detail-wrap' });
  assert.equal(await service.extractResumeContentFromIframe(frame), content);
  assert.equal(calls.ocr, 0);
  assert.equal(calls.ready, 0);
});

test('BOSS 官方验证在 OCR 前后均会中止，且错误透传到采集器', async () => {
  for (const failureAt of [1, 2]) {
    const { service, frame, calls } = preparedService({ ocrText: '简历正文。'.repeat(30) });
    service.assertCollectorReady = async () => {
      calls.ready++;
      if (calls.ready === failureAt) {
        const error = new Error('人工验证');
        error.code = 'BOSS_VERIFICATION_REQUIRED';
        throw error;
      }
    };
    await assert.rejects(service.extractResumeContentFromIframe(frame),
      error => error.code === 'BOSS_VERIFICATION_REQUIRED');
    assert.equal(calls.ocr, failureAt === 1 ? 0 : 1);
  }
});

test('BOSS OCR 截图仅在内存中交给识别器', async () => {
  const service = new CanvasOcrService();
  const pixels = Buffer.from('synthetic-image');
  const calls = [];
  service.captureCanvasScreenshot = async (frame, selector) => {
    calls.push(['capture', frame, selector]);
    return pixels;
  };
  service.recognizeTextFromImage = async image => {
    calls.push(['recognize', image]);
    return '简历文字';
  };
  const frame = {};
  assert.equal(await service.captureAndRecognizeCanvas(frame), '简历文字');
  assert.deepEqual(calls, [
    ['capture', frame, 'canvas#resume'],
    ['recognize', pixels]
  ]);
});

test('BOSS 简历 iframe 支持推荐来源和参数顺序变化，拒绝外站同名路径', async () => {
  const service = new BossZhipinService();
  const expectedFrame = { waitForTimeout: async () => {} };
  const makeIframe = (src, frame) => ({
    getAttribute: async () => src,
    contentFrame: async () => frame
  });
  const page = { $$: async () => [
    makeIframe('https://other.example/web/frame/c-resume/?source=search', {}),
    makeIframe('/web/frame/c-resume/?token=1&source=recommend', expectedFrame)
  ] };
  assert.equal(await service.findResumeIframe(page), expectedFrame);
});
