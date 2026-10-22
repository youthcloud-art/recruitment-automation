const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const NodeCache = require('node-cache');
const { isSameZhilianResume } = require('../utils/zhilianResumeIdentity');
const { sameBossNearDuplicate,
  chooseBossNearDuplicate } = require('../utils/bossResumeIdentity');
const { SqliteResumeStore } = require('./sqliteResumeStore');

// 简历数据缓存，TTL为5分钟
const resumeCache = new NodeCache({ stdTTL: 300 });

function exactDuplicateInArray(resumes, incoming) {
  const sameSource = resumes.filter(item => item.source === incoming.source);
  if (incoming.source === 'boss') {
    if (incoming.sourceCandidateId) {
      const byId = sameSource.find(item =>
        item.sourceCandidateId === incoming.sourceCandidateId);
      if (byId) return byId;
    }
    if (!incoming.sourceFingerprint) return null;
    const compatible = sameSource.filter(item =>
      item.sourceFingerprint === incoming.sourceFingerprint &&
      !(incoming.sourceCandidateId && item.sourceCandidateId &&
        incoming.sourceCandidateId !== item.sourceCandidateId));
    return compatible.length === 1 ? compatible[0] : null;
  }
  return sameSource.find(item =>
    (incoming.sourceFingerprint && item.sourceFingerprint === incoming.sourceFingerprint) ||
    isSameZhilianResume(item, incoming)) || null;
}

/**
 * 简历模型类
 * 负责简历库的管理，包括简历的存储、分类、评分等功能
 */
class ResumeModel {
  constructor({ resumeStorageDir, storageEngine = process.env.RESUME_STORAGE_ENGINE } = {}) {
    // 简历库存储目录
    this.resumeStorageDir = resumeStorageDir || path.join(__dirname, '../../storage/resume_library');
    // 简历数据库文件
    this.dbFile = path.join(this.resumeStorageDir, 'resumes.json');
    // A restored data backup contains SQLite and the old JSON snapshot, but
    // deliberately excludes .env. Never silently open that stale JSON when
    // the storage setting has not yet been copied to the new host.
    const migratedSqlite = ['resumes.sqlite', 'resumes.sqlite.migration.json']
      .some(name => fs.existsSync(path.join(this.resumeStorageDir, name)));
    this.storageEngine = storageEngine || (migratedSqlite ? 'sqlite' : 'json');
    if (!['sqlite', 'json'].includes(this.storageEngine)) {
      throw new Error('RESUME_STORAGE_ENGINE 只能为 sqlite 或 json');
    }
    
    // 简历来源配置
    this.resumeSources = [
      { value: 'boss', label: 'Boss直聘' },
      { value: 'qcwy', label: '前程无忧' },
      { value: 'zlzp', label: '智联招聘' },
      { value: 'lagou', label: '拉勾网' },
      { value: 'liepin', label: '猎聘网' },
      { value: 'linkedin', label: 'LinkedIn' },
      { value: 'manual', label: '手动添加' }
    ];
    
    // 确保存储目录存在
    fs.ensureDirSync(this.resumeStorageDir);
    
    // 初始化数据库
    this.initDatabase();
    this.sqliteStore = this.storageEngine === 'sqlite'
      ? new SqliteResumeStore(this.dbFile) : null;
  }
  
  /**
   * 初始化数据库
   */
  initDatabase() {
    try {
      if (!fs.existsSync(this.dbFile) &&
          !(this.storageEngine === 'sqlite' &&
            (fs.existsSync(path.join(this.resumeStorageDir, 'resumes.sqlite')) ||
              fs.existsSync(path.join(this.resumeStorageDir, 'resumes.sqlite.migration.json'))))) {
        // 创建初始数据库结构
        const initialData = {
          resumes: [],
          positions: [],
          categories: []
        };
        this.writeDatabase(initialData);
      }
    } catch (error) {
      console.error('初始化简历数据库失败:', error);
      throw error;
    }
  }

  databaseCacheKey() {
    return `resume_database:${path.resolve(this.dbFile)}`;
  }
  
