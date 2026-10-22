const originalEnvironment = { ...process.env };
const originalLocation = Object.getOwnPropertyDescriptor(window, 'location');

function loadConfig(environment = {}) {
  process.env.NODE_ENV = 'production';
  delete process.env.REACT_APP_API_BASE_URL;
  delete process.env.REACT_APP_SOCKET_URL;
  Object.assign(process.env, environment);
  jest.resetModules();
  return require('./api');
}

afterEach(() => {
  process.env = { ...originalEnvironment };
  Object.defineProperty(window, 'location', originalLocation);
  jest.resetModules();
});

test.each(['http://192.168.1.24:4000', 'https://recruitment.example.test:4000'])(
  '生产默认请求当前站点的 API，Socket 保持与页面 %s 同源', pageURL => {
    Object.defineProperty(window, 'location', { configurable: true, value: new URL(pageURL) });
    const { buildApiUrl, API_ENDPOINTS, REQUEST_CONFIG, WEBSOCKET_CONFIG } = loadConfig();

    expect(buildApiUrl('/positions')).toBe('/api/positions');
    expect(buildApiUrl('/resume-library?page=2')).toBe('/api/resume-library?page=2');
    expect(API_ENDPOINTS.BASE_URL).toBe('');
    expect(REQUEST_CONFIG.baseURL).toBe('');
    expect(WEBSOCKET_CONFIG.URL).toBe(pageURL);
  }
);

test('显式后端和 Socket 地址仍支持已有独立部署', () => {
  const { buildApiUrl, WEBSOCKET_CONFIG } = loadConfig({
    REACT_APP_API_BASE_URL: 'https://recruitment-automation-backend.zeabur.app',
    REACT_APP_SOCKET_URL: 'wss://recruitment-automation-backend.zeabur.app'
  });

  expect(buildApiUrl('/positions')).toBe('https://recruitment-automation-backend.zeabur.app/api/positions');
  expect(WEBSOCKET_CONFIG.URL).toBe('wss://recruitment-automation-backend.zeabur.app');
});

test('空生产环境变量也使用页面同源服务', () => {
  const { buildApiUrl, WEBSOCKET_CONFIG } = loadConfig({
    REACT_APP_API_BASE_URL: '',
    REACT_APP_SOCKET_URL: ''
  });

  expect(buildApiUrl('/positions')).toBe('/api/positions');
  expect(WEBSOCKET_CONFIG.URL).toBe(window.location.origin);
});

test('开发环境继续使用现有 API 代理和本机 Socket', () => {
  const { buildApiUrl, WEBSOCKET_CONFIG } = loadConfig({ NODE_ENV: 'development' });

  expect(buildApiUrl('/positions')).toBe('/api/positions');
  expect(WEBSOCKET_CONFIG.URL).toBe('ws://localhost:5001');
});
