import React, { useEffect, useState } from 'react';
import { Alert, Button, Card, Col, Empty, Row, Select, Space, Spin, Typography, message } from 'antd';
import { BarChartOutlined, DownloadOutlined, ReloadOutlined } from '@ant-design/icons';
import { apiGet } from '../utils/apiClient';
import { ACTIVE_JOB_CHANGED } from '../utils/activeJobEvents';
import './RecruitmentAnalytics.css';

const { Title, Text } = Typography;
const STATUS_COLORS = {
  new: '#7695bd', shortlisted: '#2f9e75', viewed: '#53a6d6',
  contacted: '#9169c9', rejected: '#c28b83'
};
const SOURCE_COLORS = { boss: '#f08b47', zlzp: '#357fe7', qcwy: '#8c6bd7' };

function percent(value, total) {
  return total ? Math.max(0, Math.min(100, (value / total) * 100)) : 0;
}

function Metric({ label, value, suffix, detail }) {
  return <Card className="ra-metric" size="small">
    <Text type="secondary">{label}</Text>
    <div className="ra-metric-value">{value ?? '—'}{value !== null && value !== undefined && suffix && <small>{suffix}</small>}</div>
    <Text type="secondary" className="ra-metric-detail">{detail}</Text>
  </Card>;
}

function RowBar({ label, value, total, color, suffix = '份' }) {
  return <div className="ra-row-bar">
    <span className="ra-row-label">{label}</span>
    <div className="ra-track" role="img" aria-label={`${label} ${value}${suffix}`}>
      <div className="ra-fill" style={{ width: `${percent(value, total)}%`, background: color }} />
    </div>
    <strong className="ra-row-value">{value}{suffix}</strong>
  </div>;
}

