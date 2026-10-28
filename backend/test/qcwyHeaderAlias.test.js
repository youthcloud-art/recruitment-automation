const test = require('node:test');
const assert = require('node:assert/strict');
const { qcwyHeaderAlias } = require('../src/utils/qcwyHeaderAlias');
const { publicCandidate } = require('../src/utils/candidateDisplay');

test('51job detail header alias is labeled on historical anonymous records', () => {
  const raw = '活跃时间:2026.10.23\n扫码分享\n蒋先生\n刚刚活跃\n求职意向';
  assert.equal(qcwyHeaderAlias(raw), '蒋先生');
  const record = { source:'qcwy', name:'未识别姓名', id:'record',
    originalText:raw, position:'通知' };
  const visible = publicCandidate(record);
  assert.equal(visible.name, '蒋先生（平台称呼）');
  assert.equal(record.name, '未识别姓名');
});

test('51job alias is not inferred from work history or a navigation label', () => {
  assert.equal(qcwyHeaderAlias('工作经历\n负责服务蒋先生客户\n扫码分享'), '');
  assert.equal(qcwyHeaderAlias('扫码分享\n通知\n刚刚活跃'), '');
});
