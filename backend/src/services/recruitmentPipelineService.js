const resumeModel = require('../models/resumeModel');
const LLMService = require('./llmService');
const { evaluateLocally, isCostAccountingManagerJD, removePersonalInformation } =
  require('./localResumeEvaluationService');
const { ActiveJobService } = require('./activeJobService');
const { isVettedEvaluation } = require('./resumeRecommendationService');
const { isSameZhilianResume } = require('../utils/zhilianResumeIdentity');
const { candidateName, candidatePosition, hiringJobTitle } = require('../utils/candidateDisplay');
const { hasTrackedActiveJob } = require('../utils/activeJobScope');

const SOURCES = ['boss', 'zlzp', 'qcwy'];
const STATUSES = ['new', 'shortlisted', 'viewed', 'contacted', 'rejected'];
const LABELS = { boss: 'BOSS直聘', zlzp: '智联招聘', qcwy: '前程无忧' };

function parseEvaluation(reply) {
  const fenced = String(reply || '').match(/```(?:json)?\s*([\s\S]*?)```/i);
  const value = fenced ? fenced[1] : String(reply || '').slice(String(reply || '').indexOf('{'), String(reply || '').lastIndexOf('}') + 1);
  const parsed = JSON.parse(value);
  const score = Number(parsed.score);
  if (parsed.score === null || parsed.score === undefined || parsed.score === '' ||
      !Number.isFinite(score) || score < 0 || score > 100) throw new Error('AI 返回的匹配分数无效');
  return {
    score: Math.round(score),
    strengths: Array.isArray(parsed.strengths) ? parsed.strengths.filter(x => typeof x === 'string').slice(0, 5) : [],
    gaps: Array.isArray(parsed.gaps) ? parsed.gaps.filter(x => typeof x === 'string').slice(0, 5) : [],
    summary: typeof parsed.summary === 'string' ? parsed.summary.slice(0, 500) : ''
  };
}

function resumeText(resume) {
  const relevant = {
    expectedPosition: resume.expectedPosition,
    workYears: resume.workYears || resume.experience,
    education: resume.education,
    skills: resume.skills,
    workExperience: resume.workExperience,
    educationExperience: resume.educationExperience,
    projects: resume.projectExperience,
    selfIntroduction: resume.selfIntroduction,
    originalText: resume.originalText || resume.content || ''
  };
  // Redact before JSON encoding: escaped line breaks in JSON would otherwise
  // make profile-line removal unreliable. Nested work/project descriptions can
  // contain contact details too, so sanitize every string recursively.
  const privateKeys = /^(?:name|age|gender|sex|birthdate|birthday|phone|mobile|email|contact|address|idcard|idnumber|maritalstatus|ethnicity|wechat)$/i;
  const redact = value => {
    if (typeof value === 'string') return removePersonalInformation(value, resume);
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === 'object') return Object.fromEntries(
      Object.entries(value).filter(([key]) => !privateKeys.test(key))
        .map(([key, item]) => [key, redact(item)]));
    return value;
  };
  return JSON.stringify(redact(relevant)).slice(0, 14000);
}

function line(value) {
  return String(value ?? '').replace(/[\r\n|]/g, ' ').trim().slice(0, 400);
}

class RecruitmentPipelineService {
  constructor({ store = resumeModel, llmFactory = () => new LLMService(),
    activeJobService = new ActiveJobService() } = {}) {
    this.store = store;
    this.llmFactory = llmFactory;
    this.activeJobService = activeJobService;
  }

