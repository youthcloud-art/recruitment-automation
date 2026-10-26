'use strict';

// A local resume ID, OCR fingerprint, or card-text hash is not a platform ID.
// Only identifiers present in an official candidate URL or an official card
// identity attribute are eligible for a platform locator.
const ID = /^[A-Za-z0-9_-]{1,256}$/;
const CARD_ID = /^[A-Za-z0-9_-]{4,256}$/;

function officialUrl(value, domain) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password ||
        !(url.hostname === domain || url.hostname.endsWith(`.${domain}`))) return null;
    return url;
  } catch (_) { return null; }
}

function queryId(url, names) {
  if (!url) return '';
  for (const name of names) {
    const value = url.searchParams.get(name);
    if (value && ID.test(value)) return value;
  }
  return '';
}

function idFromOfficialUrl(source, value) {
  const configuration = {
    boss: { domain: 'zhipin.com', path: /^\/web\/frame\/c-resume\/?$/,
      keys: ['expectId', 'expectid', 'geekId', 'geekid'] },
    zlzp: { domain: 'zhaopin.com', path: /^\/app\/search\/?$/,
      keys: ['resumeNumber'] },
    qcwy: { domain: '51job.com', path: /\/resume\/detail(?:\/|$)/i,
      keys: ['resumeId', 'resume_id', 'resumeNo', 'resume_no'] }
  }[source];
  if (!configuration) return '';
  const url = officialUrl(value, configuration.domain);
  if (source === 'qcwy' && url) {
    const pathId = /^\/candidate\/detail\/([A-Za-z0-9_-]{1,256})\/?$/i.exec(url.pathname);
    if (pathId) return pathId[1];
  }
  if (!url || !configuration.path.test(url.pathname)) return '';
  return queryId(url, configuration.keys);
}

function bossCardId(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 2048) return '';
  if (CARD_ID.test(raw) && !/^(?:true|false|null|undefined|search|recommend)$/i.test(raw)) return raw;
  if (!raw.startsWith('{')) return '';
  try {
    const record = JSON.parse(raw);
    if (!record || typeof record !== 'object' || Array.isArray(record)) return '';
    const candidates = ['expectId', 'encryptExpectId', 'geekId', 'encryptGeekId']
      .map(key => record[key]).filter(value => typeof value === 'string' && CARD_ID.test(value));
    return candidates.length === 1 ? candidates[0] : '';
  } catch (_) { return ''; }
}

function platformLocator(item = {}) {
  const source = item.source;
  if (!['boss', 'zlzp', 'qcwy'].includes(source)) {
    return { id: '', kind: '', status: 'unavailable', url: '' };
  }
  const urlId = idFromOfficialUrl(source, item.sourceUrl);
  const storedId = typeof item.sourceCandidateId === 'string' && ID.test(item.sourceCandidateId)
    ? item.sourceCandidateId : '';
  // Conflicting identities must not be presented as a trustworthy locator.
  if (urlId && storedId && urlId !== storedId) {
    return { id: '', kind: '', status: 'conflict', url: '' };
  }
  const cardId = source === 'boss' && item.sourceCandidateIdSource === 'platform_card'
    ? storedId : '';
  const id = urlId || cardId;
  if (!id) return { id: '', kind: '', status: 'unavailable', url: '' };
  const kind = source === 'zlzp' ? '智联简历号' : source === 'qcwy'
    ? '前程无忧简历 ID' : 'BOSS 平台记录号';
  return { id, kind, status: urlId ? 'official_url' : 'platform_card',
    url: urlId ? item.sourceUrl : '' };
}

module.exports = { idFromOfficialUrl, bossCardId, platformLocator };
