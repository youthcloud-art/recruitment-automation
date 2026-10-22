const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

test('BOSS route uses raw login and exact-job recommendation collection without legacy attach', async () => {
  const servicePath = require.resolve('../src/services/bossZhipinService');
  const collectorPath = require.resolve('../src/services/bossRawRecommendCollector');
  const searchCollectorPath = require.resolve('../src/services/bossRawSearchCollector');
  const cdpPath = require.resolve('../src/services/bossRawCdp');
  const navigationPath = require.resolve('../src/services/bossOfficialSearchNavigation');
  const visiblePath = require.resolve('../src/services/visibleChromeCdp');
  const jobPath = require.resolve('../src/services/activeJobService');
  const quarantinePath = require.resolve('../src/services/bossCardQuarantine');
  const routePath = require.resolve('../src/routes/bossZhipin');
  const originals = new Map([servicePath,collectorPath,searchCollectorPath,cdpPath,navigationPath,visiblePath,jobPath,
    quarantinePath,routePath]
    .map(path => [path,require.cache[path]]));
  let legacyLoginCalls = 0;
  let rawLoginCalls = 0;
  let searchNavigationCalls = 0;
  let loginHold = null;
  let releaseHeldLogin = null;
  let quarantineCount = 2;
  let liveCollector;
  class FakeService {
    constructor() { this.currentStatus = 'waiting_login'; this.isLoggedIn = false; }
    async initializeFullProcess() {}
    getCurrentStatus() { return {status:this.currentStatus,isLoggedIn:this.isLoggedIn,
      hasBrowser:true,hasPage:true}; }
    async checkLoginStatus() { legacyLoginCalls++; throw new Error('legacy attach forbidden'); }
    async closeBrowser() {}
  }
  class FakeCollector {
    constructor() { liveCollector = this;
      this.status = {state:'idle',saved:0,attempted:0,skipped:0,scrollRounds:0}; }
    collect({targetCount,maxRuntimeMs,resume}) {
      this.requestedMaxRuntimeMs=maxRuntimeMs;
      this.requestedResume=resume;
      this.status = {...this.status,state:'running',targetCount};
      return new Promise(resolve => { this.finish = resolve; });
    }
    stop() { this.status.state='stopped'; this.finish?.(this.status); }
    getStatus() { return this.status; }
    canResume() { return this.status.state==='paused' &&
      this.status.lastFailureCode==='BOSS_VERIFICATION_REQUIRED'; }
    getResumeInfo() { return this.canResume() ? {mode:'search',
      filters:{position:'成本核算经理'},targetCount:500,maxRuntimeMinutes:180} : null; }
    validateResumeRequest({job,targetCount,runtimeLimitMs}) {
      if (job.title!=='成本核算经理' || targetCount!==500 ||
          runtimeLimitMs!==180*60_000) throw new Error('断点岗位或时间不一致');
    }
  }
  const stubs = new Map([
    [servicePath,FakeService],
    [collectorPath,{BossRawRecommendCollector:FakeCollector}],
    [searchCollectorPath,{BossRawSearchCollector:FakeCollector}],
    [cdpPath,{connectOwnedBossPage:async () => {
      rawLoginCalls++;
      if (loginHold) {
        loginHold.enter();
        await loginHold.promise;
      }
      return {async assertRecruiterReady() {},close() {}};
    }}],
    [navigationPath,{ensureOfficialSearchPage:async () => { searchNavigationCalls++; }}],
    [visiblePath,{getCdpTabs:async () => [{url:'https://www.zhipin.com/web/chat/recommend'}]}],
    [quarantinePath,{BossCardQuarantine:class {
      summary() {return {count:quarantineCount,ttlHours:24};}
      clear() {const count=quarantineCount;quarantineCount=0;return count;}
    }}],
    [jobPath,{ActiveJobService:class {current() {return {
      title:'成本核算经理',searchKeywords:'成本核算经理',jobRequirements:'成本核算经验三年以上'
    };}}}]
  ]);
  for (const [path,exports] of stubs) require.cache[path] = {
    id:path,filename:path,loaded:true,exports
  };
  delete require.cache[routePath];
  const router = require('../src/routes/bossZhipin');
  const app = express();
  app.use(express.json());
  app.use('/api/boss-zhipin',router);
  const server = await new Promise(resolve => {
    const opened = app.listen(0,'127.0.0.1',() => resolve(opened));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/boss-zhipin`;
  const post = async (path,body={}) => {
    const response = await fetch(`${base}${path}`,{method:'POST',
      headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    return {status:response.status,body:await response.json()};
  };
  try {
    assert.equal((await post('/start')).body.success,true);
    const login = await post('/check-login',{confirmLogin:true});
    assert.equal(login.body.data.isLoggedIn,true);
    assert.equal(legacyLoginCalls,0);
    const bad = await post('/start-browsing',{
      mode:'search',filters:{position:'无关岗位'},targetCount:1
    });
    assert.equal(bad.status,422);
    const unsupported = await post('/start-browsing',{
      mode:'search',filters:{position:'成本核算经理',education:'本科及以上'},targetCount:1
    });
    assert.equal(unsupported.status,422);
    assert.equal((await post('/start-browsing',{
      mode:'search',filters:{position:'成本核算经理'},targetCount:1,
      maxRuntimeMinutes:181
    })).status,422);
    assert.equal((await post('/start-browsing',{
      mode:'recommended',filters:{position:'成本核算经理'},targetCount:1,
      maxRuntimeMinutes:180
    })).status,422);
    assert.equal((await post('/start-browsing',{
      mode:'search',filters:{position:'成本核算经理'},targetCount:500,
      maxRuntimeMinutes:180,resume:true
    })).status,422,'continuation without a paused verification must be rejected');
    const started = await post('/start-browsing',{
      mode:'search',filters:{position:'成本核算经理'},targetCount:500,
      maxRuntimeMinutes:180
    });
    assert.equal(started.status,200);
    assert.equal(started.body.data.mode,'search');
    assert.equal(started.body.data.requestedMode,'search');
    assert.equal(started.body.data.targetCount,500);
    assert.equal(started.body.data.maxRuntimeMinutes,180);
    assert.equal(searchNavigationCalls,1);
    assert.equal(liveCollector.requestedMaxRuntimeMs,180*60_000);
    const progress = await (await fetch(`${base}/browsing-status`)).json();
    assert.equal(progress.data.isActive,true);
    assert.equal(progress.data.targetCount,500);
    assert.equal(progress.data.mode,'search');
    liveCollector.status={...liveCollector.status,
      lastFailureCode:'BOSS_RESUME_CONTENT_INVALID',
      lastError:'该份简历正文不完整，已跳过'};
    const runningWarning=await (await fetch(`${base}/browsing-status`)).json();
    assert.equal(runningWarning.data.lastFailureCode,'');
    assert.equal(runningWarning.data.lastError,'');
    assert.equal(runningWarning.data.lastSkippedCode,'BOSS_RESUME_CONTENT_INVALID');
    liveCollector.status={...liveCollector.status,state:'partial'};
    const partial=await (await fetch(`${base}/browsing-status`)).json();
    assert.equal(partial.data.lastError,'');
    assert.match(partial.data.completionReason,/搜索结果/);
    liveCollector.status={...liveCollector.status,state:'running'};
    const loginReadsWhileRunning=rawLoginCalls;
    const activeLogin=await post('/check-login');
    assert.equal(activeLogin.body.data.status,'browsing');
    assert.equal(activeLogin.body.data.isLoggedIn,true);
    assert.equal(rawLoginCalls,loginReadsWhileRunning,
      'active collection must not attach a second login probe');
    assert.equal((await post('/start-browsing',{
      mode:'recommended',filters:{position:'成本核算经理'},targetCount:1
    })).status,409);
    assert.equal(rawLoginCalls,loginReadsWhileRunning,
      'duplicate start must not attach to the recruiter tab');
    assert.equal((await post('/reset-card-quarantine')).status,409);
    const quarantine=await (await fetch(`${base}/card-quarantine`)).json();
    assert.deepEqual(quarantine.data,{count:2,ttlHours:24});
    assert.equal((await post('/stop-browsing')).body.success,true);
    assert.equal(liveCollector.getStatus().state,'stopped');
    const reset=await post('/reset-card-quarantine');
    assert.equal(reset.status,200);
    assert.equal(reset.body.data.cleared,2);
    liveCollector.status={...liveCollector.status,state:'paused',phase:'paused',
      pausedAtPhase:'ocr_resume_page_2',pausedAtStage:'capture_screenshot',
      lastFailureCode:'BOSS_CDP_TIMEOUT',currentCardIndex:68,
      lastCardIndex:68,lastTargetState:'obscured'};
    const paused=await (await fetch(`${base}/browsing-status`)).json();
    assert.equal(paused.data.pausedAtPhase,'ocr_resume_page_2');
    assert.equal(paused.data.pausedAtStage,'capture_screenshot');
    assert.equal(paused.data.lastFailureCode,'BOSS_CDP_TIMEOUT');
    assert.equal(paused.data.currentCardIndex,68);
    assert.equal(paused.data.lastCardIndex,68);
    assert.equal(paused.data.lastTargetState,'obscured');
    assert.equal(paused.data.lastSkippedCode,'');
    liveCollector.status={...liveCollector.status,
      lastFailureCode:'BOSS_VERIFICATION_REQUIRED'};
    const resumable=await (await fetch(`${base}/browsing-status`)).json();
    assert.equal(resumable.data.resumeAvailable,true);
    assert.deepEqual(resumable.data.filters,{position:'成本核算经理'});
    assert.equal((await post('/start-browsing',{
      mode:'search',filters:{position:'成本核算经理'},targetCount:500,
      maxRuntimeMinutes:90,resume:true
    })).status,422,'a changed runtime cannot resume the paused run');
    const resumed=await post('/start-browsing',{
      mode:'search',filters:{position:'成本核算经理'},targetCount:500,
      maxRuntimeMinutes:180,resume:true
    });
    assert.equal(resumed.status,200);
    assert.equal(searchNavigationCalls,1,'verification resume must retain its original search page');
    assert.equal(liveCollector.requestedResume,true);
    assert.equal(liveCollector.requestedMaxRuntimeMs,180*60_000);
    assert.equal((await post('/stop-browsing')).body.success,true);
    assert.equal(legacyLoginCalls,0);
    assert.ok(rawLoginCalls >= 2);

    // Hold the first login probe after it passes the synchronous reservation.
    // A second start must fail before opening another CDP connection or task.
    let entered;
    const enteredLogin=new Promise(resolve=>{entered=resolve;});
    const heldLogin=new Promise(resolve=>{releaseHeldLogin=resolve;});
    loginHold={enter:entered,promise:heldLogin};
    const firstStart=post('/start-browsing',{
      mode:'search',filters:{position:'成本核算经理'},targetCount:1
    });
    await enteredLogin;
    const readsAtReservation=rawLoginCalls;
    assert.equal((await post('/start-browsing',{
      mode:'search',filters:{position:'成本核算经理'},targetCount:1
    })).status,409);
    assert.equal((await post('/stop-browsing')).status,409,
      'a stop during startup must not silently miss the pending collector');
    assert.equal(rawLoginCalls,readsAtReservation);
    releaseHeldLogin();
    loginHold=null;
    assert.equal((await firstStart).status,200);
  } finally {
    releaseHeldLogin?.();
    liveCollector?.stop();
    await new Promise(resolve => server.close(resolve));
    delete require.cache[routePath];
    for (const [path,original] of originals) {
      if (original) require.cache[path] = original;
      else delete require.cache[path];
    }
  }
});
