const test = require('node:test');
const assert = require('node:assert/strict');
const { PostCaptureEvaluationQueue } = require('../src/services/postCaptureEvaluationQueue');
const { ZhilianResumeCollector } = require('../src/services/zhilianResumeCollector');
const { RecruitmentPipelineService } = require('../src/services/recruitmentPipelineService');
const { CandidateEmailService } = require('../src/services/candidateEmailService');

const JOB = Object.freeze({ title: '成本核算经理', jobRequirements: '熟悉制造业成本核算和财务分析',
  updatedAt: '2026-10-20T00:00:00.000Z' });

function fakeStore(items = []) {
  const records = new Map(items.map(item => [item.id, { ...item }]));
  return {
    records,
    getResumes: () => [...records.values()],
    getResumeById: id => records.get(id) || null,
    updateCandidateMetadata(id, changes) {
      const value = records.get(id);
      if (!value) return null;
      Object.assign(value, changes);
      return value;
    }
  };
}

test('new resume evaluation is background work with the captured job snapshot', async () => {
  const store = fakeStore([{ id: 'a', source: 'zlzp' }]);
  const seen = [];
  const queue = new PostCaptureEvaluationQueue({ store,
    evaluate: async (id, requirements) => {
      seen.push([id, requirements]);
      store.updateCandidateMetadata(id, { matchEvaluation: { score: 80 }, matchScore: 80 });
    } });
  const job = { ...JOB };
  assert.deepEqual(queue.enqueue(store.getResumeById('a'), job), { queued: true });
  job.jobRequirements = '中途改成了其他岗位';
  assert.equal(queue.status().queued, 1);
  await queue.whenIdle();
  assert.deepEqual(seen, [['a', JOB.jobRequirements]]);
  assert.equal(store.getResumeById('a').matchEvaluationStatus, 'completed');
  assert.equal(store.getResumeById('a').matchEvaluationJobTitle, JOB.title);
  assert.equal(queue.status().completed, 1);
});

test('missing job, duplicates and already evaluated resumes do not invoke the model', async () => {
  const store = fakeStore([{ id: 'a', source: 'boss' },
    { id: 'b', source: 'boss', matchScore: 70,
      matchEvaluation: { score: 70, jobRequirements: JOB.jobRequirements,
        method: 'llm', evaluationVersion: 1, evaluatedAt: JOB.updatedAt } }]);
  let calls = 0;
  const queue = new PostCaptureEvaluationQueue({ store, evaluate: async () => { calls++; } });
  assert.equal(queue.enqueue(store.getResumeById('a'), {}).reason, 'no_active_job');
  assert.equal(queue.enqueue(store.getResumeById('b'), JOB).reason, 'already_evaluated_or_queued');
  assert.deepEqual(queue.enqueue(store.getResumeById('a'), JOB), { queued: true });
  assert.equal(queue.enqueue(store.getResumeById('a'), JOB).reason, 'already_evaluated_or_queued');
  await queue.whenIdle();
  assert.equal(calls, 1);
});

test('a BOSS resume with complete OCR is evaluated again for a different job and enters that report', async () => {
  const oldRequirements = '熟悉网络设备维护和 Linux 运维';
  const store = fakeStore([{ id: 'existing-boss', source: 'boss', name: '候选人甲',
    originalText: '曾负责制造企业的成本核算、ERP 月结及成本差异分析。',
    matchScore: 86, matchEvaluationStatus: 'completed',
    matchEvaluation: { score: 86, jobRequirements: oldRequirements,
      method: 'llm', evaluationVersion: 1, evaluatedAt: JOB.updatedAt } }]);
  const calls = [];
  const queue = new PostCaptureEvaluationQueue({ store,
    evaluate: async (id, requirements) => {
      calls.push([id, requirements]);
      store.updateCandidateMetadata(id, { matchScore: 75,
        matchEvaluation: { score: 75, jobRequirements: requirements,
          method: 'llm', evaluationVersion: 1,
          evaluatedAt: new Date().toISOString(), summary: '符合成本岗位要求' } });
    } });
  const pipeline = new RecruitmentPipelineService({ store,
    activeJobService: { current: () => JOB } });
  const email = new CandidateEmailService({ pipeline });
  const mailSelection = { source: 'boss', jobRequirements: JOB.jobRequirements,
    minScore: 70, topN: 10, reportFormat: 'docx' };
  assert.match(pipeline.report({ source: 'boss' }), /符合条件：0 份/);
  assert.equal((await email.preview(mailSelection)).count, 0);
  assert.deepEqual(queue.enqueue(store.getResumeById('existing-boss'), JOB), { queued: true });
  await queue.whenIdle();
  assert.deepEqual(calls, [['existing-boss', JOB.jobRequirements]]);
  assert.equal(store.records.size, 1);
  assert.equal(store.getResumeById('existing-boss').matchEvaluationJobTitle, JOB.title);
  assert.match(pipeline.report({ source: 'boss' }), /符合条件：1 份/);
  assert.equal((await email.preview(mailSelection)).count, 1);
  assert.equal(queue.enqueue(store.getResumeById('existing-boss'), JOB).reason,
    'already_evaluated_or_queued');
});

