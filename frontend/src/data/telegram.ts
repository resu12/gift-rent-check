interface TelegramWebApp {
  ready?: () => void;
  expand?: () => void;
  colorScheme?: 'light' | 'dark';
  themeParams?: { accent_text_color?: string };
  BackButton?: {
    show: () => void;
    hide: () => void;
    onClick: (callback: () => void) => void;
    offClick: (callback: () => void) => void;
  };
}

declare global {
  interface Window { Telegram?: { WebApp?: TelegramWebApp }; }
}

// Optional bridge only: no Telegram SDK is downloaded and no Telegram identity
// is trusted as authentication for the local dashboard.
export const telegramBridge = {
  ready() {
    const app = window.Telegram?.WebApp;
    app?.ready?.();
    app?.expand?.();
    if (app?.colorScheme) document.documentElement.dataset.telegramTheme = app.colorScheme;
    const accent = app?.themeParams?.accent_text_color;
    if (accent && /^#[0-9a-f]{6}$/i.test(accent)) document.documentElement.style.setProperty('--telegram-accent', accent);
  },
  back(callback: (() => void) | null) {
    const button = window.Telegram?.WebApp?.BackButton;
    if (!button || !callback) { button?.hide(); return () => undefined; }
    button.onClick(callback);
    button.show();
    return () => { button.offClick(callback); button.hide(); };
  },
};
