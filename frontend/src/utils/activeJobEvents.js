export const ACTIVE_JOB_CHANGED = 'recruitment:active-job-changed';

export function notifyActiveJobChanged(job, applyTo = 'all') {
  if (typeof window !== 'undefined' && job?.title) {
    window.dispatchEvent(new CustomEvent(ACTIVE_JOB_CHANGED, { detail: { job, applyTo } }));
  }
}
