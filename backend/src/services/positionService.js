const ResumeModel = require('../models/resumeModel');
const NodeCache = require('node-cache');
const { ActiveJobService, normalizeJob } = require('./activeJobService');

// 岗位服务缓存，TTL为10分钟
const positionCache = new NodeCache({ stdTTL: 600 });
const LLMService = require('./llmService');

class PositionService {
  constructor({ resumeModel = ResumeModel, activeJobService = new ActiveJobService() } = {}) {
    this.resumeModel = resumeModel;
    this.activeJobService = activeJobService;
    this.llmService = null;
  }

  positionDataFromJob(job, metadata = {}) {
    const lines = job.jobRequirements.split('\n').map(line => line.trim()).filter(Boolean);
    const skillLine = lines.find(line => /^必需技能[：:]/.test(line)) || '';
    const responsibilityLines = lines.filter(line => /^岗位职责[：:]/.test(line))
      .flatMap(line => line.replace(/^岗位职责[：:]\s*/, '').split(/[；;\n]/).map(item => item.trim()).filter(Boolean));
    const requirements = lines.filter(line => !/^(岗位名称|岗位职责)[：:]/.test(line));
    const skills = skillLine.replace(/^必需技能[：:]\s*/, '').split(/[,，、；;]/)
      .map(item => item.trim()).filter(Boolean).slice(0, 20);
    return {
      title: job.title, name: job.title, location: job.location,
      department: metadata.department || '', salary: metadata.salary || '',
      education: job.education, experience: job.minExperienceYears ?? '',
      skills, responsibilities: responsibilityLines, requirements, benefits: [],
      description: [
        `# ${job.title}`,
        metadata.department ? `所属部门：${metadata.department}` : '',
        metadata.salary ? `薪资范围：${metadata.salary}` : '',
        job.jobRequirements
      ].filter(Boolean).join('\n\n'),
      searchKeywords: job.searchKeywords, targetCount: job.targetCount,
      recommendationTargetCount: job.recommendationTargetCount,
      jobCriteria: job, createdLocally: true, status: '招聘中'
    };
  }

  sameJob(left, right) {
    if (!left || !right) return false;
    return ['title', 'searchKeywords', 'location', 'education', 'minExperienceYears',
      'targetCount', 'recommendationTargetCount', 'jobRequirements'].every(key =>
      (left[key] ?? null) === (right[key] ?? null));
  }

  draftLocalPosition(description) {
    if (typeof description !== 'string' || description.trim().length < 10 ||
        description.length > 5000) {
      throw new Error('请用 10～5000 字描述岗位名称及具体要求');
    }
    const text = description.replace(/\r\n?/g, '\n').trim();
    const explicitTitle = text.match(/(?:岗位名称|职位名称)[：:]\s*([^，。,；;\n]{2,40})/);
    const recruitTitle = text.match(/(?:招聘|招募)\s*(?:一名|一位|一个)?\s*([^，。,；;\s]{2,30})(?:岗位|职位)?/);
    const firstSegment = text.split(/[，。,；;\n]/)[0].trim();
    let title = (explicitTitle?.[1] || recruitTitle?.[1] ||
      (/^[^\s]{2,30}(?:经理|主管|工程师|专员|顾问|设计师)$/.test(firstSegment)
        ? firstSegment : '')).trim();
    title = title.replace(/(?:岗位|职位)$/, '').trim();
    if (/^(?:岗位|职位|新的|新|招聘|创建)$/.test(title)) title = '';
    const experience = text.match(/(?:至少|不低于)\s*(\d{1,2})\s*年|\b(\d{1,2})\s*年以上/);
    const education = text.match(/(?:博士|硕士|研究生|本科|大专)(?:及以上|以上)?/);
    const location = text.match(/(?:工作地点|工作城市)[：:]\s*([^，。,；;\n]{2,40})/);
    const collectCount = text.match(/(?:获取|采集|筛选)\s*(\d{1,3})\s*份(?:简历)?/);
    const recommendCount = text.match(/推荐\s*(\d{1,3})\s*(?:份(?:简历)?|人)/);
    return {
      title,
      searchKeywords: title,
      location: location?.[1]?.trim() || '',
      education: education?.[0] || '',
      minExperienceYears: experience ? Number(experience[1] || experience[2]) : null,
      targetCount: collectCount ? Number(collectCount[1]) : null,
      recommendationTargetCount: recommendCount ? Number(recommendCount[1]) : null,
      // Keep the user's own conditions as the editable JD draft. This avoids
      // inventing skills, responsibilities or benefits that were not supplied.
      jobRequirements: text,
      updatedAt: null
    };
  }

