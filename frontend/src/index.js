import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import App from './App';
import CompanyAuthGate from './components/CompanyAuthGate';
import './index.css';

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <ConfigProvider locale={zhCN}>
      {process.env.REACT_APP_COMPANY_AUTH === 'true' ? <CompanyAuthGate /> : <App />}
    </ConfigProvider>
  </React.StrictMode>
);
