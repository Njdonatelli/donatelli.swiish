import React from 'react';
import ReactDOM from 'react-dom/client';
import './admin/admin.css';
import AdminApp from './admin/AdminApp';
import { applyTheme, readTheme } from './admin/theme';

// Before the first render, so a saved Light/Dark choice paints without a flash of the system theme.
applyTheme(readTheme());

// The Swiish app registered a service worker that served its own shell offline. public/service-worker.js is
// now a kill switch; this also removes any registration a browser still holds, whatever its script.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker
    .getRegistrations()
    .then((regs) => regs.forEach((r) => r.unregister()))
    .catch(() => {});
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AdminApp />
  </React.StrictMode>
);
