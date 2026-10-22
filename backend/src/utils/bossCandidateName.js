// The general-purpose resume parser also treats the first 1–3 Chinese glyphs
// of a line as a name. On BOSS Canvas OCR that can be a section heading or an
// ordinary word. Only a labelled name in the captured resume is OCR evidence.
const NON_PERSON_LABELS = new Set([
  '姓名', '名字', '工作', '经验', '项目', '技能', '教育', '简历',
  '候选人', '求职者', '求职', '推荐', '通知', '个人', '详情',
  '工作经历', '教育经历', '专业技能', '项目经历', '个人优势',
  '自我评价', '求职意向'
]);

function verifiedBossOcrName(value, originalText) {
  const name = String(value || '').normalize('NFKC').replace(/\s+/g, '').trim();
  if (!/^[\u4e00-\u9fff]{2,4}$/.test(name) || NON_PERSON_LABELS.has(name)) return '';
  const text = String(originalText || '').normalize('NFKC');
  const labelledName = /(?:^|[\r\n。；;])\s*(?:姓名|名字)\s*[:：]\s*([\u4e00-\u9fff]{2,4})(?=$|[\s，,。;；|｜/])/gmu;
  for (const match of text.matchAll(labelledName)) {
    if (match[1] === name) return name;
  }
  return '';
}

module.exports = { verifiedBossOcrName };
