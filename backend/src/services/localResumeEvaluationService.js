// 本机匹配只计算岗位关键词的原文覆盖，不调用网络服务或推断未写明的能力。
const LATIN_TERM = /[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*[+#]{0,2}/gi;
const ENGLISH_STOP_WORDS = new Set(('a an the and or with for of in to on at as is are be have has ' +
  'must should required requirements require preferred familiar proficient experience experienced ' +
  'skill skills ability knowledge years year job role responsibilities male female gender age ' +
  'name phone mobile email contact candidate candidates work working').split(' '));
const CHINESE_TERMS = [
  '自动化测试', '软件测试', '单元测试', '测试开发', '软件开发', '后端开发', '前端开发',
  '需求分析', '产品规划', '原型设计', '用户研究', '项目管理', '团队管理', '接口设计',
  '性能优化', '数据库', '数据分析', '数据挖掘', '机器学习', '深度学习', '算法设计',
  '云计算', '微服务', '分布式', '财务核算', '税务申报', '成本控制', '预算管理',
  '客户开发', '客户维护', '市场分析', '商务谈判', '供应链', '沟通协调'
].sort((a, b) => b.length - a.length);
const GENERIC_CHINESE = /我们|需要|一位|一名|候选人|人员|岗位|要求|任职|职位|招聘|具备|具有|相关|丰富|扎实|较强|良好|优秀|出色|熟练|熟悉|掌握|了解|精通|负责|能够|可以|完成|工作|项目|经验|经历|能力|技能|基础|优先|必须|至少|及以上|以上|不限|的|等/g;

function removePersonalInformation(value, resume = {}) {
  let text = String(value || '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, ' ')
    .replace(/(?:\+?86[- ]?)?1[3-9]\d{9}/g, ' ')
    .replace(/(?:姓名|性别|年龄|出生日期|出生年月|婚姻状况|民族|身份证号?|联系电话|联系方式|手机号?|电话|邮箱|电子邮件|微信|住址)\s*[:：]?\s*[^\n，,;；|]{0,100}/g, ' ')
    .replace(/\b(?:name|gender|age|date of birth|phone|mobile|e-?mail|contact)\s*:\s*[^\n,;|]{0,100}/gi, ' ')
    .replace(/\d{1,3}\s*(?:周岁|岁)(?:以上|以下|左右)?/g, ' ')
    .replace(/男性|女性|男士|女士|男|女|\b(?:male|female)\b/gi, ' ');
  for (const key of ['name', 'phone', 'email']) {
    const personalValue = String(resume[key] || '');
    if (personalValue.length >= 2) text = text.split(personalValue).join(' ');
  }
  return text;
}

function extractKeywords(requirements) {
  const text = removePersonalInformation(requirements);
  const keywords = [];
  const seen = new Set();
  const add = keyword => {
    const normalized = keyword.toLowerCase();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      keywords.push(keyword);
    }
  };
  for (const [term] of text.matchAll(LATIN_TERM)) {
    if (!ENGLISH_STOP_WORDS.has(term.toLowerCase())) add(term);
  }
  let chinese = text.replace(LATIN_TERM, ' ')
    .replace(/\d+(?:\s*[-~至到]\s*\d+)?\s*年(?:及以上|以上|以下)?/g, ' ');
  for (const term of CHINESE_TERMS) {
    if (chinese.includes(term)) {
      add(term);
      chinese = chinese.split(term).join(' ');
    }
  }
  chinese = chinese.replace(GENERIC_CHINESE, ' ')
    .replace(/以及|并且|或者|与|及|和|或/g, ' ');
  for (const [term] of chinese.matchAll(/[\u4e00-\u9fff]{2,12}/g)) add(term);
  return keywords.slice(0, 30);
}

function findEvidence(text, keyword) {
  let index;
  if (/^[a-z]/i.test(keyword)) {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`(^|[^a-z0-9_])(${escaped})(?=$|[^a-z0-9_+#])`, 'i').exec(text);
    index = match ? match.index + match[1].length : -1;
  } else {
    index = text.indexOf(keyword);
  }
  if (index < 0) return null;
  const lineStart = text.lastIndexOf('\n', index) + 1;
  const nextLine = text.indexOf('\n', index);
  const lineEnd = nextLine < 0 ? text.length : nextLine;
  return text.slice(Math.max(lineStart, index - 35), Math.min(lineEnd, index + keyword.length + 70))
    .replace(/\s+/g, ' ').trim();
}

// 该岗位有明确的学历和相关工作年限底线；不能把 JD 中出现的词当成简历证据。
const COST_ACCOUNTING_RUBRIC_VERSION = 2;
// 计算相关年限必须由任职头衔证明，不能因一段合并后的长职责里偶然出现“会计”而算入整段任期。
const RELEVANT_POSITION = /成本(?:核算|会计|管理|分析|控制|经理|主管|专员)|(?:制造业|工厂|生产)(?:财务|会计)|财务(?:成本|制造业)/i;
const COST_PRACTICE = /成本(?:核算|会计|结转|归集|分摊|差异|控制)|制造费用|产品成本|生产成本|标准成本|作业成本|制造业财务|工厂财务/i;
const RUBRIC = [
  { key: 'manufacturing', label: '制造业生产或产品成本', weight: 10,
    pattern: /制造业|工厂|生产成本|产品成本|制造费用|BOM|工艺路线|车间|产线/i },
  { key: 'costMethods', label: '成本方法与差异分析', weight: 10,
    pattern: /标准成本|作业成本|成本差异|本量利|成本分摊|成本归集|目标成本/i },
  { key: 'systems', label: 'ERP、BOM 或 MES', weight: 10,
    pattern: /\bERP\b|\bSAP\b|\bBOM\b|\bMES\b|用友|金蝶/i },
  { key: 'inventoryBudget', label: '存货或预算', weight: 5,
    pattern: /存货|库存|盘点|预算/i },
  { key: 'management', label: '团队、跨部门或汇报', weight: 5,
    pattern: /团队管理|带领团队|管理\d+人|跨部门|管理层汇报|成本分析报告|\bPPT\b/i },
  { key: 'preferred', label: '优先资质', weight: 5,
    pattern: /\bCPA\b|\bCMA\b|中级会计师|六西格玛|精益生产|\bPower BI\b|\bTableau\b/i }
];

function isCostAccountingManagerJD(requirements) {
  const text = String(requirements || '');
  return /成本核算(?:经理|主管)/.test(text.slice(0, 180)) && /本科/.test(text) &&
    /(?:不少于|至少|≥|>=|及以上)?\s*(?:3|三)\s*年/.test(text);
}

function degreeLevel(value) {
  const text = String(value || '');
  if (/博士/.test(text)) return 5;
  if (/硕士|研究生/.test(text)) return 4;
  if (/本科|学士/.test(text)) return 3;
  if (/大专|专科|高职/.test(text)) return 2;
  if (/高中|中专|职高/.test(text)) return 1;
  return 0;
}

function educationEvidence(resume, text) {
  const explicit = String(resume.education || '').trim();
  const history = Array.isArray(resume.educationExperience) ? resume.educationExperience : [];
  const completed = history.map(entry => String(entry?.degree || '')).filter(Boolean);
  const levels = completed.map(degreeLevel).filter(Boolean);
  const explicitLevel = degreeLevel(explicit);
  const highest = Math.max(explicitLevel, ...levels, 0);
  const fallback = text.split('\n').find(line =>
    /学历|教育经历|教育背景|毕业院校/.test(line) && degreeLevel(line));
  const fallbackLevel = fallback ? degreeLevel(fallback) : 0;
  const level = highest || fallbackLevel;
  const evidence = explicit || completed.find(value => degreeLevel(value) === highest) ||
    (fallback ? fallback.replace(/\s+/g, ' ').slice(0, 85) : '');
  if (!level || /在读|肄业|未毕业|未取得/.test(evidence)) {
    return { status: 'unknown', evidence: evidence || '简历未明确写出已取得的最高学历' };
  }
  // 学历栏和教育经历若相互矛盾，保守地交人工核实。
  if (explicitLevel && levels.length && explicitLevel < Math.max(...levels)) {
    return { status: 'unknown', evidence: '学历栏与教育经历的学位信息不一致，需核实' };
  }
  return { status: level >= 3 ? 'met' : 'not_met', evidence: `学历证据：${evidence}` };
}

function monthNumber(year, month) {
  const y = Number(year);
  const m = Number(month || 1);
  return y >= 1950 && y <= new Date().getFullYear() && m >= 1 && m <= 12
    ? y * 12 + m - 1 : null;
}

function monthsFromDuration(value) {
  const match = String(value || '').match(/((?:19|20)\d{2})(?:[.\/-](0?[1-9]|1[0-2]))?\s*(?:-|–|—|~|至|到)\s*((?:19|20)\d{2})(?:[.\/-](0?[1-9]|1[0-2]))?|((?:19|20)\d{2})(?:[.\/-](0?[1-9]|1[0-2]))?\s*(?:-|–|—|~|至|到)\s*(至今|现在|目前)/);
  if (!match) return [];
  const start = monthNumber(match[1] || match[5], match[2] || match[6]);
  const end = match[3] ? monthNumber(match[3], match[4]) :
    new Date().getFullYear() * 12 + new Date().getMonth();
  if (start === null || end === null || end < start || end - start > 600) return [];
  return Array.from({ length: end - start }, (_, index) => start + index);
}

function yearsNumber(value) {
  const text = String(value || '');
  const arabic = text.match(/(\d+(?:\.\d+)?)\s*年/);
  if (arabic) return Number(arabic[1]);
  const digits = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
    六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const chinese = text.match(/([一二两三四五六七八九十])\s*年/);
  return chinese ? digits[chinese[1]] : null;
}

function relevantYearsEvidence(resume, workRecords, text) {
  const months = new Set();
  const totalYears = yearsNumber(resume.workYears || resume.experience);
  for (const record of workRecords) {
    const position = String(record.position || '').trim();
    if (position.length > 40 || /[。；：\n]/.test(position) || !RELEVANT_POSITION.test(position)) continue;
    for (const month of monthsFromDuration(record.duration)) months.add(month);
  }
  if (months.size >= 36) {
    if (totalYears !== null && totalYears < 3) {
      return { status: 'unknown', evidence: '简历总工作年限与岗位任职日期相互矛盾，需核实' };
    }
    return { status: 'met', evidence: `相关财务/成本岗位的可核对任职起止月份合计约 ${(months.size / 12).toFixed(1)} 年（重叠月份只计一次）` };
  }
  const yearToken = '(\\d+(?:\\.\\d+)?|[一二两三四五六七八九十])\\s*年';
  const relevantToken = '(?:成本(?:核算|会计|管理|分析|控制)|(?:制造业|工厂|生产)财务)';
  const joiner = '(?:工作|从业|岗位|相关|实践|经验|\\s){0,8}';
  const direct = new RegExp(`${relevantToken}${joiner}${yearToken}|${yearToken}${joiner}${relevantToken}`, 'ig');
  const explicitYears = [];
  const workStart = text.search(/工作经历|任职经历|职业经历|工作经验/);
  const followingEducation = workStart >= 0 ? text.slice(workStart).search(/\n\s*(?:教育经历|教育背景|学历信息)/) : -1;
  const workSection = workStart < 0 ? '' : text.slice(workStart,
    followingEducation >= 0 ? workStart + followingEducation : workStart + 6000);
  for (const match of workSection.matchAll(direct)) {
    const years = yearsNumber(match[0]);
    if (years !== null && years <= 50) explicitYears.push(years);
  }
  const greatest = Math.max(0, ...explicitYears);
  if (greatest >= 3) return { status: 'met', evidence: `简历明确写出约 ${greatest} 年相关财务/成本经验` };
  if (totalYears !== null && totalYears < 3) {
    return { status: 'not_met', evidence: `简历写出总工作经验 ${totalYears} 年，低于岗位最低 3 年` };
  }
  if (explicitYears.length && greatest < 3 && !months.size) {
    return { status: 'not_met', evidence: `简历明确写出相关经验 ${greatest} 年，低于岗位最低 3 年` };
  }
  return { status: 'unknown', evidence: months.size
    ? `当前可核对的相关岗位任职月份约 ${(months.size / 12).toFixed(1)} 年；其他经历需核实`
    : '未找到不少于 3 年的相关财务/成本岗位任职起止时间或明确年限' };
}

function firstPatternEvidence(text, pattern) {
  const match = pattern.exec(text);
  if (!match) return null;
  const lineStart = text.lastIndexOf('\n', match.index) + 1;
  const lineEnd = text.indexOf('\n', match.index);
  return text.slice(Math.max(lineStart, match.index - 40),
    Math.min(lineEnd < 0 ? text.length : lineEnd, match.index + match[0].length + 75))
    .replace(/\s+/g, ' ').trim();
}

function evaluateCostAccounting(resume, text) {
  const workRecords = Array.isArray(resume.workExperience) ? resume.workExperience : [];
  const workText = removePersonalInformation(workRecords.map(record => {
    const position = String(record.position || '').trim();
    const title = position.length <= 40 && !/[。；：\n]/.test(position) ? position : '';
    return `${title} ${String(record.description || '').slice(0, 300)}`;
  }).join('\n'), resume);
  const evidenceText = `${workText}\n${text}`;
  const education = educationEvidence(resume, text);
  const relatedExperience = relevantYearsEvidence(resume, workRecords, text);
  const workSectionStart = text.search(/工作经历|项目经历|工作内容|职责/);
  const practice = firstPatternEvidence(workText, COST_PRACTICE) ||
    (!workRecords.length && workSectionStart >= 0
      ? firstPatternEvidence(text.slice(workSectionStart), COST_PRACTICE) : null);
  const costAccounting = { status: practice ? 'met' : 'unknown',
    evidence: practice || '工作经历中未找到成本核算或制造业财务的明确证据' };
  const requiredEvidence = { education, relatedExperience, costAccounting };
  const recommendationEligible = Object.values(requiredEvidence).every(gate => gate.status === 'met');
  const recommendationStatus = Object.values(requiredEvidence).some(gate => gate.status === 'not_met')
    ? '不满足最低条件' : recommendationEligible ? '证据满足' : '待核实';
  const strengths = [];
  const gaps = [];
  let score = 0;
  for (const [label, weight, gate] of [
    ['本科及以上学历', 10, education], ['不少于 3 年相关经验', 20, relatedExperience],
    ['成本核算或制造业财务经历', 25, costAccounting]
  ]) {
    if (gate.status === 'met') { score += weight; strengths.push(`${label}：${gate.evidence}`); }
    else gaps.push(`${label}：${gate.evidence}（${gate.status === 'unknown' ? '待核实' : '未达最低条件'}）`);
  }
  for (const criterion of RUBRIC) {
    const quote = firstPatternEvidence(evidenceText, criterion.pattern);
    if (quote) { score += criterion.weight; strengths.push(`${criterion.label}：原文“${quote}”`); }
    else gaps.push(`${criterion.label}：简历未见明确证据，待核实`);
  }
  return { method: 'local', evaluationVersion: COST_ACCOUNTING_RUBRIC_VERSION,
    score, requiredEvidence, recommendationEligible, recommendationStatus,
    strengths, gaps,
    summary: `成本核算经理本机证据评分 ${score}/100；最低条件核对：${recommendationStatus}。分数仅辅助排序，未写明的条件须人工核实。`,
    matchedKeywords: strengths.length, totalKeywords: 9 };
}

function evaluateLocally(resume, requirements) {
  const text = removePersonalInformation(resume.originalText || resume.content, resume);
  if (text.replace(/\s/g, '').length < 20) throw new Error('该简历内容不足，无法可靠评估');
  if (isCostAccountingManagerJD(requirements)) return evaluateCostAccounting(resume, text);
  const keywords = extractKeywords(requirements);
  if (!keywords.length) throw new Error('岗位要求无效：请补充可核对的技能或职责关键词');
  const evidence = keywords.map(keyword => ({ keyword, quote: findEvidence(text, keyword) }));
  const matched = evidence.filter(item => item.quote);
  const missing = evidence.filter(item => !item.quote);
  return {
    method: 'local',
    score: Math.round(matched.length / keywords.length * 100),
    strengths: matched.map(item => `关键词“${item.keyword}”：原文“${item.quote}”`),
    gaps: missing.map(item => `原文未找到“${item.keyword}”的明确证据，请人工核实`),
    summary: `本机关键词覆盖 ${matched.length}/${keywords.length} 项。分数仅表示原文关键词覆盖率，不做语义推断；未提及不代表没有能力，请人工复核。`,
    matchedKeywords: matched.length,
    totalKeywords: keywords.length
  };
}

module.exports = { evaluateLocally, isCostAccountingManagerJD, COST_ACCOUNTING_RUBRIC_VERSION,
  removePersonalInformation };
