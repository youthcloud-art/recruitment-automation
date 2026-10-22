const resumeModel = require('../models/resumeModel');
const { ActiveJobService } = require('./activeJobService');
const { isSameZhilianResume } = require('../utils/zhilianResumeIdentity');
const { candidateName, candidatePosition } = require('../utils/candidateDisplay');

const SOURCES = Object.freeze(['boss', 'zlzp', 'qcwy']);

function optionsFor(input = {}) {
  const source = String(input.source || '');
  const minScore = Number(input.minScore ?? 70);
  const limit = input.limit === undefined || input.limit === null ? null : Number(input.limit);
  if (source && !SOURCES.includes(source)) throw new Error('不支持的招聘平台');
  if (input.minScore === '' || !Number.isInteger(minScore) || minScore < 0 || minScore > 100) {
    throw new Error('最低匹配分需为 0～100 的整数');
  }
  if (limit !== null && (input.limit === '' || !Number.isInteger(limit) || limit < 1 || limit > 200)) {
    throw new Error('推荐份数需为 1～200 的整数');
  }
  return { source, minScore, limit };
}

function hasUsableResume(item) {
  return Boolean(String(item.originalText || item.content || '').trim());
}

function isVettedEvaluation(item) {
  if (['pending', 'failed'].includes(item.matchEvaluationStatus)) return false;
  if (item.matchEvaluation?.recommendationEligible === false) return false;
  const evaluation = item.matchEvaluation || {};
  if (item.source !== 'qcwy') {
    return ['zlzp', 'boss'].includes(item.source) &&
      evaluation.method === 'llm' && evaluation.evaluationVersion === 1 &&
      Boolean(evaluation.evaluatedAt);
  }
  // Keep the QCWY evidence gate consistent with the existing email selection.
  return (evaluation.method === 'local' && evaluation.evaluationVersion === 2 &&
    evaluation.recommendationEligible === true) ||
    (evaluation.method === 'llm' && evaluation.evaluationVersion === 1 &&
      Boolean(evaluation.evaluatedAt));
}

function displayText(value) {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

function toCard(item) {
  const evaluation = item.matchEvaluation || {};
  return {
    id: item.id,
    name: candidateName(item),
    source: item.source,
    position: candidatePosition(item),
    experience: displayText(item.workYears) || displayText(item.experience),
    education: displayText(item.education),
    matchScore: item.matchScore,
    summary: typeof evaluation.summary === 'string' ? evaluation.summary : '',
    strengths: Array.isArray(evaluation.strengths)
      ? evaluation.strengths.filter(value => typeof value === 'string').slice(0, 5) : [],
    gaps: Array.isArray(evaluation.gaps)
      ? evaluation.gaps.filter(value => typeof value === 'string').slice(0, 5) : [],
    workflowStatus: item.workflowStatus || 'new',
    evaluatedAt: evaluation.evaluatedAt || null
  };
}

class ResumeRecommendationService {
  constructor({ store = resumeModel, activeJobService = new ActiveJobService() } = {}) {
    this.store = store;
    this.activeJobService = activeJobService;
  }

  recommend(input = {}) {
    const { source, minScore, limit: requestedLimit } = optionsFor(input);
    const activeJob = this.activeJobService.current();
    const targetCount = Number.isInteger(activeJob.recommendationTargetCount) &&
      activeJob.recommendationTargetCount > 0 ? activeJob.recommendationTargetCount : null;
    const limit = requestedLimit ?? targetCount ?? 20;
    const requirements = String(activeJob.jobRequirements || '').trim();
    const configured = Boolean(activeJob.updatedAt && activeJob.title && requirements.length >= 5);
    if (!configured) {
      return { job: { title: '', updatedAt: null, recommendationTargetCount: null }, source, minScore,
        limit, evaluatedCount: 0, qualifiedCount: 0, targetShortfall: null, recommendations: [] };
    }
    const evaluated = [];
    const collect = item => {
      if (SOURCES.includes(item.source) && (!source || item.source === source) &&
          item.matchEvaluation?.jobRequirements === requirements &&
          isVettedEvaluation(item) && Number.isFinite(item.matchScore) &&
          item.matchScore >= 0 && item.matchScore <= 100) evaluated.push(item);
    };
    if (typeof this.store.forEachResume === 'function') {
      this.store.forEachResume(collect, { source: source || null,
        jobRequirements: requirements });
    } else {
      this.store.getResumes().forEach(collect);
    }
    const sorted = evaluated.filter(item => item.matchScore >= minScore &&
      item.workflowStatus !== 'rejected' && hasUsableResume(item) && isVettedEvaluation(item))
      .sort((a, b) => b.matchScore - a.matchScore ||
        String(b.matchEvaluation?.evaluatedAt || b.updatedAt || '').localeCompare(
          String(a.matchEvaluation?.evaluatedAt || a.updatedAt || '')));
    const qualified = [];
    const zhilianFingerprints = new Set();
    const zhilianBuckets = new Map();
    for (const item of sorted) {
      if (item.source === 'zlzp') {
        if (item.sourceFingerprint && zhilianFingerprints.has(item.sourceFingerprint)) continue;
        const name = String(item.name || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
        const bucketKey = JSON.stringify([item.sourceUrl || '', name]);
        const bucket = zhilianBuckets.get(bucketKey) || [];
        if (bucket.some(existing => isSameZhilianResume(existing, item))) continue;
        bucket.push(item);
        zhilianBuckets.set(bucketKey, bucket);
        if (item.sourceFingerprint) zhilianFingerprints.add(item.sourceFingerprint);
      }
      qualified.push(item);
    }
    return {
      job: { title: activeJob.title, updatedAt: activeJob.updatedAt, recommendationTargetCount: targetCount },
      source, minScore, limit,
      evaluatedCount: evaluated.length,
      qualifiedCount: qualified.length,
      targetShortfall: targetCount === null || source ? null : Math.max(targetCount - qualified.length, 0),
      recommendations: qualified.slice(0, limit).map(toCard)
    };
  }
}

module.exports = { ResumeRecommendationService, optionsFor, isVettedEvaluation };
