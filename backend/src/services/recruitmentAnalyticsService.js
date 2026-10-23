const resumeModel = require('../models/resumeModel');
const { ActiveJobService } = require('./activeJobService');
const { hasTrackedActiveJob } = require('../utils/activeJobScope');
const { isVettedEvaluation } = require('./resumeRecommendationService');
const { candidateName, candidatePosition } = require('../utils/candidateDisplay');

const SOURCE_LABELS = Object.freeze({ boss: 'BOSS直聘', zlzp: '智联招聘', qcwy: '前程无忧' });
const STATUS_LABELS = Object.freeze({
  new: '待查看', shortlisted: '已入围', viewed: '已查看', contacted: '已联系', rejected: '已排除'
});
const SCORE_BANDS = Object.freeze([
  { key: '0-59', label: '0–59 分', min: 0, maxExclusive: 60 },
  { key: '60-69', label: '60–69 分', min: 60, maxExclusive: 70 },
  { key: '70-79', label: '70–79 分', min: 70, maxExclusive: 80 },
  { key: '80-89', label: '80–89 分', min: 80, maxExclusive: 90 },
  { key: '90-100', label: '90–100 分', min: 90, maxExclusive: 101 }
]);

function localDateKey(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function cleanInline(value, maxLength = 100) {
  return String(value || '').replace(/[\r\n|]/g, ' ').trim().slice(0, maxLength);
}

function percentage(part, whole) {
  return whole ? Math.round((part / whole) * 1000) / 10 : 0;
}

function validateOptions({ scope = 'active', threshold = 70 } = {}) {
  if (typeof scope !== 'string' || !['active', 'all'].includes(scope)) {
    throw new Error('不支持的数据范围');
  }
  if (typeof threshold !== 'string' && typeof threshold !== 'number') {
    throw new Error('通过分数需为 0～100 之间的整数');
  }
  const number = Number(threshold);
  if (threshold === '' || !Number.isInteger(number) || number < 0 || number > 100) {
    throw new Error('通过分数需为 0～100 之间的整数');
  }
  return { scope, threshold: number };
}

class RecruitmentAnalyticsService {
  constructor({ store = resumeModel, activeJobService = new ActiveJobService(), clock = () => new Date() } = {}) {
    this.store = store;
    this.activeJobService = activeJobService;
    this.clock = clock;
  }

  snapshot(options = {}) {
    const { scope, threshold } = validateOptions(options);
    const activeJob = this.activeJobService.current();
    const requirements = String(activeJob?.jobRequirements || '').trim();
    const configured = requirements.length >= 5;
    // New captures retain their exact job criteria even when evaluation is
    // deferred. Older records can still be linked by a completed evaluation.
    const bySource = Object.entries(SOURCE_LABELS).map(([source, label]) => ({
      source, label, total: 0, evaluated: 0, passed: 0, withOriginalText: 0,
      nameNeedsReview: 0, positionNeedsReview: 0, parseNeedsReview: 0
    }));
    const sourceMap = Object.fromEntries(bySource.map(row => [row.source, row]));
    const byStatus = Object.entries(STATUS_LABELS).map(([status, label]) => ({ status, label, count: 0 }));
    const statusMap = Object.fromEntries(byStatus.map(row => [row.status, row]));
    const scoreBands = SCORE_BANDS.map(({ key, label }) => ({ key, label, count: 0 }));
    const now = this.clock();
    const trend = Array.from({ length: 14 }, (_, index) => {
      const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (13 - index));
      return { date: localDateKey(day), stored: 0, evaluated: 0 };
    });
    const trendMap = Object.fromEntries(trend.map(day => [day.date, day]));
    const metrics = { total: 0, evaluated: 0, passed: 0,
      withOriginalText: 0, scoreSum: 0, scoreAverage: null };

    const countRecord = item => {
      if (!Object.hasOwn(SOURCE_LABELS, item.source) ||
          (scope === 'active' && item.matchEvaluation?.jobRequirements !== requirements &&
            item.captureJobRequirements !== requirements)) return;
      metrics.total++;
      const source = sourceMap[item.source];
      source.total++;
      if (/^(?:未识别姓名|匿名候选人|姓名待核实)/.test(candidateName(item)) ||
          (item.source === 'boss' && Boolean(item.platformAlias)) ||
          (item.source === 'qcwy' && /（平台称呼）$/.test(candidateName(item)))) {
        source.nameNeedsReview++;
      }
      if (!candidatePosition(item) || /待核实/.test(candidatePosition(item))) source.positionNeedsReview++;
      // A complete captured OCR page can still have uncertain structured
      // fields. Keep that uncertainty visible even when the raw text passed
      // the full-resume gate and AI evaluation has completed.
      if (item.parseStatus === 'needs_review' ||
          (item.source === 'boss' && item.parseMethod === 'ocr')) {
        source.parseNeedsReview++;
      }
      const status = statusMap[item.workflowStatus] || statusMap.new;
      status.count++;
      if (String(item.originalText || item.content || '').trim()) {
        source.withOriginalText++;
        metrics.withOriginalText++;
      }
      const storedDay = trendMap[localDateKey(item.createdAt)];
      if (storedDay) storedDay.stored++;
      // An old score can survive a failed retry. Use the same versioned
      // evaluation gate as recommendation and the candidate report so such a
      // record never inflates evaluated or above-threshold analytics.
      const score = item.matchScore;
      const evaluated = (scope !== 'active' || item.matchEvaluation?.jobRequirements === requirements) &&
        isVettedEvaluation(item) &&
        Number.isFinite(score) && score >= 0 && score <= 100;
      if (!evaluated) return;
      source.evaluated++;
      metrics.evaluated++;
      metrics.scoreSum += score;
      if (score >= threshold) {
        source.passed++;
        metrics.passed++;
      }
      const bandIndex = SCORE_BANDS.findIndex(band => score >= band.min && score < band.maxExclusive);
      if (bandIndex !== -1) scoreBands[bandIndex].count++;
      const evaluatedDay = trendMap[localDateKey(item.matchEvaluation.evaluatedAt)];
      if (evaluatedDay) evaluatedDay.evaluated++;
    };
    if (scope === 'all' || configured) {
      if (typeof this.store.forEachResume === 'function') {
        this.store.forEachResume(countRecord,
          { jobRequirements: scope === 'active' ? requirements : null,
            jobGroup: scope === 'active' && hasTrackedActiveJob(this.store, activeJob, requirements)
              ? 'current' : null });
      } else {
        this.store.getResumes().forEach(countRecord);
      }
    }
    metrics.scoreAverage = metrics.evaluated
      ? Math.round((metrics.scoreSum / metrics.evaluated) * 10) / 10 : null;
    delete metrics.scoreSum;
    metrics.evaluationRate = percentage(metrics.evaluated, metrics.total);
    metrics.passRate = percentage(metrics.passed, metrics.evaluated);
    metrics.originalTextRate = percentage(metrics.withOriginalText, metrics.total);
    metrics.unevaluated = metrics.total - metrics.evaluated;
    return {
      scope, threshold,
      generatedAt: now.toISOString(),
      job: { title: cleanInline(activeJob?.title), targetCount: activeJob?.targetCount || null,
        updatedAt: activeJob?.updatedAt || null, configured },
      metrics, bySource, byStatus, scoreBands, trend,
      scopeNote: scope === 'active'
        ? '当前岗位包含按这版条件采集或评估的简历；旧版未记录采集岗位且未评估的简历无法可靠归属。评分失败或进行中的记录计入待评估，不会误算为已评分。'
        : '全部历史简历包含不同岗位；已评估数采用初筛报告的有效性检查，失败或进行中的重评不计入。各岗位匹配分仅作参考，不宜直接横向比较。'
    };
  }

  reportMarkdown(options = {}) {
    const data = this.snapshot(options);
    const { metrics } = data;
    const range = data.scope === 'active'
      ? `当前岗位：${data.job.title || '未设置'}` : '范围：全部历史岗位';
    const cohortLabel = data.scope === 'active' ? '本岗位已关联简历' : '历史入库简历';
    const lines = [
      '# 招聘数据分析报告', '',
      `生成时间：${new Date(data.generatedAt).toLocaleString('zh-CN')}`,
      range,
      `通过分数：${data.threshold} 分`, '',
      `本报告基于本机已入库的三平台简历。所选范围内共 ${metrics.total} 份，其中 ${metrics.evaluated} 份完成岗位评估，${metrics.passed} 份达到所设分数线。`,
      data.scopeNote, '',
      '## 汇总指标', '',
      `- ${cohortLabel}：${metrics.total} 份`,
      `- 已评估：${metrics.evaluated} 份${metrics.evaluationRate === null ? '' : `（${metrics.evaluationRate}%）`}`,
      metrics.unevaluated === null ? '- 待评估：当前岗位未评估记录无法可靠归属' :
        `- 待评估：${metrics.unevaluated} 份`,
      `- 达到分数线：${metrics.passed} 份（占已评估 ${metrics.passRate}%）`,
      `- 已保存简历原文：${metrics.withOriginalText} 份（${metrics.originalTextRate}%）`,
      `- 已评分简历平均分：${metrics.scoreAverage ?? '暂无'}`, '',
      '## 平台分布', '',
      `| 平台 | ${data.scope === 'active' ? '已关联' : '入库'} | 已评估 | 达到分数线 | 保存原文 |`,
      '| --- | ---: | ---: | ---: | ---: |',
      ...data.bySource.map(row => `| ${row.label} | ${row.total} | ${row.evaluated} | ${row.passed} | ${row.withOriginalText} |`), '',
      '## 分数分布', '',
      '| 分数段 | 简历数 |', '| --- | ---: |',
      ...data.scoreBands.map(row => `| ${row.label} | ${row.count} |`), '',
      '## 跟进状态', '',
      '| 状态 | 简历数 |', '| --- | ---: |',
      ...data.byStatus.map(row => `| ${row.label} | ${row.count} |`), '',
      '## 最近十四天', '',
      '| 日期 | 入库 | 评估 |', '| --- | ---: | ---: |',
      ...data.trend.map(row => `| ${row.date} | ${row.stored} | ${row.evaluated} |`), '',
      '> 匹配分是辅助筛选结果，最终判断需人工复核。此报告不包含候选人姓名、联系方式或简历原文。', ''
    ];
    return lines.join('\n');
  }

  reportCsv(options = {}) {
    const data = this.snapshot(options);
    const cohortLabel = data.scope === 'active' ? '本岗位已关联简历' : '历史入库简历';
    const rows = [['维度', '类别', '指标', '数量', '说明']];
    const add = (dimension, category, metric, count, note = '') =>
      rows.push([dimension, category, metric, count, note]);
    add('范围', data.scope === 'active' ? data.job.title || '未设置' : '全部历史岗位',
      '通过分数', data.threshold, data.scopeNote);
    for (const [metric, label] of Object.entries({ total: cohortLabel, evaluated: '已评估',
      passed: '达到分数线', withOriginalText: '保存原文' })) {
      add('汇总', '三平台', label, data.metrics[metric]);
    }
    if (data.metrics.unevaluated !== null) add('汇总', '三平台', '待评估', data.metrics.unevaluated);
    for (const row of data.bySource) {
      for (const [metric, label] of Object.entries({ total: cohortLabel, evaluated: '已评估',
        passed: '达到分数线', withOriginalText: '保存原文' })) {
        add('平台', row.label, label, row[metric]);
      }
    }
    for (const row of data.scoreBands) add('分数分布', row.label, '简历数', row.count);
    for (const row of data.byStatus) add('跟进状态', row.label, '简历数', row.count);
    for (const row of data.trend) {
      add('最近十四天', row.date, '入库', row.stored);
      add('最近十四天', row.date, '评估', row.evaluated);
    }
    const cell = value => {
      let text = String(value ?? '');
      if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
      return `"${text.replace(/"/g, '""')}"`;
    };
    return `\uFEFF${rows.map(row => row.map(cell).join(',')).join('\r\n')}\r\n`;
  }
}

module.exports = { RecruitmentAnalyticsService, validateOptions, SOURCE_LABELS, STATUS_LABELS };
