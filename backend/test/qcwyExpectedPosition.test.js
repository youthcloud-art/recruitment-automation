const test = require('node:test');
const assert = require('node:assert/strict');
const { extractQcwyExpectedPosition } = require('../src/utils/qcwyExpectedPosition');
const { publicCandidate } = require('../src/utils/candidateDisplay');

test('51job intent line yields the desired role before a city or city list', () => {
  assert.equal(extractQcwyExpectedPosition('求职意向\n\n销售工程师无锡、常州全职8千-1.2万/月\n\n工作经历'),
    '销售工程师');
  assert.equal(extractQcwyExpectedPosition('求职意向\n广州区域销售经理上海全职8千/月\n工作经历'),
    '广州区域销售经理');
  const historical = { source: 'qcwy', name: '未识别姓名', position: '通知',
    originalText: '求职意向\n\n销售工程师无锡、常州全职8千/月\n工作经历' };
  const displayed = publicCandidate(historical);
  assert.equal(displayed.position, '销售工程师');
  assert.equal(displayed.expectedPosition, '销售工程师');
  assert.equal(historical.position, '通知');
});

test('51job intent parser leaves ambiguous or unrelated text for manual review', () => {
  assert.equal(extractQcwyExpectedPosition('求职意向\n销售工程师全职8千/月\n工作经历'), '');
  assert.equal(extractQcwyExpectedPosition('求职意向\n销售工程师上海全职\n工作经历'), '');
  assert.equal(extractQcwyExpectedPosition('通知\n工作经历\n销售工程师'), '');
});
