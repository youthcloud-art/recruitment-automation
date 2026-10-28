import React, { useState } from 'react';
import { Alert, Button, Card, Input, Select, Space, Typography, message } from 'antd';
import { ExportOutlined } from '@ant-design/icons';

const PRESETS = [
  { label: '智联招聘', value: 'https://sou.zhaopin.com/' },
  { label: '前程无忧', value: 'https://www.51job.com/' },
  { label: 'BOSS 直聘', value: 'https://www.zhipin.com/' }
];

function safeWebUrl(value) {
  const input = String(value || '').trim();
  if (!input || input.length > 2048) return null;
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(input) ? input : `https://${input}`);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname ||
        url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

export default function Browser() {
  const [url, setUrl] = useState(PRESETS[0].value);
  const open = () => {
    const target = safeWebUrl(url);
    if (!target) return message.error('请输入有效的 HTTP 或 HTTPS 网址');
    window.open(target, '_blank', 'noopener,noreferrer');
  };

  return <div style={{ padding: 24, maxWidth: 900, margin: '0 auto' }}>
    <Typography.Title level={3}>浏览器</Typography.Title>
    <Alert type="info" showIcon style={{ marginBottom: 18 }}
      message="在新标签页打开招聘平台或其他网页"
      description="招聘平台通常禁止嵌入网页，旧版内嵌浏览器因此可能空白。这里打开官网供你查看；简历采集仍使用公司服务器上的专用浏览器，可通过页面顶部的“服务器浏览器”查看或处理登录验证。" />
    <Card title="打开网页">
      <Space wrap style={{ width: '100%' }}>
        <Select aria-label="常用招聘网站" value={PRESETS.some(item => item.value === url) ? url : undefined}
          placeholder="常用招聘网站" style={{ width: 170 }} options={PRESETS} onChange={setUrl} />
        <Input aria-label="网页地址" value={url} onChange={event => setUrl(event.target.value)}
          onPressEnter={open} placeholder="输入网址" style={{ width: 'min(420px, 78vw)' }} />
        <Button type="primary" icon={<ExportOutlined />} onClick={open}>在新标签页打开</Button>
      </Space>
    </Card>
  </div>;
}
