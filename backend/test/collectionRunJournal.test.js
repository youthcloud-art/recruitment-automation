const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CollectionRunJournal } = require('../src/services/collectionRunJournal');

test('BOSS run journal survives restart and offers only a new deduplicated run', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-run-journal-'));
  t.after(() => fs.rmSync(directory, {recursive:true,force:true}));
  const file = path.join(directory, 'state.json');
  const signature = 'a'.repeat(64);
  const journal = new CollectionRunJournal(file);
  journal.write({mode:'search',targetCount:34,jobSignature:signature,
    jobTitle:'磁轴销售工程师',status:{state:'running',saved:12,attempted:17,
      maxRuntimeMinutes:90,startedAt:'2026-10-24T00:00:00Z'}});
  const recovered = new CollectionRunJournal(file).interruptedStatus({signature});
  assert.equal(recovered.status, 'paused');
  assert.equal(recovered.collectedCount, 12);
  assert.equal(recovered.targetCount, 34);
  assert.deepEqual(recovered.filters, {position:'磁轴销售工程师'});
  assert.equal(recovered.lastFailureCode, 'BOSS_RUNTIME_RESTARTED');
  assert.equal(recovered.resumeAvailable, false);
  assert.deepEqual(recovered.candidates, []);
  const changed = journal.interruptedStatus({signature:'b'.repeat(64)});
  assert.equal(changed.filters, null);
  assert.equal(changed.lastFailureCode, 'BOSS_JOB_CHANGED');
  journal.clear();
  assert.equal(journal.read(), null);
});

test('completed BOSS run remains complete after backend restart', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-run-journal-'));
  t.after(() => fs.rmSync(directory, {recursive:true,force:true}));
  const journal = new CollectionRunJournal(path.join(directory, 'state.json'));
  const signature = 'c'.repeat(64);
  journal.write({mode:'search',targetCount:6,jobSignature:signature,jobTitle:'项目经理',
    status:{state:'completed',saved:6,maxRuntimeMinutes:90}});
  const recovered = journal.interruptedStatus({signature});
  assert.equal(recovered.status, 'completed');
  assert.equal(recovered.lastFailureCode, '');
});
