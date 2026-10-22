const logger = require('../utils/logger');
const resumeModel = require('../models/resumeModel');
const { RecruitmentPipelineService } = require('./recruitmentPipelineService');
const { classifyLlmAccessError } = require('./llmAccessError');
const { isVettedEvaluation } = require('./resumeRecommendationService');

const EVALUATED_SOURCES = new Set(['boss', 'zlzp']);

function hasCurrentEvaluation(resume, requirements) {
  return resume?.matchEvaluation?.jobRequirements === requirements &&
    Number.isFinite(resume.matchScore) &&
    isVettedEvaluation(resume);
}

function safeErrorMessage(error) {
  const apiKey = process.env.LLM_API_KEY || '';
  const message = String(error?.message || error || '未知错误');
  return (apiKey ? message.split(apiKey).join('[REDACTED]') : message).slice(0, 240);
}

/**
 * A small in-process queue for evaluations of resumes saved during this run.
 * It never scans old records at startup. A process restart can leave a newly
 * saved resume unevaluated; the user can evaluate it from the candidate list.
 */
class PostCaptureEvaluationQueue {
  constructor({
    store = resumeModel,
    evaluate = (id, requirements) => new RecruitmentPipelineService({ store }).evaluate(id, requirements),
    capacity = 20,
    log = logger
  } = {}) {
    this.store = store;
    this.evaluate = evaluate;
    this.capacity = Math.max(1, Math.min(Number(capacity) || 20, 100));
    this.log = log;
    this.items = [];
    this.ids = new Set();
    this.running = false;
    this.closed = false;
    this.completed = 0;
    this.failed = 0;
    this.overflowed = 0;
    this.deferred = 0;
    this.pausedCode = null;
    this.pausedReason = null;
    this.pausedAt = null;
    this.lastError = null;
    this.lastFinishedAt = null;
    this.idleResolvers = [];
  }

  enqueue(resume, job = {}) {
    const id = resume?.id;
    if (!id || !EVALUATED_SOURCES.has(resume.source)) return { queued: false, reason: 'unsupported_resume' };
    const title = String(job?.title || '').trim();
    const requirements = String(job?.jobRequirements || '').trim();
    if (title.length < 2 || requirements.length < 5 || requirements.length > 5000) {
      return { queued: false, reason: 'no_active_job' };
    }
    if (hasCurrentEvaluation(resume, requirements) || this.ids.has(id)) {
      return { queued: false, reason: 'already_evaluated_or_queued' };
    }
    if (this.closed) return { queued: false, reason: 'queue_closed' };
    if (this.pausedCode) {
      this.deferred++;
      this.#recordPending(id, this.pausedReason);
      return { queued: false, reason: 'llm_unavailable' };
    }
    if (this.items.length + Number(this.running) >= this.capacity) {
      this.overflowed++;
      this.#recordFailure(id, '评估队列已满，请在候选人列表中手动评估');
      return { queued: false, reason: 'queue_full' };
    }
    // Keep a copy: edits to the active job during a long search do not change
    // the criteria used for candidates already captured by that search.
    this.items.push({ id, source: resume.source, title, requirements,
      jobUpdatedAt: job.updatedAt || null });
    this.ids.add(id);
    setImmediate(() => { void this.#pump(); });
    return { queued: true };
  }

  status() {
    return {
      queued: this.items.length,
      running: this.running,
      capacity: this.capacity,
      completed: this.completed,
      failed: this.failed,
      overflowed: this.overflowed,
      deferred: this.deferred,
      paused: Boolean(this.pausedCode),
      pauseCode: this.pausedCode,
      pauseReason: this.pausedReason,
      pausedAt: this.pausedAt,
      lastError: this.lastError,
      lastFinishedAt: this.lastFinishedAt,
      closed: this.closed
    };
  }

  whenIdle() {
    if (!this.running && !this.items.length) return Promise.resolve();
    return new Promise(resolve => this.idleResolvers.push(resolve));
  }

  // Allows an orderly service shutdown. The default finishes accepted work;
  // close(false) abandons only queued work, never an in-flight LLM request.
  async close({ drain = true } = {}) {
    this.closed = true;
    if (!drain) {
      for (const item of this.items.splice(0)) {
        this.ids.delete(item.id);
        this.#recordFailure(item.id, '服务停止，自动评估未完成，请手动评估');
      }
      this.#resolveIfIdle();
    }
    await this.whenIdle();
  }

  // Only call after a fresh, successful AI evaluation confirms the configured
  // model is usable again. Deferred resumes remain in storage for batch repair.
  resume() {
    this.pausedCode = null;
    this.pausedReason = null;
    this.pausedAt = null;
    return this.status();
  }

  #recordPending(id, message) {
    this.lastError = message;
    this.lastFinishedAt = new Date().toISOString();
    try {
      this.store.updateCandidateMetadata(id, {
        matchEvaluationStatus: 'pending', matchEvaluationError: message
      });
    } catch (error) {
      this.log.warn(`保存简历 ${id} 的待评估状态出错: ${safeErrorMessage(error)}`);
    }
  }

  #recordFailure(id, message) {
    this.lastError = message;
    this.lastFinishedAt = new Date().toISOString();
    try {
      this.store.updateCandidateMetadata(id, {
        matchEvaluationStatus: 'failed', matchEvaluationError: message
      });
    } catch (error) {
      this.log.warn(`保存简历 ${id} 的评估失败状态出错: ${safeErrorMessage(error)}`);
    }
  }

  #resolveIfIdle() {
    if (this.running || this.items.length) return;
    for (const resolve of this.idleResolvers.splice(0)) resolve();
  }

  async #pump() {
    if (this.running || !this.items.length) return;
    this.running = true;
    try {
      while (this.items.length) {
        const item = this.items.shift();
        try {
          const current = this.store.getResumeById(item.id);
          if (!current || hasCurrentEvaluation(current, item.requirements)) continue;
          await this.evaluate(item.id, item.requirements);
          this.completed++;
          this.lastFinishedAt = new Date().toISOString();
          try {
            this.store.updateCandidateMetadata(item.id, {
              matchEvaluationStatus: 'completed', matchEvaluationError: null,
              matchEvaluationJobTitle: item.title,
              matchEvaluationJobUpdatedAt: item.jobUpdatedAt
            });
          } catch (error) {
            this.log.warn(`保存简历 ${item.id} 的评估完成状态出错: ${safeErrorMessage(error)}`);
          }
        } catch (error) {
          const blocked = classifyLlmAccessError(error);
          if (blocked) {
            this.failed++;
            this.pausedCode = blocked.code;
            this.pausedReason = blocked.message;
            this.pausedAt = new Date().toISOString();
            this.#recordPending(item.id, blocked.message);
            this.deferred++;
            for (const waiting of this.items.splice(0)) {
              this.ids.delete(waiting.id);
              this.#recordPending(waiting.id, blocked.message);
              this.deferred++;
            }
            this.log.warn(`自动评估已暂停: ${blocked.message}`);
            break;
          }
          const message = safeErrorMessage(error);
          this.failed++;
          this.#recordFailure(item.id, message);
          this.log.warn(`新采集简历 ${item.id} 自动评估失败: ${message}`);
        } finally {
          this.ids.delete(item.id);
        }
      }
    } finally {
      this.running = false;
      this.#resolveIfIdle();
    }
  }
}

const postCaptureEvaluationQueue = new PostCaptureEvaluationQueue();
module.exports = { PostCaptureEvaluationQueue, postCaptureEvaluationQueue };