  // Create a local, reusable job record and apply exactly the same criteria to
  // the three platform collectors. No third-party vacancy is published here.
  async createLocalPosition(input, metadata = {}) {
    const job = normalizeJob(input);
    const checkedMetadata = {};
    for (const key of ['department', 'salary']) {
      const value = metadata?.[key];
      if (value !== undefined && (typeof value !== 'string' || value.length > 100 ||
          /[\x00-\x1f]/.test(value))) throw new Error(`${key}格式无效`);
      checkedMetadata[key] = (value || '').trim();
    }
    const previous = this.activeJobService.current();
    const existing = this.resumeModel.getPositions();
    const match = existing.find(position => this.sameJob(position.jobCriteria, job));
    const added = [];
    try {
      // Preserve a job set through the older active-job editor before it is
      // replaced, so it can later be selected again from the local job list.
      if (previous.title && previous.jobRequirements &&
          !this.sameJob(previous, job) &&
          !existing.some(position => this.sameJob(position.jobCriteria, previous))) {
        added.push(await this.resumeModel.addPosition(this.positionDataFromJob(previous)));
      }
      const position = match || await this.resumeModel.addPosition(this.positionDataFromJob(job, checkedMetadata));
      if (!match) added.push(position);
      const savedJob = this.activeJobService.save(job);
      positionCache.del('all_positions');
      return { position, job: savedJob, reused: Boolean(match) };
    } catch (error) {
      for (const position of added.reverse()) {
        const rollback = await this.resumeModel.deletePosition(position.id);
        if (!rollback.success) error.message += '；本地岗位记录回滚失败，请检查岗位列表';
      }
      positionCache.del('all_positions');
      throw error;
    }
  }

  applyLocalPosition(positionId) {
    const position = this.resumeModel.getPositionById(positionId);
    if (!position) throw new Error('岗位不存在');
    if (!position.jobCriteria) throw new Error('该岗位没有可应用的三平台筛选条件');
    const job = this.activeJobService.save(position.jobCriteria);
    return { position, job };
  }
  
  // 延迟初始化LLM服务
  async initLLMService() {
    if (!this.llmService) {
      try {
        this.llmService = new LLMService();
        console.log('✅ LLM服务初始化成功');
      } catch (error) {
        console.warn('大语言模型服务初始化失败，将使用模拟模式:', error.message);
      }
    }
    return this.llmService;
  }

  async createPositionFromDialog(userMessage, thinkingCallback = null, finalAnswerCallback = null) {
    try {
      const positionInfo = await this.parsePositionInfo(userMessage, thinkingCallback);
      const jobDescription = await this.generateJobDescription(positionInfo, thinkingCallback);
      
      const positionData = {
        title: positionInfo.title,
        department: positionInfo.department,
        location: positionInfo.location,
        salary: positionInfo.salary,
        experience: positionInfo.experience,
        education: positionInfo.education,
        skills: positionInfo.skills,
        responsibilities: jobDescription.responsibilities,
        requirements: jobDescription.requirements,
        benefits: jobDescription.benefits,
        description: jobDescription.fullDescription,
        status: 'active',
        createdFromDialog: true,
        originalMessage: userMessage
      };

      const position = await this.resumeModel.addPosition(positionData);
      positionCache.del('all_positions');
      
      const result = {
        success: true,
        position: position,
        summary: `已成功创建岗位"${position.title}"，包含完整的岗位描述和要求。`
      };

      if (finalAnswerCallback) {
        finalAnswerCallback(result);
      }

      return result;

    } catch (error) {
      console.error('创建岗位失败:', error);
      const errorResult = {
        success: false,
        error: error.message,
        summary: '创建岗位时出现错误，请重试。'
      };

      if (finalAnswerCallback) {
        finalAnswerCallback(errorResult);
      }

      throw error;
    }
  }

