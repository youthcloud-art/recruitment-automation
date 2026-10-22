import React, { useState, useEffect } from 'react';
import { Layout, Card, Table, Tag, message, Button, Modal, Space, Tabs, Alert } from 'antd';
import { DeleteOutlined, ExclamationCircleOutlined, EyeOutlined, ReloadOutlined } from '@ant-design/icons';
import DocumentUpload from './DocumentUpload';
import DocumentViewer from './DocumentViewer';
import SmartSearch from './SmartSearch';
import { API_ENDPOINTS } from '../config/api';
import { apiDelete, apiGet } from '../utils/apiClient';

const { Content } = Layout;
const { confirm } = Modal;

const KnowledgeBase = ({ selectedMenu: defaultMenu = 'documents' }) => {
  const [documents, setDocuments] = useState([]);
  const [loading, setLoading] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [viewerVisible, setViewerVisible] = useState(false);
  const [selectedDocument, setSelectedDocument] = useState(null);
  const [activeTab, setActiveTab] = useState(defaultMenu);
  const [loadError, setLoadError] = useState('');

  // 使用统一的API端点配置

  useEffect(() => {
    loadDocuments();
  }, []);

  useEffect(() => setActiveTab(defaultMenu), [defaultMenu]);

  const loadDocuments = async () => {
    setLoading(true);
    try {
      setLoadError('');
      const response = await apiGet(API_ENDPOINTS.KNOWLEDGE.DOCUMENTS, { companyId: '1' });
      if (!response.success) throw new Error(response.message || '加载文档列表失败');
      setDocuments(Array.isArray(response.data) ? response.data : []);
    } catch (error) {
      setLoadError(error.message || '加载文档列表失败');
    } finally {
      setLoading(false);
    }
  };

  // 删除文档
  const handleDeleteDocument = async (documentId, documentTitle) => {
    setDeleteLoading(true);
    try {
      const response = await apiDelete(`${API_ENDPOINTS.KNOWLEDGE.DOCUMENTS}/${documentId}?companyId=1`);
      if (response.success) {
        message.success(response.data?.message || `文档"${documentTitle}"删除成功`);
        await loadDocuments();
      } else {
        message.error('删除失败');
      }
    } catch (error) {
      console.error('删除文档失败:', error);
      message.error(`删除文档失败: ${error.message}`);
    } finally {
      setDeleteLoading(false);
    }
  };

  // 显示删除确认弹窗
  const showDeleteConfirm = (documentId, documentTitle, status) => {
    const isProcessing = status === 'processing';
    
    confirm({
      title: '确认删除文档',
      icon: <ExclamationCircleOutlined />,
      content: (
        <div>
          <p>您确定要删除文档 <strong>"{documentTitle}"</strong> 吗？</p>
          {isProcessing && (
            <p style={{ color: '#faad14', fontSize: '14px', fontWeight: 'bold' }}>
              ⚠️ 该文档正在处理中，删除后将立即停止处理并移除所有相关数据。
            </p>
          )}
          <p style={{ color: '#ff4d4f', fontSize: '14px' }}>
            ⚠️ 此操作不可撤销，删除后文档及其所有相关内容将永久丢失。
          </p>
        </div>
      ),
      okText: '确认删除',
      okType: 'danger',
      cancelText: '取消',
      onOk() {
        handleDeleteDocument(documentId, documentTitle);
      },
    });
  };

  // 查看文档
  const handleViewDocument = (document) => {
    setSelectedDocument(document);
    setViewerVisible(true);
  };

  // 关闭文档查看器
  const handleCloseViewer = () => {
    setViewerVisible(false);
    setSelectedDocument(null);
  };

  const columns = [
    {
      title: '文档名称',
      dataIndex: 'title',
      key: 'title',
      render: (title, record) => (
        <div style={{ maxWidth: '300px', wordBreak: 'break-all' }}>
          {record.status === 'processing' && (
            <Tag color="orange" style={{ marginRight: 8, marginBottom: 4 }}>
              处理中
            </Tag>
          )}
          {title}
        </div>
      ),
    },
    {
      title: '文件类型',
      dataIndex: 'file_type',
      key: 'file_type',
      render: (type) => {
        const typeMap = {
          'application/pdf': { text: 'PDF', color: 'red' },
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { text: 'Word', color: 'blue' },
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { text: 'Excel', color: 'green' },
          'text/plain': { text: 'TXT', color: 'default' },
          'text/markdown': { text: 'MD', color: 'purple' }
        };
        const config = typeMap[type] || { text: '未知', color: 'default' };
        return <Tag color={config.color}>{config.text}</Tag>;
      },
    },
    {
      title: '文件大小',
      dataIndex: 'file_size',
      key: 'file_size',
      render: (size) => {
        if (size < 1024) return `${size} B`;
        if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
        return `${(size / (1024 * 1024)).toFixed(1)} MB`;
      },
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      render: (status) => {
        const statusMap = {
          'processed': { text: '已处理', color: 'green' },
          'processing': { text: '处理中', color: 'orange' },
          'failed': { text: '处理失败', color: 'red' }
        };
        const config = statusMap[status] || { text: status, color: 'default' };
        return <Tag color={config.color}>{config.text}</Tag>;
      },
    },
    {
      title: '上传时间',
      dataIndex: 'upload_time',
      key: 'upload_time',
      render: (time) => new Date(time).toLocaleString('zh-CN'),
    },
    {
      title: '操作',
      key: 'action',
      render: (_, record) => (
        <Space>
          <Button
            type="primary"
            size="small"
            icon={<EyeOutlined />}
            onClick={() => handleViewDocument(record)}
            disabled={record.status === 'processing'}
          >
            查看
          </Button>
          <Button
            type="primary"
            danger
            size="small"
            icon={<DeleteOutlined />}
            loading={deleteLoading}
            onClick={() => showDeleteConfirm(record.id, record.title, record.status)}
          >
            删除
          </Button>
        </Space>
      ),
    },
  ];

  const renderContent = () => {
    switch (activeTab) {
      case 'documents':
        return (
          <div>
            <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3>文档管理</h3>
              <Space>
                <span style={{ color: '#666', fontSize: '14px' }}>
                  共 {documents.length} 个文档
                </span>
                <Button icon={<ReloadOutlined />} onClick={loadDocuments}>刷新</Button>
              </Space>
            </div>
            {loadError && <Alert type="error" showIcon message={loadError} style={{ marginBottom: 16 }} />}
            <Table
              columns={columns}
              dataSource={documents}
              loading={loading}
              rowKey="id"
              pagination={{
                pageSize: 10,
                showSizeChanger: true,
                showQuickJumper: true,
                showTotal: (total, range) => `第 ${range[0]}-${range[1]} 条，共 ${total} 条`,
              }}
            />
          </div>
        );
      case 'upload':
        return (
          <div>
            <h3>文档上传</h3>
            <DocumentUpload onUploadSuccess={async () => {
              await loadDocuments();
              setActiveTab('documents');
            }} />
          </div>
        );
      case 'search':
        return <SmartSearch onOpenDocuments={() => setActiveTab('documents')} />;
      default:
        return <div>请选择功能</div>;
    }
  };

  return (
    <Content style={{ padding: 24, height: '100%', overflow: 'auto' }}>
      <Card style={{ minHeight: '100%' }}>
        <Tabs
          activeKey={activeTab}
          onChange={setActiveTab}
          items={[
            { key: 'documents', label: '文档管理' },
            { key: 'upload', label: '文档上传' },
            { key: 'search', label: '知识检索' }
          ]}
        />
        {renderContent()}
      </Card>
      
      {/* 文档查看器 */}
      <DocumentViewer
        visible={viewerVisible}
        onClose={handleCloseViewer}
        documentId={selectedDocument?.id}
        documentTitle={selectedDocument?.title}
      />
    </Content>
  );
};

export default KnowledgeBase;