test('queue capacity and model errors preserve saved records and expose failure', async () => {
  const store = fakeStore([{ id: 'a', source: 'boss' }, { id: 'b', source: 'zlzp' }]);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const queue = new PostCaptureEvaluationQueue({ store, capacity: 1,
    evaluate: async () => { await gate; throw new Error('模型暂不可用'); },
    log: { warn: () => {} } });
  assert.equal(queue.enqueue(store.getResumeById('a'), JOB).queued, true);
  assert.equal(queue.enqueue(store.getResumeById('b'), JOB).reason, 'queue_full');
  assert.equal(store.getResumeById('b').matchEvaluationStatus, 'failed');
  release();
  await queue.whenIdle();
  assert.equal(store.getResumeById('a').matchEvaluationStatus, 'failed');
  assert.match(store.getResumeById('a').matchEvaluationError, /模型暂不可用/);
  assert.equal(store.records.size, 2);
  assert.equal(queue.status().failed, 1);
  assert.equal(queue.status().overflowed, 1);
});

test('智联 collector only queues a newly created resume', async () => {
  const records = [];
  const enqueued = [];
  const collector = new ZhilianResumeCollector({
    llmService: { chatWithLLM: async () => '{"name":"候选人甲","expectedPosition":"成本核算经理"}' },
    resumeStore: {
      getResumes: () => records,
      addResume: async value => {
        const resume = { ...value, id: 'new-1' };
        records.push(resume);
        return { resume, created: true };
      }
    },
    evaluationQueue: { enqueue: (resume, job) => enqueued.push([resume.id, job.jobRequirements]) }
  });
  const captured = { text: '候选人甲：从事制造业成本核算五年，负责预算与财务分析。',
    url: 'https://rd.zhaopin.com/app/search?resumeNumber=test-001', title: '智联招聘' };
  assert.equal((await collector.save(captured, JOB)).saved, true);
  assert.equal((await collector.save(captured, JOB)).duplicate, true);
  assert.deepEqual(enqueued, [['new-1', JOB.jobRequirements]]);
});

test('智联保存成功后队列故障不会使采集失败', async () => {
  const collector = new ZhilianResumeCollector({
    llmService: { chatWithLLM: async () => '{"name":"候选人乙"}' },
    resumeStore: {
      getResumes: () => [],
      addResume: async value => ({ resume: { ...value, id: 'new-2' }, created: true })
    },
    evaluationQueue: { enqueue: () => { throw new Error('queue unavailable'); } }
  });
  const result = await collector.save({ text: '候选人乙：负责制造业成本核算。',
    url: 'https://rd.zhaopin.com/app/search?resumeNumber=test-002', title: '智联招聘' }, JOB);
  assert.equal(result.saved, true);
  assert.equal(result.resume.id, 'new-2');
});

test('closing the queue drains accepted work and rejects new work', async () => {
  const store = fakeStore([{ id: 'a', source: 'boss' }]);
  let calls = 0;
  const queue = new PostCaptureEvaluationQueue({ store, evaluate: async () => { calls++; } });
  queue.enqueue(store.getResumeById('a'), JOB);
  await queue.close();
  assert.equal(calls, 1);
  assert.equal(queue.status().closed, true);
  assert.equal(queue.enqueue({ id: 'b', source: 'boss' }, JOB).reason, 'queue_closed');
});

