import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import App from './App';
import CompanyAuthGate from './components/CompanyAuthGate';
import './index.css';

function AppEntry() {
  const [plainApp, setPlainApp] = React.useState(false);
  const unsupported = React.useCallback(() => setPlainApp(true), []);
  return plainApp ? <App /> : <CompanyAuthGate
    onUnsupported={process.env.REACT_APP_COMPANY_AUTH === 'true' ? null : unsupported} />;
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <ConfigProvider locale={zhCN}>
      <AppEntry />
    </ConfigProvider>
  </React.StrictMode>
);
