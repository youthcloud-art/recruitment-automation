'use strict';

// Single public port for the built React app, HTTP API and Socket.IO. The
// recruitment backend keeps its loopback-only boundary on BACKEND_PORT.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const { CompanyAuth } = require('./auth');

const gzip = promisify(zlib.gzip);
const brotliCompress = promisify(zlib.brotliCompress);
const STATIC_CACHE_LIMIT = 32 * 1024 * 1024;
const STATIC_FILE_LIMIT = 8 * 1024 * 1024;

const LOOPBACK = new Set(['127.0.0.1', '::1']);
const HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade'
]);
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
};

function portNumber(value, label) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${label} 必须为 1～65535`);
  return port;
}

function ipv4Number(value) {
  const parts = String(value).split('.');
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null;
  return parts.reduce((result, part) => (result * 256 + Number(part)) >>> 0, 0);
}

function parseCidr(value) {
  const [address, prefixText, ...extra] = String(value).trim().split('/');
  const network = ipv4Number(address);
  const prefix = Number(prefixText);
  if (extra.length || network === null || prefixText === undefined || !/^\d{1,2}$/.test(prefixText) ||
      prefix < 0 || prefix > 32) throw new Error(`无效的 LAN_ALLOW_CIDRS IPv4 网段: ${value}`);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return { mask, network: (network & mask) >>> 0 };
}

function installedNetworkConfigFile() {
  const releaseRoot = path.resolve(__dirname, '../..');
  if (path.basename(path.dirname(releaseRoot)).toLowerCase() !== 'releases') return null;
  return path.resolve(releaseRoot, '../..', 'delivery/config.json');
}

function installedAuthFile() {
  const releaseRoot = path.resolve(__dirname, '../..');
  if (path.basename(path.dirname(releaseRoot)).toLowerCase() !== 'releases') return null;
  return path.resolve(releaseRoot, '../..', 'shared/auth/users.json');
}

function refreshNetworkAccess(config, force = false) {
  if (!config.networkConfigFile) return;
  const now = Date.now();
  if (!force && now < config.nextNetworkCheckAt) return;
  config.nextNetworkCheckAt = now + config.networkCheckIntervalMs;
  try {
    const saved = JSON.parse(fs.readFileSync(config.networkConfigFile, 'utf8'));
    if (!Array.isArray(saved.allowedNetworks) || saved.allowedNetworks.length === 0) {
      throw new Error('公司网段名单为空或无效');
    }
    const networks = saved.allowedNetworks.map(value => String(value).trim());
    const cidrs = networks.map(parseCidr);
    config.cidrs = cidrs;
    config.allowedNetworkStrings = networks;
    config.networkConfigLoaded = true;
    config.networkReloadError = null;
  } catch (error) {
    if (!config.networkConfigLoaded) throw error;
    if (config.networkReloadError !== error.message) {
      console.error(`公司网段配置暂不可用，保留上一份有效名单: ${error.message}`);
    }
    config.networkReloadError = error.message;
  }
}

function normalizedOrigin(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) throw new Error('PUBLIC_ORIGIN 必须是完整 HTTP(S) 源地址');
  return url.origin;
}

function readConfig(options = {}) {
  const environment = options.environment || process.env;
  const host = String(options.host ?? environment.COMPANY_HOST ?? '192.168.1.24').trim();
  if (!host || /[\s/\\@?#]/.test(host)) throw new Error('COMPANY_HOST 无效');
  const port = portNumber(options.port ?? environment.COMPANY_PORT ?? 4000, 'COMPANY_PORT');
  const backendPort = portNumber(options.backendPort ?? environment.BACKEND_PORT ?? 5001, 'BACKEND_PORT');
  const authority = `${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`;
  const defaultOrigin = normalizedOrigin(`http://${authority}`);
  const publicOrigin = normalizedOrigin(options.publicOrigin ?? environment.PUBLIC_ORIGIN ?? defaultOrigin);
  const origins = new Set([defaultOrigin, publicOrigin]);
  const cidrValue = options.lanAllowCidrs ?? environment.LAN_ALLOW_CIDRS ?? '192.168.1.0/24,192.168.11.0/24';
  const allowedNetworkStrings = (Array.isArray(cidrValue) ? cidrValue : String(cidrValue).split(','))
    .map(value => String(value).trim()).filter(Boolean);
  const cidrs = allowedNetworkStrings.map(parseCidr);
  const networkConfigFile = options.networkConfigFile ?? environment.LAN_ALLOW_CONFIG_FILE ?? installedNetworkConfigFile();
  const authFile = options.authFile === null ? null :
    (options.authFile ?? environment.COMPANY_AUTH_FILE ?? installedAuthFile());
  const config = {
    host, port, backendPort, publicOrigin, origins, cidrs, allowedNetworkStrings,
    networkConfigFile: networkConfigFile ? path.resolve(networkConfigFile) : null,
    authFile: authFile ? path.resolve(authFile) : null,
    authEnabled: Boolean(authFile),
    networkCheckIntervalMs: options.networkCheckIntervalMs ?? 2000,
    nextNetworkCheckAt: 0, networkConfigLoaded: false, networkReloadError: null,
    allowedHosts: new Set([...origins].map(origin => new URL(origin).host.toLowerCase())),
    healthHosts: new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]),
    frontendBuildDir: path.resolve(options.frontendBuildDir ?? environment.FRONTEND_BUILD_DIR ??
      path.join(__dirname, '../../frontend/build')),
    healthTimeoutMs: options.healthTimeoutMs ?? 3000
  };
  refreshNetworkAccess(config, true);
  return config;
}

