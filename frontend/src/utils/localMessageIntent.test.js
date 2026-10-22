import { classifyPositionOrAnalyticsIntent, isPositionCreationQuery } from './localMessageIntent';

describe('local chat intent', () => {
  test.each([
    '创建数据分析师岗位',
    '请帮我创建一个数据分析师岗位',
    '新建 IT 网络运维职位',
    'IT 网络运维岗位创建',
    '我要招聘一名数据分析师'
  ])('routes %s to job creation', input => {
    expect(isPositionCreationQuery(input)).toBe(true);
    expect(classifyPositionOrAnalyticsIntent(input)).toBe('position-creation');
  });

  test.each([
    '查看数据分析报告',
    '查看招聘统计',
    '打开数据看板',
    '查看数据分析师岗位的招聘报告'
  ])('routes %s to analytics', input => {
    expect(classifyPositionOrAnalyticsIntent(input)).toBe('analytics');
  });

  test.each(['推荐数据分析师岗位候选人', '数据分析师简历', '', null])(
    'does not classify %s as analytics', input => {
      expect(classifyPositionOrAnalyticsIntent(input)).toBeNull();
    }
  );
});
