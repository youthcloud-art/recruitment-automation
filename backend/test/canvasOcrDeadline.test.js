const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const CanvasOcrService = require('../src/services/canvasOcrService');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9jU4gAAAAASUVORK5CYII=',
  'base64'
);

test('OCR loads bundled languages without relying on process cwd or a CDN', async () => {
  let invocation;
  const service = new CanvasOcrService({
    createOcrWorker: async (...args) => {
      invocation = args;
      return { terminate: async () => {} };
    }
  });
  await service.initializeOcr();
  assert.equal(invocation[0], 'chi_sim+eng');
  assert.equal(invocation[1], 1);
  assert.equal(invocation[2].langPath, path.resolve(__dirname, '..'));
  assert.equal(invocation[2].cacheMethod, 'none');
  assert.equal(invocation[2].gzip, false);
  await service.destroy();
});

test('OCR worker initialization has a deadline and closes a late worker', async () => {
  let completeStartup;
  let terminated = 0;
  const service = new CanvasOcrService({
    createOcrWorker: () => new Promise(resolve => { completeStartup = resolve; }),
    deadlines: { initialize: 20, terminate: 20 }
  });
  await assert.rejects(service.initializeOcr(), /OCR 工作器初始化超过20毫秒/);
  assert.equal(service.isInitialized, false);
  completeStartup({ terminate: async () => { terminated++; } });
  await wait(10);
  assert.equal(terminated, 1);
  assert.equal(service.worker, null);
});

test('OCR recognition timeout closes the stuck worker and allows a fresh retry', async () => {
  let created = 0;
  let terminated = 0;
  const service = new CanvasOcrService({
    createOcrWorker: async () => {
      created++;
      return created === 1
        ? { recognize: () => new Promise(() => {}), terminate: async () => { terminated++; } }
        : { recognize: async () => ({ data: { text: '工作经历 网络运维' } }),
          terminate: async () => { terminated++; } };
    },
    deadlines: { initialize: 50, recognize: 20, terminate: 20 }
  });
  await assert.rejects(service.recognizeTextFromImage(Buffer.from('first')),
    /OCR 文字识别超过20毫秒/);
  assert.equal(service.worker, null);
  assert.equal(service.isInitialized, false);
  assert.equal(terminated, 1);
  const text = await service.recognizeTextFromImage(Buffer.from('second'));
  assert.match(text, /工作经历/);
  assert.equal(created, 2);
  await service.destroy();
  assert.equal(terminated, 2);
});

test('unresponsive Canvas screenshot has a deadline before OCR starts', async () => {
  let created = 0;
  const service = new CanvasOcrService({
    createOcrWorker: async () => { created++; return {}; },
    deadlines: { screenshot: 20 }
  });
  const frame = {
    waitForSelector: async () => {},
    $: async () => ({ screenshot: () => new Promise(() => {}) })
  };
  await assert.rejects(service.captureAndRecognizeCanvas(frame), /Canvas 截图超过20毫秒/);
  assert.equal(created, 0);
});

test('Canvas pixel read returns a bounded, validated in-memory PNG without screenshot', async () => {
  const service = new CanvasOcrService();
  let screenshots = 0;
  const frame = {
    waitForSelector: async selector => assert.equal(selector, 'canvas#resume'),
    evaluate: async (callback, options) => {
      assert.equal(typeof callback, 'function');
      assert.equal(options.selector, 'canvas#resume');
      assert.ok(options.maxPixels > 0);
      return { dataUrl: `data:image/png;base64,${ONE_PIXEL_PNG.toString('base64')}` };
    },
    $: async () => { screenshots++; throw new Error('screenshot should not run'); }
  };
  assert.deepEqual(await service.captureCanvasScreenshot(frame), ONE_PIXEL_PNG);
  assert.equal(screenshots, 0);
});

