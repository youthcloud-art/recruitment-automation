const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

function resolveBindHost(value) {
  const host = String(value || '').trim() || '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error('招聘数据服务尚无远程访问认证；请绑定 127.0.0.1，并在部署远程访问前配置认证和 HTTPS');
  }
  return host;
}

module.exports = { resolveBindHost };
