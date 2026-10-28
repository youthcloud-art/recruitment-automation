'use strict';

const CanvasOcrService = require('../src/services/canvasOcrService');

(async () => {
  const service = new CanvasOcrService();
  try {
    await service.initializeOcr();
    process.stdout.write('OCR_READY\n');
  } finally {
    await service.destroy();
  }
})().catch(error => {
  process.stderr.write(`OCR_PRECHECK_FAILED: ${error.code || error.message}\n`);
  process.exitCode = 1;
});