test('tainted Canvas falls back to a bounded, validated screenshot', async () => {
  const service = new CanvasOcrService({ deadlines: { screenshotFallback: 25 } });
  let screenshotTimeout;
  let disposed = 0;
  const frame = {
    waitForSelector: async () => {},
    evaluate: async () => ({ error: 'unreadable' }),
    $: async () => ({ screenshot: async options => {
      screenshotTimeout = options.timeout;
      return ONE_PIXEL_PNG;
    }, dispose: async () => { disposed++; } })
  };
  assert.deepEqual(await service.captureCanvasScreenshot(frame), ONE_PIXEL_PNG);
  assert.equal(screenshotTimeout, 25);
  assert.equal(disposed, 1);
});

test('invalid PNG data and oversized Canvas do not reach OCR or screenshot', async () => {
  const service = new CanvasOcrService();
  let screenshots = 0;
  const frame = {
    waitForSelector: async () => {},
    evaluate: async () => ({ dataUrl: 'data:image/png;base64,' + Buffer.from('not a png').toString('base64') }),
    $: async () => { screenshots++; return null; }
  };
  await assert.rejects(service.captureCanvasScreenshot(frame), /PNG 图片头无效/);
  frame.evaluate = async () => ({ error: 'dimensions' });
  await assert.rejects(service.captureCanvasScreenshot(frame), /尺寸无效或过大/);
  assert.equal(screenshots, 0);
});

test('stalled Canvas pixel read aborts without queuing a second screenshot', async () => {
  const service = new CanvasOcrService({ deadlines: { screenshot: 100, canvasRead: 20 } });
  let screenshots = 0;
  const frame = {
    waitForSelector: async () => {},
    evaluate: () => new Promise(() => {}),
    $: async () => { screenshots++; return null; }
  };
  await assert.rejects(service.captureCanvasScreenshot(frame),
    /Canvas 像素读取超过20毫秒/);
  assert.equal(screenshots, 0);
});

test('fallback screenshot timeout stops the candidate promptly', async () => {
  const service = new CanvasOcrService({
    deadlines: { screenshot: 100, screenshotFallback: 20 }
  });
  let disposed = 0;
  const frame = {
    waitForSelector: async () => {},
    evaluate: async () => ({ error: 'unreadable' }),
    $: async () => ({ screenshot: () => new Promise(() => {}),
      dispose: async () => { disposed++; } })
  };
  await assert.rejects(service.captureCanvasScreenshot(frame),
    /Canvas 浏览器截图超过20毫秒/);
  assert.equal(disposed, 1);
});

test('failed Canvas screenshot still disposes its browser element handle', async () => {
  const service = new CanvasOcrService({ deadlines: { screenshotFallback: 50 } });
  let disposed = 0;
  const frame = {
    waitForSelector: async () => {},
    evaluate: async () => ({ error: 'unreadable' }),
    $: async () => ({ screenshot: async () => { throw new Error('capture failed'); },
      dispose: async () => { disposed++; } })
  };
  await assert.rejects(service.captureCanvasScreenshot(frame), /capture failed/);
  assert.equal(disposed, 1);
});

test('late Canvas element handle is disposed without starting a screenshot', async () => {
  const service = new CanvasOcrService({
    deadlines: { screenshot: 100, screenshotFallback: 20 }
  });
  let resolveHandle;
  let screenshots = 0;
  let disposed = 0;
  const frame = {
    waitForSelector: async () => {},
    evaluate: async () => ({ error: 'unreadable' }),
    $: () => new Promise(resolve => { resolveHandle = resolve; })
  };
  await assert.rejects(service.captureCanvasScreenshot(frame),
    /Canvas 浏览器截图超过20毫秒/);
  resolveHandle({ screenshot: async () => { screenshots++; return ONE_PIXEL_PNG; },
    dispose: async () => { disposed++; } });
  await wait(10);
  assert.equal(screenshots, 0);
  assert.equal(disposed, 1);
});
