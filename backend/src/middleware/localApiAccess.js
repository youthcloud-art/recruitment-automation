const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const TRUSTED_ORIGINS = new Set([
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://[::1]:3000',
  'http://localhost:5001',
  'http://127.0.0.1:5001',
  'http://[::1]:5001'
]);

function localApiAccess(req, res, next) {
  // The local launcher binds the backend to loopback. Reject requests addressed
  // through an unrelated hostname as well, so DNS rebinding cannot read resumes.
  if (!LOOPBACK_ADDRESSES.has(req.socket.remoteAddress || '') ||
      !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::5001)?$/i.test(req.get('host') || '') ||
      (req.get('origin') && !TRUSTED_ORIGINS.has(req.get('origin'))) ||
      (!req.get('origin') && req.get('sec-fetch-site') === 'cross-site')) {
    return res.status(403).json({ success: false, message: '本机招聘数据仅允许从本机系统访问' });
  }
  next();
}

module.exports = { localApiAccess };
