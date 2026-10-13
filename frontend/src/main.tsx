import React from 'react';
import ReactDOM from 'react-dom/client';
import { waitForTelegramSdkScript } from './bootstrap';
import { telegramBridge } from './data/telegram';
import './styles.css';

function Startup({ failed = false }: { failed?: boolean }) {
  return <section className="app-startup" role={failed ? 'alert' : 'status'}>
    <span className="app-startup-mark" aria-hidden="true">G</span>
    <h1>Gift Rent Check</h1>
    <p>{failed ? 'The app could not load. Your saved data is kept.' : 'Opening your dashboard…'}</p>
    {failed ? <button type="button" onClick={() => window.location.reload()}>Try again</button>
      : <span className="app-startup-progress" aria-hidden="true" />}
  </section>;
}

function telegramReady() {
  const script = document.getElementById('telegram-web-app-sdk');
  return waitForTelegramSdkScript({
    script,
    page: window,
    available: () => Boolean(window.Telegram?.WebApp),
    pageFinished: () => document.readyState === 'complete',
    timeout(callback) { const timer = setTimeout(callback, 15000); return () => clearTimeout(timer); },
  }).then(() => {
    // The shell is ready even while the main application chunk is downloading.
    try { telegramBridge.ready(); } catch { /* Optional native UI support. */ }
  });
}

async function mount() {
  const root = ReactDOM.createRoot(document.getElementById('root')!);
  root.render(<Startup />);
  try {
    if (import.meta.env.MODE === 'serverless') {
      const [{ default: CloudApp }] = await Promise.all([import('./serverless/CloudApp'), telegramReady()]);
      root.render(<React.StrictMode><CloudApp /></React.StrictMode>);
    } else {
      const [{ default: App }, { createLocalDashboardAdapter }] = await Promise.all([import('./App'), import('./data/local'), import('./pricing.css')]);
      const adapter = createLocalDashboardAdapter();
      root.render(<React.StrictMode><App adapter={adapter} /></React.StrictMode>);
    }
  } catch {
    root.render(<Startup failed />);
  }
}

void mount();
