const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanSourceText, buildResumePresentation, presentationMarkdown } =
  require('../src/services/resumePresentation');

test('三平台简历按保存的正文分段，过滤末尾平台控件而保留真实公司经历', () => {
  for (const source of ['boss', 'zlzp', 'qcwy']) {
    const originalText = '工作经历\n冠泰电子有限公司 销售工程师，负责磁轴产品客户沟通。\n' +
      '教育经历\n惠州学院 本科\n冠泰电子有限公司\n举报\n冠泰电子有限公司\n举报';
    const record = { source, name: '吴女士', captureJobTitle: '磁轴销售工程师',
      originalText };
    const presentation = buildResumePresentation(record);
    assert.equal(presentation.sections[0].title, '工作经历');
    assert.match(presentation.sections[0].paragraphs[0], /冠泰电子有限公司 销售工程师/);
    assert.equal(presentation.sections[1].title, '教育经历');
    const markdown = presentationMarkdown(presentation);
    assert.match(markdown, /惠州学院 本科/);
    assert.doesNotMatch(markdown, /举报/);
    assert.equal(record.originalText, originalText);
  }
});

test('单个真实公司名称不被误删，长段落仅分段不改写事实', () => {
  const text = '项目经历\n' + '负责客户沟通。'.repeat(40) + '\n某某电子有限公司';
  assert.match(cleanSourceText(text), /某某电子有限公司$/);
  const presentation = buildResumePresentation({ name: '候选人', originalText: text });
  assert.ok(presentation.sections[0].paragraphs.length > 1);
  assert.match(presentationMarkdown(presentation), /负责客户沟通/);
});
