import React, { useState, useEffect } from 'react';
import { Card, Button, Typography, Alert, Steps, message, Tag, Space, Row, Col, InputNumber, Progress } from 'antd';
import { 
  SearchOutlined, 
  UserOutlined,
  HeartOutlined,
  DislikeOutlined,
  StarOutlined,
  ReloadOutlined,
  PlayCircleOutlined,
  StopOutlined,
  MessageOutlined,
  BulbOutlined
} from '@ant-design/icons';
import styled from 'styled-components';
import FilterPanel from './FilterPanel';
import { apiPost, apiGet, apiPut } from '../utils/apiClient';
import { API_ENDPOINTS } from '../config/api';
import useFilters from '../hooks/useFilters';
import JobCriteriaEditor, { EMPTY_JOB } from './JobCriteriaEditor';
import { ACTIVE_JOB_CHANGED, notifyActiveJobChanged } from '../utils/activeJobEvents';
import CaptureTargetNotice from './CaptureTargetNotice';
import { getFilterConfig } from '../config/filterConfig';

const { Title, Text } = Typography;
const ZHILIAN_FILTER_LABELS = {
  location: '工作地点', education: '学历', age: '年龄',
  experience: '经验', university: '院校'
};
const BOSS_PHASE_LABELS = {
  starting: '准备采集', selecting_job: '匹配企业在招岗位',
  reading_candidates: '读取推荐候选人', scrolling_candidates: '加载更多推荐候选人',
  quarantined_candidate: '暂缓超时候选卡',
  activating_recruiter_page: '恢复招聘页可见状态',
  restoring_recruiter_window: '恢复 BOSS 专用浏览器窗口',
  closing_official_guide: '关闭平台官方引导弹窗',
  opening_candidate: '打开候选人简历', waiting_resume: '等待在线简历加载',
  reopening_resume_once: '重新读取当前简历', existing_candidate: '跳过已入库候选人',
  extracting_resume: '提取简历', locating_resume_frame: '定位简历页面',
  reading_resume_frame: '读取在线简历', reading_resume_page: '读取简历正文',
  copying_canvas_resume: '复制在线简历', reading_resume_text: '解析简历文字',
  recognizing_canvas_resume: '识别在线简历', saving_resume: '保存简历',
  returning_to_search: '返回搜索结果', candidate_timeout: '单份简历超时，已暂停',
  stopped: '已停止', completed: '已达到目标', partial: '当前列表采集完毕',
  paused: '已暂停，需检查平台页面'
};
const BOSS_STAGE_LABELS = {
  read_recruiter_state: '确认招聘页状态', read_page: '读取招聘页',
  read_job: '确认岗位', read_modal: '读取简历弹窗', read_guide: '读取官方引导',
  capture_preflight: '截图前确认页面', capture_geometry: '确认截图区域',
  capture_enable: '准备截图', capture_screenshot: '获取简历截图',
  capture_postflight: '截图后核对区域',
  capture_postflight_state: '截图后确认页面',
  pre_scroll_probe: '滚动前确认简历', set_scroll: '定位简历页面',
  post_scroll_observation: '核对滚动位置'
};

const Container = styled.div`
  padding: 24px;
  max-width: 1200px;
  margin: 0 auto;
`;

// FilterPanel组件已移至独立文件

const CandidateCard = styled(Card)`
  margin-bottom: 16px;
  cursor: pointer;
  transition: all 0.3s ease;
  border: 2px solid transparent;
  
  &:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
    border-color: #1890ff;
  }
  
  .candidate-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
  }
  
  .candidate-info {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  
  .candidate-avatar {
    width: 48px;
    height: 48px;
    border-radius: 50%;
    background: #f0f0f0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 20px;
    color: #666;
  }
  
  .candidate-details {
    flex: 1;
  }
  
  .candidate-name {
    font-size: 16px;
    font-weight: 600;
    margin-bottom: 4px;
  }
  
  .candidate-position {
    color: #666;
    margin-bottom: 4px;
  }
  
  .candidate-company {
    color: #999;
    font-size: 12px;
  }
  
  .candidate-actions {
    display: flex;
    gap: 8px;
  }
  
  .candidate-tags {
    margin-top: 12px;
    
    .ant-tag {
      margin-bottom: 4px;
    }
  }
`;

const StatusPanel = styled(Card)`
  margin-bottom: 24px;
  
  .status-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
    padding: 12px 16px;
    background: #fafafa;
    border-radius: 8px;
    border: 1px solid #f0f0f0;
    transition: all 0.2s ease;
    
    &:last-child {
      margin-bottom: 0;
    }
    
    &:hover {
      background: #f5f5f5;
      border-color: #d9d9d9;
    }
  }
  
  .status-value {
    font-weight: 600;
    min-width: 80px;
    text-align: center;
    
    .ant-tag {
      margin: 0;
      font-size: 12px;
      padding: 4px 12px;
      border-radius: 6px;
    }
  }
`;

/**
 * 统一的模式选择卡片样式组件
 * 为所有浏览模式提供一致的选中动效和悬停效果
 */
const ModeSelectionCard = styled(Card)`
  cursor: pointer;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  border: 2px solid transparent;
  position: relative;
  overflow: hidden;
  
  &:hover {
    transform: translateY(-4px);
    box-shadow: 0 8px 25px rgba(0, 0, 0, 0.15);
  }
  
  &.selected {
    border-color: #1890ff;
    background: linear-gradient(135deg, #f0f9ff 0%, #e0f2fe 100%);
    transform: translateY(-2px);
    box-shadow: 0 6px 20px rgba(24, 144, 255, 0.2);
    
    &::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 3px;
      background: linear-gradient(90deg, #1890ff, #52c41a);
      animation: shimmer 2s ease-in-out infinite;
    }
    
    .mode-icon {
      animation: pulse 1.5s ease-in-out infinite;
    }
    
    .mode-title {
      color: #1890ff;
      font-weight: 600;
    }
  }
  
  .mode-content {
    text-align: center;
    padding: 8px;
  }
  
  .mode-icon {
    transition: all 0.3s ease;
    margin-bottom: 8px;
  }
  
  .mode-title {
    transition: all 0.3s ease;
    margin-bottom: 4px;
  }
  
  @keyframes shimmer {
    0%, 100% {
      opacity: 1;
    }
    50% {
      opacity: 0.7;
    }
  }
  
  @keyframes pulse {
    0%, 100% {
      transform: scale(1);
    }
    50% {
      transform: scale(1.1);
    }
  }
`;

/**
 * 候选人浏览组件
 * @param {Object} props - 组件属性
 * @param {string} props.platform - 招聘平台标识，默认为'boss-zhipin'
 */
