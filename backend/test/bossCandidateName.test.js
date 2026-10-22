const test = require('node:test');
const assert = require('node:assert/strict');
const { verifiedBossOcrName } = require('../src/utils/bossCandidateName');

test('BOSS OCR name requires an explicit matching name label in captured text', () => {
  assert.equal(verifiedBossOcrName('张三', '姓名：张三\n工作经历：网络维护'), '张三');
  assert.equal(verifiedBossOcrName('李四', '个人简介。\n名字: 李四，五年运维经验'), '李四');
  assert.equal(verifiedBossOcrName('张三', '姓名：李四\n工作经历：网络维护'), '');
  assert.equal(verifiedBossOcrName('张三', '张三 28岁\n工作经历：网络维护'), '');
});

test('BOSS OCR name never promotes section headings or fragments to a person', () => {
  assert.equal(verifiedBossOcrName('工作', '工作经历：网络维护\n教育经历：本科'), '');
  assert.equal(verifiedBossOcrName('工作', '姓名：工作\n教育经历：本科'), '');
  assert.equal(verifiedBossOcrName('张三', '姓名：张三某公司负责网络维护'), '');
  assert.equal(verifiedBossOcrName('张', '姓名：张'), '');
});
