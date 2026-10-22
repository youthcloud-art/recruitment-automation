const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const XLSX = require('xlsx');

const MAX_TEMPLATE_BYTES = 1_500_000;

const DEFAULT_FILE = path.join(__dirname, '../../../.local/active-job.json');
const EMPTY_JOB = Object.freeze({
  title: '', searchKeywords: '', location: '', education: '',
  minExperienceYears: null, targetCount: null, recommendationTargetCount: null,
  jobRequirements: '', updatedAt: null
});

function field(value, label, maxLength) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error(`${label}格式无效`);
  }
  const text = String(value).replace(/\r\n?/g, '\n').trim();
  if (text.length > maxLength || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) {
    throw new Error(`${label}内容过长或包含无效字符`);
  }
  return text;
}

function optionalInteger(value, label, max) {
  if (value === undefined || value === null || value === '') return null;
  const numeric = Number(value);
  const minimum = ['目标份数', '推荐人数'].includes(label) ? 1 : 0;
  if (!Number.isInteger(numeric) || numeric < 0 || numeric > max ||
      numeric < minimum) {
    throw new Error(`${label}需为${minimum}～${max}之间的整数`);
  }
  return numeric;
}

function normalizeJob(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('岗位配置格式无效');
  }
  const title = field(input.title, '岗位名称', 100);
  const searchKeywords = field(input.searchKeywords || title, '搜索关键词', 200);
  const rawRequirements = field(input.jobRequirements, '详细岗位要求', 5000);
  if (title.length < 2) throw new Error('请填写至少 2 字的岗位名称');
  if (rawRequirements.length < 5) throw new Error('请填写至少 5 字的详细岗位要求');
  const keywords = searchKeywords.split(/[,，、\n]/).map(value => value.trim()).filter(Boolean);
  if (!keywords.length || keywords.length > 10 || keywords.some(value => value.length > 30)) {
    throw new Error('搜索关键词需为 1～10 个，每个不超过 30 字');
  }
  const location = field(input.location, '工作地点', 100);
  const education = field(input.education, '学历要求', 100);
  const minExperienceYears = optionalInteger(input.minExperienceYears, '最低经验年数', 50);
  // Keep manually entered structured fields in the exact text used by all three
  // platform evaluations and by mail/report selection. Replacing these lines
  // makes a subsequent edit or save idempotent instead of retaining stale criteria.
  const detailLines = rawRequirements.split('\n').filter(line =>
    !/^(岗位名称|工作地点|工作经验|学历要求)：/.test(line.trim()));
  const jobRequirements = [
    `岗位名称：${title}`,
    location && location !== '不限' ? `工作地点：${location}` : '',
    minExperienceYears !== null ? `工作经验：至少${minExperienceYears}年` : '',
    education && education !== '不限' ? `学历要求：${education}` : '',
    ...detailLines
  ].filter(Boolean).join('\n').trim();
  if (jobRequirements.length > 5000) throw new Error('详细岗位要求内容过长');
  return {
    title,
    searchKeywords: keywords.join('，'),
    location,
    education,
    minExperienceYears,
    targetCount: optionalInteger(input.targetCount, '目标份数', 200),
    recommendationTargetCount: optionalInteger(input.recommendationTargetCount, '推荐人数', 200),
    jobRequirements,
    updatedAt: new Date().toISOString()
  };
}

const LABELS = {
  '岗位名称': 'title', '招聘岗位': 'title', '职位名称': 'title',
  '搜索关键词': 'searchKeywords', '岗位关键词': 'searchKeywords',
  '工作地点': 'location', '最低经验（年）': 'minExperienceYears',
  '最低经验(年)': 'minExperienceYears', '最低经验年限': 'minExperienceYears',
  '最低学历': 'education', '学历要求': 'education',
  '必需技能': 'requiredSkills', '必须技能': 'requiredSkills', '必备技能': 'requiredSkills',
  '优先技能': 'preferredSkills', '加分条件': 'preferredSkills',
  '岗位职责': 'responsibilities', '任职要求': 'otherRequirements',
  '其他要求': 'otherRequirements', '详细岗位要求': 'otherRequirements',
  '推荐人数': 'recommendationTargetCount', '推荐份数': 'recommendationTargetCount',
  '推荐名单人数': 'recommendationTargetCount',
  '目标简历份数': 'targetCount', '采集目标份数': 'targetCount',
  '单次采集目标份数': 'targetCount'
};

function readableXlsxBuffer(buffer, { sourcePath } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_TEMPLATE_BYTES) {
    throw new Error('请上传不超过 1.5 MB 的 .xlsx 岗位条件模板');
  }
  // Some Windows file providers expose a 887d1c wrapper to Node, while
  // Python's file API sees OOXML. A trusted original path is preferable;
  // uploaded buffers use a bounded temporary copy. HTTP never supplies a path.
  if (buffer[0] === 0x88 && buffer[1] === 0x7d && buffer[2] === 0x1c) {
    let temporaryDirectory;
    let temporaryFile;
    try {
      if (sourcePath !== undefined &&
          (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath) ||
           path.extname(sourcePath).toLowerCase() !== '.xlsx' ||
           !fs.readFileSync(sourcePath).equals(buffer))) {
        throw new Error('original file path does not match uploaded bytes');
      }
      if (sourcePath === undefined) {
        temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'recruit-job-'));
        temporaryFile = path.join(temporaryDirectory, 'import.xlsx');
        fs.writeFileSync(temporaryFile, buffer);
      }
      // Fixed Python code only reads bounded bytes from the same local file;
      // the path is passed as an argument, without shell interpolation.
      const script = [
        'import base64,sys',
        `with open(sys.argv[1], "rb") as f: data=f.read(${MAX_TEMPLATE_BYTES + 1})`,
        `if len(data)>${MAX_TEMPLATE_BYTES}: sys.exit(2)`,
        'sys.stdout.write(base64.b64encode(data).decode("ascii"))'
      ].join('\n');
      const encoded = execFileSync('python', ['-c', script,
        sourcePath === undefined ? temporaryFile : sourcePath], {
        encoding: 'ascii', timeout: 5000, maxBuffer: 2_100_000,
        windowsHide: true
      });
      buffer = Buffer.from(encoded.trim(), 'base64');
    } catch (_) {
      throw new Error('此 Excel 文件无法在本机读取，请用 Excel 另存为 .xlsx 后重新导入');
    } finally {
      if (temporaryFile) fs.unlinkSync(temporaryFile);
      if (temporaryDirectory) fs.rmdirSync(temporaryDirectory);
    }
  }
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new Error('Excel 文件无法读取，请下载最新岗位条件模板重新填写');
  }
  return buffer;
}

