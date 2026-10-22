const { createProxyMiddleware } = require('http-proxy-middleware');

module.exports = function(app) {
  // Socket.IO WebSocket 代理
  app.use(
    createProxyMiddleware({
      pathFilter: '/socket.io',
      target: 'http://127.0.0.1:5001',
      changeOrigin: true,
      ws: true, // 支持 WebSocket
      on: {
        error: (err) => {
          console.error('Socket.IO 代理错误:', err.message);
        }
      }
    })
  );
  
  // API 代理
  app.use(
    createProxyMiddleware({
      pathFilter: '/api',
      target: 'http://127.0.0.1:5001',
      changeOrigin: true,
      on: {
        error: (err) => {
          console.error('API 代理错误:', err.message);
        }
      }
    })
  );
};
