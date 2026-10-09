import { defineConfig, loadEnv } from 'vite';
import {tonConnectBuild} from './config/tonConnect';
import {tonConnectPrivacyPlugin} from './config/tonConnectPrivacy';

export default defineConfig(({ mode }) => {
  const wallet = mode === 'serverless' ? tonConnectBuild(loadEnv(mode, process.cwd(), 'VITE_')) : null;
  return {
    base: mode === 'serverless' ? './' : '/',
    define: {__TON_CONNECT_CONFIG__: JSON.stringify(wallet?.config ?? null)},
    plugins: mode === 'serverless' ? [tonConnectPrivacyPlugin(), {
      name: 'telegram-serverless-sdk',
      generateBundle() {
        if (wallet) this.emitFile({type: 'asset', fileName: 'tonconnect-manifest.json', source: JSON.stringify(wallet.manifest, null, 2) + '\n'});
      },
      transformIndexHtml(html: string) {
        return {
          html: html.replace('<title>Gift Rent Check · Rental prices</title>', '<title>Gift Rent Check · Telegram</title>')
            .replace('Compare rental asking prices for your TON gifts by collection, exact model, and Black backdrop.', 'Private Telegram dashboard for gift listing and rental-price comparisons.'),
          tags: [{ tag: 'script', attrs: { src: 'https://telegram.org/js/telegram-web-app.js?64' }, injectTo: 'head-prepend' as const }],
        };
      },
    }] : [],
    server: {
      host: '127.0.0.1',
      proxy: { '/api': 'http://127.0.0.1:8765' },
    },
    build: { target: 'es2022', sourcemap: false, ...(mode === 'serverless' ? { outDir: '../serverless/dist', emptyOutDir: true } : {}) },
  };
});
