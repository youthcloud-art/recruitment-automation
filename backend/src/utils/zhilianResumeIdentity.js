function normalizedField(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/g, '').trim().toLowerCase();
}

function normalizedText(value) {
  return String(value ?? '').normalize('NFKC').replace(/\r\n?/g, '\n')
    .replace(/[\t\u00a0 ]+/g, ' ').trim();
}

function meaningfulName(value) {
  const name = normalizedField(value);
  return name.length >= 2 && !/^(未识别姓名|未知|匿名|保密|暂无|求职者|候选人)$/.test(name);
}

function normalizedAge(value) {
  const text = String(value ?? '').normalize('NFKC').trim();
  const age = text.match(/^(\d{1,3})(?:岁|$)/);
  return age ? String(Number(age[1])) : normalizedField(value);
}

function hasConflictingField(a, b, field) {
  const normalize = field === 'age' ? normalizedAge : normalizedField;
  const left = normalize(a[field]);
  const right = normalize(b[field]);
  return Boolean(left && right && left !== right);
}

function stableResumeCore(text) {
  // 求职期望、在线状态等页首内容会变；工作/教育经历是相对稳定的身份佐证。
  const section = /(?:^|\n)\s*(?:工作经历|工作经验|教育经历|教育背景)\s*(?:\n|[：:])/u.exec(text);
  return section ? text.slice(section.index) : '';
}

function smallEditDistance(left, right, limit) {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    for (let j = 1; j <= right.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1,
        previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1));
    }
    previous = current;
    if (Math.min(...current) > limit) return false;
  }
  return previous[right.length] <= limit;
}

function oneSmallTextChange(left, right, strongIdentity) {
  if (left === right) return true;
  const maxLength = Math.max(left.length, right.length);
  if (Math.min(left.length, right.length) < 500) return false;
  const tinyAllowed = Math.max(4, Math.min(8, Math.floor(maxLength * 0.002)));
  const allowed = strongIdentity ? Math.max(tinyAllowed, Math.min(40, Math.floor(maxLength * 0.02)))
    : tinyAllowed;
  if (Math.abs(left.length - right.length) > allowed) return false;
  let prefix = 0;
  while (prefix < Math.min(left.length, right.length) && left[prefix] === right[prefix]) prefix++;
  let suffix = 0;
  while (suffix < Math.min(left.length, right.length) - prefix &&
    left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) suffix++;
  const changeLeft = left.slice(prefix, left.length - suffix);
  const changeRight = right.slice(prefix, right.length - suffix);
  const changeSize = Math.max(changeLeft.length, changeRight.length);
  if (changeSize <= tinyAllowed) return true;
  if (!strongIdentity || changeSize > allowed) return false;
  return smallEditDistance(changeLeft, changeRight,
    Math.max(4, Math.min(24, Math.floor(maxLength * 0.012))));
}

function isSameZhilianResume(a, b) {
  if (a?.source !== 'zlzp' || b?.source !== 'zlzp') return false;
  if (a.sourceFingerprint && a.sourceFingerprint === b.sourceFingerprint) return true;
  // Search-result pages are shared by many candidates. Matching URLs are a guard,
  // not an identity by themselves: require a parsed name and almost identical long text.
  if (!a.sourceUrl || !b.sourceUrl || a.sourceUrl !== b.sourceUrl) return false;
  const name = normalizedField(a.name);
  if (!meaningfulName(name) || name !== normalizedField(b.name)) return false;
  for (const field of ['phone', 'email', 'age', 'education']) {
    if (hasConflictingField(a, b, field)) return false;
  }
  const sameContact = ['phone', 'email'].some(field =>
    normalizedField(a[field]) && normalizedField(a[field]) === normalizedField(b[field]));
  const sameAgeAndEducation = normalizedAge(a.age) && normalizedAge(a.age) === normalizedAge(b.age) &&
    normalizedField(a.education) && normalizedField(a.education) === normalizedField(b.education);
  const left = normalizedText(a.originalText);
  const right = normalizedText(b.originalText);
  const leftCore = stableResumeCore(left);
  const sameLongCore = leftCore.length >= 500 && leftCore === stableResumeCore(right);
  // 同名、同年龄、同学历在匿名简历中并非唯一标识。没有相同联系方式时，
  // 只在长篇工作/教育经历完全一致的情况下合并，避免吞掉不同人的资料。
  if (!sameContact && !(sameAgeAndEducation && sameLongCore)) return false;
  return oneSmallTextChange(left, right, Boolean(sameContact || sameLongCore));
}

module.exports = { isSameZhilianResume };
