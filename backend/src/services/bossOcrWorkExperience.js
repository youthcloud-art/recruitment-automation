'use strict';

// A BOSS resume canvas often OCRs several visual rows into one long line.
// The general resume parser expects a company on its own line; this narrow
// fallback only records an employer and dates that occur together inside a
// verified work-history section. It never invents a missing role or employer.
const WORK_HEADING = /工作经历|任职经历|工作经验/;
const NEXT_HEADING = /教育经历|教育背景|项目经历|专业技能|技能特长|求职意向/;
const DATE_RANGE = /(?<startYear>(?:19|20)\d{2})\s*(?:[.\/年-]\s*(?<startMonth>0?[1-9]|1[0-2])\s*月?)?\s*[-~—–至到]+\s*(?:(?<endYear>(?:19|20)\d{2})\s*(?:[.\/年-]\s*(?<endMonth>0?[1-9]|1[0-2])\s*月?)?|(?<present>至今|现在))/gu;
const COMPANY = /([\p{Script=Han}A-Za-z][\p{Script=Han}A-Za-z0-9·()（）&-]{1,38}?(?:有限责任公司|股份有限公司|有限公司|公司|集团|工厂))/gu;
const ROLE = /([\p{Script=Han}]{1,16}(?:销售工程师|技术工程师|工程师|销售经理|项目经理|经理|主管|专员|顾问|负责人|销售))/u;

function extractBossOcrWorkExperience(value) {
  const text=String(value || '');
  const match=WORK_HEADING.exec(text);
  if (!match) return [];
  const after=text.slice(match.index+match[0].length);
  const next=NEXT_HEADING.exec(after);
  const section=next ? after.slice(0,next.index) : after;
  // Require a substantial OCR section. A short card teaser with one date is
  // not evidence of an employer's work history.
  if (section.length<120) return [];
  const results=[];
  const seen=new Set();
  for (const date of section.matchAll(DATE_RANGE)) {
    const startYear=Number(date.groups.startYear);
    const endYear=Number(date.groups.endYear || new Date().getFullYear());
    if (startYear<1950 || startYear>new Date().getFullYear()+1 ||
        endYear<startYear || endYear>new Date().getFullYear()+1) continue;
    const before=section.slice(Math.max(0,date.index-80),date.index);
    const employers=[...before.matchAll(COMPANY)];
    const employer=employers.at(-1);
    if (!employer) continue;
    const company=employer[1].replace(/^(?:工作经历|任职经历|工作经验)/,'').trim();
    const between=before.slice(employer.index+employer[0].length);
    if (company.length<5 || company.length>40 ||
        /工作经历|任职经历|工作经验|教育经历|负责|参与|项目/.test(company) ||
        between.length>28 || /[。；;!?！？]/.test(between)) continue;
    const role=ROLE.exec(between)?.[1] || '';
    const duration=date[0].replace(/\s+/g,' ').trim();
    const key=`${company}\u0000${duration}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({company,position:role,duration,description:'',
      verificationStatus:'ocr_needs_review'});
    if (results.length>=12) break;
  }
  return results;
}

module.exports={extractBossOcrWorkExperience};
