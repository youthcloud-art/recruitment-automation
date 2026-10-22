// BOSS may show a resume inside a canvas while the surrounding iframe still
// contains navigation, prompts and candidate-card summaries. Length alone is
// not evidence that the text is a resume.
const SECTION_RULES = [
  // Tesseract can separate Chinese heading characters with spaces and confuse
  // 历/厉 or 目/日. Keep the variants narrow: an arbitrary long card summary
  // must not turn into a resume merely because it contains job-related words.
  { key: 'work', heading: /(?:工作|任职|职业|实习|就职)经[历厉]|工作履[历厉]|工作经验/g, minBody: 14 },
  { key: 'project', heading: /项[目日](?:经[历厉]|经验|介绍)/g, minBody: 18 },
  { key: 'skills', heading: /专业技能|技能特长|技术能力|技术栈|技能清单|职业技能/g, minBody: 14 },
  { key: 'education', heading: /教[育肓]经[历厉]|教育背景|教育信息|毕业院校|学历信息/g, minBody: 5 },
  { key: 'summary', heading: /个人优势|自我评价|个人简介|个人总结/g, minBody: 18 },
  { key: 'intent', heading: /求职意向|期望职位|期望岗位/g, minBody: 4 }
];

function normalizeForEvidence(value) {
  // OCR whitespace is not a reliable section delimiter. This string is used
  // only for evidence checks; the original OCR text is stored unchanged.
  return String(value || '').normalize('NFKC')
    .replace(/[\s\u00a0\u200b-\u200d\ufeff]/g, '');
}

function meaningfulLength(value) {
  return value.replace(/[^\p{L}\p{N}]/gu, '').length;
}

function distinctOcrScreens(screens) {
  const accepted = [];
  for (const screen of screens) {
    const text = normalizeForEvidence(screen).toLowerCase()
      .replace(/[^\p{L}\p{N}]/gu, '');
    if (text.length < 80) continue;
    const grams = new Set();
    for (let index = 0; index <= text.length - 5; index++) {
      grams.add(text.slice(index, index + 5));
    }
    const repeated = accepted.some(previous => {
      let shared = 0;
      for (const gram of grams) if (previous.has(gram)) shared++;
      return shared / Math.min(grams.size, previous.size) >= .94;
    });
    if (!repeated) accepted.push(grams);
  }
  return accepted.length;
}

function hasStructuredOcrEvidence(text, {screens, reachedEnd} = {}) {
  // This second path is only for a verified, fully scrolled official resume.
  // OCR can corrupt every section heading while leaving the dated employment
  // history readable. Do not use this path for a card, a single screenshot,
  // an unfinished scroll, or mostly repeated/blank screenshots.
  if (reachedEnd !== true || !Array.isArray(screens) || screens.length < 3 ||
      meaningfulLength(text) < 350 || distinctOcrScreens(screens) < 3) return false;

  const years = new Set(text.match(/(?:19|20)\d{2}/g) || []);
  const dateRange = /(?:19|20)\d{2}(?:年(?:\d{1,2}月?)?|[.\/]\d{1,2})?[-–—~～至到]+(?:(?:19|20)\d{2}|今|现在)/u;
  if (!dateRange.test(text) || years.size < 2) return false;

  const employer = /公司|集团|工厂|事务所|银行|医院|研究院/u.test(text);
  const role = /经理|主管|会计|分析师|工程师|专员|顾问|负责人|财务|成本|运营|运维|开发|设计|销售/u.test(text);
  const education = /本科|大专|专科|硕士|博士|大学|学院|毕业/u.test(text);
  const skills = /熟悉|精通|掌握|技能|能力|系统|ERP|SAP|Excel|报表|预算|服务器/u.test(text);
  const actions = ['负责', '管理', '参与', '实施', '主导', '完成', '制定',
    '优化', '核算', '协助', '维护', '建设', '开发', '分析', '审核']
    .filter(word => text.includes(word)).length;
  return employer && role && education && skills && actions >= 3;
}

function assessBossResumeText(value, options = {}) {
  const text = normalizeForEvidence(value);
  const compactLength = meaningfulLength(text);
  if (compactLength < 60) {
    return { valid: false, reason: '正文少于 60 字', sections: [] };
  }

  const headings = SECTION_RULES.flatMap(rule => {
    const matches = [];
    for (const match of text.matchAll(rule.heading)) {
      matches.push({ key: rule.key, at: match.index, end: match.index + match[0].length,
        minBody: rule.minBody });
    }
    return matches;
  }).sort((a, b) => a.at - b.at);

  const sections = new Set();
  for (let index = 0; index < headings.length; index++) {
    const current = headings[index];
    const next = headings[index + 1];
    const body = text.slice(current.end, next?.at ?? text.length);
    if (meaningfulLength(body) >= current.minBody) sections.add(current.key);
  }

  const careerEvidence = ['work', 'project', 'skills'].some(key => sections.has(key));
  if (!careerEvidence || sections.size < 2) {
    if (hasStructuredOcrEvidence(text, options)) {
      return { valid: true, reason: '', sections: [...sections],
        evidence: 'verified_multiscreen_timeline' };
    }
    return { valid: false, reason: '缺少两段有正文的简历章节及经历或技能',
      sections: [...sections] };
  }
  return { valid: true, reason: '', sections: [...sections] };
}

function isTrustedBossResumeSource(source) {
  return typeof source === 'string' && (
    source.startsWith('.resume-detail-wrap') ||
    ['.resume-content', '.profile-content', '.user-detail',
      '.candidate-detail', '.talent-detail'].includes(source)
  );
}

module.exports = { assessBossResumeText, isTrustedBossResumeSource };
