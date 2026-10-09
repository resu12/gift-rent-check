import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles.css';

async function mount() {
  const root = ReactDOM.createRoot(document.getElementById('root')!);
  if (import.meta.env.MODE === 'serverless') {
    const { default: CloudApp } = await import('./serverless/CloudApp');
    root.render(<React.StrictMode><CloudApp /></React.StrictMode>);
  } else {
    const [{ default: App }, { localAdapter }] = await Promise.all([import('./App'), import('./data/local'), import('./pricing.css')]);
    root.render(<React.StrictMode><App adapter={localAdapter} /></React.StrictMode>);
  }
}

void mount();
