// A 51job page may include navigation text before the actual resume. Historic
// captures treated the navigation label "通知" as both the person's name and
// their desired position. Keep stored evidence intact, but never present that
// label as a verified identity or role.
const QCWY_PAGE_LABELS = new Set(['通知']);
const { verifiedBossOcrName } = require('./bossCandidateName');
const { extractQcwyExpectedPosition } = require('./qcwyExpectedPosition');
const { qcwyHeaderAlias } = require('./qcwyHeaderAlias');

function text(value) {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

function isQcwyPageLabel(value) {
  return QCWY_PAGE_LABELS.has(text(value));
}

function zhilianHeaderAlias(value) {
  const first = String(value || '').split(/\r?\n/).map(part => part.trim()).find(Boolean) || '';
  // A recruiter-visible honorific is useful context, but it is not a
  // verified full name. Read only the resume header, never page chrome.
  return /^(?:[A-Z]|[\u4e00-\u9fff]{1,2})(?:先生|女士|小姐)$/.test(first) ? first : '';
}

function sourceRecordId(item) {
  const key = text(item.sourceRecordKey);
  if (/^[a-f0-9]{64}$/i.test(key)) return key.slice(0, 16);
  return text(item.id) || '待核实';
}

function jobTitleFromRequirements(value) {
  const match = String(value || '').match(/(?:^|\n)\s*(?:岗位名称|招聘岗位|目标岗位|职位名称)\s*[:：]\s*([^\r\n，,。；;]{2,80})/);
  return match ? match[1].trim() : '';
}

function hiringJobTitle(item) {
  return text(item.captureJobTitle) || jobTitleFromRequirements(item.captureJobRequirements) ||
    jobTitleFromRequirements(item.matchEvaluation?.jobRequirements) || '招聘岗位待核实';
}

function candidateName(item) {
  const name = text(item.name);
  const idLike = /^(?:\d{5,}|[a-f\d-]{8,}|(?:id|编号|候选人编号)\s*[:：]?\s*[a-z\d-]{4,})$/i.test(name);
  const alias = text(item.platformAlias);
  const bossAlias = item.source === 'boss' && (
    (item.platformAliasType === 'masked' && /^[\u4e00-\u9fff]{1,2}\*{1,3}$/.test(alias)) ||
    (item.platformAliasType === 'honorific' &&
      /^[\u4e00-\u9fff]{1,2}(?:先生|女士|小姐|同学)$/.test(alias)))
    ? `${alias}（${item.platformAliasType === 'masked' ? '平台脱敏' : '平台称呼'}）` : '';
  if (item.source === 'boss' && item.nameSource === 'ocr' &&
      !verifiedBossOcrName(name, item.originalText)) return bossAlias || '未识别姓名';
  if (item.source === 'qcwy' && (!name || name === '未识别姓名' || isQcwyPageLabel(name) || idLike)) {
    const alias = qcwyHeaderAlias(item.originalText);
    return alias ? `${alias}（平台称呼）` :
      `匿名候选人（前程无忧记录 ID：${sourceRecordId(item)}）`;
  }
  if (item.source === 'qcwy' && /(?:先生|女士|同学)$/.test(name)) {
    return `${name}（平台称呼）`;
  }
  if (item.source === 'zlzp' && /^(?:[A-Z]|[\u4e00-\u9fff]{1,2})(?:先生|女士|小姐)$/.test(name)) {
    return `${name}（平台称呼）`;
  }
  if (item.source === 'zlzp' && (idLike || !name || name === '未识别姓名')) {
    const alias = zhilianHeaderAlias(item.originalText);
    return alias ? `${alias}（平台称呼）` : '未识别姓名';
  }
  return idLike || !name || name === '未识别姓名'
    ? bossAlias || '未识别姓名' : name;
}

function candidatePosition(item) {
  const expected = text(item.expectedPosition?.position) || text(item.expectedPosition);
  const stored = text(item.position);
  const position = item.source === 'qcwy' && isQcwyPageLabel(stored) ? expected : stored || expected;
  if (item.source === 'qcwy' && (!position || isQcwyPageLabel(position))) {
    return extractQcwyExpectedPosition(item.originalText) || '求职岗位待核实';
  }
  return position;
}

function publicCandidate(item) {
  if (!item) return item;
  const common = { ...item, hiringJobTitle: hiringJobTitle(item) };
  if (item.source === 'boss') {
    const name = candidateName(item);
    return { ...common, name };
  }
  if (item.source === 'zlzp') return { ...common, name: candidateName(item) };
  if (item.source !== 'qcwy') return common;
  const name = candidateName(item).startsWith('匿名候选人（前程无忧记录 ID：')
    ? '姓名待核实' : candidateName(item);
  const position = candidatePosition(item);
  let expectedPosition = item.expectedPosition;
  if (!expectedPosition || isQcwyPageLabel(expectedPosition)) expectedPosition = position;
  else if (expectedPosition && typeof expectedPosition === 'object' &&
      (!expectedPosition.position || isQcwyPageLabel(expectedPosition.position))) {
    expectedPosition = { ...expectedPosition, position };
  }
  return { ...common, platformRecordId: sourceRecordId(item),
    name, position, expectedPosition };
}

function publicCandidateSummary(item, { view = 'pipeline' } = {}) {
  const { originalText, content, rawText, ...summary } = publicCandidate(item);
  if (view === 'library') delete summary.matchEvaluation;
  return summary;
}

module.exports = { isQcwyPageLabel, sourceRecordId, candidateName, candidatePosition,
  jobTitleFromRequirements, hiringJobTitle, publicCandidate, publicCandidateSummary };
