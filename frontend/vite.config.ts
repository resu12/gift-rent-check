import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => ({
  base: mode === 'serverless' ? './' : '/',
  plugins: mode === 'serverless' ? [{
    name: 'telegram-serverless-sdk',
    transformIndexHtml(html: string) {
      return {
        html: html.replace('<title>Giftfolio · Rental price comparisons</title>', '<title>Giftfolio · Telegram pricing dashboard</title>')
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
}));
