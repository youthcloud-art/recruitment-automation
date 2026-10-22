import React, { useState, useEffect } from 'react';
import {
  Modal,
  Form,
  Input,
  Select,
  DatePicker,
  Button,
  Space,
  Divider,
  Card,
  Row,
  Col,
  Tag,
  message,
  InputNumber,
  Typography,
  List,
  Avatar,
  Checkbox,
  Pagination
} from 'antd';
import {
  PlusOutlined,
  DeleteOutlined,
  UserOutlined,
  MailOutlined,
  PhoneOutlined,
  SearchOutlined,
  FileTextOutlined
} from '@ant-design/icons';
import { API_ENDPOINTS } from '../config/api';
import { apiGet, apiPost, apiPut } from '../utils/apiClient';
import dayjs from 'dayjs';

const { TextArea } = Input;
const { Option } = Select;
const { Text } = Typography;

const TaskForm = ({ visible, task, onCancel, onSuccess }) => {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [candidates, setCandidates] = useState([]);
  const [positions, setPositions] = useState([]);
  const [resumes, setResumes] = useState([]);
  const [resumePage, setResumePage] = useState(1);
  const [resumeTotal, setResumeTotal] = useState(0);
  const [resumeLoading, setResumeLoading] = useState(false);
  const [resumeSearchText, setResumeSearchText] = useState('');
  const [showResumeSelector, setShowResumeSelector] = useState(false);
  const [selectedResumes, setSelectedResumes] = useState([]);
  const [selectedResumeDetails, setSelectedResumeDetails] = useState({});
  const [selectedPlatforms, setSelectedPlatforms] = useState([]);

  // 岗位在打开表单时读取；简历只在打开选择器后分页读取。
  useEffect(() => {
    if (visible) {
      fetchPositions();
    }
  }, [visible]);

  useEffect(() => {
    if (!showResumeSelector) return;
    let active = true;
    const timer = setTimeout(async () => {
      setResumeLoading(true);
      try {
        const result = await apiGet('/resume-library/page', {
          keyword: resumeSearchText.trim(), limit: 20, offset: (resumePage - 1) * 20
        });
        if (active && result.success) {
          setResumes(result.data.items || []);
          setResumeTotal(result.data.total || 0);
        }
      } catch (error) {
        if (active) message.error('读取简历列表失败');
      } finally {
        if (active) setResumeLoading(false);
      }
    }, 250);
    return () => { active = false; clearTimeout(timer); };
  }, [showResumeSelector, resumeSearchText, resumePage]);

  // 初始化表单数据
  useEffect(() => {
    if (visible) {
      if (task) {
        // 同一个弹窗会在不同任务之间复用，initialValues 不会随 task 更新。
        const candidatesWithId = (task.candidates || []).map((candidate, index) => ({
          ...candidate,
          id: candidate.id || `candidate-${index}`
        }));
        setCandidates(candidatesWithId);
        setSelectedPlatforms(task.platforms || []);
        form.setFieldsValue({ ...task,
          deadline: task.deadline ? dayjs(task.deadline) : null,
          candidates: candidatesWithId });
      } else {
        // 创建模式
        form.resetFields();
        form.setFieldsValue({ status: '进行中', priority: '中', progress: 0 });
        setCandidates([]);
        setSelectedResumes([]);
        setSelectedResumeDetails({});
        setSelectedPlatforms([]);
      }
    }
  }, [visible, task, form]);

  // 获取职位列表
  const fetchPositions = async () => {
    try {
      const result = await apiGet(API_ENDPOINTS.POSITIONS.LIST);
      if (result.success) {
        setPositions(result.data || []);
      } else {
        console.error('获取职位列表失败:', result.error);
        message.error('获取职位列表失败');
        setPositions([]);
      }
    } catch (error) {
      console.error('获取职位列表失败:', error);
      message.error('获取职位列表失败');
      setPositions([]);
    }
  };

  // 添加候选人
  const addCandidate = () => {
    const newCandidate = {
      id: Date.now().toString(),
      name: '',
      email: '',
      phone: '',
      status: '待联系'
    };
    setCandidates([...candidates, newCandidate]);
  };

  // 从简历库选择候选人
  const selectCandidatesFromResumes = () => {
    setResumePage(1);
    setResumeSearchText('');
    setShowResumeSelector(true);
  };

  // 确认选择简历库候选人
  const confirmResumeSelection = () => {
    const selectedResumeData = selectedResumes.map(id => selectedResumeDetails[id]).filter(Boolean);
    const existingIds = new Set(candidates.map(candidate => candidate.resumeId).filter(Boolean));

    const newCandidates = selectedResumeData.filter(resume => !existingIds.has(resume.id)).map(resume => ({
      id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
      name: resume.name || resume.filename || '未知姓名',
      email: resume.email || '',
      phone: resume.phone || '',
      status: '待联系',
      resumeId: resume.id,
      notes: `来自简历库: ${resume.filename || resume.name}`
    }));

    setCandidates([...candidates, ...newCandidates]);
    setSelectedResumes([]);
    setSelectedResumeDetails({});
    setShowResumeSelector(false);
    message.success(`已添加 ${newCandidates.length} 个候选人`);
  };

  // 删除候选人
  const removeCandidate = (index) => {
    const newCandidates = candidates.filter((_, i) => i !== index);
    setCandidates(newCandidates);
    form.setFieldsValue({ candidates: newCandidates });
  };

  // 更新候选人信息
  const updateCandidate = (index, field, value) => {
    const newCandidates = [...candidates];
    newCandidates[index] = { ...newCandidates[index], [field]: value };
    setCandidates(newCandidates);
    form.setFieldsValue({ candidates: newCandidates });
  };

  // 提交表单
  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      if (candidates.some(candidate => !String(candidate.name || '').trim())) {
        message.error('请填写候选人姓名，或删除空白候选人');
        return;
      }
      setLoading(true);

      const taskData = {
        ...values,
        deadline: values.deadline ? values.deadline.toISOString() : null,
        candidates,
        platforms: selectedPlatforms, // 添加招聘平台
        progress: values.progress || 0
      };

      const result = task 
        ? await apiPut(`${API_ENDPOINTS.TASKS.UPDATE}/${task.id}`, taskData)
        : await apiPost(API_ENDPOINTS.TASKS.CREATE, taskData);

      if (result.success) {
        message.success(task ? '任务更新成功' : '任务创建成功');
        onSuccess();
      } else {
        message.error(result.message || '操作失败');
      }
    } catch (error) {
      console.error('提交失败:', error);
      message.error('提交失败，请检查表单数据');
    } finally {
      setLoading(false);
    }
  };

  // 获取状态选项
  const getStatusOptions = () => [
    { value: '进行中', label: '进行中' },
    { value: '已完成', label: '已完成' },
    { value: '已暂停', label: '已暂停' },
    { value: '已取消', label: '已取消' }
  ];

  // 获取优先级选项
  const getPriorityOptions = () => [
    { value: '高', label: '高优先级' },
    { value: '中', label: '中优先级' },
    { value: '低', label: '低优先级' }
  ];

  // 获取候选人状态选项
  const getCandidateStatusOptions = () => [
    { value: '待联系', label: '待联系' },
    { value: '已联系', label: '已联系' },
    { value: '面试中', label: '面试中' },
    { value: '已录用', label: '已录用' },
    { value: '已拒绝', label: '已拒绝' }
  ];

  // 获取招聘平台选项
  const getPlatformOptions = () => [
    { value: '智联招聘', label: '智联招聘' },
    { value: '前程无忧', label: '前程无忧' },
    { value: 'BOSS直聘', label: 'BOSS直聘' }
  ];

  return (
    <Modal
      title={task ? '编辑任务' : '创建任务'}
      open={visible}
      onCancel={onCancel}
      width={800}
      footer={[
        <Button key="cancel" onClick={onCancel}>
          取消
        </Button>,
        <Button key="submit" type="primary" loading={loading} onClick={handleSubmit}>
          {task ? '更新' : '创建'}
        </Button>
      ]}
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={task ? {
          ...task,
          deadline: task.deadline ? dayjs(task.deadline) : null,
          candidates: (task.candidates || []).map((candidate, index) => ({
            ...candidate,
            id: candidate.id || `candidate-${index}`
          }))
        } : {
          status: '进行中',
          priority: '中',
          progress: 0
        }}
      >
        <Row gutter={16}>
          <Col span={12}>
            <Form.Item
              name="title"
              label="任务名称"
              rules={[{ required: true, message: '请输入任务名称' }]}
            >
              <Input placeholder="请输入任务名称" />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              name="position"
              label="目标职位"
              rules={[{ required: true, message: '请选择目标职位' }]}
            >
              <Select 
                placeholder="请选择目标职位"
                showSearch
                filterOption={(input, option) =>
                  (option?.label ?? '').toLowerCase().includes(input.toLowerCase())
                }
                options={(positions || []).map(pos => ({
                  value: pos.name || pos.title,
                  label: pos.name || pos.title
                }))}
              />
            </Form.Item>
          </Col>
        </Row>

        <Form.Item
          name="description"
          label="任务描述"
        >
          <TextArea
            rows={3}
            placeholder="请输入任务描述"
          />
        </Form.Item>

        <Row gutter={16}>
          <Col span={8}>
            <Form.Item
              name="status"
              label="任务状态"
              rules={[{ required: true, message: '请选择任务状态' }]}
            >
              <Select placeholder="请选择任务状态">
                {getStatusOptions().map(option => (
                  <Option key={option.value} value={option.value}>
                    {option.label}
                  </Option>
                ))}
              </Select>
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item
              name="priority"
              label="优先级"
              rules={[{ required: true, message: '请选择优先级' }]}
            >
              <Select placeholder="请选择优先级">
                {getPriorityOptions().map(option => (
                  <Option key={option.value} value={option.value}>
                    {option.label}
                  </Option>
                ))}
              </Select>
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item
              name="progress"
              label="进度 (%)"
            >
              <InputNumber
                min={0}
                max={100}
                style={{ width: '100%' }}
                placeholder="请输入进度"
              />
            </Form.Item>
          </Col>
        </Row>

        <Row gutter={16}>
          <Col span={12}>
            <Form.Item
              name="deadline"
              label="截止时间"
            >
              <DatePicker
                style={{ width: '100%' }}
                placeholder="请选择截止时间"
                showTime
              />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              name="assignee"
              label="负责人"
            >
              <Input placeholder="请输入负责人" />
            </Form.Item>
          </Col>
        </Row>

        <Form.Item label="招聘平台">
          <div style={{ marginBottom: 8 }}>
            <Text type="secondary">仅标记手工任务关联的平台；实际采集请使用任务列表上方的采集控制台。</Text>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {getPlatformOptions().map(platform => (
              <Checkbox
                key={platform.value}
                checked={selectedPlatforms.includes(platform.value)}
                onChange={(e) => {
                  if (e.target.checked) {
                    setSelectedPlatforms([...selectedPlatforms, platform.value]);
                  } else {
                    setSelectedPlatforms(selectedPlatforms.filter(p => p !== platform.value));
                  }
                }}
              >
                {platform.label}
              </Checkbox>
            ))}
          </div>
          {selectedPlatforms.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <Text type="secondary">
                已选择: {selectedPlatforms.join(', ')}
              </Text>
            </div>
          )}
        </Form.Item>

        <Divider orientation="left">候选人管理</Divider>

        <div style={{ marginBottom: 16 }}>
          <Space>
            <Button
              type="dashed"
              icon={<PlusOutlined />}
              onClick={addCandidate}
            >
              手动添加候选人
            </Button>
            <Button
              type="dashed"
              icon={<FileTextOutlined />}
              onClick={selectCandidatesFromResumes}
            >
              从简历库选择
            </Button>
          </Space>
        </div>

        {candidates.map((candidate, index) => (
          <Card
            key={candidate.id || `candidate-${index}`}
            size="small"
            style={{ marginBottom: 16 }}
            title={
              <div>
                <span>候选人 {index + 1}</span>
                {candidate.resumeId && (
                  <Tag color="green" style={{ marginLeft: 8 }}>
                    来自简历库
                  </Tag>
                )}
              </div>
            }
            extra={
              <Button
                type="text"
                danger
                icon={<DeleteOutlined />}
                onClick={() => removeCandidate(index)}
              />
            }
          >
            <Row gutter={16}>
              <Col span={8}>
                <Form.Item label="姓名">
                  <Input
                    placeholder="请输入姓名"
                    prefix={<UserOutlined />}
                    value={candidate.name}
                    onChange={(e) => updateCandidate(index, 'name', e.target.value)}
                  />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item label="邮箱">
                  <Input
                    placeholder="请输入邮箱"
                    prefix={<MailOutlined />}
                    value={candidate.email}
                    onChange={(e) => updateCandidate(index, 'email', e.target.value)}
                  />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item label="电话">
                  <Input
                    placeholder="请输入电话"
                    prefix={<PhoneOutlined />}
                    value={candidate.phone}
                    onChange={(e) => updateCandidate(index, 'phone', e.target.value)}
                  />
                </Form.Item>
              </Col>
            </Row>
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item label="状态">
                  <Select
                    value={candidate.status}
                    onChange={(value) => updateCandidate(index, 'status', value)}
                    style={{ width: '100%' }}
                  >
                    {getCandidateStatusOptions().map(option => (
                      <Option key={option.value} value={option.value}>
                        {option.label}
                      </Option>
                    ))}
                  </Select>
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item label="备注">
                  <Input
                    placeholder="请输入备注"
                    value={candidate.notes}
                    onChange={(e) => updateCandidate(index, 'notes', e.target.value)}
                  />
                </Form.Item>
              </Col>
            </Row>
          </Card>
        ))}

        {candidates.length === 0 && (
          <div style={{ textAlign: 'center', padding: '20px', color: '#999' }}>
            <Text type="secondary">暂无候选人，请点击上方按钮添加</Text>
          </div>
        )}
      </Form>

      {/* 简历选择器模态框 */}
      <Modal
        title="从简历库选择候选人"
        open={showResumeSelector}
        onCancel={() => {
          setShowResumeSelector(false);
          setSelectedResumes([]);
          setSelectedResumeDetails({});
          setResumeSearchText('');
        }}
        width={800}
        footer={[
          <Button key="cancel" onClick={() => {
            setShowResumeSelector(false);
            setSelectedResumes([]);
            setSelectedResumeDetails({});
            setResumeSearchText('');
          }}>
            取消
          </Button>,
          <Button 
            key="confirm" 
            type="primary" 
            onClick={confirmResumeSelection}
            disabled={selectedResumes.length === 0}
          >
            确认选择 ({selectedResumes.length})
          </Button>
        ]}
      >
        <div style={{ marginBottom: 16 }}>
          <Input
            placeholder="搜索简历（姓名、邮箱、职位）"
            prefix={<SearchOutlined />}
            value={resumeSearchText}
            onChange={(e) => { setResumeSearchText(e.target.value); setResumePage(1); }}
            allowClear
          />
        </div>

        <List
          dataSource={resumes}
          loading={resumeLoading}
          renderItem={(resume) => (
            <List.Item
              actions={[
                <Checkbox
                  key="select"
                  checked={selectedResumes.includes(resume.id)}
                  onChange={(e) => {
                    if (e.target.checked) {
                      setSelectedResumes([...selectedResumes, resume.id]);
                      setSelectedResumeDetails(previous => ({ ...previous, [resume.id]: resume }));
                    } else {
                      setSelectedResumes(selectedResumes.filter(id => id !== resume.id));
                      setSelectedResumeDetails(previous => {
                        const next = { ...previous };
                        delete next[resume.id];
                        return next;
                      });
                    }
                  }}
                >
                  选择
                </Checkbox>
              ]}
            >
              <List.Item.Meta
                avatar={<Avatar icon={<UserOutlined />} />}
                title={
                  <div>
                    <Text strong>{resume.name || resume.filename || '未知姓名'}</Text>
                    {resume.position && (
                      <Tag color="blue" style={{ marginLeft: 8 }}>
                        {resume.position}
                      </Tag>
                    )}
                  </div>
                }
                description={
                  <Space direction="vertical" size="small">
                    {resume.email && (
                      <div>
                        <MailOutlined style={{ marginRight: 4 }} />
                        <Text>{resume.email}</Text>
                      </div>
                    )}
                    {resume.phone && (
                      <div>
                        <PhoneOutlined style={{ marginRight: 4 }} />
                        <Text>{resume.phone}</Text>
                      </div>
                    )}
                    {resume.filename && (
                      <div>
                        <FileTextOutlined style={{ marginRight: 4 }} />
                        <Text type="secondary">{resume.filename}</Text>
                      </div>
                    )}
                  </Space>
                }
              />
            </List.Item>
          )}
        />

        <Pagination current={resumePage} pageSize={20} total={resumeTotal}
          onChange={setResumePage} showSizeChanger={false} size="small"
          style={{ marginTop: 12, textAlign: 'right' }} />

        {!resumeLoading && resumes.length === 0 && (
          <div style={{ textAlign: 'center', padding: '40px', color: '#999' }}>
            <Text type="secondary">
              {resumeSearchText ? '没有找到匹配的简历' : '简历库中暂无简历'}
            </Text>
          </div>
        )}
      </Modal>
    </Modal>
  );
};

export default TaskForm;
