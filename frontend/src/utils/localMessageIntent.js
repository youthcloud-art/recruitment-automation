// Keep local actions available even if the chat socket has disconnected.
// Creation takes priority because job titles can contain words like 数据分析.
export function isPositionCreationQuery(query) {
  return /(?:创建|新建|添加|生成|发布).*(?:岗位|职位|JD)|(?:岗位|职位).*(?:创建|新建|添加|生成|发布)|(?:我要|需要|计划)招聘.+/.test(String(query || ''));
}

export function classifyPositionOrAnalyticsIntent(query) {
  const text = String(query || '').trim();
  if (isPositionCreationQuery(text)) return 'position-creation';

  // 数据分析师 is a job title, not an analytics request by itself.
  const withoutJobTitle = text.replace(/数据分析师/g, '');
  if (/数据分析|招聘统计|招聘报告|数据看板/.test(withoutJobTitle)) return 'analytics';
  return null;
}