function remoteAddress(req) {
  return String(req.socket.remoteAddress || '').replace(/^::ffff:/i, '');
}

function addressAllowed(address, config) {
  if (LOOPBACK.has(address)) return true;
  const number = ipv4Number(address);
  return number !== null && config.cidrs.some(cidr => ((number & cidr.mask) >>> 0) === cidr.network);
}

// Only the browser running on this server may change its shared AI model.
// Compare TCP peer addresses; request headers are fully controlled by clients.
function isServerBrowser(req) {
  const peer = remoteAddress(req);
  const local = String(req.socket.localAddress || '').replace(/^::ffff:/i, '');
  return LOOPBACK.has(peer) || Boolean(peer && local && peer === local);
}

function isModelConfigPath(pathname) {
  return pathname === '/api/model-config' || pathname.startsWith('/api/model-config/');
}

// Never use Forwarded, X-Forwarded-For or X-Real-IP for this decision. The
// gateway is the LAN boundary and sees the connecting employee's real socket.
function boundaryError(req, config, pathname) {
  refreshNetworkAccess(config);
  const address = remoteAddress(req);
  if (!addressAllowed(address, config)) return '该地址不在允许的公司网段内';
  const host = String(req.headers.host || '').toLowerCase();
  const localHealth = pathname === '/healthz' && LOOPBACK.has(address) && config.healthHosts.has(host);
  if (!config.allowedHosts.has(host) && !localHealth) return '访问地址不在公司服务器允许列表内';
  const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (fetchSite && !['same-origin', 'none'].includes(fetchSite)) return '不允许跨站请求';
  if (req.headers.origin !== undefined) {
    try {
      const origin = normalizedOrigin(req.headers.origin);
      if (new URL(origin).host.toLowerCase() !== host ||
          (!config.origins.has(origin) && !(localHealth && origin === `http://${host}`))) {
        return '不允许跨域请求';
      }
    } catch { return '不允许跨域请求'; }
  }
  return null;
}

function requestPath(req) {
  const target = String(req.url || '');
  if (!target.startsWith('/') || target.startsWith('//')) throw new Error('无效请求地址');
  const pathname = decodeURIComponent(target.split('?')[0]);
  if (/[\0\\:]/.test(pathname) || pathname.split('/').some(part => part === '..')) {
    throw new Error('无效请求路径');
  }
  return pathname;
}

function safeHeaders(headers, upgrade = false) {
  const blocked = new Set(HOP_HEADERS);
  String(headers.connection || '').split(',').forEach(name => blocked.add(name.trim().toLowerCase()));
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !blocked.has(name.toLowerCase()) &&
        !name.toLowerCase().startsWith('x-forwarded-') &&
        !['forwarded', 'x-real-ip'].includes(name.toLowerCase())) result[name] = value;
  }
  if (upgrade) {
    result.connection = 'Upgrade';
    result.upgrade = 'websocket';
  }
  return result;
}

