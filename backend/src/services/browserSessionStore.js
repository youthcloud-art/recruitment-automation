const fs = require('fs-extra');
const path = require('path');

const DIRECTORY = path.join(__dirname, '../../../.local/browser-sessions');
const NAMES = { boss: 'boss', zlzp: 'zlzp', qcwy: 'qcwy' };
const lastSaved = new Map();

function statePath(source) {
  if (!NAMES[source]) throw new Error('不支持的浏览器会话来源');
  return path.join(DIRECTORY, `${source}.json`);
}

async function loadBrowserSession(source) {
  const file = statePath(source);
  if (!await fs.pathExists(file)) return undefined;
  try {
    const state = await fs.readJson(file);
    return state.cookies?.length || state.origins?.some(origin => origin.localStorage?.length)
      ? file : undefined;
  } catch (_) {
    return undefined;
  }
}

async function saveBrowserSession(context, source, { force = false } = {}) {
  if (!context) return false;
  const now = Date.now();
  if (!force && now - (lastSaved.get(source) || 0) < 60000) return false;
  const file = statePath(source);
  await fs.ensureDir(DIRECTORY);
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    const state = await context.storageState();
    if (!state.cookies?.length && !state.origins?.some(origin => origin.localStorage?.length)) {
      return false;
    }
    await fs.writeJson(temporary, state);
    await fs.move(temporary, file, { overwrite: true });
    lastSaved.set(source, now);
    return true;
  } finally {
    await fs.remove(temporary).catch(() => {});
  }
}

module.exports = { loadBrowserSession, saveBrowserSession };
