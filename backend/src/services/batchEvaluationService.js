const { RecruitmentPipelineService } = require('./recruitmentPipelineService');
const { isCostAccountingManagerJD, COST_ACCOUNTING_RUBRIC_VERSION } =
  require('./localResumeEvaluationService');
const { classifyLlmAccessError } = require('./llmAccessError');
const { hasTrackedActiveJob } = require('../utils/activeJobScope');

function hasCurrentEvaluation(item, requirements) {
  const evaluation = item.matchEvaluation;
  if (evaluation?.jobRequirements !== requirements || !Number.isFinite(item.matchScore)) return false;
  if (item.source === 'qcwy' && isCostAccountingManagerJD(requirements)) {
    return evaluation.method === 'local' &&
      evaluation.evaluationVersion === COST_ACCOUNTING_RUBRIC_VERSION &&
      typeof evaluation.recommendationEligible === 'boolean';
  }
  // Old keyword scores and results without the current AI version need to be
  // evaluated again. They must never count as current AI matches.
  return evaluation.method === 'llm' && evaluation.evaluationVersion === 1;
}

class BatchEvaluationService {
  constructor({ pipeline = new RecruitmentPipelineService(), delay = ms => new Promise(resolve => setTimeout(resolve, ms)),
    onEvaluationSuccess = () => {} } = {}) {
    this.pipeline = pipeline;
    this.delay = delay;
    this.onEvaluationSuccess = onEvaluationSuccess;
    this.state = this.emptyState();
    this.stopRequested = false;
  }

  emptyState() {
    return { running: false, total: 0, processed: 0, evaluated: 0, skipped: 0,
      failed: 0, paused: false, pauseCode: null, pauseReason: null,
      currentCandidate: '', errors: [], startedAt: null, finishedAt: null };
  }

  status() {
    return { ...this.state, errors: [...this.state.errors] };
  }

  start({ source = '', status = '', jobRequirements, limit = 100, pendingOnly = true } = {}) {
    if (this.state.running) throw new Error('批量评估正在进行中');
    if (source && !['boss', 'zlzp', 'qcwy'].includes(source)) throw new Error('不支持的招聘平台');
    if (status && !['new', 'shortlisted', 'viewed', 'contacted', 'rejected'].includes(status)) {
      throw new Error('不支持的跟进状态');
    }
    const requirements = String(jobRequirements || '').trim();
    const count = Number(limit);
    if (requirements.length < 5 || requirements.length > 5000) throw new Error('岗位要求需为 5～5000 字');
    if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error('批量评估份数需为 1～100');
    if (typeof pendingOnly !== 'boolean') throw new Error('待补评筛选参数无效');
    // Stream the whole library and retain only this batch. The old list()
    // path loaded every resume (including long original text) into memory and
    // silently ignored pending candidates beyond its 10,000-item cap.
    let withContentCount = 0;
    let pendingCount = 0;
    const candidates = [];
    const consider = item => {
      if (!item.originalText && !item.content) return;
      withContentCount++;
      const pending = pendingOnly
        ? !item.matchEvaluation && !Number.isFinite(item.matchScore)
        : !hasCurrentEvaluation(item, requirements);
      if (!pending) return;
      pendingCount++;
      if (candidates.length < count) candidates.push(item);
    };
    if (typeof this.pipeline.store?.forEachResume === 'function') {
      const activeJob = typeof this.pipeline.activeJob === 'function' ? this.pipeline.activeJob() : null;
      const scopeCurrentJob = hasTrackedActiveJob(this.pipeline.store, activeJob, requirements);
      this.pipeline.store.forEachResume(consider, {
        source: source || null, status: status || null,
        ...(scopeCurrentJob ? { jobRequirements: requirements, jobGroup: 'current' } : {})
      });
    } else {
      this.pipeline.list({ source, status, limit: 10000 }).forEach(consider);
    }
    this.stopRequested = false;
    this.state = { ...this.emptyState(), running: candidates.length > 0, pendingOnly,
      total: candidates.length, skipped: withContentCount - pendingCount,
      startedAt: new Date().toISOString(),
      finishedAt: candidates.length ? null : new Date().toISOString() };
    if (!candidates.length) return this.status();
    this.run(candidates, requirements).catch(error => {
      this.recordError(error.message);
      this.state.running = false;
      this.state.finishedAt = new Date().toISOString();
    });
    return this.status();
  }

  recordError(message) {
    this.state.failed++;
    this.state.errors.push(message);
    if (this.state.errors.length > 20) this.state.errors.shift();
  }

  async run(candidates, requirements) {
    try {
      for (const item of candidates) {
        if (this.stopRequested) break;
        this.state.currentCandidate = item.name || item.id;
        try {
          if (hasCurrentEvaluation(item, requirements)) {
            this.state.skipped++;
          } else {
            const evaluation = await this.pipeline.evaluate(item.id, requirements);
            this.state.evaluated++;
            try { this.onEvaluationSuccess(evaluation); } catch (_) { /* evaluation is already saved */ }
            if (!this.stopRequested) await this.delay(500 + Math.floor(Math.random() * 500));
          }
        } catch (error) {
          const blocked = classifyLlmAccessError(error);
          if (blocked) {
            this.state.paused = true;
            this.state.pauseCode = blocked.code;
            this.state.pauseReason = blocked.message;
            this.recordError(blocked.message);
            break;
          }
          this.recordError(`${item.name || item.id}: ${error.message}`);
        } finally {
          this.state.processed++;
        }
      }
    } finally {
      this.state.currentCandidate = '';
      this.state.running = false;
      this.state.finishedAt = new Date().toISOString();
    }
  }

  stop() {
    this.stopRequested = true;
    return this.status();
  }
}

module.exports = { BatchEvaluationService };
