// Historical installations can have an active criteria file without a saved
// position catalog entry. Scope to the current/archived index only when the
// active job has an unambiguous catalog identity; otherwise retain the older
// requirements-based view until the job is saved again.
function hasTrackedActiveJob(store, activeJob, requirements) {
  if (!activeJob || activeJob.jobRequirements !== requirements) return false;
  if (activeJob.positionId) return true;
  if (typeof store?.getPositions !== 'function') return false;
  return store.getPositions().some(position => !position.archivedAt &&
    position.title === activeJob.title &&
    position.jobCriteria?.jobRequirements === requirements);
}

module.exports = { hasTrackedActiveJob };
