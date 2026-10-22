const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {BossCardQuarantine,TTL_MS}=require('../src/services/bossCardQuarantine');

test('BOSS timeout quarantine persists only hashed per-job metadata and expires in 24 hours', t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boss-card-quarantine-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  let now=Date.parse('2026-10-21T00:00:00.000Z');
  const file=path.join(dir,'quarantine.json');
  const first=new BossCardQuarantine({file,now:()=>now});
  const hash='a'.repeat(64);
  first.mark('job-1',hash,'BOSS_CDP_TIMEOUT');
  const stored=JSON.parse(fs.readFileSync(file,'utf8'));
  assert.deepEqual(Object.keys(stored).sort(),['entries','version']);
  assert.deepEqual(Object.keys(stored.entries[0]).sort(),
    ['cardFingerprint','failedAt','failureCode','jobId']);
  assert.equal(stored.entries[0].cardFingerprint,hash);
  assert.equal(stored.entries[0].jobId,'job-1');
  assert.equal(stored.entries[0].failureCode,'BOSS_CDP_TIMEOUT');
  assert.equal(first.has('job-1',hash),true);
  assert.equal(first.has('job-2',hash),false);
  assert.equal(first.has('job-1','b'.repeat(64)),false);
  const restarted=new BossCardQuarantine({file,now:()=>now});
  assert.equal(restarted.has('job-1',hash),true);
  now += TTL_MS;
  assert.equal(restarted.has('job-1',hash),false);
  assert.deepEqual(restarted.summary(),{count:0,ttlHours:24});
  assert.equal(restarted.clear(),1);
  assert.equal(fs.existsSync(file),false);
});

test('BOSS timeout quarantine rejects candidate text and malformed persisted records', t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boss-card-quarantine-invalid-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'quarantine.json');
  const quarantine=new BossCardQuarantine({file});
  assert.throws(()=>quarantine.mark('job-1','candidate name','BOSS_CDP_TIMEOUT'),
    {code:'BOSS_CARD_QUARANTINE_INVALID'});
  assert.throws(()=>quarantine.mark('job-1','a'.repeat(64),'BOSS_CDP_CLICK_UNCERTAIN'),
    {code:'BOSS_CARD_QUARANTINE_INVALID'});
  fs.writeFileSync(file,JSON.stringify({version:1,entries:[{
    jobId:'job-1',cardFingerprint:'a'.repeat(64),
    failureCode:'BOSS_CDP_TIMEOUT',failedAt:new Date().toISOString(),
    candidateName:'must not persist'
  }]}));
  assert.throws(()=>quarantine.has('job-1','a'.repeat(64)),
    {code:'BOSS_CARD_QUARANTINE_INVALID'});
  assert.equal(quarantine.clear(),0);
  assert.equal(fs.existsSync(file),false);
});
