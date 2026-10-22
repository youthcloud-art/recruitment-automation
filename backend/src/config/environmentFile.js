const path = require('node:path');

// Company releases share one configuration file outside the code directories.
// Resolve the actual file instead of hard-linking .env: atomic settings writes
// replace the inode and would otherwise detach a release from its shared copy.
function environmentFile(environment = process.env) {
  return environment.RECRUITMENT_ENV_FILE
    ? path.resolve(environment.RECRUITMENT_ENV_FILE)
    : path.resolve(__dirname, '../../.env');
}

module.exports = { environmentFile };
