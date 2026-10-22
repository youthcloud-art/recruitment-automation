const test = require('node:test');
const assert = require('node:assert/strict');
const mammoth = require('mammoth');
const JSZip = require('jszip');
const { markdownToDocx } = require('../src/services/candidateReportDocx');

test('Word 初筛报告保留筛选信息、候选人表格与人工复核提示', async () => {
  const markdown = [
    '# 候选人初筛报告', '',
    '生成时间：2026/10/20 10:00',
    '候选人数量：1', '',
    '## 本次岗位要求',
    '成本核算经理，负责制造业成本分析。', '',
    '| 序号 | 平台 | 候选人 | 岗位 | 匹配分 | 评估摘要 |',
    '| ---: | --- | --- | --- | ---: | --- |',
    '| 1 | 前程无忧 | 候选人甲 | 成本核算经理 | 86 | 成本核算经验相关 |', '',
    '## 岗位匹配评估明细', '',
    '### 候选人 1', '',
    '相关优势：',
    '- 制造业成本分析', '',
    '待核实点：',
    '- 需确认系统实施经验', '',
    '> 岗位匹配仅供人工复核。简历内容见附件。'
  ].join('\n');
  const buffer = await markdownToDocx(markdown);
  assert.equal(buffer.subarray(0, 2).toString(), 'PK');
  const result = await mammoth.extractRawText({ buffer });
  for (const expected of ['候选人初筛报告', '成本核算经理', '前程无忧', '候选人甲',
    '86', '制造业成本分析', '需确认系统实施经验', '岗位匹配仅供人工复核']) {
    assert.match(result.value, new RegExp(expected));
  }
  assert.doesNotMatch(result.value, /\| ---/);
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file('word/document.xml').async('string');
  assert.equal((xml.match(/<w:cantSplit\s*\/>/g) || []).length, 2,
    'table header and candidate row must each stay on one page');
});

test('Word 报告拒绝过长或非文本输入', async () => {
  await assert.rejects(markdownToDocx(null), /报告内容无效/);
  await assert.rejects(markdownToDocx('x'.repeat(300001)), /报告内容无效/);
});