function upstreamHeaders(req, config, upgrade = false) {
  const headers = {
    ...safeHeaders(req.headers, upgrade),
    host: `127.0.0.1:${config.backendPort}`,
    // Local position and email routes only accept the launcher's port-3000
    // origin. Rewriting is safe only after the gateway boundary checks above.
    origin: 'http://127.0.0.1:3000',
    'sec-fetch-site': 'same-origin'
  };
  // The company session belongs to the public gateway only. The loopback
  // recruitment backend has no reason to receive it or log it.
  delete headers.cookie;
  return headers;
}

function json(res, status, value, extraHeaders = {}) {
  if (res.destroyed || res.writableEnded) return;
  const data = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length,
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    ...extraHeaders
  });
  res.end(data);
}

function backendHealthy(config) {
  return new Promise(resolve => {
    const check = http.get({
      hostname: '127.0.0.1', port: config.backendPort, path: '/api/health',
      headers: { host: `127.0.0.1:${config.backendPort}`, origin: 'http://127.0.0.1:3000' },
      timeout: config.healthTimeoutMs
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        body += chunk;
        if (body.length > 65536) response.destroy();
      });
      response.on('end', () => {
        try { resolve(response.statusCode === 200 && JSON.parse(body).status === 'ok'); }
        catch { resolve(false); }
      });
      response.on('error', () => resolve(false));
      response.on('aborted', () => resolve(false));
    });
    check.on('timeout', () => check.destroy());
    check.on('error', () => resolve(false));
  });
}

function withinDirectory(root, filename) {
  const relative = path.relative(root, filename);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function staticFile(config, pathname) {
  if (pathname.split('/').some(part => part.startsWith('.'))) return { status: 403 };
  let root;
  try { root = await fs.promises.realpath(config.frontendBuildDir); }
  catch { return { status: 503 }; }
  let candidate = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!withinDirectory(root, candidate)) return { status: 403 };
  try {
    const metadata = await fs.promises.stat(candidate);
    if (!metadata.isFile()) throw Object.assign(new Error('Not a file'), { code: 'ENOENT' });
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') return { status: 404 };
    if (path.extname(pathname)) return { status: 404 };
    candidate = path.join(root, 'index.html');
  }
  try {
    const actual = await fs.promises.realpath(candidate);
    if (!withinDirectory(root, actual)) return { status: 403 };
    const metadata = await fs.promises.stat(actual);
    return metadata.isFile() ? { filename: actual, metadata } : { status: 404 };
  } catch { return { status: 503 }; }
}

function proxyHttp(req, res, config) {
  const upstream = http.request({
    hostname: '127.0.0.1', port: config.backendPort, method: req.method, path: req.url,
    headers: upstreamHeaders(req, config), timeout: 300000
  }, response => {
    res.writeHead(response.statusCode, { ...safeHeaders(response.headers), 'cache-control': 'no-store' });
    response.on('error', () => res.destroy());
    response.pipe(res);
  });
  upstream.on('timeout', () => upstream.destroy());
  upstream.on('error', () => {
    if (!res.headersSent) json(res, 502, { status: 'unavailable', message: '招聘后端暂不可用' });
    else res.destroy();
  });
  req.on('aborted', () => upstream.destroy());
  res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
  req.pipe(upstream);
}