  list({ source = '', status = '', keyword = '', limit = 200,
    jobGroup = '', jobTitle = '' } = {}) {
    if (source && !SOURCES.includes(source)) throw new Error('不支持的招聘平台');
    if (status && !STATUSES.includes(status)) throw new Error('不支持的跟进状态');
    const term = String(keyword).trim().toLowerCase();
    const title = String(jobTitle).trim();
    if (title.length > 120) throw new Error('岗位名称过长');
    const max = Math.min(Math.max(Number(limit) || 200, 1), 10000);
    const matches = item => SOURCES.includes(item.source) &&
      (!source || item.source === source) &&
      (!title || hiringJobTitle(item) === title) &&
      (!jobGroup || !item.jobGroup || item.jobGroup === jobGroup) &&
      (!status || (item.workflowStatus || 'new') === status) &&
      (!term || [item.name, item.position, item.expectedPosition?.position,
        typeof item.expectedPosition === 'string' ? item.expectedPosition : '',
        ...(Array.isArray(item.skills) ? item.skills : [])]
        .some(value => String(value || '').toLowerCase().includes(term)));
    if (typeof this.store.forEachResume === 'function') {
      const records = [];
      this.store.forEachResume(item => {
        if (records.length <= max && matches(item)) records.push(item);
      }, { source: source || null, status: status || null, jobGroup: jobGroup || null,
        hiringJobTitle: title || null });
      return records.slice(0, max);
    }
    return this.store.getResumes().filter(matches).slice(0, max);
  }

