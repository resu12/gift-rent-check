interface TelegramWebApp {
  ready?: () => void;
  expand?: () => void;
  openLink?: (url: string) => void;
  isVersionAtLeast?: (version: string) => boolean;
  isVerticalSwipesEnabled?: boolean;
  disableVerticalSwipes?: () => void;
  enableVerticalSwipes?: () => void;
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

const verticalSwipeLeases = new WeakMap<TelegramWebApp, { count: number; restore: () => void }>();
const noRelease = () => undefined;

// Optional bridge only: no Telegram SDK is downloaded and no Telegram identity
// is trusted as authentication for the local dashboard.
export const telegramBridge = {
  /** Own native vertical swipes only while the app has a conflicting gesture. */
  reserveVerticalSwipes(): () => void {
    let app: TelegramWebApp | undefined;
    try { app = typeof window === 'undefined' ? undefined : window.Telegram?.WebApp; } catch { return noRelease; }
    if (!app) return noRelease;
    let lease = verticalSwipeLeases.get(app);
    if (lease) lease.count++;
    else {
      try {
        // Bot API 7.7 introduced both the methods and their observable state.
        // A missing state cannot be restored faithfully, so leave it alone.
        if (app.isVersionAtLeast?.('7.7') !== true || app.isVerticalSwipesEnabled !== true
          || typeof app.disableVerticalSwipes !== 'function' || typeof app.enableVerticalSwipes !== 'function') return noRelease;
        const restore = app.enableVerticalSwipes.bind(app);
        app.disableVerticalSwipes();
        lease = { count: 1, restore };
        verticalSwipeLeases.set(app, lease);
      } catch { return noRelease; }
    }
    const owned = lease;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--owned.count !== 0) return;
      verticalSwipeLeases.delete(app);
      try { owned.restore(); } catch { /* An older or detached bridge must not break cleanup. */ }
    };
  },
  /** Call only from a user gesture; false preserves the ordinary anchor fallback. */
  openLink(value: string): boolean {
    try {
      const url = new URL(value);
      if (url.origin !== 'https://marketapp.org' || url.username || url.password) return false;
      const open = window.Telegram?.WebApp?.openLink;
      if (!open) return false;
      open.call(window.Telegram?.WebApp, url.href);
      return true;
    } catch { return false; }
  },
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
