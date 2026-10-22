import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Card, Typography, Button, Space, Select, message, Spin, Row, Col, Tag, Avatar, Input, Modal, Pagination } from 'antd';
import { DownloadOutlined, SearchOutlined, UploadOutlined, UserOutlined, MailOutlined, PhoneOutlined, EyeOutlined, DeleteOutlined, ClearOutlined } from '@ant-design/icons';
import { API_ENDPOINTS } from '../config/api';
import { apiGet, apiDelete } from '../utils/apiClient';
import ResumeUploadModal from './ResumeUploadModal';
import ResumeDetailModal from './ResumeDetailModal';
// 移除AI工作亮点分析组件
// import WorkExperienceHighlights from './WorkExperienceHighlights';

const { Text } = Typography;
const { Option } = Select;
const DEFAULT_PAGE_SIZE = 24;

/**
 * 简历库组件
 * 用于展示和管理简历资源
 */
const ResumeLibrary = () => {
  const [resumes, setResumes] = useState([]);
  const [loading, setLoading] = useState(false);
  const [uploadModalVisible, setUploadModalVisible] = useState(false);
  const [selectedSource, setSelectedSource] = useState('');
  const [searchText, setSearchText] = useState('');
  const [sortBy, setSortBy] = useState('createdAt');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [total, setTotal] = useState(0);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const requestSequence = useRef(0);
  const [detailModalVisible, setDetailModalVisible] = useState(false);
  const [selectedResume, setSelectedResume] = useState(null);
  
  // 获取简历列表
  const fetchResumes = useCallback(async () => {
    const sequence = ++requestSequence.current;
    setLoading(true);
    try {
      const result = await apiGet(`${API_ENDPOINTS.RESUME.LIST}/page`, {
        source: selectedSource || '', keyword: searchText.trim(), sortBy,
        limit: pageSize, offset: (page - 1) * pageSize
      });
      if (sequence !== requestSequence.current) return;
      if (!result?.success || !Array.isArray(result.data?.items) ||
          !Number.isInteger(result.data?.total)) throw new Error('服务返回的数据格式错误');
      const nextTotal = result.data.total;
      const lastPage = Math.max(1, Math.ceil(nextTotal / pageSize));
      if (page > lastPage) {
        setPage(lastPage);
        return;
      }
      setResumes(result.data.items);
      setTotal(nextTotal);
    } catch (error) {
      if (sequence !== requestSequence.current) return;
      console.error('获取简历列表失败:', error);
      message.error('获取简历列表失败：' + error.message);
      setResumes([]);
      setTotal(0);
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, [selectedSource, searchText, sortBy, page, pageSize]);
  
  // Filters and pagination are applied by the backend so a large library is
  // never transferred into the browser merely to show a single page.
  useEffect(() => {
    fetchResumes();
  }, [fetchResumes, refreshVersion]);

  const refreshPage = () => setRefreshVersion(value => value + 1);
  
  // 处理来源筛选
  const handleSourceChange = (value) => {
    setSelectedSource(value || '');
    setPage(1);
  };

  // 处理搜索
  const handleSearch = (value) => {
    setSearchText(value || '');
    setPage(1);
  };

  // 处理排序
  const handleSortChange = (value) => {
    setSortBy(value);
    setPage(1);
  };

  // 处理查看详情
  const handleViewDetail = (resume) => {
    setSelectedResume(resume);
    setDetailModalVisible(true);
  };

  // 关闭详情弹窗
  const handleCloseDetail = () => {
    setDetailModalVisible(false);
    setSelectedResume(null);
  };

  // 处理上传成功
  const handleUploadSuccess = () => {
    setPage(1);
    refreshPage();
    setUploadModalVisible(false);
    message.success('简历上传成功');
  };

  /**
   * 删除单个简历
   * @param {string} resumeId - 简历ID
   * @param {string} resumeName - 简历姓名
   */
  const handleDeleteResume = async (resumeId, resumeName) => {
    try {
      const result = await apiDelete(`${API_ENDPOINTS.RESUME.DELETE}/${resumeId}`);
      
      if (result.success) {
        message.success(`简历 "${resumeName}" 删除成功`);
        refreshPage();
      } else {
        message.error(result.error || '删除简历失败');
      }
    } catch (error) {
      console.error('删除简历失败:', error);
      message.error('删除简历失败');
    }
  };

  /**
   * 清空所有简历
   */
  const handleClearAllResumes = async () => {
    try {
      const result = await apiDelete(API_ENDPOINTS.RESUME.DELETE);
      
      if (result.success) {
        message.success(result.message);
        refreshPage();
      } else {
        message.error(result.error || '清空简历库失败');
      }
    } catch (error) {
      console.error('清空简历库失败:', error);
      message.error('清空简历库失败');
    }
  };

  /**
   * 确认清空所有简历
   */
  const confirmClearAllResumes = () => {
    if (selectedSource || searchText) {
      message.info('请先清除来源和搜索条件；清空操作会删除整个简历库');
      return;
    }
    if (total === 0) {
      message.info('简历库已经是空的');
      return;
    }
    
    Modal.confirm({
      title: '确认清空简历库',
      content: `确定要清空所有 ${total} 份简历吗？此操作不可恢复！`,
      okText: '确认清空',
      okType: 'danger',
      cancelText: '取消',
      onOk: handleClearAllResumes
    });
  };

  /**
   * 确认删除单个简历
   */
  const confirmDeleteResume = (resumeId, resumeName) => {
    Modal.confirm({
      title: '确认删除简历',
      content: `确定要删除简历 "${resumeName}" 吗？此操作不可恢复！`,
      okText: '确认删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: () => handleDeleteResume(resumeId, resumeName)
    });
  };
  
  // 下载简历
  const handleDownload = async (resume) => {
    if (resume.filePath) {
      try {
        const filename = String(resume.filePath).replace(/\\/g, '/').split('/').pop();
        const blob = await apiGet(`/resumes/${encodeURIComponent(filename)}`, {}, { responseType: 'blob' });
        if (blob) {
          const url = window.URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          window.URL.revokeObjectURL(url);
          document.body.removeChild(a);
        } else {
          message.error('下载简历失败');
        }
      } catch (error) {
        console.error('下载简历失败:', error);
        message.error('下载简历失败');
      }
    } else {
      message.info('该简历没有可下载的文件');
    }
  };
  
  return (
    <Card 
      title={
        <Space>
          <SearchOutlined />
          <span>简历库</span>
        </Space>
      } 
      extra={
        <Space>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Text type="secondary">来源筛选:</Text>
            <Select
              placeholder="选择来源"
              style={{ width: 140 }}
              allowClear
              onChange={handleSourceChange}
              value={selectedSource}
            >
              <Option value="boss">Boss直聘</Option>
              <Option value="qcwy">前程无忧</Option>
              <Option value="zlzp">智联招聘</Option>
              <Option value="lagou">拉勾网</Option>
              <Option value="liepin">猎聘网</Option>
              <Option value="linkedin">LinkedIn</Option>
              <Option value="manual">手动添加</Option>
            </Select>
          </div>
          <Button 
            danger
            icon={<ClearOutlined />}
            onClick={confirmClearAllResumes}
            disabled={total === 0 || Boolean(selectedSource || searchText)}
            title={selectedSource || searchText ? '请先清除筛选条件；此操作会删除整个简历库' : ''}
          >
            清空简历库
          </Button>
          <Button 
            type="primary" 
            icon={<UploadOutlined />}
            onClick={() => setUploadModalVisible(true)}
          >
            上传简历
          </Button>
        </Space>
      }
      style={{ 
        height: 'calc(100vh - 64px)', 
        display: 'flex', 
        flexDirection: 'column',
        overflow: 'hidden'
      }}
      styles={{
        body: { 
          flex: 1, 
          overflow: 'visible', 
          display: 'flex', 
          flexDirection: 'column',
          padding: '16px'
        }
      }}
    >
      <Spin spinning={loading} style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'visible' }}>
        <div style={{ marginBottom: 16, flexShrink: 0 }}>
          <Row gutter={[16, 16]} align="middle">
            <Col span={8}>
              <Text type="secondary">共找到 {total} 份简历</Text>
            </Col>
            <Col span={8}>
              <Input.Search
                placeholder="搜索姓名、职位或技能"
                allowClear
                onSearch={handleSearch}
                onChange={event => { if (!event.target.value && searchText) handleSearch(''); }}
                style={{ width: '100%' }}
              />
            </Col>
            <Col span={8}>
              <Select
                placeholder="排序方式"
                style={{ width: '100%' }}
                value={sortBy}
                onChange={handleSortChange}
              >
                <Option value="createdAt">按创建时间</Option>
                <Option value="name">按姓名</Option>
                <Option value="experience">按经验</Option>
                <Option value="education">按学历</Option>
                <Option value="age">按年龄</Option>
              </Select>
            </Col>
          </Row>
        </div>
        
        <div style={{ 
          flex: 1, 
          overflowY: 'auto', 
          overflowX: 'hidden',
          paddingRight: '4px',
          minHeight: 0,
          maxHeight: 'calc(100vh - 200px)',
          border: '1px solid #f0f0f0',
          borderRadius: '4px',
          padding: '8px'
        }}>
          <Row gutter={[16, 16]}>
          {resumes.map(item => {
            // 解析候选人姓名
            // 直接使用后端返回的结构化数据
            const parseCandidateName = (resume) => {
              // 优先使用结构化数据字段
              return resume.name || '未知姓名';
            };

            // 解析学历信息
            // 直接使用后端返回的结构化数据
            const parseEducationLevel = (resume) => {
              // 优先使用结构化数据字段
              return resume.education || '未知学历';
            };

            // 解析工作年限
            // 直接使用后端返回的结构化数据
             const parseWorkYears = (resume) => {
               // 优先使用结构化数据字段
               return resume.workYears || resume.experience || '0';
             };

             // 解析求职岗位
             // 直接使用后端返回的结构化数据
             const parseExpectedPosition = (resume) => {
               // 优先使用结构化数据字段，确保返回字符串类型
               let position = resume.expectedPosition || resume.position || '未指定职位';
               
               // 如果是对象类型，尝试提取position字段
               if (typeof position === 'object' && position !== null) {
                 if (position.position && position.position.trim() !== '') {
                   position = position.position;
                 } else {
                   // 如果position字段为空，返回友好的提示
                   position = '未指定职位';
                 }
               }
               
               return typeof position === 'string' ? position : '未指定职位';
              };

            // 解析工作经历数据
            // 直接使用后端返回的结构化数据
            const parseWorkExperience = (resume) => {
              // 优先使用结构化数据字段
              if (resume.workExperience && Array.isArray(resume.workExperience)) {
                return resume.workExperience.slice(0, 3); // 最多显示3段经历
              }
              
              // 如果没有工作经历数据，返回空数组
              return [];
            };
            
            // 解析教育经历数据
            const parseEducation = (resume) => {
              // 优先使用 educationExperience 数组
              if (resume.educationExperience && Array.isArray(resume.educationExperience) && resume.educationExperience.length > 0) {
                const edu = resume.educationExperience[0]; // 取第一个教育经历
                return {
                  school: edu.school || edu.university || '未知学校',
                  major: edu.major || edu.specialty || '未知专业',
                  degree: edu.degree || edu.education || '未知学历',
                  duration: edu.duration || edu.period || edu.time || 
                           (edu.startDate && edu.endDate ? `${edu.startDate} - ${edu.endDate}` : '未知时间')
                };
              }
              
              // 其次使用 education 数组
              if (resume.education && Array.isArray(resume.education) && resume.education.length > 0) {
                const edu = resume.education[0];
                return {
                  school: edu.school || edu.university || '未知学校',
                  major: edu.major || edu.specialty || '未知专业',
                  degree: edu.degree || edu.education || '未知学历',
                  duration: edu.duration || edu.period || edu.time || '未知时间'
                };
              }
              
              // 处理字符串形式的教育信息
              if (resume.education && typeof resume.education === 'string') {
                return {
                  school: resume.school || '未知学校',
                  major: resume.major || '未知专业',
                  degree: resume.education,
                  duration: resume.graduationYear ? `${resume.graduationYear}年毕业` : '未知时间'
                };
              }
              
              // 从解析内容中提取
              if (resume.parsedContent) {
                try {
                  const parsedData = JSON.parse(resume.parsedContent);
                  if (parsedData.educationExperiences && Array.isArray(parsedData.educationExperiences) && parsedData.educationExperiences.length > 0) {
                    const edu = parsedData.educationExperiences[0];
                    return {
                      school: edu.school || '未知学校',
                      major: edu.major || '未知专业',
                      degree: edu.degree || '未知学历',
                      duration: edu.startDate && edu.endDate ? `${edu.startDate} - ${edu.endDate}` : '未知时间'
                    };
                  }
                } catch (e) {
                  // 如果解析失败，尝试文本匹配
                  const content = resume.parsedContent;
                  const eduSectionMatch = content.match(/## 教育经历([\s\S]*?)(?=##|---)/i);
                  if (eduSectionMatch) {
                    const eduSection = eduSectionMatch[1];
                    const eduMatch = eduSection.match(/\*\*(.+?) \| (.+?) \| (.+?)\*\*\s*\n\*\*(.+?)\*\*/);
                    if (eduMatch) {
                      return {
                        school: eduMatch[1].trim(),
                        major: eduMatch[2].trim(),
                        degree: eduMatch[3].trim(),
                        duration: eduMatch[4].trim()
                      };
                    }
                  }
                }
              }
              
              // 从基本字段中提取
              if (resume.school || resume.major || resume.degree || resume.education) {
                return {
                  school: resume.school || '未知学校',
                  major: resume.major || '未知专业', 
                  degree: resume.degree || resume.education || '未知学历',
                  duration: resume.graduationYear ? `${resume.graduationYear}年毕业` : '未知时间'
                };
              }
              
              // 如果都没有，尝试从其他可能的字段中提取
              if (resume.university || resume.specialty) {
                return {
                  school: resume.university || '未知学校',
                  major: resume.specialty || '未知专业',
                  degree: '未知学历',
                  duration: '未知时间'
                };
              }
              
              return null;
            };
            
            // 解析联系方式
            const parseContactInfo = (resume) => {
              const contact = { email: '', phone: '' };
              if (resume.parsedContent) {
                const content = resume.parsedContent;
                // 从基本信息中提取联系方式
                const basicInfoMatch = content.match(/## 基本信息([\s\S]*?)(?=##|---)/i);
                if (basicInfoMatch) {
                  const basicSection = basicInfoMatch[1];
                  // 提取邮箱
                  const emailMatch = basicSection.match(/\*\*邮箱\*\*：(.+?)(?=\n|$)/i) || 
                                   basicSection.match(/\*\*Email\*\*：(.+?)(?=\n|$)/i) ||
                                   basicSection.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i);
                  if (emailMatch) {
                    contact.email = emailMatch[1] ? emailMatch[1].trim() : emailMatch[0].trim();
                  }
                  // 提取电话
                  const phoneMatch = basicSection.match(/\*\*电话\*\*：(.+?)(?=\n|$)/i) ||
                                   basicSection.match(/\*\*手机\*\*：(.+?)(?=\n|$)/i) ||
                                   basicSection.match(/(1[3-9]\d{9})/i);
                  if (phoneMatch) {
                    contact.phone = phoneMatch[1] ? phoneMatch[1].trim() : phoneMatch[0].trim();
                  }
                }
              }
              return contact;
            };
            
            const candidateName = parseCandidateName(item);
            const educationLevel = parseEducationLevel(item);
            const workYears = parseWorkYears(item);
            const expectedPosition = parseExpectedPosition(item);
            const workExperiences = parseWorkExperience(item);
            const education = parseEducation(item);
            const contactInfo = parseContactInfo(item);

            return (
              <Col xs={24} sm={12} md={8} lg={6} key={item.id}>
                <Card
                  hoverable
                  size="small"
                  style={{ height: 'auto', minHeight: '400px' }}
                  styles={{ body: { padding: '16px' } }}
                  actions={[
                    <Button 
                      icon={<EyeOutlined />} 
                      size="small"
                      type="link"
                      onClick={() => handleViewDetail(item)}
                    >
                      查看详情
                    </Button>,
                    ...(item.filePath ? [<Button
                      key="download"
                      icon={<DownloadOutlined />}
                      size="small"
                      type="link"
                      onClick={() => handleDownload(item)}
                    >下载文件</Button>] : []),
                    <Button 
                      icon={<DeleteOutlined />} 
                      size="small"
                      type="link"
                      danger
                      onClick={() => confirmDeleteResume(item.id, candidateName)}
                    >
                      删除
                    </Button>
                  ]}
                >
                  {/* 头像和姓名 */}
                  <div style={{ textAlign: 'center', marginBottom: '12px' }}>
                    <Avatar 
                      size={48} 
                      icon={<UserOutlined />}
                      style={{ backgroundColor: '#1890ff', marginBottom: '6px' }}
                    />
                    <div style={{ fontSize: '16px', fontWeight: 'bold', color: '#333' }}>
                      {candidateName}
                    </div>
                  </div>

                  {/* 求职岗位 */}
                  <div style={{ textAlign: 'center', marginBottom: '12px' }}>
                    <Tag color="blue" style={{ fontSize: '13px', padding: '4px 8px', borderRadius: '12px' }}>
                      {expectedPosition}
                    </Tag>
                  </div>

                  {/* 学历和工作年限 */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
                    <Tag color="green" style={{ fontSize: '11px' }}>
                      {educationLevel}
                    </Tag>
                    <Tag color="orange" style={{ fontSize: '11px' }}>
                      {workYears}年经验
                    </Tag>
                  </div>

                  {/* 工作经历 */}
                  {workExperiences.length > 0 && (
                    <div style={{ marginBottom: '12px' }}>
                      <Text strong style={{ fontSize: '12px', color: '#333', display: 'block', marginBottom: '6px' }}>
                        💼 工作经历
                      </Text>
                      {workExperiences.slice(0, 2).map((exp, index) => {
                        // 确保所有字段都是字符串类型，避免React渲染错误
                        const company = typeof exp.company === 'string' ? exp.company : 
                                       (typeof exp.company === 'object' && exp.company ? JSON.stringify(exp.company) : '未知公司');
                        const position = typeof exp.position === 'string' ? exp.position : 
                                        (typeof exp.position === 'object' && exp.position ? JSON.stringify(exp.position) : '未知职位');
                        const duration = typeof exp.duration === 'string' ? exp.duration : 
                                        (typeof exp.duration === 'object' && exp.duration ? JSON.stringify(exp.duration) : '未知时间');
                        const description = typeof exp.description === 'string' ? exp.description : 
                                           (typeof exp.description === 'object' && exp.description ? JSON.stringify(exp.description) : '暂无描述');
                        
                        return (
                          <div key={index} style={{ marginBottom: '8px', padding: '6px', backgroundColor: '#fafafa', borderRadius: '4px' }}>
                            <div style={{ fontSize: '11px', fontWeight: 'bold', color: '#333' }}>
                              {company} | {position}
                            </div>
                            <div style={{ fontSize: '10px', color: '#666', marginBottom: '2px' }}>
                              {duration}
                            </div>
                            <div style={{ fontSize: '10px', color: '#888', lineHeight: '1.3' }}>
                              {description.length > 50 ? description.substring(0, 50) + '...' : description}
                            </div>
                          </div>
                        );
                      })}
                      {workExperiences.length > 2 && (
                        <Text type="secondary" style={{ fontSize: '10px' }}>
                          还有 {workExperiences.length - 2} 段工作经历...
                        </Text>
                      )}
                      
                      {/* 移除AI亮点分析功能 */}
                    </div>
                  )}

                  {/* 教育经历 */}
                  {education && (
                    <div style={{ marginBottom: '12px' }}>
                      <Text strong style={{ fontSize: '12px', color: '#333', display: 'block', marginBottom: '6px' }}>
                        🎓 教育经历
                      </Text>
                      <div style={{ padding: '8px', backgroundColor: '#f0f8ff', borderRadius: '6px', border: '1px solid #e6f7ff' }}>
                        <div style={{ fontSize: '10px', color: '#1890ff', lineHeight: '1.4' }}>
                          {typeof education.school === 'string' ? education.school : '未知学校'} | {typeof education.major === 'string' ? education.major : '未知专业'} | {typeof education.degree === 'string' ? education.degree : '未知学历'} | {typeof education.duration === 'string' ? education.duration : '未知时间'}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* 联系方式 */}
                  <div style={{ borderTop: '1px solid #f0f0f0', paddingTop: '8px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', marginBottom: '3px' }}>
                      <MailOutlined style={{ fontSize: '11px', color: '#1890ff', marginRight: '4px' }} />
                      <Text type="secondary" style={{ fontSize: '10px' }}>
                        {contactInfo.email || '未提供邮箱'}
                      </Text>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center' }}>
                      <PhoneOutlined style={{ fontSize: '11px', color: '#1890ff', marginRight: '4px' }} />
                      <Text type="secondary" style={{ fontSize: '10px' }}>
                        {contactInfo.phone || '未提供电话'}
                      </Text>
                    </div>
                  </div>
                </Card>
              </Col>
            );
          })}
          </Row>
          
          {total === 0 && !loading && (
            <div style={{ textAlign: 'center', padding: '40px 0' }}>
              <Text type="secondary">暂无简历数据</Text>
            </div>
          )}
        </div>
        <Pagination
          style={{ marginTop: 12, textAlign: 'right', flexShrink: 0 }}
          current={page}
          pageSize={pageSize}
          total={total}
          showSizeChanger
          pageSizeOptions={[24, 48, 96]}
          showTotal={count => `共 ${count} 份`}
          onChange={(nextPage, nextSize) => {
            setPageSize(nextSize);
            setPage(nextSize === pageSize ? nextPage : 1);
          }}
        />
      </Spin>
      
      <ResumeUploadModal
        visible={uploadModalVisible}
        onClose={() => setUploadModalVisible(false)}
        onSuccess={handleUploadSuccess}
      />
      
      {/* 简历详情弹窗 */}
      <ResumeDetailModal
        visible={detailModalVisible}
        onClose={handleCloseDetail}
        resume={selectedResume}
      />
    </Card>
  );
};

export default ResumeLibrary;