  /**
   * 读取数据库
   * @returns {Object} 数据库内容
   */
  readDatabase() {
    if (this.sqliteStore) return this.sqliteStore.readDatabase();
    const cacheKey = this.databaseCacheKey();
    let cachedDb = resumeCache.get(cacheKey);
    
    if (cachedDb) {
      // Callers mutate the returned document before writeDatabase. Never hand
      // them the cached object or a failed disk write would appear committed.
      return structuredClone(cachedDb);
    }
    
    try {
      const db = fs.readJsonSync(this.dbFile);
      resumeCache.set(cacheKey, db);
      return structuredClone(db);
    } catch (error) {
      console.error('读取简历数据库失败:', error);
      // 返回空库会使下一次写入覆盖仍在磁盘上的真实简历。
      throw error;
    }
  }
  
  /**
   * 写入数据库
   * @param {Object} data - 数据库内容
   */
  writeDatabase(data) {
    if (this.sqliteStore) {
      this.sqliteStore.writeDatabase(data);
      this.clearRelatedCache();
      return;
    }
    const directory = path.dirname(this.dbFile);
    const temporaryFile = path.join(directory,
      `.${path.basename(this.dbFile)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
    let descriptor;
    try {
      const json = JSON.stringify(data, null, 2);
      if (typeof json !== 'string') throw new TypeError('简历数据库内容无法序列化为 JSON');
      fs.ensureDirSync(directory);
      // 临时文件与正式文件位于同一目录，使 rename 保持在同一卷内。
      descriptor = fs.openSync(temporaryFile, 'wx', 0o600);
      fs.writeFileSync(descriptor, `${json}\n`, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      // Windows 上目标文件被占用时 rename 可能失败；保留原文件并向上报告。
      fs.renameSync(temporaryFile, this.dbFile);
      // 只有磁盘替换成功后才能发布新缓存。
      try {
        resumeCache.set(this.databaseCacheKey(), structuredClone(data));
        this.clearRelatedCache();
      } catch (cacheError) {
        resumeCache.del(this.databaseCacheKey());
        console.error('更新简历缓存失败:', cacheError);
      }
    } catch (error) {
      console.error('写入简历数据库失败:', error);
      throw error;
    } finally {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch (_) { /* 保留原始错误 */ }
      }
      try { fs.unlinkSync(temporaryFile); } catch (_) { /* 临时文件可能已被 rename */ }
    }
  }
  
  /**
   * 清除相关缓存
   */
  clearRelatedCache() {
    const keys = resumeCache.keys();
    keys.forEach(key => {
      if (key.startsWith('resumes_') || key.startsWith('positions_')) {
        resumeCache.del(key);
      }
    });
  }
  
  /**
   * 获取简历来源列表
   * @returns {Array} 简历来源列表
   */
  getResumeSources() {
    return this.resumeSources;
  }
  
  /**
   * 添加简历到简历库
   * @param {Object} resumeData - 简历数据
   * @returns {Object} 添加的简历信息
   */
  async addResume(resumeData, { returnStatus = false } = {}) {
    const db = this.sqliteStore ? null : this.readDatabase();
    // 页面上的动态文字会让同一份智联简历产生不同的原文哈希。
    if (db && resumeData.source) {
      let existing = exactDuplicateInArray(db.resumes,resumeData);
      if (!existing && resumeData.source === 'boss') {
        const near = db.resumes.filter(item => sameBossNearDuplicate(item, resumeData));
        existing = chooseBossNearDuplicate(near);
      }
      if (existing) return returnStatus ? { resume: existing, created: false } : existing;
    }
    
    // 生成简历ID
    const resumeId = `resume_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // 创建简历记录，保留原始解析数据
    const resumeRecord = {
      id: resumeId,
      
      // 直接使用解析数据，避免覆盖有效内容
      ...resumeData,
      
      // 确保必要的系统字段
      source: resumeData.source || 'manual',
      parseStatus: resumeData.parseStatus || 'pending',
      qualityScore: resumeData.qualityScore || 0,
      workflowStatus: resumeData.workflowStatus || 'new',
      candidateNotes: resumeData.candidateNotes || '',
      
      // 兼容旧字段（保留用于向后兼容）
      position: resumeData.source === 'qcwy'
        ? [resumeData.expectedPosition?.position, resumeData.position]
          .find(value => typeof value === 'string' && value.trim() && value.trim() !== '通知') || ''
        : resumeData.source === 'boss'
          ? resumeData.expectedPosition?.position || resumeData.position || ''
        : resumeData.expectedPosition?.position || resumeData.position || resumeData.name || '',
      experience: resumeData.workYears || resumeData.experience || '',
      
      // 时间戳
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    
    // 添加到数据库
    if (this.sqliteStore) {
      const result = this.sqliteStore.insertIfNew(resumeData, resumeRecord);
      return returnStatus ? result : result.resume;
    }
    db.resumes.push(resumeRecord);
    this.writeDatabase(db);

    return returnStatus ? { resume: resumeRecord, created: true } : resumeRecord;
  }
  
  /**
   * 获取简历列表
   * @param {string} positionId - 岗位ID（可选）
   * @param {string} source - 简历来源（可选）
   * @returns {Array} 简历列表
   */
  getResumes(positionId = null, source = null) {
    if (this.sqliteStore) return this.sqliteStore.getResumes(positionId, source);
    const db = this.readDatabase();
    let resumes = db.resumes;
    
    // 为缺少source字段的简历添加默认值
    resumes = resumes.map(resume => {
      if (!resume.source) {
        resume.source = 'manual'; // 默认来源为手动添加
      }
      return resume;
    });
    
    // 按来源筛选
    if (source) {
      resumes = resumes.filter(resume => resume.source === source);
    }
    
    // 按岗位筛选（这里简化处理，实际可能需要更复杂的关联逻辑）
    if (positionId) {
      resumes = resumes.filter(resume => resume.position === positionId);
    }
    
    // 按创建时间倒序排列
    return resumes.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  forEachResume(visitor, { source = null, jobRequirements = null } = {}) {
    if (typeof visitor !== 'function') throw new TypeError('简历读取回调无效');
    if (this.sqliteStore) {
      return this.sqliteStore.forEachResume(visitor, { source, jobRequirements });
    }
    let count = 0;
    for (const item of this.getResumes(null, source)) {
      if (jobRequirements !== null &&
          item.matchEvaluation?.jobRequirements !== jobRequirements) continue;
      visitor(item);
      count++;
    }
    return count;
  }

  getResumesPage({ position = null, source = null, sources = null, status = null,
    keyword = '', keywordFields = 'library', sortBy = 'createdAt', limit = 100, offset = 0 } = {}) {
    if (this.sqliteStore) {
      return this.sqliteStore.getResumesPage({ position, source, sources, status,
        keyword, keywordFields, sortBy, limit, offset });
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 500 ||
        !Number.isInteger(offset) || offset < 0) throw new Error('分页参数无效');
    if (!['createdAt', 'name', 'experience', 'education', 'age'].includes(sortBy)) {
      throw new Error('排序方式无效');
    }
    if (!['library', 'pipeline'].includes(keywordFields)) throw new Error('搜索范围无效');
    const term = String(keyword).trim().toLowerCase();
    const items = this.getResumes(position, source)
      .filter(item => !sources || sources.includes(item.source))
      .filter(item => !status || (item.workflowStatus || 'new') === status)
      .filter(item => !term || [item.name, item.position, item.expectedPosition?.position,
        typeof item.expectedPosition === 'string' ? item.expectedPosition : '',
        ...(Array.isArray(item.skills) ? item.skills : []),
        ...(keywordFields === 'library' ? [item.selfIntroduction,
          ...(Array.isArray(item.workExperience) ? item.workExperience.flatMap(exp =>
            [exp?.company, exp?.position]) : [])] : [])]
        .some(value => String(value || '').toLowerCase().includes(term)));
    if (sortBy !== 'createdAt') {
      const educationOrder = { '博士': 5, '硕士': 4, '本科': 3, '大专': 2, '高中': 1 };
      items.sort((a, b) => {
        if (sortBy === 'name') return String(a.name || '').localeCompare(String(b.name || ''));
        if (sortBy === 'experience') return (parseInt(b.workYears, 10) || 0) -
          (parseInt(a.workYears, 10) || 0);
        if (sortBy === 'education') return (educationOrder[b.education] || 0) -
          (educationOrder[a.education] || 0);
        return (parseInt(a.age, 10) || 0) - (parseInt(b.age, 10) || 0);
      });
    }
    return { items: items.slice(offset, offset + limit), total: items.length,
      limit, offset };
  }

  getSourceStatusCounts(sources) {
    if (this.sqliteStore) return this.sqliteStore.getSourceStatusCounts(sources);
    const counts = new Map();
    for (const resume of this.readDatabase().resumes) {
      if (!sources.includes(resume.source)) continue;
      const status = resume.workflowStatus || 'new';
      const key = `${resume.source}\u0000${status}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return [...counts].map(([key, total]) => {
      const [source, status] = key.split('\u0000');
      return { source, status, total };
    });
  }

  getResumeById(resumeId) {
    if (this.sqliteStore) return this.sqliteStore.getResumeById(resumeId);
    return this.readDatabase().resumes.find(item => item.id === resumeId) || null;
  }

  findDuplicateResume(incoming) {
    if (this.sqliteStore) return this.sqliteStore.findDuplicate(incoming);
    const resumes = this.getResumes();
    const exact = exactDuplicateInArray(resumes,incoming);
    if (exact || incoming.source !== 'boss') return exact;
    const near = resumes.filter(item => sameBossNearDuplicate(item,incoming));
    return chooseBossNearDuplicate(near);
  }

  // Read-only hint for the BOSS recommendation collector. It must not be
  // passed to addResume as a dedup key: two people can share a card teaser.
  findBossCardMatch(fingerprint) {
    if (this.sqliteStore) return this.sqliteStore.findBossCardMatch(fingerprint);
    if (!/^[a-f0-9]{64}$/.test(fingerprint || '')) return null;
    const matches = this.readDatabase().resumes.filter(item =>
      item.source === 'boss' && item.sourceCardFingerprint === fingerprint).slice(0, 2);
    if (matches.length !== 1) return null;
    const resume = matches[0];
    return resume.parseStatus === 'completed' && resume.sourceFingerprint &&
      String(resume.originalText || '').length >= 100 ? resume : null;
  }

  findWuyouDuplicate(incoming, { hasStableId = false } = {}) {
    if (this.sqliteStore) return this.sqliteStore.findWuyouDuplicate(incoming, { hasStableId });
    const normalized = incoming.originalText?.replace(/\s+/g, ' ').trim().toLowerCase();
    return this.getResumes().find(item => item.source === 'qcwy' &&
      ((incoming.sourceRecordKey && item.sourceRecordKey === incoming.sourceRecordKey) ||
        (hasStableId && incoming.sourceUrl && item.sourceUrl === incoming.sourceUrl) ||
        (incoming.sourceFingerprint && item.sourceFingerprint === incoming.sourceFingerprint) ||
        (normalized && item.originalText?.replace(/\s+/g, ' ').trim().toLowerCase() === normalized))) || null;
  }

  updateCandidateMetadata(resumeId, changes) {
    if (this.sqliteStore) {
      const resume = this.sqliteStore.getResumeById(resumeId);
      if (!resume) return null;
      Object.assign(resume, changes, { updatedAt: new Date().toISOString() });
      this.sqliteStore.putResume(resume);
      return resume;
    }
    const db = this.readDatabase();
    const resume = db.resumes.find(item => item.id === resumeId);
    if (!resume) return null;
    Object.assign(resume, changes, { updatedAt: new Date().toISOString() });
    this.writeDatabase(db);
    return resume;
  }
  
  /**
   * 上传简历文件
   * @param {string} filename - 文件名
   * @param {Buffer} buffer - 文件缓冲区
   * @returns {string} 文件路径
   */
  async uploadResumeFile(filename, buffer) {
    try {
      const filePath = path.join(this.resumeStorageDir, filename);
      await fs.writeFile(filePath, buffer);
      return filePath;
    } catch (error) {
      console.error('保存简历文件失败:', error);
      throw new Error('保存简历文件失败');
    }
  }
  
  /**
   * 根据岗位对简历进行评分
   * @param {string} resumeId - 简历ID
   * @param {string} positionId - 岗位ID
   * @param {Object} scoringCriteria - 评分标准
   * @returns {Object} 评分结果
   */
  async scoreResume(resumeId, positionId, scoringCriteria) {
    const db = this.sqliteStore
      ? { resumes: [this.getResumeById(resumeId)], positions: this.getPositions() }
      : this.readDatabase();
    
    // 查找简历
    const resume = db.resumes.find(r => r?.id === resumeId);
    if (!resume) {
      throw new Error('简历不存在');
    }
    
    // 查找岗位
    const position = db.positions.find(p => p.id === positionId);
    if (!position) {
      throw new Error('岗位不存在');
    }
    
    // 计算评分（简化实现）
    let totalScore = 0;
    let maxScore = 0;
    const scoreDetails = {};
    
    // 根据评分标准计算各项得分
    for (const [criteria, weight] of Object.entries(scoringCriteria)) {
      let score = 0;
      
      // 根据不同评分标准计算得分
      switch (criteria) {
        case 'education':
          // 学历匹配度评分
          score = this.calculateEducationScore(resume.education, position.education);
          break;
        case 'experience':
          // 工作经验评分
          score = this.calculateExperienceScore(resume.experience, position.experience);
          break;
        case 'skills':
          // 技能匹配度评分
          score = this.calculateSkillsScore(resume.skills, position.skills);
          break;
        default:
          // 其他自定义评分标准
          score = 0;
      }
      
      scoreDetails[criteria] = {
        score: score,
        weight: weight,
        weightedScore: score * weight
      };
      
      totalScore += score * weight;
      maxScore += 100 * weight;
    }
    
    // 计算总分（百分制）
    const finalScore = maxScore > 0 ? Math.round((totalScore / maxScore) * 100) : 0;
    
    // 保存评分结果
    const scoreRecord = {
      resumeId,
      positionId,
      score: finalScore,
      details: scoreDetails,
      createdAt: new Date().toISOString()
    };
    
    // 更新简历记录
    if (!resume.scores) {
      resume.scores = [];
    }
    resume.scores.push(scoreRecord);
    resume.updatedAt = new Date().toISOString();
    
    if (this.sqliteStore) this.sqliteStore.putResume(resume);
    else this.writeDatabase(db);
    
    return scoreRecord;
  }
  
  /**
   * 计算学历匹配度评分
   * @param {string} resumeEducation - 简历中的学历
   * @param {string} positionEducation - 岗位要求的学历
   * @returns {number} 评分（0-100）
   */
  calculateEducationScore(resumeEducation, positionEducation) {
    const educationLevels = {
      '高中': 1,
      '大专': 2,
      '本科': 3,
      '硕士': 4,
      '博士': 5
    };
    
    const resumeLevel = educationLevels[resumeEducation] || 0;
    const positionLevel = educationLevels[positionEducation] || 0;
    
    // 如果简历学历大于等于要求学历，得满分
    if (resumeLevel >= positionLevel) {
      return 100;
    }
    
    // 否则按比例评分
    return Math.max(0, 100 - (positionLevel - resumeLevel) * 20);
  }
  
  /**
   * 计算工作经验评分
   * @param {string} resumeExperience - 简历中的工作经验
   * @param {string} positionExperience - 岗位要求的工作经验
   * @returns {number} 评分（0-100）
   */
  calculateExperienceScore(resumeExperience, positionExperience) {
    // 提取数字部分
    const resumeExp = parseInt(resumeExperience) || 0;
    const positionExp = parseInt(positionExperience) || 0;
    
    // 如果简历经验大于等于要求经验，得满分
    if (resumeExp >= positionExp) {
      return 100;
    }
    
    // 否则按比例评分
    return Math.max(0, Math.round((resumeExp / positionExp) * 100));
  }
  
  /**
   * 计算技能匹配度评分
   * @param {Array} resumeSkills - 简历中的技能列表
   * @param {Array} positionSkills - 岗位要求的技能列表
   * @returns {number} 评分（0-100）
   */
  calculateSkillsScore(resumeSkills, positionSkills) {
    if (!resumeSkills || !positionSkills || resumeSkills.length === 0 || positionSkills.length === 0) {
      return 0;
    }
    
    // 计算匹配的技能数量
    const matchedSkills = resumeSkills.filter(skill => 
      positionSkills.some(positionSkill => 
        skill.toLowerCase().includes(positionSkill.toLowerCase()) ||
        positionSkill.toLowerCase().includes(skill.toLowerCase())
      )
    );
    
    // 计算匹配度
    const matchRatio = matchedSkills.length / positionSkills.length;
    return Math.round(matchRatio * 100);
  }

  /**
   * 获取所有岗位
   * @returns {Array} 岗位列表
   */
  getPositions() {
    try {
      if (this.sqliteStore) return this.sqliteStore.getPositions();
      const db = this.readDatabase();
      return db.positions || [];
    } catch (error) {
      console.error('获取岗位列表失败:', error);
      return [];
    }
  }

  /**
   * 添加岗位
   * @param {Object} positionData - 岗位数据
   * @returns {Object} 添加的岗位信息
   */
  async addPosition(positionData) {
    try {
      const db = this.sqliteStore ? null : this.readDatabase();
      
      // 生成岗位ID
      const positionId = `position_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      // 创建岗位记录
      const positionRecord = {
        id: positionId,
        title: positionData.title || '',
        name: positionData.name || positionData.title || '',
        company: positionData.company || '',
        department: positionData.department || '',
        experience: positionData.experience || '',
        education: positionData.education || '',
        skills: positionData.skills || [],
        salary: positionData.salary || '',
        description: positionData.description || '',
        responsibilities: positionData.responsibilities || '',
        requirements: positionData.requirements || '',
        benefits: positionData.benefits || '',
        location: positionData.location || '',
        searchKeywords: positionData.searchKeywords || '',
        targetCount: positionData.targetCount ?? null,
        jobCriteria: positionData.jobCriteria || null,
        createdLocally: Boolean(positionData.createdLocally),
        type: positionData.type || '全职',
        status: positionData.status || '招聘中',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      
      // 添加到数据库
      if (this.sqliteStore) {
        this.sqliteStore.mutatePositions(positions => {
          positions.push(positionRecord);
          return { changed: true };
        });
      } else {
        if (!db.positions) db.positions = [];
        db.positions.push(positionRecord);
        this.writeDatabase(db);
      }
      
      console.log('岗位添加成功:', positionRecord.title);
      return positionRecord;
    } catch (error) {
      console.error('添加岗位失败:', error);
      throw error;
    }
  }

  /**
   * 根据ID获取岗位
   * @param {string} positionId - 岗位ID
   * @returns {Object|null} 岗位信息
   */
  getPositionById(positionId) {
    try {
      const positions = this.sqliteStore ? this.sqliteStore.getPositions()
        : this.readDatabase().positions;
      return positions?.find(p => p.id === positionId) || null;
    } catch (error) {
      console.error('根据ID获取岗位失败:', error);
      return null;
    }
  }

  /**
   * 更新岗位信息
   * @param {string} positionId - 岗位ID
   * @param {Object} updatedData - 更新的数据
   * @returns {Object} 更新结果
   */
  async updatePosition(positionId, updatedData) {
    try {
      if (this.sqliteStore) return this.sqliteStore.mutatePositions(positions => {
        const positionIndex = positions.findIndex(p => p.id === positionId);
        if (positionIndex === -1) return { changed: false,
          result: { success: false, error: '岗位不存在' } };
        const updatedPosition = { ...positions[positionIndex], ...updatedData,
          updatedAt: new Date().toISOString() };
        positions[positionIndex] = updatedPosition;
        return { changed: true, result: { success: true, position: updatedPosition,
          message: '岗位更新成功' } };
      });
      const db = this.readDatabase();
      const positionIndex = db.positions.findIndex(p => p.id === positionId);
      
      if (positionIndex === -1) {
        return {
          success: false,
          error: '岗位不存在'
        };
      }

      // 更新岗位数据
      const updatedPosition = {
        ...db.positions[positionIndex],
        ...updatedData,
        updatedAt: new Date().toISOString()
      };

      db.positions[positionIndex] = updatedPosition;
      this.writeDatabase(db);

      return {
        success: true,
        position: updatedPosition,
        message: '岗位更新成功'
      };
    } catch (error) {
      console.error('更新岗位失败:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * 删除简历
   * @param {string} resumeId - 简历ID
   * @returns {Object} 删除结果
   */
  async deleteResume(resumeId) {
    try {
      if (this.sqliteStore) {
        const resume = this.getResumeById(resumeId);
        if (!resume) return { success: false, error: '简历不存在' };
        this.sqliteStore.deleteResume(resumeId);
        return { success: true, resume, message: '简历删除成功' };
      }
      const db = this.readDatabase();
      const resumeIndex = db.resumes.findIndex(r => r.id === resumeId);
      
      if (resumeIndex === -1) {
        return {
          success: false,
          error: '简历不存在'
        };
      }

      // 删除简历
      const deletedResume = db.resumes[resumeIndex];
      db.resumes.splice(resumeIndex, 1);
      this.writeDatabase(db);

      return {
        success: true,
        resume: deletedResume,
        message: '简历删除成功'
      };
    } catch (error) {
      console.error('删除简历失败:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * 清空所有简历
   * @returns {Object} 清空结果
   */
  async clearAllResumes() {
    try {
      if (this.sqliteStore) {
        const count = this.sqliteStore.clearAllResumes();
        return { success: true, count, message: `成功清空 ${count} 份简历` };
      }
      const db = this.readDatabase();
      const resumeCount = db.resumes.length;
      
      // 清空简历数组
      db.resumes = [];
      this.writeDatabase(db);

      return {
        success: true,
        count: resumeCount,
        message: `成功清空 ${resumeCount} 份简历`
      };
    } catch (error) {
      console.error('清空简历失败:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * 删除岗位
   * @param {string} positionId - 岗位ID
   * @returns {Object} 删除结果
   */
  async deletePosition(positionId) {
    try {
      if (this.sqliteStore) return this.sqliteStore.mutatePositions(positions => {
        const positionIndex = positions.findIndex(p => p.id === positionId);
        if (positionIndex === -1) return { changed: false,
          result: { success: false, error: '岗位不存在' } };
        if (this.sqliteStore.hasResumeForPositionId(positionId)) return { changed: false,
          result: { success: false, error: '该岗位还有关联的简历，无法删除' } };
        const [deletedPosition] = positions.splice(positionIndex, 1);
        return { changed: true, result: { success: true, position: deletedPosition,
          message: '岗位删除成功' } };
      });
      const db = this.readDatabase();
      const positionIndex = db.positions.findIndex(p => p.id === positionId);
      
      if (positionIndex === -1) {
        return {
          success: false,
          error: '岗位不存在'
        };
      }

      // 检查是否有简历关联此岗位
      const hasRelatedResumes = db.resumes.some(resume => resume.positionId === positionId);
      if (hasRelatedResumes) {
        return {
          success: false,
          error: '该岗位还有关联的简历，无法删除'
        };
      }

      // 删除岗位
      const deletedPosition = db.positions[positionIndex];
      db.positions.splice(positionIndex, 1);
      this.writeDatabase(db);

      return {
        success: true,
        position: deletedPosition,
        message: '岗位删除成功'
      };
    } catch (error) {
      console.error('删除岗位失败:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }
}

module.exports = new ResumeModel();
module.exports.ResumeModel = ResumeModel;
