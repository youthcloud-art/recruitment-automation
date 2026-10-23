const crypto = require('crypto');
const LLMService = require('./llmService');
const resumeModel = require('../models/resumeModel');
const logger = require('../utils/logger');
const { isSameZhilianResume } = require('../utils/zhilianResumeIdentity');
const { postCaptureEvaluationQueue } = require('./postCaptureEvaluationQueue');

const DETAIL_SELECTORS = [
  '.new-shortcut-resume__modal .new-resume-detail--inner',
  '.new-shortcut-resume__modal .resume-section-new',
  '.new-shortcut-resume__modal',
  '.new-resume-detail--inner'
];
const RESUME_MARKERS = ['工作经历', '工作经验', '教育经历', '教育背景', '求职意向', '项目经历', '技能特长'];

function parseStructuredReply(reply) {
  const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const value = fenced ? fenced[1] : reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1);
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('AI 返回的简历结构无效');
  }
  return parsed;
}

function visibleCandidateName(value, resumeText) {
  const name = String(value || '').trim();
  if (!/^(?:[\u4e00-\u9fff·]{2,8}|[A-Za-z][A-Za-z .'-]{2,50})$/.test(name) ||
      /^(?:姓名|个人信息|工作经历|教育经历|简历详情|求职意向|通知|匿名候选人|未识别姓名)$/.test(name)) return '';
  return String(resumeText || '').slice(0, 700).includes(name) ? name : '';
}

class ZhilianResumeCollector {
  constructor({ llmService = null, resumeStore = resumeModel,
    evaluationQueue = postCaptureEvaluationQueue, parseTimeoutMs = 45000 } = {}) {
    this.llmService = llmService;
    this.resumeStore = resumeStore;
    this.evaluationQueue = evaluationQueue;
    this.parseTimeoutMs = parseTimeoutMs;
  }

  findExisting(candidate) {
    if (typeof this.resumeStore.findDuplicateResume === 'function') {
      return this.resumeStore.findDuplicateResume(candidate);
    }
    return this.resumeStore.getResumes().find(item =>
      isSameZhilianResume(item, candidate)) || null;
  }

  async enrichExisting(existing, candidate) {
    if (existing?.parseStatus !== 'needs_review' || candidate.parseMethod !== 'llm' ||
        existing.sourceFingerprint !== candidate.sourceFingerprint ||
        typeof this.resumeStore.updateCandidateMetadata !== 'function') return existing;
    const fields = ['name', 'age', 'workYears', 'education', 'currentStatus', 'phone',
      'email', 'selfIntroduction', 'expectedPosition', 'position', 'workExperience',
      'educationExperience', 'skills', 'certificates', 'parseMethod', 'parseStatus', 'nameSource'];
    return await this.resumeStore.updateCandidateMetadata(existing.id,
      Object.fromEntries(fields.map(key => [key, candidate[key]]))) || existing;
  }

  async captureVisibleResume(page) {
    const hostname = new URL(page.url()).hostname;
    if (hostname !== 'zhaopin.com' && !hostname.endsWith('.zhaopin.com')) {
      throw new Error('当前页面不是智联招聘');
    }
    await page.locator('.new-shortcut-resume__modal .new-resume-detail--inner, .new-resume-detail--inner')
      .first().waitFor({ state: 'visible', timeout: 12000 });
    for (const selector of DETAIL_SELECTORS) {
      const locator = page.locator(selector).first();
      if (!await locator.isVisible().catch(() => false)) continue;
      const text = (await locator.innerText({ timeout: 8000 })).trim();
      const markerCount = RESUME_MARKERS.filter(marker => text.includes(marker)).length;
      if (text.length >= 80 && markerCount >= 2) {
        return { text: text.slice(0, 16000), url: page.url(), title: await page.title() };
      }
    }
    throw new Error('未识别到完整简历详情，请确认候选人简历弹窗已打开');
  }

  async save(captured, activeJob = null) {
    const fingerprint = crypto.createHash('sha256').update(captured.text).digest('hex');
    const duplicate = this.findExisting({ source: 'zlzp', sourceFingerprint: fingerprint });
    if (duplicate?.parseStatus !== 'needs_review') {
      if (duplicate) return { saved: false, duplicate: true, resume: duplicate };
    }
    let parsed = {};
    let parseMethod = 'raw_fallback';
    let timeout;
    const controller = new AbortController();
    try {
      if (!this.llmService && !process.env.LLM_API_KEY) throw new Error('DeepSeek API 未配置');
      const reply = await Promise.race([(this.llmService || new LLMService()).chatWithLLM([
        { role: 'system', content: '你是招聘简历信息提取助手。仅返回 JSON，缺失字段使用 null 或空数组，不要编造。提取 name、age、workYears、education、currentStatus、phone、email、selfIntroduction、expectedPosition、workExperience、educationExperience、skills、certificates。workExperience 与 educationExperience 是对象数组，skills 与 certificates 是字符串数组。' },
        { role: 'user', content: '请从以下智联招聘简历详情提取候选人信息，忽略页面导航和按钮文字。\n\n' + captured.text }
      ], null, null, { signal: controller.signal, timeout: this.parseTimeoutMs }),
      new Promise((_, reject) => { timeout = setTimeout(() => {
        controller.abort();
        reject(new Error('智联简历 AI 解析超时'));
      }, this.parseTimeoutMs); })]);
      parsed = parseStructuredReply(reply);
      parseMethod = 'llm';
    } catch (_) {
      // The complete platform text is already validated above. Persist it
      // even during an AI outage; never invent a name from navigation text.
      logger.warn('智联简历结构化解析暂不可用，已保存完整原文供后续补评');
    } finally {
      clearTimeout(timeout);
    }
    const textFields = ['name', 'age', 'workYears', 'education', 'currentStatus', 'phone', 'email', 'selfIntroduction'];
    const record = Object.fromEntries(textFields.map(field => [field,
      typeof parsed[field] === 'string' || typeof parsed[field] === 'number' ? parsed[field] : null]));
    record.expectedPosition = typeof parsed.expectedPosition === 'string' ||
      (parsed.expectedPosition && typeof parsed.expectedPosition.position === 'string')
      ? parsed.expectedPosition : null;
    record.position = typeof record.expectedPosition === 'string'
      ? record.expectedPosition : record.expectedPosition?.position || '';
    for (const field of ['workExperience', 'educationExperience']) {
      record[field] = Array.isArray(parsed[field])
        ? parsed[field].filter(item => item && typeof item === 'object' && !Array.isArray(item)) : [];
    }
    for (const field of ['skills', 'certificates']) {
      record[field] = Array.isArray(parsed[field])
        ? parsed[field].filter(item => typeof item === 'string') : [];
    }
    const candidate = {
      ...record,
      name: visibleCandidateName(record.name, captured.text) || '未识别姓名',
      nameSource: visibleCandidateName(record.name, captured.text)
        ? 'zhilian_ai_visible_text' : 'unverified',
      source: 'zlzp',
      platform: '智联招聘',
      sourceUrl: captured.url,
      sourceTitle: captured.title,
      sourceFingerprint: fingerprint,
      originalText: captured.text,
      captureJobRequirements: String(activeJob?.jobRequirements || '').trim() || null,
      captureJobTitle: String(activeJob?.title || '').trim() || null,
      capturePositionId: activeJob?.positionId || null,
      parseMethod,
      parseStatus: parseMethod === 'llm' ? 'completed' : 'needs_review'
    };
    const nearDuplicate = this.findExisting(candidate);
    if (nearDuplicate) return { saved: false, duplicate: true,
      resume: await this.enrichExisting(nearDuplicate, candidate) };
    const result = await this.resumeStore.addResume(candidate, { returnStatus: true });
    const saved = result.resume || result;
    if (result.created === false) return { saved: false, duplicate: true,
      resume: await this.enrichExisting(saved, candidate) };
    try {
      this.evaluationQueue.enqueue(saved, activeJob);
    } catch (_) {
      // Matching is optional background work; a saved resume must remain saved.
      logger.warn('智联简历已保存，但自动评估队列未能接收');
    }
    return { saved: true, duplicate: false, resume: saved };
  }
}

module.exports = { ZhilianResumeCollector, parseStructuredReply };
