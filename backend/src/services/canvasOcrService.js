const { createWorker } = require('tesseract.js');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const logger = require('../utils/logger');

const BUNDLED_LANGUAGE_PATH = path.resolve(__dirname, '../../assets/tessdata');
const LANGUAGE_SHA256 = Object.freeze({
  'chi_sim.traineddata': 'a5fcb6f0db1e1d6d8522f39db4e848f05984669172e584e8d76b6b3141e1f730',
  'eng.traineddata': '7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2'
});

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_DATA_URL_PREFIX = 'data:image/png;base64,';
const MAX_CANVAS_PIXELS = 16 * 1024 * 1024;
const MAX_IMAGE_BYTES = 24 * 1024 * 1024;

function decodeCanvasPng(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith(PNG_DATA_URL_PREFIX)) {
    throw new Error('Canvas 未返回 PNG 图片');
  }
  const encoded = dataUrl.slice(PNG_DATA_URL_PREFIX.length);
  if (!encoded || encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error('Canvas PNG 数据大小或编码无效');
  }
  const image = Buffer.from(encoded, 'base64');
  return validateCanvasPng(image);
}

function validateCanvasPng(image) {
  if (!Buffer.isBuffer(image)) throw new Error('Canvas PNG 图片无效');
  if (image.length < 24 || image.length > MAX_IMAGE_BYTES ||
      !image.subarray(0, 8).equals(PNG_SIGNATURE) ||
      image.readUInt32BE(8) !== 13 || image.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('Canvas PNG 图片头无效');
  }
  const width = image.readUInt32BE(16);
  const height = image.readUInt32BE(20);
  if (!width || !height || width * height > MAX_CANVAS_PIXELS) {
    throw new Error('Canvas PNG 图片尺寸无效');
  }
  return image;
}

/**
 * Canvas截图和OCR识别服务
 * 用于从canvas元素截图并通过OCR识别文字内容
 */
class CanvasOcrService {
  constructor({ createOcrWorker = createWorker, deadlines = {},
    languagePath = BUNDLED_LANGUAGE_PATH } = {}) {
    this.worker = null;
    this.isInitialized = false;
    this.createOcrWorker = createOcrWorker;
    this.languagePath = languagePath;
    this.deadlines = {
      initialize: deadlines.initialize ?? 60000,
      screenshot: deadlines.screenshot ?? 20000,
      canvasRead: deadlines.canvasRead ?? 5000,
      screenshotFallback: deadlines.screenshotFallback ?? 7000,
      recognize: deadlines.recognize ?? 45000,
      terminate: deadlines.terminate ?? 5000
    };
    this.workerGeneration = 0;
    this.initializationPromise = null;
    this.terminatingWorkers = new WeakSet();
  }

