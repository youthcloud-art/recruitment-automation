const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const dotenv = require('dotenv');
const { environmentFile } = require('../src/config/environmentFile');
const { SmtpConfigService } = require('../src/services/smtpConfigService');
const { QcwyImapConfigService } = require('../src/services/qcwyImapConfigService');

test('company mail settings survive atomic writes and a new release instance', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'company-env-'));
  const file = path.join(directory, 'backend.env');
  const environment = { RECRUITMENT_ENV_FILE: file };
  try {
    await fs.writeFile(file, 'RESUME_STORAGE_ENGINE=sqlite\n');
    const smtp = new SmtpConfigService({ environment });
    assert.equal(smtp.file, file);
    await smtp.save({ host: 'smtp.example.test', port: 465,
      from: 'sender@example.test', user: 'sender@example.test', password: 'test-only-password' });
    const imap = new QcwyImapConfigService({ environment });
    assert.equal(imap.file, file);
    await imap.save({ host: 'imap.example.test', port: 993, security: 'tls',
      user: 'inbox@example.test', password: 'test-only-password', folder: 'INBOX',
      senderAllowlist: '@51job.com', jobTitle: '项目经理',
      jobRequirements: '项目管理经验', enabled: false });
    const restored = { RECRUITMENT_ENV_FILE: file,
      ...dotenv.parse(await fs.readFile(environmentFile(environment))) };
    assert.equal(restored.RESUME_STORAGE_ENGINE, 'sqlite');
    assert.equal(new SmtpConfigService({ environment: restored }).current().hasPassword, true);
    assert.equal(new QcwyImapConfigService({ environment: restored }).current().hasPassword, true);
    assert.equal(new SmtpConfigService({ environment: restored }).current().host, 'smtp.example.test');
  } finally {
    await fs.unlink(file).catch(() => {});
    await fs.rmdir(directory);
  }
});

test('local installations keep the backend environment-file default', () => {
  assert.equal(environmentFile({}), path.resolve(__dirname, '../.env'));
});