  listPage({ source = '', status = '', keyword = '', jobTitle = '', jobGroup = '',
    sortBy = 'createdAt', limit = 10, offset = 0 } = {}) {
    if (source && !SOURCES.includes(source)) throw new Error('不支持的招聘平台');
    if (status && !STATUSES.includes(status)) throw new Error('不支持的跟进状态');
    const pageSize = Number(limit);
    const start = Number(offset);
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100 ||
        !Number.isSafeInteger(start) || start < 0 || start > 10_000_000) {
      throw new Error('分页参数无效');
    }
    const term = String(keyword).trim();
    if (term.length > 100) throw new Error('搜索关键词过长');
    const title = String(jobTitle).trim();
    if (title.length > 120) throw new Error('岗位名称过长');
    if (jobGroup && !['current', 'historical'].includes(jobGroup)) throw new Error('岗位分组无效');
    if (!['createdAt', 'scoreAsc', 'scoreDesc'].includes(sortBy)) throw new Error('排序方式无效');
    return this.store.getResumesPage({ source: source || null, hiringJobTitle: title || null,
      jobGroup: jobGroup || null,
      sources: source ? null : SOURCES, status: status || null, keyword: term,
      keywordFields: 'pipeline', sortBy, limit: pageSize, offset: start });
  }

  jobs() {
    const rows = typeof this.store.getHiringJobCounts === 'function'
      ? this.store.getHiringJobCounts(SOURCES)
      : this.store.getResumes().filter(item => SOURCES.includes(item.source))
        .map(item => ({ title: hiringJobTitle(item),
          source: item.source, total: 1 }));
    const jobs = new Map();
    for (const row of rows) {
      const title = row.title || '招聘岗位待核实';
      const jobGroup = row.jobGroup === 'historical' ? 'historical' : 'current';
      const key = `${jobGroup}\u0000${title}`;
      if (!jobs.has(key)) jobs.set(key, { title, jobGroup, total: 0,
        bySource: Object.fromEntries(SOURCES.map(source => [source, 0])) });
      const count = Number(row.total) || 0;
      jobs.get(key).total += count;
      if (row.source in jobs.get(key).bySource) jobs.get(key).bySource[row.source] += count;
    }
    return [...jobs.values()].sort((a, b) =>
      (a.jobGroup === b.jobGroup ? 0 : a.jobGroup === 'current' ? -1 : 1) ||
      b.total - a.total || a.title.localeCompare(b.title, 'zh-CN'));
  }

  summary() {
    const result = Object.fromEntries(SOURCES.map(source => [source, {
      label: LABELS[source], total: 0, byStatus: Object.fromEntries(STATUSES.map(status => [status, 0]))
    }]));
    const counts = typeof this.store.getSourceStatusCounts === 'function'
      ? this.store.getSourceStatusCounts(SOURCES)
      : this.store.getResumes().filter(item => SOURCES.includes(item.source))
        .map(item => ({ source: item.source, status: item.workflowStatus, total: 1 }));
    for (const item of counts) {
      if (!result[item.source]) continue;
      const total = Number(item.total) || 0;
      result[item.source].total += total;
      const status = STATUSES.includes(item.status) ? item.status : 'new';
      result[item.source].byStatus[status] += total;
    }
    return result;
  }

  activeJob(platform) {
    return this.activeJobService.current(platform);
  }

  deleteHistoricalCandidates({ ids, jobTitle } = {}) {
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 50 ||
        ids.some(id => typeof id !== 'string' || id.length < 1 || id.length > 120) ||
        new Set(ids).size !== ids.length) throw new Error('请从当前页选择 1～50 份不同的历史简历');
    const title = String(jobTitle || '').trim();
    if (!title || title.length > 120) throw new Error('请先选择要删除的历史岗位');
    if (typeof this.store.deleteHistoricalResumes !== 'function') throw new Error('简历存储不支持历史岗位删除');
    return this.store.deleteHistoricalResumes(ids, title);
  }

  update(id, { status, notes } = {}) {
    const item = this.store.getResumeById(id);
    if (!item || !SOURCES.includes(item.source)) throw new Error('未找到该平台候选人');
    const changes = {};
    if (status !== undefined) {
      if (!STATUSES.includes(status)) throw new Error('不支持的跟进状态');
      changes.workflowStatus = status;
    }
    if (notes !== undefined) {
      if (typeof notes !== 'string' || notes.length > 3000) throw new Error('备注不能超过 3000 字');
      changes.candidateNotes = notes;
    }
    if (!Object.keys(changes).length) throw new Error('没有要更新的内容');
    return this.store.updateCandidateMetadata(id, changes);
  }

  async evaluate(id, jobRequirements) {
    const item = this.store.getResumeById(id);
    if (!item || !SOURCES.includes(item.source)) throw new Error('未找到该平台候选人');
    const requirements = String(jobRequirements || '').trim();
    if (requirements.length < 5 || requirements.length > 5000) throw new Error('岗位要求需为 5～5000 字');
    if (item.source === 'qcwy' && isCostAccountingManagerJD(requirements)) {
      const evaluation = { ...evaluateLocally(item, requirements),
        jobRequirements: requirements, evaluatedAt: new Date().toISOString() };
      this.store.updateCandidateMetadata(id, { matchScore: evaluation.score, matchEvaluation: evaluation,
        matchEvaluationStatus: 'completed', matchEvaluationError: null });
      return evaluation;
    }
    const content = resumeText(item);
    if (content.length < 60) throw new Error('该简历内容不足，无法可靠评估');
    const messages = [
      { role: 'system', content: '你是招聘辅助评估助手。只根据岗位相关的技能、经验和项目证据评估，不使用年龄、性别、姓名、联系方式等与岗位无关的个人特征。仅输出 JSON 对象：{"score":0到100的整数,"strengths":["具体证据"],"gaps":["需要核实的缺口"],"summary":"简短结论"}。缺少证据时说明不确定，不要编造。评分仅供人工参考。' },
      { role: 'user', content: `岗位要求：\n${requirements}\n\n候选人简历：\n${content}` }
    ];
    const llm = this.llmFactory();
    let parsed;
    for (let attempt = 0; attempt < 2; attempt++) {
      const request = attempt === 0 ? messages : [
        { ...messages[0], content: `${messages[0].content}\n上一次返回的 JSON 语法有误。请重新生成完整、有效的 JSON；字符串正确转义，数组元素用逗号分隔。` },
        messages[1]
      ];
      const reply = await llm.chatWithLLM(request);
      try {
        parsed = parseEvaluation(reply);
        break;
      } catch (error) {
        // 仅重试模型输出的 JSON 语法错误一次；无效评分和 API 故障直接上报。
        if (!(error instanceof SyntaxError) || attempt === 1) throw error;
      }
    }
    const evaluation = { ...parsed, method: 'llm', evaluationVersion: 1,
      jobRequirements: requirements, evaluatedAt: new Date().toISOString() };
    this.store.updateCandidateMetadata(id, { matchScore: evaluation.score, matchEvaluation: evaluation,
      matchEvaluationStatus: 'completed', matchEvaluationError: null });
    return evaluation;
  }

  selectedJobReportData({ source = '', status = '', keyword = '', jobTitle = '',
    jobGroup = '', minScore = 0, topN } = {}) {
    const title = String(jobTitle).trim();
    if (!title || title.length > 120 || !['current', 'historical'].includes(jobGroup)) {
      throw new Error('请先选择一个明确的在用或历史岗位');
    }
    const minimum = Number(minScore);
    if (!Number.isInteger(minimum) || minimum < 0 || minimum > 100) {
      throw new Error('最低匹配分需为 0～100');
    }
    const records = this.list({ source, status, keyword, jobGroup, jobTitle: title, limit: 10000 });
    if (records.length >= 10000) {
      throw new Error('单次报告最多检查 10000 份简历，请按平台或关键词缩小范围');
    }
    const byVersion = new Map();
    const selectedZhilian = [];
    for (const item of records) {
      const requirements = String(item.matchEvaluation?.jobRequirements || '').trim();
      if (!requirements ||
          (item.captureJobRequirements && item.captureJobRequirements !== requirements) ||
          (status === '' && (item.workflowStatus || 'new') === 'rejected') ||
          !isVettedEvaluation(item) || !Number.isFinite(item.matchScore) ||
          item.matchScore < minimum || item.matchScore > 100 ||
          !String(item.originalText || item.content || '').trim()) continue;
      if (item.source === 'zlzp') {
        if (selectedZhilian.some(existing => isSameZhilianResume(existing, item))) continue;
        selectedZhilian.push(item);
      }
      if (!byVersion.has(requirements)) byVersion.set(requirements, []);
      byVersion.get(requirements).push(item);
    }
    for (const group of byVersion.values()) group.sort((a, b) =>
      b.matchScore - a.matchScore || String(a.id).localeCompare(String(b.id)));
    // Scores are only ordered within the same exact job requirements. Never
    // rank two historical criteria versions against each other.
    const eligible = [...byVersion.values()].flat();
    const desired = topN === undefined || topN === '' ? Math.min(eligible.length, 500) : Number(topN);
    if (!Number.isInteger(desired) || desired < 0 || desired > 500 ||
        (topN !== undefined && topN !== '' && desired < 1)) {
      throw new Error('报告候选人份数需为 1～500');
    }
    const candidates = eligible.slice(0, desired);
    return { title, jobGroup, source, status, keyword, minimum, total: records.length,
      eligibleCount: eligible.length, candidates, versions: [...byVersion.keys()] };
  }

  reportPreview(options = {}) {
    const selection = this.selectedJobReportData(options);
    return { jobTitle: selection.title, jobGroup: selection.jobGroup,
      source: selection.source, status: selection.status, keyword: selection.keyword,
      total: selection.total, eligibleCount: selection.eligibleCount,
      selectedCount: selection.candidates.length, maxCount: 500,
      requirementsVersions: selection.versions.length };
  }

  selectedJobReport(options = {}) {
    const data = this.selectedJobReportData(options);
    const lines = [
      '# 候选人初筛报告', '',
      `生成时间：${new Date().toLocaleString('zh-CN')}`,
      `招聘岗位：${line(data.title)}`,
      `岗位归属：${data.jobGroup === 'current' ? '在用岗位' : '历史/已删除岗位'}`,
      `平台：${data.source ? LABELS[data.source] : 'BOSS直聘、智联招聘、前程无忧'}`,
      `最低岗位匹配分：${data.minimum}/100`,
      `当前筛选结果：${data.total} 份；有效评估且达到分数线：${data.eligibleCount} 份；本报告展示：${data.candidates.length} 份`,
      '',
      '仅包含本岗位、本次平台及跟进状态筛选下有原文且完成有效评估的简历；人工排除者默认不纳入。', ''
    ];
    if (!data.candidates.length) lines.push('当前条件下暂无可纳入初筛报告的候选人。', '');
    data.versions.forEach((requirements, index) => {
      const group = data.candidates.filter(item => item.matchEvaluation.jobRequirements === requirements);
      if (!group.length) return;
      lines.push(`## 岗位条件版本 ${index + 1}（${group.length} 份）`, '',
        '### 该版本岗位要求', '', requirements, '',
        '| 平台 | 候选人 | 求职岗位 | 岗位匹配分 | 跟进状态 | 评估摘要 | 备注 |',
        '| --- | --- | --- | ---: | --- | --- | --- |');
      for (const item of group) lines.push(`| ${LABELS[item.source]} | ${line(candidateName(item))} | ${line(candidatePosition(item))} | ${item.matchScore} | ${line(item.workflowStatus || 'new')} | ${line(item.matchEvaluation?.summary)} | ${line(item.candidateNotes)} |`);
      lines.push('', '### 候选人详情', '');
      group.forEach((item, candidateIndex) => lines.push(
        `#### ${candidateIndex + 1}. ${line(candidateName(item))}`, '',
        `- 平台：${LABELS[item.source]}`,
        `- 求职岗位：${line(candidatePosition(item))}`,
        `- 匹配分：${item.matchScore}/100`,
        `- 跟进状态：${line(item.workflowStatus || 'new')}`,
        `- 评估结论：${line(item.matchEvaluation?.summary) || '待复核'}`,
        `- 相关优势：${line(item.matchEvaluation?.strengths?.join('；')) || '暂无'}`,
        `- 待核实：${line(item.matchEvaluation?.gaps?.join('；')) || '暂无'}`,
        `- 备注：${line(item.candidateNotes) || '暂无'}`,
        item.sourceUrl ? `- 来源页面：${line(item.sourceUrl)}` : '', ''));
    });
    lines.push('> 不同岗位条件版本的匹配分不能直接横向比较；最终判断需人工复核。', '');
    return lines.join('\n');
  }

  report(options = {}) {
    if (options.jobTitle || options.jobGroup) return this.selectedJobReport(options);
    const { source = '', status = '', minScore = 70, topN = 20, jobRequirements = '' } = options;
    const minimum = Number(minScore);
    const count = Number(topN);
    if (!Number.isInteger(minimum) || minimum < 0 || minimum > 100) {
      throw new Error('最低匹配分需为 0～100');
    }
    if (!Number.isInteger(count) || count < 1 || count > 100) {
      throw new Error('报告候选人份数需为 1～100');
    }
    const activeJob = this.activeJob();
    const activeRequirements = String(activeJob?.jobRequirements || '').trim();
    const requestedRequirements = String(jobRequirements || '').trim();
    if (!activeJob?.updatedAt || !activeJob.title || activeRequirements.length < 5) {
      throw new Error('请先保存并应用当前岗位条件，再导出初筛报告');
    }
    if (requestedRequirements && requestedRequirements !== activeRequirements) {
      throw new Error('报告岗位与当前岗位设置不一致，请刷新岗位条件后重试');
    }
    const requirements = activeRequirements;
    if (requirements.length > 5000) {
      throw new Error('岗位要求需为 5～5000 字');
    }
    const records = this.list({ source, status, limit: 10000,
      jobGroup: hasTrackedActiveJob(this.store, activeJob, requirements) ? 'current' : '' });
    if (records.length >= 10000) {
      throw new Error('单次报告最多检查 10000 份简历，请按平台或跟进状态缩小范围');
    }
    const selectedZhilian = [];
    const eligible = records
      .filter(item => (status || (item.workflowStatus || 'new') !== 'rejected') &&
        item.matchEvaluation?.jobRequirements === requirements &&
        // Older valid AI records may have no explicit status. The versioned
        // evaluation and timestamp prove completion; pending/failed are excluded
        // by the same eligibility rule used for recommendation and mail.
        isVettedEvaluation(item) &&
        Number.isFinite(item.matchScore) && item.matchScore >= minimum && item.matchScore <= 100 &&
        String(item.originalText || item.content || '').trim())
      .sort((a, b) => b.matchScore - a.matchScore ||
        String(a.source || '').localeCompare(String(b.source || '')) ||
        String(a.id || '').localeCompare(String(b.id || '')))
      .filter(item => {
        if (item.source !== 'zlzp') return true;
        if (selectedZhilian.some(existing => isSameZhilianResume(existing, item))) return false;
        selectedZhilian.push(item);
        return true;
      });
    const candidates = eligible.slice(0, count);
    const lines = [
      '# 候选人初筛报告',
      '',
      `生成时间：${new Date().toLocaleString('zh-CN')}`,
      `平台：${source ? LABELS[source] : 'BOSS直聘、智联招聘、前程无忧'}`,
      `当前岗位：${line(activeJob.title)}`,
      `最低岗位匹配分：${minimum}/100`,
      `符合条件：${eligible.length} 份；本报告展示：${candidates.length} 份（最多 ${count} 份）`,
      '',
      '## 当前岗位要求',
      requirements,
      '',
      '| 平台 | 候选人 | 求职岗位 | 岗位匹配分 | 跟进状态 | 评估摘要 | 备注 |',
      '| --- | --- | --- | ---: | --- | --- | --- |'
    ];
    for (const item of candidates) {
      lines.push(`| ${LABELS[item.source]} | ${line(candidateName(item))} | ${line(candidatePosition(item))} | ${Number.isFinite(item.matchScore) ? item.matchScore : '未评估'} | ${line(item.workflowStatus || 'new')} | ${line(item.matchEvaluation?.summary)} | ${line(item.candidateNotes)} |`);
    }
    if (!candidates.length) lines.push('', '当前岗位暂无达到本次筛选条件且已完成有效评估的候选人。');
    lines.push('', '## 跟进清单', '');
    for (const item of candidates) {
      lines.push(`- [ ] ${line(candidateName(item))}（${LABELS[item.source]}）— ${line(candidatePosition(item))}`);
    }
    lines.push('', '## 候选人详情', '');
    candidates.forEach((item, index) => {
      lines.push(`### ${index + 1}. ${line(candidateName(item))}`, '',
        `- 平台：${LABELS[item.source]}`,
        `- 岗位：${line(candidatePosition(item))}`,
        `- 匹配分：${Number.isFinite(item.matchScore) ? `${item.matchScore}/100` : '未评估'}`,
        `- 跟进状态：${line(item.workflowStatus || 'new')}`,
        `- 评估方式：${item.matchEvaluation?.method === 'local' ? '本机关键词证据评分' : item.matchEvaluation ? 'AI 辅助岗位匹配' : '尚未评估'}`,
        `- 评估结论：${line(item.matchEvaluation?.summary) || '尚未评估'}`,
        `- 相关优势：${line(item.matchEvaluation?.strengths?.join('；')) || '暂无'}`,
        `- 待核实：${line(item.matchEvaluation?.gaps?.join('；')) || '暂无'}`,
        `- 备注：${line(item.candidateNotes) || '暂无'}`,
        item.sourceUrl ? `- 来源页面：${line(item.sourceUrl)}` : '', '');
    });
    lines.push('', '> 岗位匹配分仅供人工复核，不代表自动录用或淘汰决定。', '');
    return lines.join('\n');
  }
}

module.exports = { RecruitmentPipelineService, SOURCES, STATUSES, parseEvaluation };
