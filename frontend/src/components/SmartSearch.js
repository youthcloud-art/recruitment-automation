import React, { useState } from 'react';
import { Alert, Card, Input, Space, Tag, Typography } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { apiPost } from '../utils/apiClient';
import KnowledgeSearchResult from './KnowledgeSearchResult';

const { Search } = Input;
const { Text } = Typography;

const SmartSearch = ({ onOpenDocuments }) => {
  const [query, setQuery] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [history, setHistory] = useState([]);

  const handleSearch = async value => {
    const trimmed = String(value || '').trim();
    if (!trimmed) return;
    setSubmittedQuery(trimmed);
    setLoading(true);
    setError('');
    try {
      const response = await apiPost('/knowledge/retrieve', {
        query: trimmed,
        companyId: '1',
        limit: 20
      });
      if (!response?.success) throw new Error(response?.message || '检索失败');
      setResults(Array.isArray(response.data?.results) ? response.data.results : []);
      setHistory(previous => [trimmed, ...previous.filter(item => item !== trimmed)].slice(0, 8));
    } catch (searchError) {
      setResults([]);
      setError(searchError.message || '知识检索服务暂时不可用');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <Card title={<><SearchOutlined style={{ marginRight: 8 }} />知识检索</>} style={{ marginBottom: 16 }}>
        <Search
          aria-label="知识检索关键词"
          placeholder="输入制度、岗位资料或其他关键词"
          enterButton="检索"
          size="large"
          value={query}
          onChange={event => setQuery(event.target.value)}
          onSearch={handleSearch}
          loading={loading}
          allowClear
        />
        {history.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <Text type="secondary">最近搜索：</Text>
            <Space wrap>
              {history.map(item => (
                <Tag key={item} color="blue" style={{ cursor: 'pointer' }} onClick={() => {
                  setQuery(item);
                  handleSearch(item);
                }}>{item}</Tag>
              ))}
            </Space>
          </div>
        )}
      </Card>

      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />}
      {submittedQuery && !loading && !error && (
        <KnowledgeSearchResult
          query={submittedQuery}
          results={results}
          onOpenDocuments={onOpenDocuments}
        />
      )}
    </div>
  );
};

export default SmartSearch;
