'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const IsolatedCanvasOcrService=require('../src/services/isolatedCanvasOcrService');

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ'
  + 'AAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==','base64');

function fakeChild(reply) {
  const child=new EventEmitter();
  child.killed=false;
  child.kill=()=>{child.killed=true;child.emit('exit',0);};
  child.send=(message,callback)=>{
    assert.equal(message.type,'recognize');
    assert.ok(Buffer.isBuffer(message.image));
    callback?.(null);
    if (reply) queueMicrotask(()=>child.emit('message',{
      id:message.id,...reply
    }));
  };
  return child;
}

test('isolated OCR receives only image bytes and returns bounded text',async()=>{
  const child=fakeChild({ok:true,text:'工作经历'});
  const service=new IsolatedCanvasOcrService({spawn:(file,args,options)=>{
    assert.match(file,/isolatedCanvasOcrChild\.js$/);
    assert.equal(options.serialization,'advanced');
    return child;
  }});
  assert.equal(await service.recognizeTextFromImage(png),'工作经历');
  await service.destroy();
  assert.equal(child.killed,true);
});

test('isolated OCR kills a stuck process and keeps the caller responsive',async()=>{
  const child=fakeChild(null);
  const service=new IsolatedCanvasOcrService({spawn:()=>child,timeoutMs:25});
  await assert.rejects(service.recognizeTextFromImage(png),
    error=>error.code==='OCR_TIMEOUT');
  assert.equal(child.killed,true);
  assert.equal(service.child,null);
  await service.destroy();
});

test('isolated OCR rejects invalid image without spawning a process',async()=>{
  let spawned=false;
  const service=new IsolatedCanvasOcrService({spawn:()=>{spawned=true;}});
  await assert.rejects(service.recognizeTextFromImage(Buffer.from('invalid')),
    error=>error.code==='OCR_IMAGE_INVALID');
  assert.equal(spawned,false);
});
