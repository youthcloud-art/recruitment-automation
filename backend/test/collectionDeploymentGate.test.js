const test = require('node:test');
const assert = require('node:assert/strict');
const { collectionDeploymentGate } = require('../src/services/collectionDeploymentGate');

test('deployment drain blocks new collection starts but leaves reads and existing work available', () => {
  const gate = collectionDeploymentGate({deployment:'true',file:'test-drain',exists:()=>true});
  const response = { status(code) { this.code=code; return this; },
    json(body) { this.body=body; return this; } };
  let continued = 0;
  gate({method:'POST',path:'/api/boss-zhipin/start-browsing'},response,()=>continued++);
  assert.equal(response.code,503);
  assert.equal(response.body.code,'DEPLOY_DRAINING');
  assert.equal(continued,0);
  gate({method:'GET',path:'/api/boss-zhipin/browsing-status'},response,()=>continued++);
  gate({method:'POST',path:'/api/boss-zhipin/stop-browsing'},response,()=>continued++);
  assert.equal(continued,2);
});

test('local development and an idle company server permit collection starts', () => {
  for (const options of [{deployment:'false',exists:()=>true},
    {deployment:'true',exists:()=>false}]) {
    let continued=0;
    collectionDeploymentGate(options)({method:'POST',path:'/api/wuyou/keyword-batch'},
      {},()=>continued++);
    assert.equal(continued,1);
  }
});