function RecruitmentAnalytics() {
  const [scope, setScope] = useState('active');
  const [threshold, setThreshold] = useState(70);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState('');
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    apiGet('/recruitment-pipeline/analytics', { scope, threshold }, { signal: controller.signal })
      .then(result => {
        if (!controller.signal.aborted) setData(result.data);
      })
      .catch(cause => {
        if (!controller.signal.aborted) setError(cause.message || '无法加载招聘统计');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [scope, threshold, reloadKey]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden) setReloadKey(value => value + 1);
    }, 30000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    const onJobChanged = () => setReloadKey(value => value + 1);
    window.addEventListener(ACTIVE_JOB_CHANGED, onJobChanged);
    return () => window.removeEventListener(ACTIVE_JOB_CHANGED, onJobChanged);
  }, []);

  const download = async format => {
    setDownloading(format);
    try {
      const blob = await apiGet('/recruitment-pipeline/analytics/report',
        { scope, threshold, format }, { responseType: 'blob' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `招聘数据分析报告.${format}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      message.success(`已下载 ${format === 'docx' ? 'Word' : 'CSV'} 分析报告`);
    } catch (cause) {
      message.error(`导出分析报告失败：${cause.message}`);
    } finally { setDownloading(''); }
  };

  const maxSource = Math.max(1, ...(data?.bySource || []).map(row => row.total));
  const maxStatus = Math.max(1, ...(data?.byStatus || []).map(row => row.count));
  const maxBand = Math.max(1, ...(data?.scoreBands || []).map(row => row.count));
  const maxTrend = Math.max(1, ...(data?.trend || []).map(row => Math.max(row.stored, row.evaluated)));

  return <div className="ra-page">
    <div className="ra-header">
      <div>
        <Title level={3} className="ra-title"><BarChartOutlined /> 招聘数据分析</Title>
        <Text type="secondary">统计本机已入库的三平台简历，按真实采集和评估记录生成报告。</Text>
      </div>
      <Space wrap>
        <Select aria-label="统计范围" value={scope} style={{ width: 174 }} onChange={setScope}
          options={[{ value: 'active', label: '当前岗位' }, { value: 'all', label: '全部历史岗位' }]} />
        <Select aria-label="通过分数" value={threshold} style={{ width: 155 }} onChange={setThreshold}
          options={[60, 70, 80, 90].map(value => ({ value, label: `${value} 分及以上` }))} />
        <Button icon={<ReloadOutlined />} onClick={() => setReloadKey(value => value + 1)}>刷新</Button>
        <Button type="primary" icon={<DownloadOutlined />} disabled={!data || loading}
          loading={downloading === 'docx'} onClick={() => download('docx')}>下载 Word 报告</Button>
        <Button icon={<DownloadOutlined />} disabled={!data || loading}
          loading={downloading === 'csv'} onClick={() => download('csv')}>下载 CSV 明细</Button>
      </Space>
    </div>

    {error && <Alert type="error" showIcon style={{ marginBottom: 16 }} message="统计加载失败"
      description={error} action={<Button onClick={() => setReloadKey(value => value + 1)}>重试</Button>} />}
    {loading && !data ? <div className="ra-loading"><Spin tip="正在统计本机简历" /></div> : null}

    {data && <>
      <Alert className="ra-scope-note" type="info" showIcon
        message={scope === 'active'
          ? `当前岗位：${data.job.title || '尚未设置'}${data.job.targetCount ? ` · 每平台目标 ${data.job.targetCount} 份` : ''}`
          : '全部历史岗位'}
        description={`${data.scopeNote} 通过线为 ${data.threshold} 分；通过率以已评估简历为分母。报告仅包含聚合数量，不包含姓名、联系方式或简历正文。`} />

      {scope === 'active' && !data.job.configured ? <Empty className="ra-empty"
        description="请先在三平台候选人页面填写或导入岗位条件并保存，再查看当前岗位统计" /> : <>
        <Row gutter={[14, 14]} className="ra-metrics">
          <Col xs={12} md={8} xl={4}><Metric label={scope === 'active' ? '本岗位已关联' : '历史入库简历'}
            value={data.metrics.total} suffix="份"
            detail={scope === 'active' ? '仅同版要求已评估记录' : '所选范围内'} /></Col>
          <Col xs={12} md={8} xl={4}><Metric label="有效评估" value={data.metrics.evaluated} suffix="份"
            detail={data.metrics.evaluationRate === null ? '同版要求关联记录' : `评估率 ${data.metrics.evaluationRate}%`} /></Col>
          <Col xs={12} md={8} xl={4}><Metric label="达到分数线" value={data.metrics.passed} suffix="份" detail={`占已评估 ${data.metrics.passRate}%`} /></Col>
          <Col xs={12} md={8} xl={4}><Metric label="待评估" value={data.metrics.unevaluated} suffix="份"
            detail={data.metrics.unevaluated === null ? '当前岗位无法可靠归属' : '待补充岗位匹配评估'} /></Col>
          <Col xs={12} md={8} xl={4}><Metric label="保存原文" value={data.metrics.withOriginalText} suffix="份" detail={`原文留存率 ${data.metrics.originalTextRate}%`} /></Col>
          <Col xs={12} md={8} xl={4}><Metric label="平均匹配分" value={data.metrics.scoreAverage} suffix="分" detail="仅计算有效评估分" /></Col>
        </Row>

        <Row gutter={[16, 16]}>
          <Col xs={24} lg={12}><Card title="招聘平台分布" className="ra-panel">
            {data.bySource.map(row => <div key={row.source} className="ra-source-block">
              <RowBar label={row.label} value={row.total} total={maxSource} color={SOURCE_COLORS[row.source]} />
              <Text type="secondary" className="ra-source-detail">已评估 {row.evaluated} · 达到 {threshold} 分 {row.passed} · 已保存原文 {row.withOriginalText}</Text>
            </div>)}
          </Card></Col>
          <Col xs={24} lg={12}><Card title="岗位匹配分分布" className="ra-panel"
            extra={<Text type="secondary">已评估 {data.metrics.evaluated} 份</Text>}>
            {data.scoreBands.map(row => <RowBar key={row.key} label={row.label} value={row.count}
              total={maxBand} color={row.key === '90-100' || row.key === '80-89' ? '#2f9e75' : '#6097d8'} />)}
          </Card></Col>
          <Col xs={24} lg={12}><Card title="人工跟进状态" className="ra-panel">
            {data.byStatus.map(row => <RowBar key={row.status} label={row.label} value={row.count}
              total={maxStatus} color={STATUS_COLORS[row.status]} />)}
          </Card></Col>
          <Col xs={24} lg={12}><Card title="最近十四天" className="ra-panel">
            <div className="ra-trend-legend"><span className="ra-dot ra-stored" />入库
              <span className="ra-dot ra-evaluated" />评估</div>
            <div className="ra-trend" role="img" aria-label="最近十四天入库及评估数量">
              {data.trend.map((row, index) => <div className="ra-day" key={row.date}
                title={`${row.date}：入库 ${row.stored} 份，评估 ${row.evaluated} 份`}>
                <div className="ra-day-bars">
                  <div className="ra-trend-bar ra-trend-stored" style={{ height: `${percent(row.stored, maxTrend)}%` }} />
                  <div className="ra-trend-bar ra-trend-evaluated" style={{ height: `${percent(row.evaluated, maxTrend)}%` }} />
                </div>
                <span>{index === 0 || index === 6 || index === 13 ? row.date.slice(5) : ''}</span>
              </div>)}
            </div>
            <Text type="secondary" className="ra-chart-note">鼠标悬停可查看每日数量；空白表示当日没有入库或评估。</Text>
          </Card></Col>
        </Row>
      </>}
      <Text type="secondary" className="ra-generated">更新于 {new Date(data.generatedAt).toLocaleString('zh-CN')}。匹配分仅供人工复核。</Text>
    </>}
  </div>;
}

export default RecruitmentAnalytics;
