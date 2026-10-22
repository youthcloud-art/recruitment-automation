const crypto = require('node:crypto');

function normalizedName(value) {
  const name = String(value || '').normalize('NFKC').replace(/\s+/g, '').trim();
  // One-surname aliases and headings are shared by many people. They must
  // never become a near-duplicate lookup key.
  if (!/^[\u4e00-\u9fa5]{2,5}$/.test(name) ||
      /(?:先生|女士|小姐|同学)$/.test(name) ||
      /^(?:候选人|求职者|未知|匿名|保密|暂无|简历|牛人|未识别姓名)$/.test(name)) return '';
  return name;
}

function bossNameKey(value) {
  const name = normalizedName(value);
  return name ? crypto.createHash('sha256').update(name).digest('hex') : '';
}

function normalizedResumeText(value) {
  return [...String(value || '').normalize('NFKC')]
    .filter(char => /[\p{L}\p{N}]/u.test(char)).join('').toLowerCase();
}

function ngrams(value, size = 5) {
  const result = new Set();
  for (let index = 0; index + size <= value.length; index++) {
    result.add(value.slice(index, index + size));
  }
  return result;
}

function textSimilarity(left, right) {
  const rawA = String(left || '').normalize('NFKC');
  const rawB = String(right || '').normalize('NFKC');
  const a = normalizedResumeText(left);
  const b = normalizedResumeText(right);
  const lengthRatio = Math.min(a.length, b.length) / Math.max(a.length, b.length, 1);
  // BOSS Canvas OCR inserts spaces between many Chinese glyphs. Require a
  // very long raw resume and substantial semantic text, not an impossible
  // post-normalization 3,000-character minimum.
  if (rawA.length < 4500 || rawB.length < 4500 ||
      a.length < 2500 || b.length < 2500 || lengthRatio < 0.95) {
    return {jaccard:0, containment:0, lengthRatio};
  }
  const gramsA = ngrams(a);
  const gramsB = ngrams(b);
  let shared = 0;
  for (const gram of gramsA) if (gramsB.has(gram)) shared++;
  return {
    jaccard:shared / (gramsA.size + gramsB.size - shared || 1),
    containment:shared / (Math.min(gramsA.size, gramsB.size) || 1),
    lengthRatio
  };
}

const HEADING = /(?:工作|任职|职业|实习|就职)经[历厉]|工作履[历厉]|工作经验|项[目日](?:经[历厉]|经验|介绍)|教[育肓]经[历厉]|教育背景|教育信息|毕业院校|学历信息|专业技能|技能特长|个人优势|自我评价|求职意向/gu;
const CAREER_HEADING = /^(?:(?:工作|任职|职业|实习|就职)经[历厉]|工作履[历厉]|工作经验|项[目日](?:经[历厉]|经验|介绍))$/u;

function careerDates(value) {
  // Dates are accepted only from the work/project body, never the header,
  // search card or a generic application timestamp. OCR can split Chinese
  // headings with spaces, so remove whitespace before section detection.
  const text = String(value || '').normalize('NFKC').replace(/\s+/g, '');
  const headings = [...text.matchAll(HEADING)].map(match => ({
    value:match[0], at:match.index, end:match.index + match[0].length
  }));
  const dates = new Set();
  for (let index = 0; index < headings.length; index++) {
    if (!CAREER_HEADING.test(headings[index].value)) continue;
    const body = text.slice(headings[index].end, headings[index + 1]?.at ?? text.length);
    for (const match of body.matchAll(/((?:19|20)\d{2})[.\/年-](\d{1,2})(?:月)?/gu)) {
      const month = Number(match[2]);
      if (month >= 1 && month <= 12) dates.add(`${match[1]}-${String(month).padStart(2, '0')}`);
    }
  }
  return dates;
}

function matchingCareerDates(left, right) {
  const a = careerDates(left);
  const b = careerDates(right);
  if (a.size < 3 || b.size < 3) return false;
  const common = [...a].filter(date => b.has(date));
  return common.length >= 3 &&
    new Set(common.map(date => date.slice(0, 4))).size >= 2 &&
    common.length / Math.min(a.size, b.size) >= 0.8;
}

function degree(value) {
  const field = String(value || '').normalize('NFKC');
  return ['博士','硕士','本科','大专','高中','中专'].find(item => field.includes(item)) || '';
}

