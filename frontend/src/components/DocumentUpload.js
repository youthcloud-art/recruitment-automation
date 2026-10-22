import React, { useState } from 'react';
import { Card, Button, message, Progress, List, Tag, Space } from 'antd';
import { InboxOutlined, FileTextOutlined } from '@ant-design/icons';
import { useDropzone } from 'react-dropzone';
import axios from 'axios';
import { buildApiUrl } from '../config/api';

const DocumentUpload = ({ onUploadSuccess }) => {
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadedFiles, setUploadedFiles] = useState([]);

  const onDrop = async (acceptedFiles, rejectedFiles) => {
    if (rejectedFiles.length > 0) {
      message.error('仅支持单个不超过 50 MB 的 PDF、DOCX、XLSX、TXT 或 MD 文件');
    }
    if (acceptedFiles.length === 0) return;
    setUploading(true);
    setUploadProgress(0);
    let anySuccess = false;

    for (let i = 0; i < acceptedFiles.length; i++) {
      const file = acceptedFiles[i];
      try {
        const formData = new FormData();
        formData.append('document', file);
        formData.append('companyId', '1');
        formData.append('title', file.name);

        const response = await axios.post(buildApiUrl('/knowledge/upload'), formData, {
          onUploadProgress: (progressEvent) => {
            if (progressEvent.total) {
              setUploadProgress(Math.round((progressEvent.loaded * 100) / progressEvent.total));
            }
          },
        });

        if (response.data.success) {
          anySuccess = true;
          message.success(`${file.name} 上传成功`);
          setUploadedFiles(prev => [...prev, {
            name: file.name,
            status: 'success',
            id: response.data.data.documentId
          }]);
          
        }
      } catch (error) {
        message.error(`${file.name} 上传失败: ${error.response?.data?.message || error.message}`);
        setUploadedFiles(prev => [...prev, {
          name: file.name,
          status: 'error',
          error: error.response?.data?.message || error.message
        }]);
      }

      setUploadProgress((i + 1) * 100 / acceptedFiles.length);
    }

    setUploading(false);
    setUploadProgress(0);
    if (anySuccess && onUploadSuccess) await onUploadSuccess();
  };

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'application/pdf': ['.pdf'],
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
      'text/plain': ['.txt'],
      'text/markdown': ['.md']
    },
    multiple: true,
    maxSize: 50 * 1024 * 1024
  });

  const getFileTypeIcon = (fileName) => {
    const ext = fileName.split('.').pop().toLowerCase();
    const iconMap = {
      'pdf': '📄',
      'docx': '📝',
      'xlsx': '📊',
      'txt': '📄',
      'md': '📝'
    };
    return iconMap[ext] || '📄';
  };

  const getFileTypeTag = (fileName) => {
    const ext = fileName.split('.').pop().toLowerCase();
    const tagMap = {
      'pdf': { text: 'PDF', color: 'red' },
      'docx': { text: 'Word', color: 'blue' },
      'xlsx': { text: 'Excel', color: 'green' },
      'txt': { text: 'TXT', color: 'default' },
      'md': { text: 'MD', color: 'purple' }
    };
    const config = tagMap[ext] || { text: '未知', color: 'default' };
    return <Tag color={config.color}>{config.text}</Tag>;
  };

  return (
    <div>
      <Card title="文档上传" style={{ marginBottom: 16 }}>
        <div
          {...getRootProps()}
          style={{
            border: '2px dashed #d9d9d9',
            borderRadius: 8,
            padding: 40,
            textAlign: 'center',
            backgroundColor: isDragActive ? '#f0f8ff' : '#fafafa',
            cursor: 'pointer',
            transition: 'all 0.3s',
          }}
        >
          <input {...getInputProps()} />
          <InboxOutlined style={{ fontSize: 48, color: '#1890ff', marginBottom: 16 }} />
          <p style={{ fontSize: 16, marginBottom: 8 }}>
            {isDragActive ? '将文件拖放到这里' : '点击或拖拽文件到此区域上传'}
          </p>
          <p style={{ color: '#666', marginBottom: 16 }}>
            支持 PDF、Word、Excel、TXT、Markdown 格式，单个文件不超过50MB
          </p>
          <Button type="primary" icon={<FileTextOutlined />}>
            选择文件
          </Button>
        </div>
      </Card>

      {uploading && (
        <Card title="上传进度" style={{ marginBottom: 16 }}>
          <Progress percent={uploadProgress} status="active" />
          <p>正在处理文档，请稍候...</p>
        </Card>
      )}

      {uploadedFiles.length > 0 && (
        <Card title="上传记录">
          <List
            dataSource={uploadedFiles}
            renderItem={(file) => (
              <List.Item>
                <List.Item.Meta
                  avatar={<span style={{ fontSize: 24 }}>{getFileTypeIcon(file.name)}</span>}
                  title={
                    <Space>
                      {file.name}
                      {getFileTypeTag(file.name)}
                      <Tag color={file.status === 'success' ? 'green' : 'red'}>
                        {file.status === 'success' ? '成功' : '失败'}
                      </Tag>
                    </Space>
                  }
                  description={file.error && `错误: ${file.error}`}
                />
              </List.Item>
            )}
          />
        </Card>
      )}
    </div>
  );
};

export default DocumentUpload;
