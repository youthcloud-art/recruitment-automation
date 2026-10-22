const crypto = require('crypto');
const path = require('path');
const resumeModel = require('../models/resumeModel');
const resumeParserService = require('./resumeParserService');
const { portableBasename } = require('../utils/portablePath');

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const SUPPORTED_EXTENSIONS = new Set(['.pdf', '.docx', '.txt']);
const SOURCE_ALIASES = { '智联招聘': 'zlzp', '前程无忧': 'qcwy', 'BOSS直聘': 'boss', 'Boss直聘': 'boss' };

function hash(algorithm, value) {
  return crypto.createHash(algorithm).update(value).digest('hex');
}

class ResumeImportService {
  constructor({ store = resumeModel, parser = resumeParserService, parseWithLLM = null } = {}) {
    this.store = store;
    this.parser = parser;
    this.parseWithLLM = parseWithLLM;
  }

  async importFile(file, { source = 'manual', localOnly = true } = {}) {
    if (!file?.buffer?.length) throw new Error('请选择非空简历文件');
    if (file.buffer.length > MAX_FILE_SIZE) throw new Error('简历文件不能超过 10MB');
    source = SOURCE_ALIASES[source] || source;
    if (!this.store.getResumeSources().some(item => item.value === source)) {
      throw new Error('请选择有效的简历来源');
    }

    const extension = path.extname(file.originalname || '').toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(extension)) {
      throw new Error('仅支持 PDF、DOCX、TXT 文件；请先将 DOC 转为 DOCX');
    }

    let parsed;
    let text;
    if (extension === '.pdf') {
      parsed = await this.parser.parsePDFResume(file.buffer);
      text = parsed.rawText;
    } else if (extension === '.docx') {
      parsed = await this.parser.parseDOCXResume(file.buffer);
      text = parsed.rawText;
    } else {
      text = file.buffer.toString('utf8');
      parsed = this.parser.parseResumeText(text);
    }
    text = String(text || '').trim();
    if (text.length < 20) {
      throw new Error('未能提取足够的简历文字，请检查文件内容；图片版 PDF 需先进行文字识别');
    }

    // 前程无忧文件只在本机解析；不将候选人内容发送给第三方模型。
    const useLocalParser = source === 'qcwy' || localOnly === true || localOnly === 'true';
    let usedLLM = false;
    let llmFallback = false;
    if (!useLocalParser && text.length > 50) {
      try {
        const llmResult = this.parseWithLLM ? await this.parseWithLLM(text) : null;
        if (llmResult?.parseStatus === 'completed') {
          parsed = llmResult;
          usedLLM = true;
        } else {
          llmFallback = true;
        }
      } catch (_) {
        llmFallback = true;
      }
    }
    // Return a fixed explanation instead of upstream diagnostics, which may
    // contain request details or service credentials.
    const parseWarning = llmFallback ? 'AI 解析未成功，已改用本机解析' : null;

    const normalizedText = text.replace(/\s+/g, ' ').toLowerCase();
    const fileHash = hash('md5', file.buffer);
    const textHash = hash('md5', normalizedText);
    const sourceFingerprint = hash('sha256', normalizedText);
    const existing = this.store.getResumes().find(item => item.source === source &&
      (item.fileHash === fileHash || item.textHash === textHash || item.sourceFingerprint === sourceFingerprint));
    if (existing) {
      return { duplicate: true, resume: existing, parsedResume: parsed, filePath: null,
        llmFallback, parseWarning };
    }

    const safeName = path.basename(file.originalname).replace(/[^\p{L}\p{N}._-]/gu, '_');
    const savedPath = await this.store.uploadResumeFile(`${Date.now()}-${fileHash.slice(0, 12)}-${safeName}`, file.buffer);
    // Keep a portable path in the candidate record. Older records may still
    // contain an absolute path; the email attachment reader handles those.
    const filePath = portableBasename(savedPath);
    const { rawText, ...fields } = parsed;
    const resume = await this.store.addResume({
      ...fields,
      name: fields.name || '未识别姓名',
      source,
      originalText: text,
      parseMethod: usedLLM ? 'llm' : 'local',
      parseStatus: 'completed',
      fileHash,
      textHash,
      sourceFingerprint,
      filePath
    });
    return { duplicate: false, resume, parsedResume: fields, filePath, llmFallback, parseWarning };
  }
}

module.exports = { ResumeImportService, SUPPORTED_EXTENSIONS, MAX_FILE_SIZE };
