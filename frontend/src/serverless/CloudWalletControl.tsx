import { THEME, TonConnectUIProvider } from '@tonconnect/ui-react';
import { WalletConnection } from './WalletConnection';

export function CloudWalletControl({savedWallet, dashboardReady, activityTarget}: {savedWallet: string | null; dashboardReady: boolean; activityTarget?: HTMLElement | null}) {
  const config = __TON_CONNECT_CONFIG__;
  if (!config) return null;
  return <TonConnectUIProvider manifestUrl={config.manifestUrl} analytics={{mode: 'off'}}
      uiPreferences={{theme: THEME.DARK}}
      actionsConfiguration={config.returnUrl ? {twaReturnUrl: config.returnUrl} : undefined}>
      <WalletConnection savedWallet={savedWallet} dashboardReady={dashboardReady} activityTarget={activityTarget} />
    </TonConnectUIProvider>;
}
