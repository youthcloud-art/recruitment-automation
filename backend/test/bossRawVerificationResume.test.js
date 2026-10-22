const test=require('node:test');
const assert=require('node:assert/strict');
const {BossRawSearchCollector,searchScope}=
  require('../src/services/bossRawSearchCollector');

const title='IT网络运维';
const pageUrl='https://www.zhipin.com/web/chat/search';
const frameUrl='https://www.zhipin.com/web/frame/search/';
const runtimeMs=20*60_000;

function fixture() {
  const job={title,jobRequirements:'网络运维、交换机、防火墙',
    updatedAt:'2026-10-21T00:00:00.000Z'};
  const cards=[
    {index:0,text:'候选人甲 交换机维护三年',clickText:'候选人甲 交换机维护三年'},
    {index:1,text:'候选人乙 防火墙运维四年',clickText:'候选人乙 防火墙运维四年'}
  ];
  const clicks=[];
  let verified=false;
  let modalActive=false;
  let currentPageUrl=pageUrl;
  let currentFrameUrl=frameUrl;
  const session=()=>({assertUsableRecruiterWindow:async()=>{},
    close:async()=>{},clickUnique:async({identityValue})=>clicks.push(identityValue)});
  const collector=new BossRawSearchCollector({connect:async()=>session(),
    jobService:{current:()=>job},wait:async()=>{},
    store:{findBossCardMatch:async()=>null}});
  collector.assertPage=async()=>({url:currentPageUrl,
    iframeLiveUrl:currentFrameUrl,visibilityState:'visible'});
  collector.ensureVisibleRecruiterPage=async()=>{};
  collector.selectJob=async()=>({value:searchScope(title)});
  collector.assertCandidateListJob=async()=>{};
  collector.dismissKnownGuideModal=async()=>{};
  collector.readModal=async()=>({active:modalActive});
  collector.closeOfficialModal=async()=>{};
  collector.prepareCandidateCard=async()=>{};
  collector.assertJob=async()=>{};
  collector.readCandidateCards=async()=>{
    collector.cardWindowTotal=cards.length;
    return cards.slice();
  };
  collector.extractResume=async()=>{
    if (clicks.at(-1)===cards[1].clickText && !verified) {
      const error=new Error('官方人工验证');
      error.code='BOSS_VERIFICATION_REQUIRED';
      throw error;
    }
    return {text:'完整简历正文'};
  };
  collector.saveResume=async()=>({created:true});
  return {collector,job,cards,clicks,
    solve:()=>{verified=true;},
    modal:active=>{modalActive=active;},
    page:url=>{currentPageUrl=url;},
    frame:url=>{currentFrameUrl=url;}};
}

test('search continuation after human verification retains completed cards and retries the interrupted card',async()=>{
  const x=fixture();
  const first=await x.collector.collect({targetCount:2,maxRuntimeMs:runtimeMs});
  assert.equal(first.state,'paused');
  assert.equal(first.lastFailureCode,'BOSS_VERIFICATION_REQUIRED');
  assert.equal(first.saved,1);
  assert.equal(x.collector.canResume(),true);
  assert.deepEqual(x.collector.getResumeInfo(),{mode:'search',
    filters:{position:title},targetCount:2,maxRuntimeMinutes:20});
  x.solve();
  const second=await x.collector.collect({targetCount:2,maxRuntimeMs:runtimeMs,
    resume:true});
  assert.equal(second.state,'completed');
  assert.equal(second.saved,2);
  assert.equal(second.attempted,3);
  assert.deepEqual(x.clicks,[x.cards[0].clickText,x.cards[1].clickText,
    x.cards[1].clickText],
  'the full-text completed card is not reopened; the interrupted card is');
  assert.equal(x.collector.canResume(),false);
});

test('continuation refuses rearranged full-text cards before another click',async()=>{
  const x=fixture();
  await x.collector.collect({targetCount:2,maxRuntimeMs:runtimeMs});
  x.solve();
  x.cards.reverse();
  const clicks=x.clicks.length;
  const second=await x.collector.collect({targetCount:2,maxRuntimeMs:runtimeMs,
    resume:true});
  assert.equal(second.state,'paused');
  assert.equal(second.lastFailureCode,'BOSS_RESUME_LIST_CHANGED');
  assert.equal(x.clicks.length,clicks);
});

test('continuation refuses changed job, official page, iframe, or an open modal',async()=>{
  for (const changed of ['job','page','frame','modal']) {
    const x=fixture();
    await x.collector.collect({targetCount:2,maxRuntimeMs:runtimeMs});
    x.solve();
    if (changed==='job') x.job.jobRequirements='另一岗位条件';
    if (changed==='page') x.page('https://www.zhipin.com/web/chat/recommend');
    if (changed==='frame') x.frame('https://www.zhipin.com/web/frame/recommend/');
    if (changed==='modal') x.modal(true);
    const clicks=x.clicks.length;
    if (changed==='job') {
      await assert.rejects(x.collector.collect({targetCount:2,
        maxRuntimeMs:runtimeMs,resume:true}),
      error=>error.code==='BOSS_RESUME_JOB_CHANGED');
    } else {
      const result=await x.collector.collect({targetCount:2,
        maxRuntimeMs:runtimeMs,resume:true});
      assert.equal(result.state,'paused');
      assert.equal(result.lastFailureCode,changed==='modal'
        ? 'BOSS_RESUME_DIALOG_BLOCKED':'BOSS_RESUME_PAGE_CHANGED');
    }
    assert.equal(x.clicks.length,clicks);
  }
});

test('only an interrupted search verification exposes continuation',()=>{
  const x=fixture();
  assert.equal(x.collector.canResume(),false);
  x.collector.status.state='paused';
  x.collector.status.lastFailureCode='BOSS_VERIFICATION_REQUIRED';
  assert.equal(x.collector.canResume(),false,'a card snapshot is required');
  x.collector.resumeCheckpoint={window:{cards:[{index:0,fingerprint:'f'}]}};
  assert.equal(x.collector.canResume(),true);
  x.collector.status.lastFailureCode='BOSS_RATE_LIMITED';
  assert.equal(x.collector.canResume(),false);
});
