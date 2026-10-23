const test = require('node:test');
const assert = require('node:assert/strict');
const { candidateName, candidatePosition, sourceRecordId, publicCandidate,
  publicCandidateSummary, hiringJobTitle } =
  require('../src/utils/candidateDisplay');

test('51job page chrome is shown as an anonymous stable source record, without changing the record', () => {
  const item = { id: 'local-id', source: 'qcwy', name: '通知', position: '通知',
    sourceRecordKey: 'a'.repeat(64), originalText: '通知\n工作经历：网络运维' };
  const snapshot = JSON.stringify(item);
  assert.equal(sourceRecordId(item), 'a'.repeat(16));
  assert.equal(candidateName(item), `匿名候选人（前程无忧记录 ID：${'a'.repeat(16)}）`);
  assert.equal(candidatePosition(item), '求职岗位待核实');
  const publicView = publicCandidate(item);
  assert.equal(publicView.name, '姓名待核实');
  assert.equal(publicView.position, '求职岗位待核实');
  assert.equal(publicView.originalText, item.originalText);
  assert.equal(publicView.platformRecordId, 'a'.repeat(16));
  assert.equal(JSON.stringify(item), snapshot);
});

test('a genuine desired position is preferred over corrupted page chrome', () => {
  assert.equal(candidatePosition({ source: 'qcwy', position: '通知',
    expectedPosition: { position: '网络运维' } }), '网络运维');
  assert.equal(candidateName({ source: 'qcwy', name: '张三' }), '张三');
  assert.equal(candidateName({ source: 'qcwy', name: '董先生', nameSource: 'qcwy_card' }),
    '董先生（平台称呼）');
  assert.equal(candidateName({ source: 'qcwy', id: 'fallback-id', name: '未识别姓名' }),
    '匿名候选人（前程无忧记录 ID：fallback-id）');
  const parsed = { source: 'qcwy', id: 'fallback-id', name: '未识别姓名',
    position: '通知', expectedPosition: { position: '通知', city: '上海' } };
  const displayed = publicCandidate(parsed);
  assert.equal(displayed.expectedPosition.position, '求职岗位待核实');
  assert.equal(displayed.expectedPosition.city, '上海');
  assert.equal(parsed.expectedPosition.position, '通知');
});

test('hiring job stays separate from candidate desired position and list omits full text', () => {
  const item = { id: 'record-1', source: 'qcwy', name: '未识别姓名',
    position: '销售代表', captureJobRequirements: '岗位名称：磁轴销售工程师\n工作地点：惠州',
    originalText: '完整简历原文', parsedContent: '解析正文' };
  const view = publicCandidate(item);
  assert.equal(hiringJobTitle(item), '磁轴销售工程师');
  assert.equal(view.hiringJobTitle, '磁轴销售工程师');
  assert.equal(view.position, '销售代表');
  assert.equal(view.originalText, item.originalText);
  const list = publicCandidateSummary(item);
  assert.equal(list.originalText, undefined);
  assert.equal(list.parsedContent, '解析正文');
  assert.equal(list.hiringJobTitle, '磁轴销售工程师');
  assert.equal(publicCandidateSummary({ ...item, matchEvaluation: { summary: '完整评分' } },
    { view: 'library' }).matchEvaluation, undefined);
  assert.equal(item.originalText, '完整简历原文');
});

test('historical BOSS OCR first-line guesses are hidden without rewriting resume evidence', () => {
  const item = { source: 'boss', name: '工作', nameSource: 'ocr',
    originalText: '工作经历：负责网络巡检。\n教育经历：本科。' };
  const original = JSON.stringify(item);
  assert.equal(candidateName(item), '未识别姓名');
  const displayed = publicCandidate(item);
  assert.equal(displayed.name, '未识别姓名');
  assert.equal(displayed.originalText, item.originalText);
  assert.equal(JSON.stringify(item), original);
  assert.equal(candidateName({ ...item, name: '张三',
    originalText: '姓名：张三\n工作经历：负责网络巡检。' }), '张三');
  assert.equal(candidateName({ ...item, name: '张三',
    nameSource: 'boss_search_card' }), '张三');
});

test('numeric and opaque platform IDs are never displayed as candidate names', () => {
  assert.equal(publicCandidate({ source: 'zlzp', name: '1234567890' }).name, '未识别姓名');
  assert.equal(publicCandidate({ source: 'boss', name: 'af03dc91b01e' }).name, '未识别姓名');
  assert.equal(publicCandidate({ source: 'qcwy', id: 'record-2', name: 'ID:12ab34cd' }).name,
    '姓名待核实');
});
