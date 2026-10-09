/** User-run exporter for visible, signed-in Marketapp personal rental analytics.
 * Keep this function standalone: its compiled source is copied as a bookmarklet.
 * It reads the rendered analytics DOM only; it cannot access a session or provider API.
 */
function captureMarketappRentalAnalytics() {
  try {
    const url = new URL(location.href);
    const wallet = /^\/user\/([A-Za-z0-9_-]{48})\/$/.exec(url.pathname)?.[1];
    if (url.origin !== 'https://marketapp.org' || !wallet || url.searchParams.get('tab') !== 'analytics_rent') {
      throw new Error('Open your personal Marketapp Rent analytics first.');
    }
    if ([...url.searchParams.keys()].some(key => /collection/i.test(key))) {
      throw new Error('Select all collections before saving analytics.');
    }
    const charts = [...document.querySelectorAll<HTMLElement>('.js-ma-chart')].map(chart => ({
      key: chart.getAttribute('data-key'), spec_raw: chart.getAttribute('data-spec'),
    }));
    for (const key of ['profile.rent.income', 'profile.rent.rentals']) {
      const chart = charts.find(entry => entry.key === key);
      if (!chart?.spec_raw || JSON.parse(chart.spec_raw).gran !== 'day') {
        throw new Error('Choose By day, then save analytics again.');
      }
    }
    const summary = [...document.querySelectorAll<HTMLElement>('.ma-an-tile')].map(tile => ({
      label: tile.querySelector('.ma-an-tile-label')?.textContent?.trim() || '',
      value: tile.querySelector('.ma-an-tile-value')?.textContent?.trim() || '',
      foot: tile.querySelector('.ma-an-tile-foot')?.textContent?.trim() || '',
      definition: tile.querySelector('.ma-an-info')?.getAttribute('data-bs-title') || '',
    }));
    if (!summary.some(tile => tile.label === 'Rent volume')) throw new Error('Rental analytics are not loaded yet.');
    const snapshot = { version: 1, source: 'marketapp_personal_rent_page', source_url: url.href,
      wallet, captured_at: new Date().toISOString(), summary, charts };
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
    const download = document.createElement('a');
    download.href = URL.createObjectURL(blob);
    download.download = `marketapp-rent-analytics-${snapshot.captured_at.slice(0, 10)}.json`;
    document.body.appendChild(download); download.click(); download.remove();
    setTimeout(() => URL.revokeObjectURL(download.href), 1000);
  } catch (problem) {
    alert(problem instanceof Error ? problem.message : 'Could not save rental analytics.');
  }
}

export function marketappAnalyticsCaptureScript(): string {
  return `(${captureMarketappRentalAnalytics.toString()})();`;
}

export function marketappAnalyticsBookmarklet(): string {
  return `javascript:${marketappAnalyticsCaptureScript()}`;
}