  async withDeadline(operation, timeoutMs, label) {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const error = new Error(`${label}超过${timeoutMs}毫秒`);
            error.code = 'OCR_TIMEOUT';
            reject(error);
          }, timeoutMs);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async terminateWorker(worker) {
    if (!worker || typeof worker.terminate !== 'function') return;
    if (this.terminatingWorkers.has(worker)) return;
    this.terminatingWorkers.add(worker);
    await this.withDeadline(() => worker.terminate(), this.deadlines.terminate, 'OCR 工作器关闭')
      .catch(error => logger.warn(`OCR 工作器关闭未及时完成: ${error.message}`));
  }

  verifyLanguageData() {
    for (const [name, expected] of Object.entries(LANGUAGE_SHA256)) {
      const file = path.join(this.languagePath, name);
      let bytes;
      try { bytes = fs.readFileSync(file); }
      catch {
        const error = new Error(`OCR 语言文件缺失：${name}；请重新部署完整发布包`);
        error.code = 'OCR_LANGUAGE_DATA_MISSING';
        throw error;
      }
      const actual = crypto.createHash('sha256').update(bytes).digest('hex');
      if (actual !== expected) {
        const error = new Error(`OCR 语言文件校验失败：${name}；请重新部署完整发布包`);
        error.code = 'OCR_LANGUAGE_DATA_INVALID';
        throw error;
      }
    }
  }

  /**
   * 初始化OCR工作器
   */
  async initializeOcr() {
    if (this.isInitialized) return;
    if (this.initializationPromise) return this.initializationPromise;
    const generation = ++this.workerGeneration;
    this.initializationPromise = (async () => {
      logger.info('正在初始化OCR工作器...');
      // A missing model can make the Tesseract worker fail outside the
      // collector's promise chain. Reject before spawning it instead.
      this.verifyLanguageData();
      const startup = Promise.resolve().then(() => this.createOcrWorker('chi_sim+eng', 1, {
        // Resolve bundled, checksum-verified models independently of cwd.
        langPath: this.languagePath,
        cacheMethod: 'none',
        gzip: false,
        logger: m => {
          if (m.status === 'recognizing text') {
            logger.info(`OCR识别进度: ${Math.round(m.progress * 100)}%`);
          }
        }
      }));
      // createWorker has no cancellation signal. If it completes after the
      // deadline, close that orphaned worker instead of retaining it.
      startup.then(worker => {
        if (generation !== this.workerGeneration) void this.terminateWorker(worker);
      }, () => {});
      const worker = await this.withDeadline(() => startup, this.deadlines.initialize,
        'OCR 工作器初始化');
      if (generation !== this.workerGeneration) {
        await this.terminateWorker(worker);
        throw new Error('OCR 工作器初始化已取消');
      }
      this.worker = worker;
      this.isInitialized = true;
      logger.info('OCR工作器初始化完成');
    })().catch(error => {
      if (generation === this.workerGeneration) this.workerGeneration++;
      logger.error('OCR工作器初始化失败:', error);
      throw error;
    }).finally(() => { this.initializationPromise = null; });
    return this.initializationPromise;
  }

  /**
   * 截取canvas元素的截图
   * @param {Object} frame - Playwright frame对象
   * @param {string} canvasSelector - canvas元素选择器
   * @returns {Buffer} 截图的Buffer数据
   */
  async captureCanvasScreenshot(frame, canvasSelector = 'canvas#resume') {
    try {
      logger.info('正在读取简历 Canvas 图片');
      
      // 等待canvas元素加载
      await frame.waitForSelector(canvasSelector, { timeout: 10000 });

      // Reading the same-origin canvas pixels avoids the Playwright element
      // screenshot path, which can wait indefinitely for a moving page. Keep
      // the data URL inside this call and never write it to disk or logs.
      if (typeof frame.evaluate === 'function') {
        let direct;
        try {
          direct = await this.withDeadline(() => frame.evaluate(({ selector, maxPixels }) => {
            const canvas = document.querySelector(selector);
            if (!(canvas instanceof HTMLCanvasElement)) return { error: 'missing' };
            if (!canvas.width || !canvas.height || canvas.width * canvas.height > maxPixels) {
              return { error: 'dimensions' };
            }
            try {
              return { dataUrl: canvas.toDataURL('image/png') };
            } catch (_) {
              // A tainted canvas may still be captured by Chromium screenshot.
              return { error: 'unreadable' };
            }
          }, { selector: canvasSelector, maxPixels: MAX_CANVAS_PIXELS }),
          Math.min(this.deadlines.canvasRead, this.deadlines.screenshot), 'Canvas 像素读取');
        } catch (error) {
          // A stalled protocol call is not a reason to queue another screenshot
          // on the same frame. Let the caller fail this candidate safely.
          if (error.code === 'OCR_TIMEOUT') throw error;
          direct = { error: 'unreadable' };
        }
        if (direct?.dataUrl) {
          const image = decodeCanvasPng(direct.dataUrl);
          logger.info('Canvas 内存图片读取完成');
          return image;
        }
        if (direct?.error === 'dimensions') {
          throw new Error('Canvas 图片尺寸无效或过大');
        }
        if (direct?.error === 'missing') {
          throw new Error('未找到简历 Canvas 元素');
        }
      }

      // SecurityError on a tainted canvas is the expected fallback case. This
      // path is bounded separately so a stuck element.screenshot does not
      // consume the entire candidate deadline.
      // Playwright element handles hold a browser-side object. A timed-out
      // screenshot must release that handle, including when frame.$ resolves
      // only after our own deadline. Never begin a late screenshot.
      let canvasElement;
      let captureFinished = false;
      const elementPromise = Promise.resolve().then(() => frame.$(canvasSelector))
        .then(element => {
          if (captureFinished) {
            if (typeof element?.dispose === 'function') {
              void Promise.resolve().then(() => element.dispose()).catch(() => {});
            }
            return null;
          }
          canvasElement = element;
          return element;
        });
      let screenshot;
      try {
        screenshot = await this.withDeadline(async () => {
          const element = await elementPromise;
          if (!element || captureFinished) throw new Error('未找到简历 Canvas 元素');
          return element.screenshot({
            type: 'png', timeout: Math.min(this.deadlines.screenshotFallback,
              this.deadlines.screenshot)
          });
        }, Math.min(this.deadlines.screenshotFallback, this.deadlines.screenshot),
        'Canvas 浏览器截图');
      } finally {
        captureFinished = true;
        if (typeof canvasElement?.dispose === 'function') {
          await this.withDeadline(() => canvasElement.dispose(), 1000,
            'Canvas 句柄释放').catch(() => {});
        }
      }

      logger.info('Canvas截图完成');
      return validateCanvasPng(screenshot);
    } catch (error) {
      logger.error('Canvas截图失败:', error);
      throw error;
    }
  }

  /**
   * 使用OCR识别图片中的文字
   * @param {Buffer} imageBuffer - 图片Buffer数据
   * @returns {string} 识别出的文字内容
   */
  async recognizeTextFromImage(imageBuffer) {
    try {
      // 确保OCR工作器已初始化
      await this.initializeOcr();
      
      logger.info('开始OCR文字识别...');
      
      // 使用OCR识别文字
      const worker = this.worker;
      let text;
      try {
        ({ data: { text } } = await this.withDeadline(() => worker.recognize(imageBuffer),
          this.deadlines.recognize, 'OCR 文字识别'));
      } catch (error) {
        if (error.code === 'OCR_TIMEOUT') {
          this.worker = null;
          this.isInitialized = false;
          this.workerGeneration++;
          await this.terminateWorker(worker);
        }
        throw error;
      }
      
      // 清理识别结果
      const cleanedText = this.cleanOcrText(text);
      
      logger.info(`OCR识别完成，识别出 ${cleanedText.length} 个字符`);
      return cleanedText;
    } catch (error) {
      logger.error('OCR文字识别失败:', error);
      throw error;
    }
  }

  /**
   * 清理OCR识别结果
   * @param {string} text - 原始OCR文字
   * @returns {string} 清理后的文字
   */
  cleanOcrText(text) {
    if (!text) return '';
    
    return text
      // 移除多余的空白字符
      .replace(/\s+/g, ' ')
      // 移除特殊字符
      .replace(/[\x00-\x1F\x7F]/g, '')
      // 修复常见的OCR错误
      .replace(/０/g, '0')
      .replace(/１/g, '1')
      .replace(/２/g, '2')
      .replace(/３/g, '3')
      .replace(/４/g, '4')
      .replace(/５/g, '5')
      .replace(/６/g, '6')
      .replace(/７/g, '7')
      .replace(/８/g, '8')
      .replace(/９/g, '9')
      // 修复常见标点符号
      .replace(/，/g, ',')
      .replace(/。/g, '.')
      .replace(/：/g, ':')
      .replace(/；/g, ';')
      .trim();
  }

  /**
   * 从canvas元素截图并识别文字（完整流程）
   * @param {Object} frame - Playwright frame对象
   * @param {string} canvasSelector - canvas元素选择器
   * @returns {string} 识别出的文字内容
   */
  async captureAndRecognizeCanvas(frame, canvasSelector = 'canvas#resume') {
    try {
      logger.info('开始canvas截图和OCR识别流程');
      
      // Candidate screenshots contain personal data. Keep the image in memory
      // only; the recognized text is persisted by the normal resume store.
      const screenshot = await this.withDeadline(
        () => this.captureCanvasScreenshot(frame, canvasSelector),
        this.deadlines.screenshot, 'Canvas 截图');
      const recognizedText = await this.recognizeTextFromImage(screenshot);
      logger.info('Canvas截图和OCR识别流程完成');
      return recognizedText;
    } catch (error) {
      logger.error('Canvas截图和OCR识别流程失败:', error);
      throw error;
    }
  }

  /**
   * 销毁OCR工作器
   */
  async destroy() {
    try {
      // Also invalidate an initialization that has not yet returned a worker.
      this.workerGeneration++;
      if (this.worker) {
        const worker = this.worker;
        this.worker = null;
        this.isInitialized = false;
        await this.terminateWorker(worker);
        logger.info('OCR工作器已销毁');
      }
    } catch (error) {
      logger.error('销毁OCR工作器失败:', error);
    }
  }
}

module.exports = CanvasOcrService;
