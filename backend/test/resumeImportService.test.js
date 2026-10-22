const test = require('node:test');
const assert = require('node:assert/strict');
const { ResumeImportService } = require('../src/services/resumeImportService');

const sampleText = '姓名：测试候选人\n工作经验：5年\n技能：Node.js，数据库\n教育背景：本科\n项目经历：参与系统开发。';

function setup() {
  const resumes = [];
  let uploaded = 0;
  let llmCalls = 0;
  const store = {
    getResumeSources: () => [{ value: 'qcwy' }, { value: 'zlzp' }],
    getResumes: () => resumes,
    uploadResumeFile: async () => { uploaded++; return 'local-file'; },
    addResume: async data => {
      const record = { id: `resume-${resumes.length + 1}`, ...data };
      resumes.push(record);
      return record;
    }
  };
  const parser = {
    parsePDFResume: async () => ({ name: '测试候选人', rawText: sampleText }),
    parseDOCXResume: async () => ({ name: '测试候选人', rawText: sampleText }),
    parseResumeText: () => ({ name: '测试候选人' })
  };
  const service = new ResumeImportService({
    store, parser,
    parseWithLLM: async () => { llmCalls++; return { name: '远程解析', parseStatus: 'completed' }; }
  });
  return { service, resumes, get uploaded() { return uploaded; }, get llmCalls() { return llmCalls; } };
}

test('前程无忧 PDF、DOCX、TXT 均在本机解析并以 qcwy 来源入库', async () => {
  for (const extension of ['pdf', 'docx', 'txt']) {
    const state = setup();
    const result = await state.service.importFile({
      originalname: `resume.${extension}`,
      buffer: Buffer.from(sampleText)
    }, { source: 'qcwy', localOnly: false });
    assert.equal(result.duplicate, false);
    assert.equal(result.resume.source, 'qcwy');
    assert.equal(result.resume.originalText, sampleText);
    assert.equal(result.resume.parseMethod, 'local');
    assert.equal(result.llmFallback, false);
    assert.equal(result.parseWarning, null);
    assert.equal(state.llmCalls, 0);
    assert.equal(state.uploaded, 1);
    assert.equal(state.resumes.length, 1);
  }
});

test('相同来源重复上传只保留一条记录', async () => {
  const state = setup();
  const file = { originalname: 'resume.txt', buffer: Buffer.from(sampleText) };
  const first = await state.service.importFile(file, { source: 'qcwy' });
  const second = await state.service.importFile(file, { source: 'qcwy' });
  assert.equal(first.resume.id, second.resume.id);
  assert.equal(second.duplicate, true);
  assert.equal(state.resumes.length, 1);
  assert.equal(state.uploaded, 1);
});

test('拒绝未支持的 DOC 文件且不入库', async () => {
  const state = setup();
  await assert.rejects(() => state.service.importFile({
    originalname: 'resume.doc', buffer: Buffer.from(sampleText)
  }, { source: 'qcwy' }), /仅支持 PDF、DOCX、TXT/);
  assert.equal(state.resumes.length, 0);
  assert.equal(state.uploaded, 0);
});

test('兼容智联现有上传调用使用的中文来源名称', async () => {
  const state = setup();
  const result = await state.service.importFile({
    originalname: 'resume.txt', buffer: Buffer.from(sampleText)
  }, { source: '智联招聘', localOnly: true });
  assert.equal(result.resume.source, 'zlzp');
  assert.equal(state.llmCalls, 0);
});

test('AI 返回失败状态时保留本地解析并提供固定回退提示', async () => {
  const state = setup();
  state.service.parseWithLLM = async () => ({
    parseStatus: 'llm_call_failed', message: 'synthetic-sensitive-service-detail'
  });
  const result = await state.service.importFile({
    originalname: 'resume.txt', buffer: Buffer.from(sampleText)
  }, { source: 'zlzp', localOnly: false });
  assert.equal(result.llmFallback, true);
  assert.equal(result.parseWarning, 'AI 解析未成功，已改用本机解析');
  assert.equal(result.resume.parseMethod, 'local');
  assert.equal(result.resume.parseStatus, 'completed');
  assert.equal(state.resumes.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-sensitive-service-detail/);
});

test('AI 抛出错误时仍可本地入库且不返回服务诊断', async () => {
  const state = setup();
  state.service.parseWithLLM = async () => { throw new Error('synthetic-private-request-details'); };
  const result = await state.service.importFile({
    originalname: 'resume.txt', buffer: Buffer.from(sampleText)
  }, { source: 'zlzp', localOnly: false });
  assert.equal(result.llmFallback, true);
  assert.equal(result.resume.parseMethod, 'local');
  assert.equal(result.resume.parseStatus, 'completed');
  assert.equal(state.uploaded, 1);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-private-request-details/);
});

test('AI 成功解析时不显示本地回退提示', async () => {
  const state = setup();
  const result = await state.service.importFile({
    originalname: 'resume.txt', buffer: Buffer.from(sampleText)
  }, { source: 'zlzp', localOnly: false });
  assert.equal(state.llmCalls, 1);
  assert.equal(result.llmFallback, false);
  assert.equal(result.parseWarning, null);
  assert.equal(result.resume.parseMethod, 'llm');
});
