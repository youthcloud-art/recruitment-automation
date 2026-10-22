const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
function createLocalApiAccess({ port = process.env.PORT || 5001 } = {}) {
  const backendPort = Number(port);
  if (!Number.isInteger(backendPort) || backendPort < 1 || backendPort > 65535) {
    throw new Error('Invalid local backend port');
  }
  const loopbackHosts = ['localhost', '127.0.0.1', '[::1]'];
  const trustedHosts = new Set(loopbackHosts.flatMap(host => [host, `${host}:${backendPort}`]));
  const trustedOrigins = new Set(loopbackHosts.flatMap(host =>
    [`http://${host}:3000`, `http://${host}:${backendPort}`]));

  return function localApiAccess(req, res, next) {
    // The local launcher binds the backend to loopback. Reject requests addressed
    // through an unrelated hostname as well, so DNS rebinding cannot read resumes.
    if (!LOOPBACK_ADDRESSES.has(req.socket.remoteAddress || '') ||
        !trustedHosts.has((req.get('host') || '').toLowerCase()) ||
        (req.get('origin') && !trustedOrigins.has(req.get('origin'))) ||
        (!req.get('origin') && req.get('sec-fetch-site') === 'cross-site')) {
      return res.status(403).json({ success: false, message: '本机招聘数据仅允许从本机系统访问' });
    }
    next();
  };
}

const localApiAccess = createLocalApiAccess();
module.exports = { localApiAccess, createLocalApiAccess };