function schoolNames(value) {
  const text = String(value || '').normalize('NFKC').replace(/\s+/g, '');
  const names = new Set();
  for (const match of text.matchAll(/[\u4e00-\u9fa5]{2,16}(?:大学|学院|学校)/gu)) {
    const name = match[0].replace(/^(?:毕业于|就读于|毕业学校|毕业院校)/u, '');
    if (name.length >= 4) names.add(name);
  }
  return names;
}

function hasSameSchool(a, b) {
  const schoolsA = schoolNames(a.originalText);
  const schoolsB = schoolNames(b.originalText);
  return [...schoolsA].some(school => schoolsB.has(school));
}

function normalizedContact(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

function validPhone(value) {
  const phone = normalizedContact(value);
  return /^1[3-9]\d{9}$/.test(phone) ? phone : '';
}

function validEmail(value) {
  const email = normalizedContact(value);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

function validAge(value) {
  const match = normalizedContact(value).match(/^(\d{2})(?:岁)?$/u);
  const age = Number(match?.[1]);
  return age >= 18 && age <= 70 ? String(age) : '';
}

function conflictingField(a, b, key, normalize) {
  const left = normalize(a[key]);
  const right = normalize(b[key]);
  return Boolean(left && right && left !== right);
}

function sameBossNearDuplicate(a, b) {
  if (a?.source !== 'boss' || b?.source !== 'boss') return false;
  const name = normalizedName(a.name);
  if (!name || name !== normalizedName(b.name)) return false;
  // A platform ID conflict wins over visual similarity. A BOSS ID might
  // represent a distinct profile rather than a changeable resume version.
  if (a.sourceCandidateId && b.sourceCandidateId &&
      a.sourceCandidateId !== b.sourceCandidateId) return false;
  if (conflictingField(a,b,'phone',validPhone) ||
      conflictingField(a,b,'email',validEmail) ||
      conflictingField(a,b,'age',validAge)) return false;
  if (degree(a.education) && degree(b.education) &&
      degree(a.education) !== degree(b.education)) return false;
  const datesA = careerDates(a.originalText);
  const datesB = careerDates(b.originalText);
  if (datesA.size >= 3 && datesB.size >= 3 &&
      [...datesA].filter(date => datesB.has(date)).length < 3) return false;

  const similarity = textSimilarity(a.originalText, b.originalText);
  if (similarity.jaccard < 0.92 || similarity.containment < 0.96 ||
      similarity.lengthRatio < 0.95) return false;

  // One item per independent domain. Age + a generic degree alone is too
  // weak; at least one corroboration must identify education or career.
  const sameContact = (validPhone(a.phone) && validPhone(a.phone) === validPhone(b.phone)) ||
    (validEmail(a.email) && validEmail(a.email) === validEmail(b.email));
  const sameAge = validAge(a.age) && validAge(a.age) === validAge(b.age);
  const sameDegree = degree(a.education) && degree(a.education) === degree(b.education);
  const sameSchool = hasSameSchool(a,b);
  const sameCareer = matchingCareerDates(a.originalText,b.originalText);
  const domains = [sameContact,sameAge,(sameSchool || sameDegree),sameCareer]
    .filter(Boolean).length;
  return domains >= 2 && (sameSchool || sameCareer || sameContact);
}

function chooseBossNearDuplicate(matches) {
  if (!matches.length) return null;
  if (matches.length > 8) return null;
  // Historical OCR duplicates can predate this predicate. They may all
  // match the incoming resume; accept a canonical record only when the
  // entire cohort agrees pairwise, otherwise retain the new record.
  for (let index = 0; index < matches.length; index++) {
    for (let other = index + 1; other < matches.length; other++) {
      if (!sameBossNearDuplicate(matches[index],matches[other])) return null;
    }
  }
  return [...matches].sort((a,b) =>
    String(a.createdAt || '').localeCompare(String(b.createdAt || '')) ||
      String(a.id || '').localeCompare(String(b.id || '')))[0];
}

module.exports = { normalizedName, bossNameKey, normalizedResumeText,
  textSimilarity, careerDates, matchingCareerDates, sameBossNearDuplicate,
  chooseBossNearDuplicate };
