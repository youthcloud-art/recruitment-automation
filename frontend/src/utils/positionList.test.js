import { mergeActivePosition, sameCriteria } from './positionList';

const active = {
  title: '项目经理主管', searchKeywords: '项目经理主管，项目经理',
  location: '上海', education: '本科及以上', minExperienceYears: 5,
  targetCount: 18, jobRequirements: '负责项目计划、交付和团队协调。',
  updatedAt: '2026-01-01T00:00:00Z'
};

test('旧安装只有 active-job 时，岗位管理展示可修订的当前岗位且不写入原数组', () => {
  const stored = [];
  const visible = mergeActivePosition(stored, active);
  expect(stored).toHaveLength(0);
  expect(visible).toHaveLength(1);
  expect(visible[0]).toMatchObject({
    id: 'active-job-current', title: '项目经理主管',
    isVirtualCurrent: true, jobCriteria: active
  });
});

test('当前岗位已经归档时不重复展示，不同条件则保留当前岗位', () => {
  const stored = [{ id: 'position_1', title: active.title, jobCriteria: { ...active } }];
  expect(mergeActivePosition(stored, active)).toBe(stored);
  expect(sameCriteria(stored[0].jobCriteria, active)).toBe(true);
  const changed = { ...active, targetCount: 20 };
  const visible = mergeActivePosition(stored, changed);
  expect(visible).toHaveLength(2);
  expect(visible[0].jobCriteria.targetCount).toBe(20);
});

test('未设置完整当前岗位时不显示虚拟记录', () => {
  expect(mergeActivePosition([], null)).toEqual([]);
  expect(mergeActivePosition([], { title: '项目经理主管' })).toEqual([]);
});