test('DeepSeek 一次 JSON 语法错误后重新生成，队列只记录一次成功', async () => {
  const store = fakeStore([{ id: 'retry-success', source: 'zlzp',
    originalText: '在制造企业负责成本核算、存货盘点、月度结账和差异分析，熟悉 ERP 系统并参与年度预算编制。' }]);
  let calls = 0;
  const pipeline = new RecruitmentPipelineService({ store, llmFactory: () => ({
    chatWithLLM: async messages => {
      calls++;
      if (calls === 1) return '{"score":82,"strengths":["成本核算" "ERP"],"gaps":[],"summary":"基本匹配"}';
      assert.match(messages[0].content, /JSON 语法有误/);
      return '{"score":82,"strengths":["成本核算","ERP"],"gaps":[],"summary":"基本匹配"}';
    }
  }) });
  const queue = new PostCaptureEvaluationQueue({ store,
    evaluate: (id, requirements) => pipeline.evaluate(id, requirements) });
  queue.enqueue(store.getResumeById('retry-success'), JOB);
  await queue.whenIdle();
  assert.equal(calls, 2);
  assert.equal(store.records.size, 1);
  assert.equal(store.getResumeById('retry-success').matchScore, 82);
  assert.equal(store.getResumeById('retry-success').matchEvaluationStatus, 'completed');
  assert.equal(queue.status().completed, 1);
  assert.equal(queue.status().failed, 0);
});

test('DeepSeek 连续返回非法 JSON 后停止重试，保留简历并如实标记失败', async () => {
  const store = fakeStore([{ id: 'retry-failed', source: 'zlzp',
    originalText: '在制造企业负责成本核算、存货盘点、月度结账和差异分析，熟悉 ERP 系统并参与年度预算编制。' }]);
  let calls = 0;
  const pipeline = new RecruitmentPipelineService({ store, llmFactory: () => ({
    chatWithLLM: async () => {
      calls++;
      return '{"score":82,"strengths":["成本核算" "ERP"],"gaps":[],"summary":"基本匹配"}';
    }
  }) });
  const queue = new PostCaptureEvaluationQueue({ store, log: { warn: () => {} },
    evaluate: (id, requirements) => pipeline.evaluate(id, requirements) });
  queue.enqueue(store.getResumeById('retry-failed'), JOB);
  await queue.whenIdle();
  assert.equal(calls, 2);
  assert.equal(store.records.size, 1);
  assert.equal(store.getResumeById('retry-failed').matchEvaluation, undefined);
  assert.equal(store.getResumeById('retry-failed').matchEvaluationStatus, 'failed');
  assert.equal(queue.status().completed, 0);
  assert.equal(queue.status().failed, 1);
});

test('402 暂停自动评估队列，已入库与后续简历均保留待补评且只调用一次模型', async () => {
  const records = ['a', 'b', 'c', 'd'].map(id => ({ id, source: 'zlzp' }));
  const store = fakeStore(records);
  let calls = 0;
  const queue = new PostCaptureEvaluationQueue({ store, log: { warn: () => {} },
    evaluate: async () => {
      calls++;
      throw Object.assign(new Error('Payment Required'), { httpStatus: 402 });
    } });
  for (const id of ['a', 'b', 'c']) assert.equal(queue.enqueue(store.getResumeById(id), JOB).queued, true);
  await queue.whenIdle();
  assert.equal(calls, 1);
  assert.equal(queue.status().paused, true);
  assert.equal(queue.status().pauseCode, 'LLM_BILLING_REQUIRED');
  assert.equal(queue.status().queued, 0);
  assert.equal(queue.status().deferred, 3);
  assert.equal(queue.enqueue(store.getResumeById('d'), JOB).reason, 'llm_unavailable');
  assert.equal(queue.status().deferred, 4);
  for (const record of store.records.values()) {
    assert.equal(record.matchEvaluation, undefined);
    assert.equal(record.matchEvaluationStatus, 'pending');
    assert.match(record.matchEvaluationError, /需检查余额\/计费/);
  }
  queue.resume();
  assert.equal(queue.status().paused, false);
  assert.equal(store.records.size, 4);
});
