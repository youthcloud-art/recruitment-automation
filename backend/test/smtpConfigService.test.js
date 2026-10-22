const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { SmtpConfigService } = require('../src/services/smtpConfigService');

test('网页 SMTP 设置写入本机 .env 时保留 DeepSeek 密钥并隐藏授权码', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'smtp-config-test-'));
  const file = path.join(directory, '.env');
  const environment = {};
  const service = new SmtpConfigService({ file, environment });
  try {
    await fs.writeFile(file, 'LLM_API_KEY=existing-local-key\nSMTP_HOST=old.example.test\n');
    const saved = await service.save({
      host: 'mail.example.test', port: 465, from: 'sender@example.test',
      authEnabled: true, user: 'sender@example.test', password: 'a#"\\secret',
      secure: 'auto', requireTLS: false
    });
    const content = await fs.readFile(file, 'utf8');
    assert.match(content, /LLM_API_KEY=existing-local-key/);
    assert.match(content, /SMTP_HOST=mail\.example\.test/);
    assert.doesNotMatch(content, /a#"\\secret/);
    assert.equal(Buffer.from(environment.SMTP_PASS_B64, 'base64').toString(), 'a#"\\secret');
    assert.equal(saved.hasPassword, true);
    await service.save({
      host: 'relay.example.test', port: 2525, from: 'sender@example.test',
      authEnabled: false, secure: 'false', requireTLS: true
    });
    assert.equal(environment.SMTP_USER, '');
    assert.equal(environment.SMTP_PASS_B64, '');
    assert.equal(service.current().authEnabled, false);
  } finally {
    await fs.unlink(file).catch(() => {});
    await fs.rmdir(directory).catch(() => {});
  }
});