  async parsePositionInfo(userMessage, thinkingCallback = null) {
    // 确保LLM服务已初始化
    await this.initLLMService();
    
    if (!this.llmService) {
      return this.simplePositionParsing(userMessage);
    }

    const prompt = `
请分析以下用户输入的岗位描述，提取关键信息并返回JSON格式的结果：

用户输入：${userMessage}

请提取以下信息：
1. title: 岗位标题
2. department: 部门（如果提到）
3. location: 工作地点（如果提到）
4. salary: 薪资范围（如果提到）
5. experience: 工作经验要求（年数）
6. education: 学历要求
7. skills: 技能要求（数组）

请只返回JSON格式的结果，不要包含其他文字。
`;

    const messages = [
      { role: 'system', content: '你是一个专业的HR助手，擅长分析岗位描述并提取关键信息。' },
      { role: 'user', content: prompt }
    ];

    try {
      const response = await this.llmService.chatWithLLM(messages, thinkingCallback);
      
      // 清理响应内容，移除可能的控制字符
      const cleanResponse = response.replace(/[\x00-\x1F\x7F-\x9F]/g, '');
      const jsonMatch = cleanResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          return JSON.parse(jsonMatch[0]);
        } catch (parseError) {
          console.warn('JSON解析失败，尝试清理后重新解析:', parseError.message);
          // 进一步清理JSON字符串
          const cleanedJson = jsonMatch[0].replace(/[\n\r\t]/g, ' ').replace(/\s+/g, ' ');
          return JSON.parse(cleanedJson);
        }
      } else {
        throw new Error('无法解析大模型响应');
      }
    } catch (error) {
      console.warn('大模型解析失败，使用简单解析:', error.message);
      return this.simplePositionParsing(userMessage);
    }
  }

  simplePositionParsing(userMessage) {
    const result = {
      title: '新岗位',
      department: '',
      location: '',
      salary: '',
      experience: 0,
      education: '本科',
      skills: []
    };

    const lowerMessage = userMessage.toLowerCase();
    
    if (lowerMessage.includes('前端') || lowerMessage.includes('frontend')) {
      result.title = '前端开发工程师';
      result.skills = ['JavaScript', 'React', 'Vue', 'HTML', 'CSS'];
    } else if (lowerMessage.includes('后端') || lowerMessage.includes('backend')) {
      result.title = '后端开发工程师';
      result.skills = ['Java', 'Python', 'Node.js', '数据库', 'API'];
    } else if (lowerMessage.includes('全栈') || lowerMessage.includes('fullstack')) {
      result.title = '全栈开发工程师';
      result.skills = ['JavaScript', 'React', 'Node.js', '数据库', 'API'];
    } else if (lowerMessage.includes('产品') || lowerMessage.includes('product')) {
      result.title = '产品经理';
      result.skills = ['产品设计', '用户研究', '项目管理', '数据分析'];
    } else if (lowerMessage.includes('设计') || lowerMessage.includes('design')) {
      result.title = 'UI/UX设计师';
      result.skills = ['Figma', 'Sketch', 'Photoshop', '用户研究', '交互设计'];
    }

    const experienceMatch = userMessage.match(/(\d+)[\s]*年/);
    if (experienceMatch) {
      result.experience = parseInt(experienceMatch[1]);
    }

    if (lowerMessage.includes('硕士') || lowerMessage.includes('研究生')) {
      result.education = '硕士';
    } else if (lowerMessage.includes('博士')) {
      result.education = '博士';
    } else if (lowerMessage.includes('大专')) {
      result.education = '大专';
    }

    return result;
  }

  async generateJobDescription(positionInfo, thinkingCallback = null) {
    // 确保LLM服务已初始化
    await this.initLLMService();
    
    if (!this.llmService) {
      return this.generateSimpleJD(positionInfo);
    }

    const prompt = `
请为以下岗位生成完整的岗位描述（JD）：

岗位信息：
- 岗位名称：${positionInfo.title}
- 部门：${positionInfo.department || '待定'}
- 工作地点：${positionInfo.location || '待定'}
- 薪资范围：${positionInfo.salary || '面议'}
- 工作经验：${positionInfo.experience}年
- 学历要求：${positionInfo.education}
- 技能要求：${positionInfo.skills.join(', ')}

请生成以下内容：
1. 岗位职责（responsibilities）：5-8条具体的工作职责
2. 任职要求（requirements）：5-8条具体的任职要求
3. 福利待遇（benefits）：3-5条公司福利
4. 完整描述（fullDescription）：包含以上所有信息的完整JD

请以JSON格式返回，包含responsibilities、requirements、benefits、fullDescription四个字段。
`;

    const messages = [
      { role: 'system', content: '你是一个专业的HR助手，擅长撰写岗位描述和任职要求。' },
      { role: 'user', content: prompt }
    ];

    try {
      const response = await this.llmService.chatWithLLM(messages, thinkingCallback);
      
      // 清理响应内容，移除可能的控制字符
      const cleanResponse = response.replace(/[\x00-\x1F\x7F-\x9F]/g, '');
      const jsonMatch = cleanResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          return JSON.parse(jsonMatch[0]);
        } catch (parseError) {
          console.warn('JSON解析失败，尝试清理后重新解析:', parseError.message);
          // 进一步清理JSON字符串
          const cleanedJson = jsonMatch[0].replace(/[\n\r\t]/g, ' ').replace(/\s+/g, ' ');
          return JSON.parse(cleanedJson);
        }
      } else {
        throw new Error('无法解析大模型响应');
      }
    } catch (error) {
      console.warn('大模型生成JD失败，使用简单生成:', error.message);
      return this.generateSimpleJD(positionInfo);
    }
  }

  generateSimpleJD(positionInfo) {
    const responsibilities = [
      '负责相关项目的开发和维护工作',
      '参与技术方案设计和评审',
      '编写技术文档和代码注释',
      '与产品、设计等团队协作',
      '持续学习新技术，提升团队技术水平'
    ];

    const requirements = [
      `${positionInfo.education}及以上学历`,
      `具有${positionInfo.experience}年以上相关工作经验`,
      `熟练掌握${positionInfo.skills.slice(0, 3).join('、')}等技术`,
      '具有良好的团队协作能力和沟通能力',
      '有责任心，能够承担工作压力'
    ];

    const benefits = [
      '具有竞争力的薪资待遇',
      '五险一金、带薪年假',
      '定期团建活动',
      '职业发展培训机会',
      '弹性工作制度'
    ];

    const fullDescription = `
# ${positionInfo.title}

## 岗位职责
${responsibilities.map(item => `- ${item}`).join('\n')}

## 任职要求
${requirements.map(item => `- ${item}`).join('\n')}

## 福利待遇
${benefits.map(item => `- ${item}`).join('\n')}

## 工作地点
${positionInfo.location || '待定'}

## 薪资范围
${positionInfo.salary || '面议'}
    `.trim();

    return {
      responsibilities,
      requirements,
      benefits,
      fullDescription
    };
  }

  async getPositions() {
    const cacheKey = 'all_positions';
    let cachedPositions = positionCache.get(cacheKey);
    
    if (cachedPositions) {
      console.log('📦 使用缓存的岗位数据');
      return cachedPositions;
    }
    
    const positions = await this.resumeModel.getPositions();
    positionCache.set(cacheKey, positions);
    
    return positions;
  }

  async getPositionById(positionId) {
    const cacheKey = `position_${positionId}`;
    let cachedPosition = positionCache.get(cacheKey);
    
    if (cachedPosition) {
      console.log('📦 使用缓存的岗位详情');
      return cachedPosition;
    }
    
    const positions = await this.resumeModel.getPositions();
    const position = positions.find(p => p.id === positionId);
    
    if (position) {
      positionCache.set(cacheKey, position);
    }
    
    return position;
  }

  async updatePosition(positionId, updatedData) {
    try {
      const result = await this.resumeModel.updatePosition(positionId, updatedData);
      if (result.success) {
        positionCache.del('all_positions');
        positionCache.del(`position_${positionId}`);
      }
      return result;
    } catch (error) {
      console.error('更新岗位失败:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async deletePosition(positionId) {
    try {
      const result = await this.resumeModel.deletePosition(positionId);
      if (result.success) {
        positionCache.del('all_positions');
        positionCache.del(`position_${positionId}`);
      }
      return result;
    } catch (error) {
      console.error('删除岗位失败:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }
}

module.exports = new PositionService();
module.exports.PositionService = PositionService;
