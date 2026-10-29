const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const express = require('express');
const { createCompanyMaintenanceRouter } = require('../src/routes/companyMaintenance');

async function fixture(t, environment = { COMPANY_DEPLOYMENT: 'true' }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'company-maintenance-api-test-'));
  fs.mkdirSync(path.join(root, 'delivery'));
  const app = express(); app.use('/api/company-maintenance', createCompanyMaintenanceRouter({ environment, installRoot: root }));
  const server = await new Promise(resolve => { const listener = app.listen(0,'127.0.0.1',()=>resolve(listener)); });
  t.after(async () => {
    await new Promise(resolve=>server.close(resolve));
    const relative = path.relative(path.resolve(os.tmpdir()),path.resolve(root));
    assert.ok(relative.startsWith('company-maintenance-api-test-') && !relative.includes(path.sep));
    fs.rmSync(root,{recursive:true,force:true});
  });
  const request = (headers={}) => new Promise((resolve,reject)=>{
    const req=http.get({hostname:'127.0.0.1',port:server.address().port,path:'/api/company-maintenance/status',headers:{host:'127.0.0.1:5001',origin:'http://127.0.0.1:3000',...headers}},res=>{
      let data='';res.on('data',c=>data+=c);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:JSON.parse(data)}));
    });req.on('error',reject);
  });
  return {root,request};
}
test('maintenance status is company-only and retains the local API access boundary',async t=>{
  const local=await fixture(t,{}); assert.equal((await local.request()).status,404);
  const company=await fixture(t); assert.equal((await company.request({host:'outside.example:5001'})).status,403);
  assert.equal((await company.request({origin:'https://outside.example'})).status,403);
  const empty=await company.request();assert.equal(empty.body.data.installed,false);assert.equal(empty.headers['cache-control'],'no-store');
});
test('maintenance status exposes schedule and reclaimed bytes without filenames, bundle paths or raw errors',async t=>{
  const f=await fixture(t);
  fs.writeFileSync(path.join(f.root,'delivery/cleanup-installation.json'),JSON.stringify({installed:true,enabled:true,taskName:'AutoRecru-Company-Cleanup',times:['12:30','20:00'],timeZone:'Asia/Shanghai',bundle:'PRIVATE_BUNDLE_PATH',policy:{keepNewestReleases:3,incompleteReleaseMinimumAgeHours:4,extra:'PRIVATE_POLICY_VALUE'}}));
  fs.writeFileSync(path.join(f.root,'delivery/last-cleanup.json'),JSON.stringify({status:'low_space',apply:true,removedCount:2,removedBytes:123,diskFreeAfter:456,lowDisk:true,errors:[{message:'PRIVATE_ERROR_AND_FILENAME'}]}));
  const res=await f.request();assert.equal(res.status,200);assert.equal(res.body.data.installed,true);assert.deepEqual(res.body.data.times,['12:30','20:00']);assert.equal(res.body.data.lastRun.removedBytes,123);
  assert.equal(res.body.data.lastRun.lowDisk,true);assert.equal(res.body.data.lastRun.pressureCleanup,false);assert.equal(res.body.data.policy.incompleteReleaseMinimumAgeHours,4);
  assert.equal(JSON.stringify(res.body).includes('PRIVATE_'),false);
});
