const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { QcwyImapConfigService } = require('../src/services/qcwyImapConfigService');

test('IMAP 收件配置保留其他 .env 密钥并不回显授权码', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qcwy-imap-config-'));
  const file = path.join(directory, '.env');
  const environment = {};
  const service = new QcwyImapConfigService({ file, environment });
  try {
    await fs.writeFile(file, 'LLM_API_KEY=kept\nSMTP_FROM=sender@example.com\n');
    const saved = await service.save({
      host: 'imap.example.com', port: 993, security: 'tls',
      user: 'inbox@example.com', password: 'a#secret\\value', folder: 'INBOX',
      senderAllowlist: '@51job.com, notice@example.com',
      jobTitle: '成本核算经理', jobKeywords: '成本核算主管',
      jobRequirements: '成本核算、制造业 BOM 与预算经验',
      pollMinutes: 15, maxMessages: 20, enabled: true
    });
    const text = await fs.readFile(file, 'utf8');
    assert.match(text, /LLM_API_KEY=kept/);
    assert.match(text, /SMTP_FROM=sender@example.com/);
    assert.doesNotMatch(text, /a#secret\\value/);
    assert.equal(service.password(), 'a#secret\\value');
    assert.equal(saved.hasPassword, true);
    assert.equal(saved.configured, true);
    assert.match(saved.jobKeywords, /成本核算经理/);
    assert.match(saved.jobKeywords, /成本核算主管/);
    assert.equal(saved.password, undefined);
    const retained = await service.save({ ...saved, password: '', enabled: false });
    assert.equal(retained.enabled, false);
    assert.equal(service.password(), 'a#secret\\value');
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('收件配置必须有可信发件人、岗位要求和安全连接', async () => {
  const service = new QcwyImapConfigService({ environment: {} });
  const input = {
    host: 'imap.example.com', port: 993, security: 'tls', user: 'inbox@example.com',
    password: 'secret', senderAllowlist: '@51job.com', jobTitle: '成本核算经理',
    jobRequirements: '成本核算及制造业经验'
  };
  await assert.rejects(() => service.save({ ...input, senderAllowlist: '' }), /发件邮箱筛选项/);
  await assert.rejects(() => service.save({ ...input, senderAllowlist: '@bad..com' }), /发件人筛选格式/);
  await assert.rejects(() => service.save({ ...input, security: 'plain' }), /加密方式/);
  await assert.rejects(() => service.save({ ...input, jobRequirements: '' }), /岗位要求/);
});
