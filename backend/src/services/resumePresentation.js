const { candidateName, candidatePosition, hiringJobTitle } = require('../utils/candidateDisplay');
const { platformLocator } = require('../utils/platformLocator');

const SOURCE_NAMES = { boss: 'BOSS直聘', zlzp: '智联招聘', qcwy: '前程无忧' };
const HEADING = /^(?:个人信息|基本信息|求职意向|工作经历|工作经验|教育经历|教育背景|项目经历|项目经验|专业技能|技能特长|自我评价|个人优势|证书|培训经历|语言能力|简历详情)\s*[：:]?$/u;
const CHROME = /^(?:举报|反馈|收藏|联系候选人|查看联系方式|返回列表|上一份|下一份|公司首页|招聘管理|打开候选人记录|查看更多|加载更多)$/u;

function cleanSourceText(value, source = '') {
  let text = String(value || '').replace(/\r\n?/g, '\n')
    .replace(/您可对候选人的在职状态进行相关询问[～~。]?/gu, '')
    .replace(/近\s*\d+\s*天你首次看到该牛人[，,、]?\s*赶紧联系TA吧/gu, '');
  if (source === 'boss') {
    const analysis = text.search(/牛人分析(?:器)?[”"：:]?/u);
    if (analysis >= 0) text = text.slice(0, analysis);
  }
  text = text.replace(/\s+(工作经历|工作经验|教育经历|教育背景|项目经历|项目经验|专业技能|自我评价|求职意向)(?=\s|[：:])/gu,
    '\n$1\n');
  const lines = text
    .replace(/[\u200b-\u200d\ufeff]/g, '').split('\n')
    .map(line => line.replace(/[\t\u00a0]+/g, ' ').trim());
  // Remove only exact platform controls. A company name in work history must survive.
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  // Platform footers often alternate company branding and report controls.
  // Limit removal to the trailing run so employment history in the body stays.
  let footerSeen = false;
  while (lines.length) {
    const last = lines[lines.length - 1];
    const company = /^.{2,50}(?:公司|有限公司)$/u.test(last);
    if (CHROME.test(last)) { footerSeen = true; lines.pop(); continue; }
    if (company && (footerSeen || lines[lines.length - 2] === last)) {
      footerSeen = true; lines.pop(); continue;
    }
    break;
  }
  return lines.join('\n').trim();
}

function splitDenseParagraph(value) {
  const text = value.trim();
  if (text.length <= 180) return [text];
  const phrases = text.match(/[^。！？；;]+[。！？；;]?/gu) || [text];
  const paragraphs = [];
  let current = '';
  for (const phrase of phrases) {
    if (current.length + phrase.length > 170 && current) {
      paragraphs.push(current.trim());
      current = '';
    }
    current += phrase;
  }
  if (current.trim()) paragraphs.push(current.trim());
  return paragraphs;
}

function buildSections(text) {
  const sections = [{ title: '简历内容', paragraphs: [] }];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || CHROME.test(line)) continue;
    if (HEADING.test(line)) {
      sections.push({ title: line.replace(/[：:]$/, ''), paragraphs: [] });
      continue;
    }
    sections[sections.length - 1].paragraphs.push(...splitDenseParagraph(line));
  }
  return sections.filter(section => section.paragraphs.length);
}

function buildResumePresentation(item) {
  const locator = platformLocator(item);
  const text = cleanSourceText(item.originalText || item.content ||
    item.markdownContent || item.parsedContent || '', item.source);
  const name = candidateName(item);
  const metadata = [
    ['招聘岗位', hiringJobTitle(item)],
    ['求职岗位', candidatePosition(item)],
    ['工作经验', item.workYears || item.experience],
    ['学历', typeof item.education === 'string' ? item.education : item.educationLevel],
    ['工作地点', item.location || item.city]
  ].filter(([, value]) => typeof value === 'string' && value.trim() && !/待核实|未填写/.test(value));
  if (item.source === 'qcwy' && locator.id) metadata.push(['前程无忧简历 ID', locator.id]);
  return {
    name, source: SOURCE_NAMES[item.source] || item.source || '简历库',
    metadata, sections: buildSections(text),
    note: item.source === 'boss' && item.parseMethod === 'ocr'
      ? 'BOSS 页面文字经 OCR 提取；请在官方页面核对关键信息。'
      : '根据已保存的简历内容整理排版；原始采集记录保持不变。'
  };
}

function presentationMarkdown(presentation) {
  const lines = [`# ${presentation.name} · 简历`, '', `来源：${presentation.source}`,
    ...presentation.metadata.map(([label, value]) => `${label}：${value}`), ''];
  for (const section of presentation.sections) {
    lines.push(`## ${section.title}`, '', ...section.paragraphs.flatMap(text => [text, '']));
  }
  lines.push(`> ${presentation.note}`);
  return lines.join('\n');
}

module.exports = { cleanSourceText, buildResumePresentation, presentationMarkdown };
