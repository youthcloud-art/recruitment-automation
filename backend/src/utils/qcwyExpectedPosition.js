// 51job often renders an intent row as one text node with no separator
// between the desired role and city, e.g. "销售工程师无锡、常州全职8千/月".
// Only derive a role when the city/employment/salary structure is explicit.
const CITIES = [
  '北京', '上海', '广州', '深圳', '杭州', '南京', '成都', '武汉', '西安',
  '重庆', '天津', '苏州', '青岛', '大连', '厦门', '宁波', '无锡', '长沙',
  '郑州', '济南', '福州', '合肥', '昆明', '南昌', '贵阳', '太原',
  '石家庄', '哈尔滨', '长春', '沈阳', '乌鲁木齐', '兰州', '银川',
  '西宁', '拉萨', '呼和浩特', '南宁', '海口', '三亚', '常州',
  '惠州', '佛山', '东莞', '珠海', '中山', '嘉兴', '绍兴', '温州',
  '宜昌', '泉州'
];
const CITY = `(?:${CITIES.sort((a, b) => b.length - a.length).join('|')})`;
const ROLE_AND_CITIES = new RegExp(`^(.{2,30}?)(${CITY}(?:[、，,]${CITY})*)$`, 'u');
const ROLE = /^[\p{Script=Han}A-Za-z0-9/（）()·+& -]{2,30}$/u;

function extractQcwyExpectedPosition(originalText) {
  const text = String(originalText || '');
  const match = /(?:^|\n)\s*求职意向\s*\n([\s\S]{0,1800}?)(?=\n\s*(?:工作经历|教育经历|个人优势|项目经历|技能特长)(?:\s|$)|$)/u.exec(text);
  if (!match) return '';
  for (const rawLine of match[1].split(/\r?\n/u)) {
    const line = rawLine.replace(/\s+/gu, ' ').trim();
    const employment = /全职|兼职|实习/u.exec(line);
    if (!employment || !/\d/u.test(line.slice(employment.index + employment[0].length))) continue;
    const prefix = line.slice(0, employment.index).trim();
    const fields = ROLE_AND_CITIES.exec(prefix);
    const role = fields?.[1]?.trim() || '';
    if (ROLE.test(role) && !/^(?:求职意向|期望职位|求职偏好|岗位经验)$/u.test(role)) {
      return role;
    }
  }
  return '';
}

module.exports = { extractQcwyExpectedPosition };
