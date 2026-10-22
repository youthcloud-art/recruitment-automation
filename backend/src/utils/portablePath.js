const path = require('path');

function portableBasename(value) {
  const text = String(value || '');
  const name = path.posix.basename(text.replace(/\\/g, '/'));
  if (!name || name === '.' || name === '..') throw new Error('文件名无效');
  return name;
}

module.exports = { portableBasename };