function parseJobTemplate(buffer, options) {
  buffer = readableXlsxBuffer(buffer, options);
  let workbook;
  try { workbook = XLSX.read(buffer, { type: 'buffer', cellFormula: true, cellHTML: false }); }
  catch (_) { throw new Error('Excel 文件无法读取，请下载最新岗位条件模板重新填写'); }
  const sheet = workbook.Sheets['岗位筛选条件'] || workbook.Sheets['岗位条件'] ||
    workbook.SheetNames.map(name => workbook.Sheets[name]).find(candidate =>
      String(candidate?.A2?.v || '').trim() === '岗位筛选条件' &&
      String(candidate?.A7?.v || '').trim() === '岗位名称' &&
      ['必需技能', '必须技能', '必备技能'].includes(String(candidate?.A11?.v || '').trim()));
  if (!sheet) throw new Error('模板缺少“岗位筛选条件”工作表');
  const values = {};
  const bounds = XLSX.utils.decode_range(sheet['!ref'] || 'A1:A1');
  if (bounds.e.r > 200 || bounds.e.c > 30) throw new Error('模板范围过大，请下载最新模板重新填写');
  for (let rowNumber = bounds.s.r + 1; rowNumber <= bounds.e.r + 1; rowNumber++) {
    const label = String(sheet[`A${rowNumber}`]?.v || '').trim();
    const key = LABELS[label];
    if (!key) {
      const unknown = sheet[`B${rowNumber}`];
      if (rowNumber >= 7 && label && (unknown?.f || String(unknown?.v ?? '').trim())) {
        throw new Error(`模板存在无法识别的字段“${label}”，请使用最新模板或手动填写`);
      }
      continue;
    }
    const valueCell = sheet[`B${rowNumber}`];
    if (valueCell?.f) throw new Error(`${label}不能使用公式，请填写固定内容`);
    if (values[key] !== undefined) throw new Error(`模板中的“${label}”重复`);
    values[key] = valueCell?.v ?? '';
  }
  if (!values.title) throw new Error('模板缺少岗位名称，请在对应的黄色单元格填写');
  const title = field(values.title, '岗位名称', 100);
  const location = field(values.location, '工作地点', 100);
  const education = field(values.education, '学历要求', 100);
  const minExperienceYears = optionalInteger(values.minExperienceYears, '最低经验年数', 50);
  const requiredSkills = field(values.requiredSkills, '必需技能', 3000);
  const preferredSkills = field(values.preferredSkills, '优先技能', 3000);
  const responsibilities = field(values.responsibilities, '岗位职责', 3000);
  const otherRequirements = field(values.otherRequirements, '其他要求', 3000);
  if (!requiredSkills && !preferredSkills && !responsibilities && !otherRequirements &&
      minExperienceYears === null && (!education || education === '不限')) {
    throw new Error('模板至少填写一项岗位条件，如必需技能、学历或工作经验');
  }
  const requirements = [
    `岗位名称：${title}`,
    location && location !== '不限' ? `工作地点：${location}` : '',
    minExperienceYears !== null ? `工作经验：至少${minExperienceYears}年` : '',
    education && education !== '不限' ? `学历要求：${education}` : '',
    requiredSkills ? `必需技能：${requiredSkills}` : '',
    preferredSkills ? `优先技能：${preferredSkills}` : '',
    responsibilities ? `岗位职责：${responsibilities}` : '',
    otherRequirements ? `其他要求：${otherRequirements}` : ''
  ].filter(Boolean).join('\n');
  return normalizeJob({
    title, searchKeywords: values.searchKeywords || title, location, education,
    minExperienceYears, targetCount: values.targetCount,
    recommendationTargetCount: values.recommendationTargetCount,
    jobRequirements: requirements
  });
}

class ActiveJobService {
  constructor({ file = DEFAULT_FILE } = {}) { this.file = file; }

  current() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return { ...EMPTY_JOB, ...saved };
    } catch (error) {
      if (error.code === 'ENOENT') return { ...EMPTY_JOB };
      throw error;
    }
  }

  save(input) {
    const normalized = normalizeJob(input);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(normalized, null, 2), { mode: 0o600 });
      fs.renameSync(temporary, this.file);
    } finally {
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return normalized;
  }

  import(buffer, options) { return this.save(parseJobTemplate(buffer, options)); }
}

module.exports = { ActiveJobService, normalizeJob, parseJobTemplate,
  readableXlsxBuffer, EMPTY_JOB };
