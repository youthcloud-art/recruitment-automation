'use strict';

// The Chinese OCR model is CPU-heavy. Keep it outside the HTTP process so a
// long resume cannot stall health checks or another recruiter's page.
const os = require('node:os');
const CanvasOcrService = require('./canvasOcrService');

try { os.setPriority(process.pid, 10); }
catch (_) { /* The parent still enforces a hard deadline and can kill us. */ }

const ocr = new CanvasOcrService();
let busy = false;
process.on('disconnect',()=>{
  const deadline=setTimeout(()=>process.exit(0),5000);
  deadline.unref();
  void ocr.destroy().finally(()=>process.exit(0));
});
process.on('message', async message => {
  if (message?.type !== 'recognize' || !Number.isSafeInteger(message.id) || busy) return;
  busy = true;
  try {
    const image = message.image;
    if (!Buffer.isBuffer(image) || image.length < 24 || image.length > 24*1024*1024) {
      throw Object.assign(new Error('OCR 图片无效'),{code:'OCR_IMAGE_INVALID'});
    }
    const text=await ocr.recognizeTextFromImage(image);
    if (typeof process.send === 'function') process.send({id:message.id,ok:true,
      text:String(text || '').slice(0,300000)});
  } catch (error) {
    if (typeof process.send === 'function') process.send({id:message.id,ok:false,
      code:/^[A-Z_]{3,40}$/.test(error.code || '') ? error.code : 'OCR_FAILED',
      message:error.code==='OCR_TIMEOUT' ? 'OCR 文字识别超时' : 'OCR 文字识别失败'});
  } finally { busy=false; }
});
