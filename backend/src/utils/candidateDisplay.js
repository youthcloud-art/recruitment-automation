// A 51job page may include navigation text before the actual resume. Historic
// captures treated the navigation label "通知" as both the person's name and
// their desired position. Keep stored evidence intact, but never present that
// label as a verified identity or role.
const QCWY_PAGE_LABELS = new Set(['通知']);
const { verifiedBossOcrName } = require('./bossCandidateName');

function text(value) {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

function isQcwyPageLabel(value) {
  return QCWY_PAGE_LABELS.has(text(value));
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
  if (item.source === 'boss' && item.nameSource === 'ocr' &&
      !verifiedBossOcrName(name, item.originalText)) return '未识别姓名';
  if (item.source === 'qcwy' && (!name || name === '未识别姓名' || isQcwyPageLabel(name) || idLike)) {
    return `匿名候选人（前程无忧记录 ID：${sourceRecordId(item)}）`;
  }
  if (item.source === 'qcwy' && /(?:先生|女士|同学)$/.test(name)) {
    return `${name}（平台称呼）`;
  }
  return idLike ? '未识别姓名' : name || '未识别姓名';
}

function candidatePosition(item) {
  const expected = text(item.expectedPosition?.position) || text(item.expectedPosition);
  const stored = text(item.position);
  const position = item.source === 'qcwy' && isQcwyPageLabel(stored) ? expected : stored || expected;
  if (item.source === 'qcwy' && (!position || isQcwyPageLabel(position))) return '求职岗位待核实';
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
  if (isQcwyPageLabel(expectedPosition)) expectedPosition = position;
  else if (expectedPosition && typeof expectedPosition === 'object' &&
      isQcwyPageLabel(expectedPosition.position)) {
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
