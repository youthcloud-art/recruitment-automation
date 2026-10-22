const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { QcwyImapSyncService, matchesSender, matchesJob } = require('../src/services/qcwyImapSyncService');

const JD = '成本核算经理：本科，制造业成本核算、BOM、预算、存货管理';

test('仅接受指定发件人和岗位相关的简历邮件', () => {
  assert.equal(matchesSender('push@51job.com', '@51job.com'), true);
  assert.equal(matchesSender('push@fake51job.com', '@51job.com'), false);
  assert.equal(matchesSender('notice@example.com', 'notice@example.com'), true);
  assert.equal(matchesJob({ subject: '成本核算经理候选人简历', text: '', attachments: [] },
    { jobTitle: '成本核算经理' }), true);
  assert.equal(matchesJob({ subject: '销售岗位候选人简历', text: '', attachments: [] },
    { jobTitle: '成本核算经理' }), false);
});

test('模拟只读 IMAP 同步、去重、本机评分及 UID 断点续传', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qcwy-imap-sync-'));
  const checkpointFile = path.join(directory, 'checkpoint.json');
  const mailMap = new Map([
    [1, { from: { value: [{ address: 'push@51job.com' }] },
      subject: '成本核算经理候选人简历', text: '',
      attachments: [{ filename: 'candidate.txt', content: Buffer.from('候选人具备本科和五年制造业成本核算与 BOM 经验。') }] }],
    [2, { from: { value: [{ address: 'unknown@example.com' }] },
      subject: '成本核算经理候选人简历', text: '',
      attachments: [{ filename: 'other.txt', content: Buffer.from('不应导入') }] }],
    [3, { from: { value: [{ address: 'push@51job.com' }] },
      subject: '成本核算经理候选人简历', text: '',
      attachments: [{ filename: 'same.txt', content: Buffer.from('候选人具备本科和五年制造业成本核算与 BOM 经验。') }] }]
  ]);
  let uidNext = 4;
  const locks = [];
  const fetchedUids = [];
  const importedHashes = new Set();
  const imports = [];
  const evaluations = [];
  const current = {
    configured: true, enabled: false, host: 'imap.example.com', port: 993,
    security: 'tls', user: 'inbox@example.com', folder: 'INBOX',
    senderAllowlist: '@51job.com', jobTitle: '成本核算经理',
    jobKeywords: '成本核算经理', jobRequirements: JD, maxMessages: 20
  };
  const config = { current: () => current, password: () => 'fake-auth-code' };
  const service = new QcwyImapSyncService({
    config, checkpointFile, parseMail: source => mailMap.get(Number(source.toString())),
    clientFactory: options => {
      assert.equal(options.secure, true);
      return {
        mailbox: { uidValidity: 9, get uidNext() { return uidNext; } },
        connect: async () => {}, logout: async () => {},
        getMailboxLock: async (_folder, options) => {
          locks.push(options.readOnly);
          return { release() {} };
        },
        fetchAll: async range => {
          const [first, last] = range.split(':').map(Number);
          return [...mailMap.keys()].filter(uid => uid >= first && uid <= last)
            .map(uid => ({ uid, size: 100, envelope: { from: mailMap.get(uid).from.value } }));
        },
        fetchOne: async uid => { fetchedUids.push(uid); return { source: Buffer.from(String(uid)) }; }
      };
    },
    importer: {
      importFile: async (file, settings) => {
        imports.push(settings);
        const hash = file.buffer.toString();
        const duplicate = importedHashes.has(hash);
        importedHashes.add(hash);
        return { duplicate, resume: { id: 'resume-1' } };
      }
    },
    pipeline: { evaluate: async (id, jd) => evaluations.push({ id, jd }) }
  });
  try {
    service.syncNow();
    await service.activeRun;
    const first = service.status();
    assert.equal(first.processedMessages, 3);
    assert.equal(first.imported, 1);
    assert.equal(first.duplicates, 1);
    assert.equal(first.filtered, 1);
    assert.equal(first.evaluated, 2);
    assert.deepEqual(locks, [true]);
    assert.deepEqual(fetchedUids, [1, 3]);
    assert.deepEqual(imports.map(item => item.source), ['qcwy', 'qcwy']);
    assert.deepEqual(imports.map(item => item.localOnly), [true, true]);
    assert.equal(evaluations[0].jd, JD);

    service.syncNow();
    await service.activeRun;
    assert.equal(service.status().processedMessages, 0);
    assert.equal(imports.length, 2);

    mailMap.set(4, { from: { value: [{ address: 'push@51job.com' }] },
      subject: '成本核算经理简历', text: '',
      attachments: [{ filename: 'next.pdf', content: Buffer.from('another resume') }] });
    uidNext = 5;
    service.syncNow();
    await service.activeRun;
    assert.equal(service.status().imported, 1);
    assert.equal(imports.length, 3);
    assert.deepEqual(fetchedUids, [1, 3, 4]);
    const checkpoint = JSON.parse(await fs.readFile(checkpointFile, 'utf8'));
    assert.equal(checkpoint.lastUid, 4);
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('暂时性导入失败不推进 UID；下一轮可重试同封邮件', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qcwy-imap-retry-'));
  const checkpointFile = path.join(directory, 'checkpoint.json');
  let attempts = 0;
  const current = {
    configured: true, enabled: false, host: 'imap.example.com', port: 993,
    security: 'tls', user: 'inbox@example.com', folder: 'INBOX',
    senderAllowlist: '@51job.com', jobTitle: '成本核算经理',
    jobKeywords: '成本核算经理', jobRequirements: JD, maxMessages: 20
  };
  const service = new QcwyImapSyncService({
    checkpointFile,
    config: { current: () => current, password: () => 'fake-auth-code' },
    parseMail: async () => ({ from: { value: [{ address: 'push@51job.com' }] },
      subject: '成本核算经理简历', text: '',
      attachments: [{ filename: 'resume.txt', content: Buffer.from('本科制造业成本核算经验丰富') }] }),
    clientFactory: () => ({
      mailbox: { uidValidity: 1, uidNext: 2 },
      connect: async () => {}, logout: async () => {},
      getMailboxLock: async () => ({ release() {} }),
      fetchAll: async () => [{ uid: 1, size: 100,
        envelope: { from: [{ address: 'push@51job.com' }] } }],
      fetchOne: async () => ({ source: Buffer.from('sample') })
    }),
    importer: { importFile: async () => {
      attempts++;
      if (attempts === 1) throw new Error('temporary storage failure');
      return { duplicate: false, resume: { id: 'resume-1' } };
    } },
    pipeline: { evaluate: async () => {} }
  });
  try {
    service.syncNow();
    await service.activeRun;
    assert.equal(service.status().failed, 1);
    assert.match(service.status().lastError, /保留该邮件位置/);
    const pending = JSON.parse(await fs.readFile(checkpointFile, 'utf8'));
    assert.equal(pending.lastUid, 0);
    assert.equal(pending.failure, null);
    service.syncNow();
    await service.activeRun;
    assert.equal(attempts, 2);
    assert.equal(service.status().imported, 1);
    assert.equal(JSON.parse(await fs.readFile(checkpointFile, 'utf8')).lastUid, 1);
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

function activeConfig() {
  const value = {
    configured: true, enabled: false, host: 'imap.example.com', port: 993,
    security: 'tls', user: 'inbox@example.com', folder: 'INBOX',
    senderAllowlist: '@51job.com', jobTitle: '成本核算经理',
    jobKeywords: '成本核算经理', jobRequirements: JD, maxMessages: 20
  };
  return { current: () => value, password: () => 'fake-auth-code' };
}

function fakeClient(uids, sourceFor = uid => Buffer.from(String(uid))) {
  return () => ({
    mailbox: { uidValidity: 1, uidNext: Math.max(...uids) + 1 },
    connect: async () => {}, logout: async () => {},
    getMailboxLock: async (_folder, options) => {
      assert.equal(options.readOnly, true);
      return { release() {} };
    },
    fetchAll: async range => {
      const [first, last] = range.split(':').map(Number);
      return uids.filter(uid => uid >= first && uid <= last)
        .map(uid => ({ uid, size: 100,
          envelope: { from: [{ address: 'push@51job.com' }] } }));
    },
    fetchOne: async uid => ({ source: sourceFor(uid) })
  });
}

function validMail() {
  return { from: { value: [{ address: 'push@51job.com' }] },
    subject: '成本核算经理简历', text: '',
    attachments: [{ filename: 'resume.txt', content: Buffer.from('本科制造业成本核算经验丰富') }] };
}

test('永久损坏邮件三次后显式隔离，后续 UID 继续入库', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qcwy-imap-poison-'));
  const checkpointFile = path.join(directory, 'checkpoint.json');
  let imported = 0;
  const service = new QcwyImapSyncService({
    config: activeConfig(), checkpointFile, clientFactory: fakeClient([1, 2]),
    parseMail: async source => {
      if (source.toString() === '1') throw new Error('broken MIME');
      return validMail();
    },
    importer: { importFile: async () => { imported++; return { resume: { id: 'next' } }; } },
    pipeline: { evaluate: async () => {} }
  });
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      service.syncNow();
      await service.activeRun;
      const checkpoint = JSON.parse(await fs.readFile(checkpointFile, 'utf8'));
      assert.equal(checkpoint.lastUid, 0);
      assert.equal(checkpoint.failure.attempts, attempt);
      assert.equal(imported, 0);
    }
    service.syncNow();
    await service.activeRun;
    const checkpoint = JSON.parse(await fs.readFile(checkpointFile, 'utf8'));
    assert.equal(checkpoint.lastUid, 2);
    assert.equal(checkpoint.deadLetters.length, 1);
    assert.equal(checkpoint.deadLetters[0].uid, 1);
    assert.equal(imported, 1);
    assert.match(service.status().lastError, /已隔离/);
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('临时空正文连续失败不会隔离邮件，恢复后仍可入库', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qcwy-imap-empty-'));
  const checkpointFile = path.join(directory, 'checkpoint.json');
  let fetchAttempts = 0;
  let imported = 0;
  const service = new QcwyImapSyncService({
    config: activeConfig(), checkpointFile,
    clientFactory: fakeClient([1], () => {
      fetchAttempts++;
      return fetchAttempts <= 3 ? Buffer.alloc(0) : Buffer.from('valid');
    }),
    parseMail: async () => validMail(),
    importer: { importFile: async () => { imported++; return { resume: { id: 'one' } }; } },
    pipeline: { evaluate: async () => {} }
  });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      service.syncNow();
      await service.activeRun;
      const checkpoint = JSON.parse(await fs.readFile(checkpointFile, 'utf8'));
      assert.equal(checkpoint.lastUid, 0);
      assert.equal(checkpoint.deadLetters.length, 0);
    }
    service.syncNow();
    await service.activeRun;
    assert.equal(imported, 1);
    assert.equal(JSON.parse(await fs.readFile(checkpointFile, 'utf8')).lastUid, 1);
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('主动停止不推进当前 UID，重启同步可重新处理', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qcwy-imap-stop-'));
  const checkpointFile = path.join(directory, 'checkpoint.json');
  let imported = 0;
  let service;
  service = new QcwyImapSyncService({
    config: activeConfig(), checkpointFile, clientFactory: fakeClient([1]),
    parseMail: async () => validMail(),
    importer: { importFile: async () => {
      imported++;
      if (imported === 1) service.stop();
      return { resume: { id: 'one' } };
    } },
    pipeline: { evaluate: async () => {} }
  });
  try {
    service.syncNow();
    await service.activeRun;
    await assert.rejects(() => fs.readFile(checkpointFile));
    service.syncNow();
    await service.activeRun;
    assert.equal(imported, 2);
    assert.equal(JSON.parse(await fs.readFile(checkpointFile, 'utf8')).lastUid, 1);
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('损坏的本机断点文件中止同步，不跳过旧 UID', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qcwy-imap-corrupt-'));
  const checkpointFile = path.join(directory, 'checkpoint.json');
  let fetched = 0;
  const service = new QcwyImapSyncService({
    config: activeConfig(), checkpointFile,
    clientFactory: () => {
      const client = fakeClient([1])();
      client.fetchAll = async () => { fetched++; return []; };
      return client;
    }
  });
  try {
    await fs.writeFile(checkpointFile, '{invalid json');
    service.syncNow();
    await service.activeRun;
    assert.equal(fetched, 0);
    assert.match(service.status().lastError, /断点文件/);
    assert.equal(await fs.readFile(checkpointFile, 'utf8'), '{invalid json');
    const invalidState = JSON.stringify({
      key: service.checkpointKey(activeConfig().current()),
      uidValidity: '1', lastUid: 'not-an-integer'
    });
    await fs.writeFile(checkpointFile, invalidState);
    service.syncNow();
    await service.activeRun;
    assert.equal(fetched, 0);
    assert.match(service.status().lastError, /断点文件/);
    assert.equal(await fs.readFile(checkpointFile, 'utf8'), invalidState);
    await fs.writeFile(checkpointFile, 'null');
    service.syncNow();
    await service.activeRun;
    assert.equal(fetched, 0);
    assert.match(service.status().lastError, /断点文件/);
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