function socketResponse(socket, status, message) {
  if (socket.destroyed) return;
  const body = Buffer.from(message);
  const header = Buffer.from(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\n` +
    `Content-Type: text/plain; charset=utf-8\r\nContent-Length: ${body.length}\r\n\r\n`);
  socket.end(Buffer.concat([header, body]), () => socket.destroy());
  // A short textual rejection is enough; do not relay backend error pages or
  // send JSON through an unestablished WebSocket connection.
}

function websocketHeaders(response) {
  const lines = [`HTTP/1.1 ${response.statusCode} ${http.STATUS_CODES[response.statusCode] || ''}`];
  for (const [name, values] of Object.entries(safeHeaders(response.headers, response.statusCode === 101))) {
    for (const value of Array.isArray(values) ? values : [values]) lines.push(`${name}: ${value}`);
  }
  return `${lines.join('\r\n')}\r\n\r\n`;
}

function proxyWebSocket(req, socket, head, config) {
  let connected = false;
  const upstream = http.request({
    hostname: '127.0.0.1', port: config.backendPort, method: 'GET', path: req.url,
    headers: upstreamHeaders(req, config, true), timeout: 15000
  });
  socket.on('error', () => upstream.destroy());
  socket.on('close', () => { if (!connected) upstream.destroy(); });
  upstream.on('upgrade', (response, upstreamSocket, upstreamHead) => {
    connected = true;
    upstream.setTimeout(0);
    upstreamSocket.setTimeout(0);
    socket.setTimeout(0);
    socket.write(websocketHeaders(response));
    if (upstreamHead.length) socket.write(upstreamHead);
    if (head.length) upstreamSocket.write(head);
    upstreamSocket.on('error', () => socket.destroy());
    socket.on('error', () => upstreamSocket.destroy());
    socket.on('close', () => upstreamSocket.destroy());
    upstreamSocket.on('close', () => socket.destroy());
    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);
  });
  upstream.on('response', response => {
    response.resume();
    socketResponse(socket, response.statusCode >= 400 ? response.statusCode : 502, 'WebSocket 连接未建立');
  });
  upstream.on('timeout', () => upstream.destroy());
  upstream.on('error', () => { if (!connected) socketResponse(socket, 502, '招聘后端暂不可用'); });
  upstream.end();
}

function isProxyPath(pathname) {
  return ['/api', '/socket.io'].some(prefix => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function acceptedEncoding(header) {
  const accepted = new Map();
  for (const entry of String(header || '').split(',')) {
    const [name, ...parameters] = entry.trim().toLowerCase().split(';');
    const quality = parameters.find(parameter => parameter.trim().startsWith('q='));
    const q = quality ? Number(quality.trim().slice(2)) : 1;
    if ((name === 'br' || name === 'gzip') && Number.isFinite(q) && q > 0 && q <= 1) {
      accepted.set(name, q);
    }
  }
  if ((accepted.get('br') || 0) >= (accepted.get('gzip') || 0) && accepted.has('br')) return 'br';
  if (accepted.has('gzip')) return 'gzip';
  return null;
}

function compressible(filename, size) {
  return size >= 1024 && new Set(['.html', '.js', '.css', '.json', '.map', '.svg', '.txt'])
    .has(path.extname(filename).toLowerCase());
}

function createGateway(options = {}) {
  const config = readConfig(options);
  const auth = new CompanyAuth(config.authEnabled ? config.authFile : null,
    { now: options.authNow });
  const checkBackend = options.backendHealthy || backendHealthy;
  const serverBrowser = options.isServerBrowser || isServerBrowser;
  // Cache only public build assets, never proxied API responses or resumes.
  // Coalesce simultaneous first requests and bound the resident bytes so
  // repeated Brotli compression cannot slow capture or other browser users.
  const staticCache = new Map();
  const staticInFlight = new Map();
  let staticCacheBytes = 0;
  const cachedAsset = async (file, encoding) => {
    if (file.metadata.size > STATIC_FILE_LIMIT ||
        !new Set(['.html', '.js', '.css', '.svg']).has(path.extname(file.filename).toLowerCase())) {
      return null;
    }
    const key = `${file.filename}|${file.metadata.mtimeMs}|${file.metadata.size}|${encoding || 'identity'}`;
    const cached = staticCache.get(key);
    if (cached) {
      staticCache.delete(key);
      staticCache.set(key, cached);
      return cached;
    }
    if (staticInFlight.has(key)) return staticInFlight.get(key);
    const pending = (async () => {
      const raw = await fs.promises.readFile(file.filename);
      const body = encoding === 'br'
        ? await brotliCompress(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } })
        : encoding === 'gzip' ? await gzip(raw, { level: 6 }) : raw;
      if (body.length <= STATIC_CACHE_LIMIT) {
        staticCache.set(key, body);
        staticCacheBytes += body.length;
        while (staticCacheBytes > STATIC_CACHE_LIMIT) {
          const oldest = staticCache.keys().next().value;
          staticCacheBytes -= staticCache.get(oldest).length;
          staticCache.delete(oldest);
        }
      }
      return body;
    })();
    staticInFlight.set(key, pending);
    try { return await pending; }
    finally { staticInFlight.delete(key); }
  };
  const handleRequest = async (req, res) => {
    let pathname;
    try { pathname = requestPath(req); }
    catch { json(res, 400, { message: '无效请求路径' }); return; }
    const denied = boundaryError(req, config, pathname);
    if (denied) { json(res, 403, { message: denied }); return; }
    if (pathname === '/healthz') {
      if (!['GET', 'HEAD'].includes(req.method)) { json(res, 405, { message: '方法不允许' }); return; }
      const [frontend, backend] = await Promise.all([
        staticFile(config, '/index.html').then(file => Boolean(file.filename)), checkBackend(config)
      ]);
      json(res, frontend && backend ? 200 : 503, {
        status: frontend && backend ? 'ok' : 'unavailable',
        frontend: frontend ? 'ok' : 'unavailable', backend: backend ? 'ok' : 'unavailable'
      });
      return;
    }
    if (pathname === '/__company/network-access' && req.method === 'GET') {
      if (!serverBrowser(req)) { json(res, 403, { message: '仅允许在公司服务器本机检查网段配置' }); return; }
      json(res, 200, { success: true, data: {
        allowedNetworks: config.allowedNetworkStrings,
        dynamic: Boolean(config.networkConfigFile),
        reloadError: config.networkReloadError
      } });
      return;
    }
    if (auth.enabled && pathname.startsWith('/api/auth/')) {
      const secureCookie = config.publicOrigin.startsWith('https:');
      const current = auth.current(req);
      const readBody = async () => {
        if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
          throw Object.assign(new Error('请使用 JSON 请求'), { status: 415 });
        }
        let body = '';
        for await (const chunk of req) {
          body += chunk.toString('utf8');
          if (body.length > 4096) throw Object.assign(new Error('请求内容过大'), { status: 413 });
        }
        try { return JSON.parse(body || '{}'); }
        catch { throw Object.assign(new Error('请求内容不是有效 JSON'), { status: 400 }); }
      };
      try {
        if (pathname === '/api/auth/session' && req.method === 'GET') {
          json(res, 200, { success: true, data: {
            authenticated: Boolean(current), setupRequired: auth.setupRequired,
            canSetup: auth.setupRequired && serverBrowser(req),
            user: current ? { name: current.name, role: current.role, expiresAt: current.expiresAt } : null
          } });
          return;
        }
        if (pathname === '/api/auth/setup' && req.method === 'POST') {
          if (!serverBrowser(req)) { json(res, 403, { success: false, message: '初始账号只能在公司服务器浏览器中设置' }); return; }
          if (!auth.setupRequired) { json(res, 409, { success: false, message: '账号已经设置' }); return; }
          const input = await readBody();
          const token = auth.setup(input.adminPassword);
          json(res, 200, { success: true, data: { user: { name: 'Mark', role: 'admin' } } },
            { 'Set-Cookie': auth.cookie(token, secureCookie) });
          return;
        }
        if (pathname === '/api/auth/login' && req.method === 'POST') {
          if (auth.setupRequired) { json(res, 409, { success: false, message: '请先在公司服务器完成账号初始化' }); return; }
          const input = await readBody();
          const result = auth.login(input.username, input.password, remoteAddress(req));
          if (result.rateLimited) { json(res, 429, { success: false, message: '尝试次数过多，请稍后再试' }); return; }
          if (result.invalid) { json(res, 401, { success: false, message: '用户名或密码错误' }); return; }
          json(res, 200, { success: true, data: { user: result.user } },
            { 'Set-Cookie': auth.cookie(result.token, secureCookie) });
          return;
        }
        if (pathname === '/api/auth/logout' && req.method === 'POST') {
          if (current) auth.logout(current.name);
          json(res, 200, { success: true }, { 'Set-Cookie': auth.clearCookie(secureCookie) });
          return;
        }
        if (!current) { json(res, 401, { success: false, message: '请先登录' }); return; }
        if (pathname === '/api/auth/password' && req.method === 'POST') {
          const input = await readBody();
          auth.updatePassword(current.name, input.currentPassword, input.newPassword);
          json(res, 200, { success: true, message: '密码已修改，请重新登录' },
            { 'Set-Cookie': auth.clearCookie(secureCookie) });
          return;
        }
        json(res, 404, { success: false, message: '账号接口不存在' });
      } catch (error) {
        json(res, error.status || 400, { success: false, message: error.message });
      }
      return;
    }
    const currentUser = auth.enabled ? auth.current(req) : null;
    if (auth.enabled && isProxyPath(pathname) && !currentUser) {
      json(res, 401, { success: false, message: auth.setupRequired ? '请先在服务器设置账号' : '请先登录' });
      return;
    }
    if (pathname === '/api/model-config/access' && req.method === 'GET') {
      json(res, 200, { success: true, data: { canEdit: serverBrowser(req) } });
      return;
    }
    if (isModelConfigPath(pathname) && !['GET', 'HEAD'].includes(req.method) &&
        !serverBrowser(req)) {
      json(res, 403, { success: false, message: '模型配置仅允许在公司服务器本机浏览器中修改或测试' });
      return;
    }
    if (isProxyPath(pathname)) { proxyHttp(req, res, config); return; }
    if (!['GET', 'HEAD'].includes(req.method)) { json(res, 405, { message: '方法不允许' }); return; }
    const file = await staticFile(config, pathname);
    if (!file.filename) { json(res, file.status, { message: '页面或资源不可用' }); return; }
    const encoding = !req.headers.range && compressible(file.filename, file.metadata.size)
      ? acceptedEncoding(req.headers['accept-encoding']) : null;
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(file.filename).toLowerCase()] || 'application/octet-stream',
      ...(encoding ? { 'Content-Encoding': encoding, Vary: 'Accept-Encoding' }
        : { 'Content-Length': file.metadata.size }),
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'SAMEORIGIN',
      'Cache-Control': path.basename(file.filename) === 'index.html' ? 'no-store' : 'public, max-age=3600'
    });
    if (req.method === 'HEAD') { res.end(); return; }
    if (!req.headers.range) {
      const body = await cachedAsset(file, encoding);
      if (body) { res.end(body); return; }
    }
    const stream = fs.createReadStream(file.filename);
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    if (encoding) {
      const compressor = encoding === 'br'
        ? zlib.createBrotliCompress({ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } })
        : zlib.createGzip({ level: 6 });
      compressor.on('error', () => res.destroy());
      res.on('close', () => compressor.destroy());
      stream.pipe(compressor).pipe(res);
    } else stream.pipe(res);
  };
  const server = http.createServer((req, res) => {
    // An employee can close or refresh a tab while a health check, file read
    // or upstream request is pending. Do not let a rejected async handler or
    // a closed response stream terminate the company gateway process.
    res.on('error', () => res.destroy());
    Promise.resolve(handleRequest(req, res)).catch(error => {
      console.error(`公司网关请求失败: ${error.code || error.message}`);
      if (res.destroyed || res.writableEnded) return;
      try {
        if (res.headersSent) res.destroy();
        else json(res, 500, { message: '请求暂不可用' });
      } catch { res.destroy(); }
    });
  });
  server.on('upgrade', (req, socket, head) => {
    let pathname;
    try { pathname = requestPath(req); }
    catch { socketResponse(socket, 400, '无效请求路径'); return; }
    const denied = boundaryError(req, config, pathname);
    if (denied) { socketResponse(socket, 403, denied); return; }
    const currentUser = auth.enabled ? auth.current(req) : null;
    if (auth.enabled && !currentUser) { socketResponse(socket, 401, '请先登录'); return; }
    if (!(pathname === '/socket.io' || pathname.startsWith('/socket.io/')) ||
        String(req.headers.upgrade || '').toLowerCase() !== 'websocket') {
      socketResponse(socket, 404, 'WebSocket 地址不可用'); return;
    }
    auth.trackSocket(currentUser, socket);
    proxyWebSocket(req, socket, head, config);
  });
  server.on('clientError', (_error, socket) => socketResponse(socket, 400, '无效 HTTP 请求'));
  server.requestTimeout = 600000;
  server.gatewayConfig = config;
  return server;
}

if (require.main === module) {
  try {
    const server = createGateway();
    server.on('error', error => { console.error(`公司网关启动失败: ${error.message}`); process.exitCode = 1; });
    server.listen(server.gatewayConfig.port, server.gatewayConfig.host, () => {
      console.log(`公司招聘助手已启动: ${server.gatewayConfig.publicOrigin}`);
    });
  } catch (error) {
    console.error(`公司网关配置错误: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { createGateway, readConfig, boundaryError, isServerBrowser };
