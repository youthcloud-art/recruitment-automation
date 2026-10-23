'use strict';

const { fork } = require('node:child_process');
const path = require('node:path');

function failure(code,message) {
  return Object.assign(new Error(message),{code});
}

class IsolatedCanvasOcrService {
  constructor({ spawn=fork, timeoutMs=110000 }={}) {
    this.spawn=spawn;
    this.timeoutMs=timeoutMs;
    this.child=null;
    this.pending=null;
    this.nextId=1;
  }

  ensureChild() {
    if (this.child) return this.child;
    const child=this.spawn(path.join(__dirname,'isolatedCanvasOcrChild.js'),[],{
      serialization:'advanced',stdio:['ignore','ignore','ignore','ipc'],
      env:Object.fromEntries(['PATH','Path','SystemRoot','SYSTEMROOT','TEMP','TMP',
        'NODE_ENV'].filter(key=>process.env[key] != null)
        .map(key=>[key,process.env[key]]))
    });
    this.child=child;
    child.on('message',message=>{
      const pending=this.pending;
      if (!pending || message?.id!==pending.id) return;
      this.pending=null;
      clearTimeout(pending.timer);
      if (message.ok && typeof message.text==='string') pending.resolve(message.text);
      else pending.reject(failure(message?.code || 'OCR_FAILED',
        message?.message || 'OCR 文字识别失败'));
    });
    const ended=()=>{
      if (this.child===child) this.child=null;
      const pending=this.pending;
      if (!pending) return;
      this.pending=null;
      clearTimeout(pending.timer);
      pending.reject(failure('OCR_WORKER_EXITED','OCR 工作进程已退出'));
    };
    child.once('exit',ended);
    child.once('error',ended);
    return child;
  }

  async recognizeTextFromImage(image) {
    if (!Buffer.isBuffer(image) || image.length<24 || image.length>24*1024*1024 ||
        !image.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
      throw failure('OCR_IMAGE_INVALID','OCR 图片无效');
    }
    if (this.pending) throw failure('OCR_BUSY','OCR 工作进程正处理上一页');
    const child=this.ensureChild();
    const id=this.nextId++;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{
        if (this.pending?.id!==id) return;
        this.pending=null;
        this.child=null;
        try { child.kill(); } catch (_) {}
        reject(failure('OCR_TIMEOUT','OCR 工作进程超时，已终止隔离进程'));
      },this.timeoutMs);
      this.pending={id,timer,resolve,reject};
      try { child.send({type:'recognize',id,image},error=>{
        if (!error || this.pending?.id!==id) return;
        this.pending=null;
        clearTimeout(timer);
        this.child=null;
        try { child.kill(); } catch (_) {}
        reject(failure('OCR_WORKER_EXITED','OCR 工作进程通信失败'));
      }); }
      catch (_) {
        this.pending=null;
        clearTimeout(timer);
        this.child=null;
        try { child.kill(); } catch (_) {}
        reject(failure('OCR_WORKER_EXITED','OCR 工作进程通信失败'));
      }
    });
  }

  async destroy() {
    const child=this.child;
    this.child=null;
    const pending=this.pending;
    this.pending=null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(failure('OCR_CANCELLED','OCR 任务已取消'));
    }
    if (child) { try { child.kill(); } catch (_) {} }
  }
}

module.exports=IsolatedCanvasOcrService;
