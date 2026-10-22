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

function candidateName(item) {
  const name = text(item.name);
  if (item.source === 'boss' && item.nameSource === 'ocr' &&
      !verifiedBossOcrName(name, item.originalText)) return '未识别姓名';
  if (item.source === 'qcwy' && (!name || name === '未识别姓名' || isQcwyPageLabel(name))) {
    return `匿名候选人（前程无忧记录 ID：${sourceRecordId(item)}）`;
  }
  return name || '未识别姓名';
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
  if (item.source === 'boss') {
    const name = candidateName(item);
    return name === item.name ? item : { ...item, name };
  }
  if (item.source !== 'qcwy') return item;
  const name = candidateName(item);
  const position = candidatePosition(item);
  let expectedPosition = item.expectedPosition;
  if (isQcwyPageLabel(expectedPosition)) expectedPosition = position;
  else if (expectedPosition && typeof expectedPosition === 'object' &&
      isQcwyPageLabel(expectedPosition.position)) {
    expectedPosition = { ...expectedPosition, position };
  }
  if (name === item.name && position === item.position && expectedPosition === item.expectedPosition) {
    return item;
  }
  return { ...item, name, position, expectedPosition };
}

module.exports = { isQcwyPageLabel, sourceRecordId, candidateName, candidatePosition,
  publicCandidate };
