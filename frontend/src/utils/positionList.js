const CRITERIA_FIELDS = [
  'title', 'searchKeywords', 'location', 'education', 'minExperienceYears',
  'targetCount', 'recommendationTargetCount', 'jobRequirements'
];

export const sameCriteria = (left, right) => Boolean(left && right &&
  CRITERIA_FIELDS.every(field => left[field] === right[field]));

// Older installations may have an active job saved before the local position
// catalog existed. Display it in the catalog without writing or duplicating it.
export const mergeActivePosition = (positions = [], activeJob = null) => {
  const list = Array.isArray(positions) ? positions : [];
  if (!activeJob?.title || !activeJob?.jobRequirements ||
      list.some(position => !position.archivedAt && sameCriteria(position.jobCriteria, activeJob))) return list;
  return [{
    id: 'active-job-current',
    title: activeJob.title,
    name: activeJob.title,
    location: activeJob.location || '',
    education: activeJob.education || '',
    experience: activeJob.minExperienceYears ?? '',
    description: activeJob.jobRequirements,
    searchKeywords: activeJob.searchKeywords || activeJob.title,
    targetCount: activeJob.targetCount ?? null,
    jobCriteria: activeJob,
    createdAt: activeJob.updatedAt || null,
    isVirtualCurrent: true
  }, ...list];
};