const CandidateBrowser = ({ platform = 'boss-zhipin', onOpenPipeline }) => {
  const [currentStep, setCurrentStep] = useState(0);
  const [isBrowsing, setIsBrowsing] = useState(false);
  const [browseMode, setBrowseMode] = useState('recommended'); // recommended, search, potential, communication
  const [candidates, setCandidates] = useState([]);
  const [processedCount, setProcessedCount] = useState(0);
  const [collectedCount, setCollectedCount] = useState(0);
  const [dislikedCount, setDislikedCount] = useState(0);
  const [currentCandidateIndex, setCurrentCandidateIndex] = useState(0);
  const [currentKeyword, setCurrentKeyword] = useState('');
  const [keywordErrors, setKeywordErrors] = useState([]);
  const [filterWarnings, setFilterWarnings] = useState([]);
  const filterWarningLabels = [...new Set(filterWarnings.map(warning =>
    ZHILIAN_FILTER_LABELS[warning.field] || '其他条件'))].join('、');
  const [bossResumeCheckpoint, setBossResumeCheckpoint] = useState(null);
  const [bossPhase, setBossPhase] = useState(null);
  const [browseStatus, setBrowseStatus] = useState('idle');
  const [completionNotice, setCompletionNotice] = useState('');
  const [stopRequested, setStopRequested] = useState(false);
  const [pollingInterval, setPollingInterval] = useState(null); // 保存轮询间隔ID
  
  // 系统状态变量 - 智联招聘需要的初始化状态
  const [isInitialized, setIsInitialized] = useState(false);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  
  // eslint-disable-next-line no-unused-vars
  const [searchFilters, setSearchFilters] = useState({});
  
  // 使用筛选条件Hook
  const {
    filters,
    updateFilter,
    applyFilters: applyFiltersHook,
    resetFilters: resetFiltersHook
  } = useFilters(platform);
  
  // 各平台共用岗位条件，单次目标份数可在此单独调整。
  const [targetResumeCount, setTargetResumeCount] = useState(3);
  const [batchTargetCount, setBatchTargetCount] = useState(null);
  const [bossMaxRuntimeMinutes, setBossMaxRuntimeMinutes] = useState(90);
  const [jobCriteria, setJobCriteria] = useState(EMPTY_JOB);
  const collectedResumeCount = collectedCount;
  const maxTargetCount = platform === 'boss-zhipin' ? 500 : 100;
  const applicableBossCheckpoint = platform === 'boss-zhipin' &&
    bossResumeCheckpoint?.filters?.position === jobCriteria.title &&
    bossResumeCheckpoint?.targetCount === targetResumeCount;
  const displayedBatchTarget = isBrowsing || applicableBossCheckpoint
    ? batchTargetCount || targetResumeCount : targetResumeCount;

  const handleJobCriteriaChange = job => {
    setJobCriteria(job);
    if (job?.title && (job.title !== jobCriteria.title ||
        job.searchKeywords !== jobCriteria.searchKeywords)) {
      updateFilter('position', job.searchKeywords || job.title);
    }
    if (job?.title && (job.education !== jobCriteria.education ||
        job.location !== jobCriteria.location)) {
      const config = getFilterConfig(platform);
      const education = String(job.education || '').trim();
      const normalizedEducation = education === '本科' ? '本科及以上'
        : education === '大专' ? '大专及以上'
          : education === '硕士' || education === '研究生' ? '硕士及以上' : education;
      if (config.education?.options?.some(option => option.value === normalizedEducation)) {
        updateFilter('education', normalizedEducation);
      }
      if (config.location?.options?.some(option => option.value === job.location)) {
        updateFilter('location', job.location);
      }
    }
    if (job?.targetCount !== jobCriteria.targetCount) {
      setTargetResumeCount(Number.isInteger(job?.targetCount) && job.targetCount > 0
        ? job.targetCount : 3);
    }
  };

  useEffect(() => {
    const onJobChanged = event => {
      const scopedPlatform = platform === 'boss-zhipin' ? 'boss' : 'zlzp';
      if (!['all', scopedPlatform].includes(event.detail?.applyTo)) return;
      const job = event.detail?.job;
      if (!job?.title) return;
      setJobCriteria(job);
      updateFilter('position', job.searchKeywords || job.title);
      const config = getFilterConfig(platform);
      const education = String(job.education || '').trim();
      const normalizedEducation = education === '本科' ? '本科及以上'
        : education === '大专' ? '大专及以上'
          : education === '硕士' || education === '研究生' ? '硕士及以上' : education;
      if (config.education?.options?.some(option => option.value === normalizedEducation)) {
        updateFilter('education', normalizedEducation);
      }
      if (config.location?.options?.some(option => option.value === job.location)) {
        updateFilter('location', job.location);
      }
      setTargetResumeCount(Number.isInteger(job.targetCount) && job.targetCount > 0
        ? job.targetCount : 3);
    };
    window.addEventListener(ACTIVE_JOB_CHANGED, onJobChanged);
    return () => window.removeEventListener(ACTIVE_JOB_CHANGED, onJobChanged);
  }, [platform, updateFilter]);

  // 智联招聘初始化相关函数
  const startZhilianService = async () => {
    if (platform !== 'zhilian') return;
    
    try {
      setIsLoading(true);
      setCurrentStep(0);
      
      // 初始化及打开登录页面；实际采集仅由“开始浏览”触发。
      const response = await apiPost(API_ENDPOINTS.ZHILIAN.INIT_SERVICE, {});
      
      if (response.success) {
        setIsInitialized(true);
        setCurrentStep(1);
        // 开始状态轮询
        startZhilianStatusPolling();
      } else {
        throw new Error(response.message || '启动智联招聘服务失败');
      }
    } catch (error) {
      console.error('启动智联招聘服务错误:', error);
      message.error(error.message || '启动智联招聘服务失败');
    } finally {
      setIsLoading(false);
    }
  };
  
  // 智联招聘状态轮询
  const startZhilianStatusPolling = () => {
    if (platform !== 'zhilian') return;
    
    const pollInterval = setInterval(async () => {
      try {
        const result = await apiGet(API_ENDPOINTS.ZHILIAN.GET_STATUS);
        updateZhilianStatus(result.data || result);
      } catch (error) {
        console.error('获取智联招聘状态失败:', error);
      }
    }, 2000);
    
    // 保存轮询ID以便后续清理
    window.zhilianStatusPolling = pollInterval;
  };
  
  // 更新智联招聘状态
  const updateZhilianStatus = (statusData) => {
    const { hasBrowser, hasPage, loggedIn } = statusData;
    
    setIsLoggedIn(Boolean(loggedIn));
    
    // 根据状态更新当前步骤
    if (hasBrowser && !hasPage) {
      setCurrentStep(1); // 打开官网
    } else if (hasPage && !loggedIn) {
      setCurrentStep(2); // 等待登录
    } else if (loggedIn) {
      setCurrentStep(3); // 登录完成
      // 清理状态轮询
      if (window.zhilianStatusPolling) {
        clearInterval(window.zhilianStatusPolling);
        window.zhilianStatusPolling = null;
      }
      // 重置步骤，进入浏览模式选择
      setTimeout(() => {
        setCurrentStep(0);
      }, 1000);
    }
  };
  
  // 停止智联招聘服务
  const stopZhilianService = async () => {
    if (platform !== 'zhilian') return;
    
    try {
      await apiPost(API_ENDPOINTS.ZHILIAN.STOP, {});
      
      // 重置所有状态
      setIsInitialized(false);
      setIsLoggedIn(false);
      setCurrentStep(0);
      
      // 清理轮询
      if (window.zhilianStatusPolling) {
        clearInterval(window.zhilianStatusPolling);
        window.zhilianStatusPolling = null;
      }
      
      message.success('智联招聘服务已停止');
    } catch (error) {
      console.error('停止智联招聘服务错误:', error);
      message.error('停止智联招聘服务失败');
    }
  };

  // 获取步骤信息
  const getSteps = () => {
    // 智联招聘需要完整的初始化流程
    if (platform === 'zhilian') {
      // 如果还未登录，显示初始化步骤
      if (!isLoggedIn) {
        return [
          {
            title: '初始化',
            description: '启动浏览器和基础服务',
            status: currentStep >= 0 ? 'finish' : 'wait'
          },
          {
            title: '打开官网',
            description: '访问智联招聘官网',
            status: currentStep >= 1 ? 'finish' : 'wait'
          },
          {
            title: '等待登录',
            description: '用户手动登录',
            status: currentStep >= 2 ? 'finish' : 'wait'
          },
          {
            title: '登录完成',
            description: '验证登录状态，准备开始自动化操作',
            status: currentStep >= 3 ? 'finish' : 'wait'
          }
        ];
      }
      
      // 登录后显示浏览模式选择步骤
      const modeDescription = '推荐人才、搜索人才、潜在人才、互动';
      
      if (browseMode === 'search') {
        return [
          {
            title: '选择浏览模式',
            description: modeDescription,
            status: currentStep >= 0 ? 'finish' : 'wait'
          },
          {
            title: '配置筛选条件',
            description: '设置职位、地区、经验等筛选条件',
            status: currentStep >= 1 ? 'finish' : 'wait'
          },
          {
            title: '开始浏览',
            description: '自动浏览候选人信息',
            status: currentStep >= 2 ? 'finish' : 'wait'
          },
          {
            title: '简历处理',
            description: '自动采集和处理简历',
            status: currentStep >= 3 ? 'finish' : 'wait'
          }
        ];
      } else {
        return [
          {
            title: '选择浏览模式',
            description: modeDescription,
            status: currentStep >= 0 ? 'finish' : 'wait'
          },
          {
            title: '开始浏览',
            description: '自动浏览候选人信息',
            status: currentStep >= 1 ? 'finish' : 'wait'
          },
          {
            title: '简历处理',
            description: '自动采集和处理简历',
            status: currentStep >= 2 ? 'finish' : 'wait'
          }
        ];
      }
    }
    
    // Boss直聘的原有逻辑
    const modeDescription = '在招岗位推荐、官方搜索结果';
    
    if (browseMode === 'search') {
      return [
        {
          title: '选择浏览模式',
          description: modeDescription,
          status: currentStep >= 0 ? 'finish' : 'wait'
        },
        {
          title: '配置筛选条件',
          description: '系统提交同名岗位关键词，平台细分筛选保持“不限”',
          status: currentStep >= 1 ? 'finish' : 'wait'
        },
        {
          title: '开始浏览',
          description: '自动浏览候选人信息',
          status: currentStep >= 2 ? 'finish' : 'wait'
        },
        {
          title: '简历处理',
          description: '自动采集和处理简历',
          status: currentStep >= 3 ? 'finish' : 'wait'
        }
      ];
    } else {
      return [
        {
          title: '选择浏览模式',
          description: modeDescription,
          status: currentStep >= 0 ? 'finish' : 'wait'
        },
        {
          title: '开始浏览',
          description: '自动浏览候选人信息',
          status: currentStep >= 1 ? 'finish' : 'wait'
        },
        {
          title: '简历处理',
          description: '自动采集和处理简历',
          status: currentStep >= 2 ? 'finish' : 'wait'
        }
      ];
    }
  };

  // 启动候选人浏览
  const startBrowsing = async ({ resume = false, checkpoint = null } = {}) => {
    try {
      const requestedCount = resume ? checkpoint?.targetCount : targetResumeCount;
      const requestedMode = resume ? checkpoint?.mode : browseMode;
      const requestedRuntimeMinutes = resume
        ? checkpoint?.maxRuntimeMinutes : bossMaxRuntimeMinutes;
      if (!Number.isInteger(requestedCount) || requestedCount < 1 ||
          requestedCount > maxTargetCount) {
        message.error(`请输入 1～${maxTargetCount} 之间的简历份数`);
        return;
      }
      if (platform === 'boss-zhipin' && requestedMode === 'search' &&
          (!Number.isInteger(requestedRuntimeMinutes) ||
            requestedRuntimeMinutes < 1 || requestedRuntimeMinutes > 180)) {
        message.error('BOSS 官方搜索最长运行时间须为 1～180 分钟');
        return;
      }
      if (!jobCriteria?.title || !jobCriteria?.jobRequirements) {
        message.warning('请先填写或导入岗位条件，并保存后开始采集');
        return;
      }
      // An already saved job must keep its timestamp. Re-saving at every start
      // changes the evaluation context even when the criteria did not change.
      const activeJob = jobCriteria.updatedAt
        ? jobCriteria
        : (await apiPut('/recruitment-pipeline/active-job',
          { ...jobCriteria, applyTo: platform === 'boss-zhipin' ? 'boss' : 'zlzp' })).data;
      setJobCriteria(activeJob);
      notifyActiveJobChanged(activeJob, platform === 'boss-zhipin' ? 'boss' : 'zlzp');
      const searchFilters = resume ? checkpoint?.filters
        : platform === 'boss-zhipin'
          ? {position:activeJob.title}
          : {...filters,position:filters.position?.trim() ||
            activeJob.searchKeywords || activeJob.title};
      if (!searchFilters || !requestedMode) {
        message.error('上次采集进度不完整，请新建任务');
        return;
      }
      if (resume) {
        setBrowseMode(requestedMode);
        setTargetResumeCount(requestedCount);
      }
      if (platform === 'zhilian') setFilterWarnings([]);
      setIsBrowsing(true);
      setStopRequested(false);
      setCompletionNotice('');
      // 根据模式设置不同的步骤
      if (requestedMode === 'search') {
        setCurrentStep(2);
      } else {
        setCurrentStep(1);
      }
      
      // 添加调试信息
      console.log('启动浏览参数:', {
        mode: requestedMode,
        filters: searchFilters,
        targetCount: requestedCount,
        ...(platform === 'boss-zhipin' && requestedMode === 'search'
          ? {maxRuntimeMinutes:requestedRuntimeMinutes} : {}),
        resume
      });
      
      // 根据平台显示不同的消息
      const modeMessages = {
        search: platform === 'zhilian' ? '搜索人才' : '搜索牛人',
        recommended: platform === 'zhilian' ? '推荐人才' : '推荐牛人', 
        communication: platform === 'zhilian' ? '互动' : '沟通版块',
        favorites: platform === 'zhilian' ? '潜在人才' : '收藏'
      };
      
      // 根据平台调用不同的API
      const apiEndpoint = platform === 'zhilian' ? API_ENDPOINTS.ZHILIAN.START_BROWSING : API_ENDPOINTS.BOSS_ZHIPIN.START_BROWSING;
      
      const result = await apiPost(apiEndpoint, {
        mode: requestedMode,
        filters: searchFilters,
        targetCount: requestedCount,
        ...(platform === 'boss-zhipin' && requestedMode === 'search'
          ? {maxRuntimeMinutes:requestedRuntimeMinutes} : {}),
        resume
      });
      console.log('后端响应:', result);
      
      if (result.success) {
        setBatchTargetCount(requestedCount);
        message.success(result.message || `${modeMessages[requestedMode] || '候选人'}采集已启动`);
        if (resume) setBossResumeCheckpoint(null);
        // 后端任务负责导航和采集；此处再次导航会打断正在打开的简历弹窗。
        
        // 开始轮询状态
        startStatusPolling();
      } else {
        message.error(result.message);
        setIsBrowsing(false);
      }
    } catch (error) {
      console.error('启动浏览失败:', error);
      message.error('启动浏览失败: ' + error.message);
      setIsBrowsing(false);
    }
  };

  const resumeBossBrowsing = () => startBrowsing({
    resume: true, checkpoint: bossResumeCheckpoint
  });

  // 停止候选人浏览，保留浏览器和已采集数据
  const stopBrowsing = async () => {
    try {
      // 根据平台调用不同的API
      const apiEndpoint = platform === 'zhilian' ? API_ENDPOINTS.ZHILIAN.STOP_BROWSING : API_ENDPOINTS.BOSS_ZHIPIN.STOP_BROWSING;
      const result = await apiPost(apiEndpoint, {});
      if (!result.success) throw new Error(result.message || '停止请求失败');
      setStopRequested(true);
      message.info(result.message || '已请求停止，当前简历处理完毕后采集会结束');
    } catch (error) {
      console.error('停止浏览失败:', error);
      message.error('停止采集失败：' + error.message);
    }
  };

  // 开始状态轮询
  const startStatusPolling = () => {
    // 清除之前的轮询
    if (pollingInterval) {
      clearInterval(pollingInterval);
    }
    
    let inFlight = false;
    const interval = setInterval(async () => {
      // A slow server response must not start another request every two
      // seconds: stacked polls can make an otherwise recoverable pause worse.
      if (inFlight || document.hidden) return;
      inFlight = true;
      try {
        // 根据平台调用不同的API
        const apiEndpoint = platform === 'zhilian' ? API_ENDPOINTS.ZHILIAN.BROWSING_STATUS : API_ENDPOINTS.BOSS_ZHIPIN.BROWSING_STATUS;
        const result = await apiGet(apiEndpoint);
        
        if (result.success) {
          const { 
            candidates, 
            processedCount, 
            collectedCount,
            dislikedCount, 
            currentIndex, 
            status,
            isActive,
            lastError,
            completionReason
          } = result.data;
          setBrowseStatus(status || 'idle');
          setCompletionNotice(completionReason || (status === 'paused' ? lastError : '') || '');
          setCurrentKeyword(result.data.currentKeyword || '');
          setKeywordErrors(result.data.keywordErrors || []);
          if (platform === 'zhilian') {
            setFilterWarnings(Array.isArray(result.data.filterWarnings) ? result.data.filterWarnings : []);
          }
          if (platform !== 'zhilian') {
            setBossResumeCheckpoint(result.data.resumeAvailable ? result.data : null);
            setBossPhase({
              phase: result.data.currentPhase,
              attempted: result.data.attemptedCount || 0,
              skipped: result.data.skippedCount || 0,
              failure: result.data.lastFailureCode || '',
              warning: result.data.lastSkippedCode || '',
              pausedAtPhase: result.data.pausedAtPhase || '',
              pausedAtStage: result.data.pausedAtStage || '',
              windowRestoreCount: result.data.windowRestoreCount || 0
            });
          }
          
          setCandidates(candidates || []);
          setProcessedCount(processedCount || 0);
          setCollectedCount(collectedCount || 0);
          setDislikedCount(dislikedCount || 0);
          setCurrentCandidateIndex(currentIndex || 0);
          if (Number.isInteger(result.data.targetCount) && result.data.targetCount > 0) {
            setBatchTargetCount(result.data.targetCount);
          }
          if (platform === 'boss-zhipin' && Number.isInteger(result.data.maxRuntimeMinutes) &&
              result.data.maxRuntimeMinutes > 0) {
            setBossMaxRuntimeMinutes(result.data.maxRuntimeMinutes);
          }

          // The server owns the target and closes the current official resume
          // before completing. Never interrupt that cleanup from a poll tick.
          const savedCount = platform === 'zhilian' ? (collectedCount || 0) : (processedCount || 0);
          const expectedTarget = Number(result.data.targetCount) || targetResumeCount;

          // 如果浏览不再活跃或已完成，更新状态
          if (!isActive || status === 'idle') {
            setCurrentStep(3);
            setIsBrowsing(false);
            setStopRequested(false);
            clearInterval(interval);
            setPollingInterval(null);
            
            const collected = savedCount;
            if (collected >= expectedTarget) {
              message.success(`🎉 已成功收集 ${collected} 份简历，任务完成！`);
            } else if (status === 'paused' && lastError) {
              message.error(`采集停止：${lastError}`);
            } else if (platform !== 'zhilian' && status === 'partial') {
              message.warning(`当前推荐列表采集完毕，本次新入库 ${collected}/${expectedTarget} 份。`);
            } else if (platform !== 'zhilian' && status === 'stopped') {
              message.info(`采集已停止，本次新入库 ${collected} 份。`);
            } else if (platform === 'zhilian' && completionReason === 'results_exhausted') {
              message.warning(`搜索结果已处理完，本次新增 ${collected}/${expectedTarget} 份简历；可调整关键词继续采集。`);
            } else if (platform === 'zhilian' && completionReason === 'no_progress') {
              message.warning(`搜索结果连续多页没有新增简历，已暂停本次采集（${collected}/${expectedTarget}）。可检查页面状态或更换关键词。`);
            } else if (platform === 'zhilian' && completionReason === 'detail_unavailable') {
              message.warning(lastError || '智联简历详情未能打开，采集已停止；请检查平台权限和页面提示');
            } else if (platform === 'zhilian' && completionReason === 'keyword_error') {
              message.warning(`部分关键词搜索失败，本次新增 ${collected}/${expectedTarget} 份简历；请查看失败提示。`);
            } else if (platform === 'zhilian' && completionReason === 'stopped') {
              message.info(`采集已停止，本次新增 ${collected} 份简历。`);
            } else {
              message.info(`候选人浏览已完成，共收集 ${collected} 份简历`);
            }
          }
        }
      } catch (error) {
        console.error('获取浏览状态失败:', error);
      } finally {
        inFlight = false;
      }
    }, 2000);
    
    // 保存轮询间隔ID
    setPollingInterval(interval);
    
  };
  
  // 重置状态（刷新状态按钮功能）
  const resetBrowsingStatus = async () => {
    try {
      setIsLoading(true);
      if (isBrowsing) {
        message.warning('请先停止采集并等待当前简历处理完毕');
        return;
      }
      const apiEndpoint = platform === 'zhilian' ? API_ENDPOINTS.ZHILIAN.RESET_BROWSING : API_ENDPOINTS.BOSS_ZHIPIN.RESET_BROWSING;
      const result = await apiPost(apiEndpoint, {});
      if (!result.success) throw new Error(result.message || '重置请求失败');
      // 停止当前轮询
      if (pollingInterval) {
        clearInterval(pollingInterval);
        setPollingInterval(null);
      }
      
      // 重置前端状态
      setIsBrowsing(false);
      setCurrentStep(0);
      setCandidates([]);
      setProcessedCount(0);
      setCollectedCount(0);
      setDislikedCount(0);
      setCurrentCandidateIndex(0);
      setBossResumeCheckpoint(null);
      setBossPhase(null);
      setBrowseStatus('idle');
      setCompletionNotice('');
      setStopRequested(false);
      message.success('状态已重置，可以重新开始寻聘');
    } catch (error) {
      console.error('重置状态失败:', error);
      message.error('重置状态失败: ' + error.message);
    } finally {
      setIsLoading(false);
    }
  };

  const resetBossCardQuarantine = async () => {
    if (isBrowsing) {
      message.warning('请先停止当前 BOSS 采集');
      return;
    }
    try {
      setIsLoading(true);
      const result = await apiPost(API_ENDPOINTS.BOSS_ZHIPIN.RESET_CARD_QUARANTINE, {});
      if (!result.success) throw new Error(result.message || '解除暂缓记录失败');
      message.success(result.message || '已解除 BOSS 候选卡暂缓记录');
    } catch (error) {
      message.error('解除暂缓记录失败: ' + error.message);
    } finally {
      setIsLoading(false);
    }
  };

  // 处理候选人操作
  const handleCandidateAction = async (candidateId, action) => {
    try {
      // 根据平台调用不同的API
      const apiEndpoint = platform === 'zhilian' ? API_ENDPOINTS.ZHILIAN.CANDIDATE_ACTION : API_ENDPOINTS.BOSS_ZHIPIN.CANDIDATE_ACTION;
      
      const result = await apiPost(apiEndpoint, {
        candidateId,
        action // like, dislike, skip
      });
      
      if (result.success) {
        if (action === 'like') {
          message.success('已收藏候选人');
        } else if (action === 'dislike') {
          setDislikedCount(prev => prev + 1);
          message.info('已跳过候选人');
        }
        
        // 更新候选人列表
        setCandidates(prev => prev.filter(c => c.id !== candidateId));
      } else {
        message.error(result.message);
      }
    } catch (error) {
      console.error('处理候选人操作失败:', error);
      message.error('操作失败: ' + error.message);
    }
  };

  // 应用筛选条件
  const applyFilters = () => {
    if (applyFiltersHook()) {
      setCurrentStep(1);
    }
  };

  // 重置筛选条件
  const resetFilters = () => {
    resetFiltersHook();
  };
  
  /**
   * 处理搜索模式选择
   * 统一的模式选择逻辑，不再硬编码特定接口调用
   */
  const handleSearchModeSelection = () => {
    setBrowseMode('search');
    // 智联招聘搜索模式直接显示筛选条件配置区域，不使用弹窗
  };
  


  useEffect(() => {
    apiGet('/recruitment-pipeline/active-job',
      { platform: platform === 'boss-zhipin' ? 'boss' : 'zlzp' })
      .then(result => {
        const job = result.data || EMPTY_JOB;
        handleJobCriteriaChange(job);
        setTargetResumeCount(Number.isInteger(job.targetCount) && job.targetCount > 0
          ? job.targetCount : 3);
      })
      .catch(error => message.error('读取岗位条件失败：' + error.message));
    // 岗位只在平台入口装载时同步，表单编辑由 onChange 负责。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform]);

  // The dashboard may have attached to an existing employer Chrome before
  // this tab mounts. Read that shared state instead of asking the user to
  // initialize the same browser again just to reveal the browse controls.
  useEffect(() => {
    if (platform !== 'zhilian') return undefined;
    let mounted = true;
    const syncLogin = async () => {
      try {
        const result = await apiGet(API_ENDPOINTS.ZHILIAN.GET_STATUS);
        if (!mounted || !result.success) return;
        const status = result.data || {};
        setIsInitialized(Boolean(status.initialized));
        setIsLoggedIn(Boolean(status.loggedIn));
        if (status.loggedIn) setCurrentStep(current => current === 0 ? 3 : current);
      } catch (_) { /* The existing start control can still initialize the browser. */ }
    };
    syncLogin();
    const timer = setInterval(syncLogin, 5000);
    return () => { mounted = false; clearInterval(timer); };
  }, [platform]);

  useEffect(() => {
    // 组件加载时获取初始状态
    const apiEndpoint = platform === 'zhilian' ? API_ENDPOINTS.ZHILIAN.BROWSING_STATUS : API_ENDPOINTS.BOSS_ZHIPIN.BROWSING_STATUS;
    
    apiGet(apiEndpoint)
      .then(result => {
        if (result.success) {
          const { candidates, processedCount, collectedCount, dislikedCount, currentIndex } = result.data;
          setCandidates(candidates || []);
          setProcessedCount(processedCount || 0);
          setCollectedCount(collectedCount || 0);
          setDislikedCount(dislikedCount || 0);
          setCurrentCandidateIndex(currentIndex || 0);
          setBrowseStatus(result.data.status || 'idle');
          setCompletionNotice(result.data.completionReason ||
            (result.data.status === 'paused' ? result.data.lastError : '') || '');
          if (platform === 'zhilian') {
            setFilterWarnings(Array.isArray(result.data.filterWarnings) ? result.data.filterWarnings : []);
          }
          if (platform !== 'zhilian') {
            setBossResumeCheckpoint(result.data.resumeAvailable ? result.data : null);
            setBossPhase({
              phase: result.data.currentPhase,
              attempted: result.data.attemptedCount || 0,
              skipped: result.data.skippedCount || 0,
              failure: result.data.lastFailureCode || '',
              warning: result.data.lastSkippedCode || '',
              pausedAtPhase: result.data.pausedAtPhase || '',
              pausedAtStage: result.data.pausedAtStage || ''
            });
            if (Number.isInteger(result.data.targetCount) && result.data.targetCount > 0) {
              setBatchTargetCount(result.data.targetCount);
            }
            if (Number.isInteger(result.data.maxRuntimeMinutes) &&
                result.data.maxRuntimeMinutes > 0) {
              setBossMaxRuntimeMinutes(result.data.maxRuntimeMinutes);
            }
          }
          if (result.data.isActive) {
            setIsBrowsing(true);
            startStatusPolling();
          }
        }
      })
      .catch(error => {
        console.error('获取初始状态失败:', error);
      });
  }, [platform]);

  useEffect(() => () => {
    if (pollingInterval) clearInterval(pollingInterval);
  }, [pollingInterval]);

  return (
    <Container>
      <div style={{ textAlign: 'center', marginBottom: 32 }}>
        <Title level={2}>
          <UserOutlined style={{ marginRight: 12, color: '#1890ff' }} />
          候选人浏览与筛选
        </Title>
        <Text type="secondary" style={{ fontSize: '16px' }}>
          自动化浏览候选人信息，智能筛选优质简历
        </Text>
      </div>

      <StepsContainer>
        <Steps current={currentStep} items={getSteps()} />
      </StepsContainer>

      <JobCriteriaEditor value={jobCriteria} onChange={handleJobCriteriaChange}
        platform={platform === 'boss-zhipin' ? 'boss' : 'zlzp'} disabled={isBrowsing} />
      <CaptureTargetNotice job={jobCriteria} platform={platform} refreshKey={isBrowsing} />
      {isBrowsing && batchTargetCount > 0 &&
        Number.isInteger(jobCriteria.targetCount) && jobCriteria.targetCount > 0 &&
        batchTargetCount !== jobCriteria.targetCount &&
        <Alert type="warning" showIcon style={{ marginBottom: 16 }}
          message={`当前任务按 ${batchTargetCount} 份运行，岗位默认单次目标为 ${jobCriteria.targetCount} 份`}
          description="修改岗位目标不会更改已经开始的任务。如需按新目标采集，请停止当前任务后重新启动。" />}
      {isBrowsing && Number.isInteger(jobCriteria.recommendationTargetCount) &&
        jobCriteria.recommendationTargetCount > 0 &&
        batchTargetCount > jobCriteria.recommendationTargetCount &&
        !jobCriteria.targetCount &&
        <Alert type="warning" showIcon style={{ marginBottom: 16 }}
          message={`当前任务目标 ${batchTargetCount} 份；推荐名单目标 ${jobCriteria.recommendationTargetCount} 人不是采集上限`}
          description="如果只需推荐目标数量，请停止当前任务并明确设置单次采集目标。" />}
      {targetResumeCount > maxTargetCount && <Alert type="warning" showIcon style={{ marginBottom: 16 }}
        message={`模板建议获取 ${targetResumeCount} 份，当前平台单次最多 ${maxTargetCount} 份；请在下方调整目标份数。`} />}

      {/* 浏览模式选择 */}
      <Card title="选择浏览模式" style={{ marginBottom: 24 }}>
          {platform === 'zhilian' ? (
            // 智联招聘四个模块
            <Row gutter={16}>
            <Col span={6}>
              <ModeSelectionCard 
                size="small" 
                className={browseMode === 'recommended' ? 'selected' : ''}
                onClick={() => setBrowseMode('recommended')}
              >
                <div className="mode-content">
                  <StarOutlined className="mode-icon" style={{ fontSize: 24, color: '#faad14' }} />
                  <div className="mode-title">推荐人才</div>
                  <Text type="secondary">系统推荐的优质候选人</Text>
                </div>
              </ModeSelectionCard>
            </Col>
            <Col span={6}>
              <ModeSelectionCard 
                size="small" 
                className={browseMode === 'search' ? 'selected' : ''}
                onClick={handleSearchModeSelection}
              >
                <div className="mode-content">
                  <SearchOutlined className="mode-icon" style={{ fontSize: 24, color: '#1890ff' }} />
                  <div className="mode-title">搜索人才</div>
                  <Text type="secondary">根据条件搜索候选人</Text>
                </div>
              </ModeSelectionCard>
            </Col>
            <Col span={6}>
              <ModeSelectionCard 
                size="small" 
                className={browseMode === 'favorites' ? 'selected' : ''}
                onClick={() => setBrowseMode('favorites')}
              >
                <div className="mode-content">
                  <BulbOutlined className="mode-icon" style={{ fontSize: 24, color: '#722ed1' }} />
                  <div className="mode-title">潜在人才</div>
                  <Text type="secondary">收藏的优质候选人</Text>
                </div>
              </ModeSelectionCard>
            </Col>
            <Col span={6}>
              <ModeSelectionCard 
                size="small" 
                className={browseMode === 'communication' ? 'selected' : ''}
                onClick={() => setBrowseMode('communication')}
              >
                <div className="mode-content">
                  <MessageOutlined className="mode-icon" style={{ fontSize: 24, color: '#52c41a' }} />
                  <div className="mode-title">互动</div>
                  <Text type="secondary">处理主动投递的候选人</Text>
                </div>
              </ModeSelectionCard>
            </Col>
          </Row>
        ) : (
          // BOSS recommendation and official search use separate raw-CDP
          // collectors. Platform-specific filters remain unverified.
          <Row gutter={16}>
            <Col span={8}>
              <ModeSelectionCard 
                size="small" 
                className={browseMode === 'recommended' ? 'selected' : ''}
                onClick={() => setBrowseMode('recommended')}
              >
                <div className="mode-content">
                  <StarOutlined className="mode-icon" style={{ fontSize: 24, color: '#faad14' }} />
                  <div className="mode-title">在招岗位推荐牛人</div>
                  <Text type="secondary">采集当前企业已发布的同名岗位</Text>
                </div>
              </ModeSelectionCard>
            </Col>
            <Col span={8}>
              <ModeSelectionCard size="small"
                className={browseMode === 'search' ? 'selected' : ''}
                onClick={() => setBrowseMode('search')}>
                <div className="mode-content">
                  <SearchOutlined className="mode-icon" style={{fontSize:24,color:'#1890ff'}} />
                  <div className="mode-title">官方搜索结果</div>
                  <Text type="secondary">采集已提交同名关键词的可访问简历</Text>
                </div>
              </ModeSelectionCard>
            </Col>
            <Col span={8}>
              <Alert type="info" showIcon
                message={`当前岗位：${jobCriteria.title || '请先填写并保存岗位条件'}`}
                description={browseMode === 'search'
                  ? '系统会在 BOSS 官方“搜索牛人”页输入并提交当前岗位名称；学历、经验、年龄及其他平台筛选须保持“不限”。采集时保持专用窗口正常显示；若窗口最小化，系统核对页面及候选列表后仅尝试恢复一次，再次最小化会暂停。'
                  : '系统会在 BOSS 企业端选择同名在招岗位，滚动读取推荐简历，去重入库并按岗位要求评估。'}
                style={{ height: '100%' }} />
            </Col>
          </Row>
        )}
        </Card>

      {/* 简历采集数量设置 - 所有平台都显示 */}
      <Card title="简历采集数量设置" style={{ marginBottom: 24 }}>
        <Row gutter={16} align="middle">
          <Col span={12}>
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontWeight: 500, marginBottom: 8, display: 'block' }}>
                目标简历份数（1～{maxTargetCount}）
              </label>
              <InputNumber
                aria-label="目标简历份数"
                min={1}
                max={maxTargetCount}
                precision={0}
                value={targetResumeCount}
                onChange={setTargetResumeCount}
                style={{ width: '100%' }}
                size="large"
                disabled={isBrowsing}
              />
            </div>
          </Col>
          <Col span={12}>
            <div style={{ textAlign: 'center', padding: '20px', background: '#f5f5f5', borderRadius: '8px' }}>
              <div style={{ fontSize: '24px', fontWeight: 'bold', color: '#1890ff', marginBottom: '8px' }}>
                {targetResumeCount}
              </div>
              <div style={{ color: '#666' }}>份简历</div>
              <div style={{ fontSize: '12px', color: '#999', marginTop: '4px' }}>
                采集到此数量后自动停止
              </div>
            </div>
          </Col>
        </Row>
        {platform === 'boss-zhipin' && browseMode === 'search' && (
          <Row gutter={16} align="middle" style={{ marginTop: 4 }}>
            <Col span={12}>
              <label style={{ fontWeight: 500, marginBottom: 8, display: 'block' }}>
                最长运行时间（1～180 分钟）
              </label>
              <InputNumber
                aria-label="BOSS 搜索最长运行分钟数"
                min={1}
                max={180}
                precision={0}
                value={bossMaxRuntimeMinutes}
                onChange={setBossMaxRuntimeMinutes}
                style={{ width: '100%' }}
                disabled={isBrowsing}
              />
            </Col>
            <Col span={12}>
              <Text type="secondary">达到目标份数、结果耗尽或遇平台验证、限流时会提前停止。</Text>
            </Col>
          </Row>
        )}
        {/* 进度条显示 */}
        {isBrowsing && (
          <div style={{ marginTop: 16 }}>
            <div style={{ marginBottom: 8, display: 'flex', justifyContent: 'space-between' }}>
              <Text strong>采集进度</Text>
              <Text>{collectedResumeCount}/{displayedBatchTarget}</Text>
            </div>
            <Progress 
              percent={Math.min(100, Math.round((collectedResumeCount / displayedBatchTarget) * 100))}
              status={collectedResumeCount >= displayedBatchTarget ? 'success' : 'active'}
              strokeColor={{
                '0%': '#108ee9',
                '100%': '#87d068',
              }}
              showInfo={false}
            />
          </div>
        )}
        
        <Alert
          message="简历采集说明"
          description={`系统以新入库 ${targetResumeCount || '设定'} 份为目标；遇人工验证会暂停，平台权限和搜索结果数量可能使实际份数少于目标。`}
          type="info"
          showIcon
          style={{ marginTop: 16 }}
        />
        </Card>

      {/* 筛选条件配置 - 仅在搜索模式下显示 */}
      {platform === 'zhilian' && browseMode === 'search' && (
        <FilterPanel
          platform={platform}
          filters={filters}
          onFilterChange={updateFilter}
          onApply={applyFilters}
          onReset={resetFilters}
          loading={isBrowsing}
          title="筛选条件配置"
        />
      )}
      {platform === 'zhilian' && browseMode === 'search' && currentKeyword && (
        <Alert type="info" showIcon style={{ marginBottom: 12 }}
          message={`正在搜索关键词：${currentKeyword}`} />
      )}
      {platform === 'boss-zhipin' && bossPhase?.phase && (
        <Alert type={browseStatus === 'paused' ? 'warning' : 'info'} showIcon
          style={{ marginBottom: 12 }}
          message={`BOSS 当前阶段：${BOSS_PHASE_LABELS[bossPhase.phase] || bossPhase.phase}`}
          description={`已尝试 ${bossPhase.attempted} 次，跳过 ${bossPhase.skipped} 次${bossPhase.windowRestoreCount ? `；本轮专用窗口恢复尝试 ${bossPhase.windowRestoreCount} 次` : ''}${bossPhase.failure ? `；暂停原因：${bossPhase.failure}` : ''}${bossPhase.warning ? `；最近跳过原因：${bossPhase.warning}` : ''}${bossPhase.pausedAtPhase ? `；暂停前阶段：${BOSS_PHASE_LABELS[bossPhase.pausedAtPhase] || bossPhase.pausedAtPhase}` : ''}${bossPhase.pausedAtStage ? `；暂停时步骤：${BOSS_STAGE_LABELS[bossPhase.pausedAtStage] || bossPhase.pausedAtStage}` : ''}`} />
      )}
      {platform === 'boss-zhipin' && !isBrowsing && completionNotice && (
        <Alert type={browseStatus === 'completed' ? 'success' : 'warning'} showIcon
          style={{ marginBottom: 12 }}
          message={`BOSS 本次采集：${browseStatus === 'completed' ? '达到目标' : browseStatus === 'paused' ? '已暂停' : browseStatus === 'partial' ? '当前列表处理完毕' : '已结束'}`}
          description={completionNotice} />
      )}
      {keywordErrors.length > 0 && (
        <Alert type="warning" showIcon style={{ marginBottom: 12 }}
          message={`部分关键词搜索失败：${keywordErrors.slice(-2).join('；')}`} />
      )}
      {platform === 'zhilian' && filterWarnings.length > 0 && (
        <Alert type="warning" showIcon style={{ marginBottom: 12 }}
          message="智联平台筛选未完全应用"
          description={`部分搜索未能应用${filterWarningLabels}筛选。采集结果请以入库后的岗位评估状态为准。`} />
      )}
      {platform === 'zhilian' && browseStatus === 'idle' &&
        completionNotice === 'detail_unavailable' && (
          <Alert type="warning" showIcon style={{ marginBottom: 12 }}
            message="智联简历详情未打开，已停止无效采集"
            description="请在专用浏览器中手动点击一张搜索结果，确认详情能正常打开及账号有查看权限，再从这里重新采集。" />
        )}

      {/* 状态面板 */}
      <StatusPanel title="浏览状态">
        <Row gutter={24}>
          <Col span={6}>
            <div className="status-row">
              <Text>已处理候选人:</Text>
              <Text className="status-value" type="primary">{processedCount}</Text>
            </div>
          </Col>
          <Col span={6}>
            <div className="status-row">
              <Text>本次/上次任务目标:</Text>
              <Text className="status-value" type="success">{displayedBatchTarget}</Text>
            </div>
          </Col>
          <Col span={6}>
            <div className="status-row">
              <Text>收集进度:</Text>
              <Text className="status-value" style={{ 
                color: collectedResumeCount >= displayedBatchTarget ? '#52c41a' : '#1890ff'
              }}>
                {collectedResumeCount}/{displayedBatchTarget}
              </Text>
            </div>
          </Col>
          <Col span={6}>
            <div className="status-row">
              <Text>完成状态:</Text>
              <Text className="status-value" style={{
                color: collectedResumeCount >= displayedBatchTarget ? '#52c41a' : '#faad14'
              }}>
                {browseStatus === 'completed' || (isBrowsing && collectedResumeCount >= displayedBatchTarget)
                  ? '已达到目标' : isBrowsing ? '进行中' : browseStatus === 'paused' ? '已暂停' : '未运行'}
              </Text>
            </div>
          </Col>
          <Col span={6}>
            <div className="status-row">
              <Text>已入库:</Text>
              <Text className="status-value" type="success">{collectedCount}</Text>
            </div>
          </Col>
          <Col span={6}>
            <div className="status-row">
              <Text>{platform === 'zhilian' ? '采集失败:' : '已跳过/去重:'}</Text>
              <Text className="status-value" type="warning">{platform === 'zhilian' ? dislikedCount : bossPhase?.skipped || 0}</Text>
            </div>
          </Col>
          <Col span={6}>
            <div className="status-row">
              <Text>当前进度:</Text>
              <Text className="status-value">{platform === 'zhilian' ? currentCandidateIndex + 1 : currentCandidateIndex}</Text>
            </div>
          </Col>
        </Row>
      </StatusPanel>

      {/* 控制按钮 */}
      <Card style={{ marginBottom: 24, textAlign: 'center' }}>
        <Space size="large">
          {platform === 'zhilian' ? (
            // 智联招聘控制按钮
            !isLoggedIn ? (
              !isInitialized ? (
                <Button 
                  type="primary" 
                  size="large"
                  icon={<PlayCircleOutlined />}
                  onClick={startZhilianService}
                  loading={isLoading}
                >
                  启动智能寻聘
                </Button>
              ) : (
                <Button 
                  danger
                  size="large"
                  icon={<StopOutlined />}
                  onClick={stopZhilianService}
                >
                  停止服务
                </Button>
              )
            ) : (
              // 登录后显示浏览控制按钮
              !isBrowsing ? (
                <Button 
                  type="primary" 
                  size="large"
                  icon={<PlayCircleOutlined />}
                  onClick={() => startBrowsing()}
                  disabled={browseMode === 'search' ? currentStep < 1 : !browseMode}
                >
                  开始浏览
                </Button>
              ) : (
                <Button 
                  danger
                  size="large"
                  icon={<StopOutlined />}
                  onClick={stopBrowsing}
                >
                  停止浏览
                </Button>
              )
            )
          ) : (
            // BOSS 原生推荐采集
            !isBrowsing ? (
              <Button 
                type="primary" 
                size="large"
                icon={<PlayCircleOutlined />}
                onClick={() => startBrowsing()}
                disabled={!jobCriteria.title || !jobCriteria.jobRequirements}
              >
                开始浏览
              </Button>
            ) : (
              <Button 
                danger
                size="large"
                icon={<StopOutlined />}
                onClick={stopBrowsing}
                disabled={stopRequested}
              >
                {stopRequested ? '正在停止当前简历…' : '停止浏览'}
              </Button>
            )
          )}
          {platform !== 'zhilian' && !isBrowsing && applicableBossCheckpoint && (
            <Button size="large" icon={<PlayCircleOutlined />}
              onClick={resumeBossBrowsing}>
              继续上次采集（{bossResumeCheckpoint.processedCount}/{bossResumeCheckpoint.targetCount}）
            </Button>
          )}

          <Button 
            size="large"
            icon={<ReloadOutlined />}
            onClick={resetBrowsingStatus}
            loading={isLoading}
            disabled={isBrowsing}
          >
            重置状态
          </Button>
          {platform === 'boss-zhipin' && (
            <Button size="large" onClick={resetBossCardQuarantine}
              loading={isLoading} disabled={isBrowsing}
              title="解除所有岗位中因浏览器超时暂缓 24 小时的候选卡；下次采集会重新尝试">
              解除暂缓候选卡
            </Button>
          )}
        </Space>
      </Card>

      {/* 候选人列表 */}
      <Card title={platform === 'zhilian' ? '候选人列表' : '已入库候选人'}
        extra={platform === 'zhilian' ? `共 ${candidates.length} 人` : `本次新入库 ${collectedCount} 份`}>
        {platform === 'boss-zhipin' ? (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Text>完整简历、岗位匹配评估、Word 初筛报告及邮件发送都在“三平台候选人”中查看。</Text>
            <Button type="primary" onClick={onOpenPipeline} disabled={!onOpenPipeline}>
              查看 BOSS 简历、评估与报告
            </Button>
          </Space>
        ) : candidates.length > 0 ? (
          candidates.map((candidate, index) => (
            <CandidateCard key={candidate.id}>
              <div className="candidate-header">
                <div className="candidate-info">
                  <div className="candidate-avatar">
                    <UserOutlined />
                  </div>
                  <div className="candidate-details">
                    <div className="candidate-name">{candidate.name}</div>
                    <div className="candidate-position">{candidate.position}</div>
                    <div className="candidate-company">{candidate.company}</div>
                  </div>
                </div>
                
                <div className="candidate-actions">
                  <Button 
                    type="primary" 
                    size="small"
                    icon={<HeartOutlined />}
                    onClick={() => handleCandidateAction(candidate.id, 'like')}
                  >
                    收藏
                  </Button>
                  <Button 
                    size="small"
                    icon={<DislikeOutlined />}
                    onClick={() => handleCandidateAction(candidate.id, 'dislike')}
                  >
                    跳过
                  </Button>
                </div>
              </div>
              
              <div className="candidate-tags">
                <Tag color="blue">{candidate.experience}</Tag>
                <Tag color="green">{candidate.location}</Tag>
                <Tag color="orange">{candidate.salary}</Tag>
                <Tag color="purple">{candidate.education}</Tag>
              </div>
            </CandidateCard>
          ))
        ) : (
          <div style={{ textAlign: 'center', padding: '40px 0' }}>
            <Text type="secondary">暂无候选人信息</Text>
          </div>
        )}
      </Card>

      <Alert
        message="操作说明"
        description={platform === 'zhilian'
          ? '设置岗位条件和目标份数，选择浏览模式后开始采集；入库简历可在三平台候选人管道中评估、导出和发送。'
          : browseMode === 'search'
            ? '保存岗位条件并确认 BOSS 企业端已登录、官方搜索页已打开且细分筛选为“不限”，再开始采集。页面遇安全验证会暂停；已入库简历可在三平台候选人管道中查看。'
            : '先保存岗位条件并确认 BOSS 企业端已登录、已发布同名岗位，再开始推荐采集。页面遇安全验证会暂停，已入库简历保留在本机；在三平台候选人管道中查看评估和报告。'}
        type="info"
        showIcon
        style={{ marginTop: 24 }}
      />
      

    </Container>
  );
};

const StepsContainer = styled.div`
  margin: 24px 0;
  
  .ant-steps-item-process .ant-steps-item-icon {
    background: #1890ff;
    border-color: #1890ff;
  }
  
  .ant-steps-item-finish .ant-steps-item-icon {
    background: #52c41a;
    border-color: #52c41a;
  }
`;

export default CandidateBrowser;
