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
    const combined = charts.some(entry => entry.key === 'profile.rent.activity');
    if (combined && charts.some(entry => ['profile.rent.income', 'profile.rent.rentals'].includes(entry.key || ''))) {
      throw new Error('Rental analytics contain conflicting charts. Reload Marketapp before saving.');
    }
    for (const key of combined ? ['profile.rent.activity'] : ['profile.rent.income', 'profile.rent.rentals']) {
      if (charts.filter(entry => entry.key === key).length !== 1) throw new Error('Rental analytics are not loaded yet.');
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
    const invalidItems = () => { throw new Error('The Top items table could not be verified. Reload Marketapp before saving.'); };
    const visibleText = (node: Element) => (node.textContent || '').trim().replace(/\s+/g, ' ');
    const blocks = [...document.querySelectorAll<HTMLElement>('.ma-an-tblock')].filter(block =>
      [...block.querySelectorAll('h2.tm-section-header-text')].some(heading => visibleText(heading) === 'Top items'));
    if (blocks.length > 1) invalidItems();
    let top_items: {status: 'available' | 'missing'; items: {name: string; item_url: string; rentals: string; rented_days: string; volume: string; price_per_day: string}[]} = {status: 'missing', items: []};
    if (blocks.length === 1) {
      const block = blocks[0], tables = block.querySelectorAll('table'), headings = block.querySelectorAll('h2.tm-section-header-text');
      if (headings.length !== 1 || tables.length > 1) invalidItems();
      if (tables.length) {
        if (!tables[0].classList.contains('tm-table')) invalidItems();
        const rows = [...tables[0].querySelectorAll('tr')], headers = ['Item', 'Rentals', 'Rented days', 'Volume', 'Price per day'];
        if (rows.length < 1 || rows.length > 101 || rows[0].parentElement?.tagName !== 'THEAD') invalidItems();
        const cells = (row: Element, tag: string) => {
          const values = [...row.children];
          if (values.length !== 5 || values.some(cell => cell.tagName !== tag || cell.hasAttribute('colspan') || cell.hasAttribute('rowspan') ||
            cell.querySelector('script,style,textarea,title,iframe,noscript,xmp,noembed,noframes'))) invalidItems();
          return values;
        };
        if (cells(rows[0], 'TH').some((cell, index) => visibleText(cell) !== headers[index] || cell.querySelector('a'))) invalidItems();
        const emptyCells = rows.length === 2 && rows[1].parentElement?.tagName === 'TBODY' ? [...rows[1].children] : [];
        const unknownEmptyState = emptyCells.length === 1 && emptyCells[0].tagName === 'TD' && emptyCells[0].getAttribute('colspan') === '5' &&
          !emptyCells[0].hasAttribute('rowspan') && !emptyCells[0].querySelector('a,script,style,textarea,title,iframe,noscript,xmp,noembed,noframes') && !/\d/.test(visibleText(emptyCells[0]));
        if (!unknownEmptyState) {
          const items = rows.slice(1).map(row => {
            if (row.parentElement?.tagName !== 'TBODY') invalidItems();
            const values = cells(row, 'TD'), links = values[0].querySelectorAll('a');
            if (links.length !== 1 || values.slice(1).some(cell => cell.querySelector('a'))) invalidItems();
            const name = visibleText(values[0]), href = links[0].getAttribute('href') || '';
            if (!name || name.length > 200 || name !== visibleText(links[0]) || !/^(?:https:\/\/marketapp\.org)?\/nft\/[A-Za-z0-9_-]{48}\/$/.test(href)) invalidItems();
            const [rentals, rented_days, volume, price_per_day] = values.slice(1).map(visibleText);
            if ([rentals, rented_days, volume, price_per_day].some(value => value.length > 64)) invalidItems();
            return {name, item_url: new URL(href, 'https://marketapp.org').href, rentals, rented_days, volume, price_per_day};
          });
          if (new Set(items.map(item => item.item_url)).size !== items.length) invalidItems();
          top_items = {status: 'available', items};
        }
      }
    }
    const invalidCollections = () => { throw new Error('The By collection table could not be verified. Reload Marketapp before saving.'); };
    const collectionBlocks = [...document.querySelectorAll<HTMLElement>('.ma-an-tblock')].filter(block =>
      [...block.querySelectorAll('h2.tm-section-header-text')].some(heading => visibleText(heading) === 'By collection'));
    if (collectionBlocks.length > 1) invalidCollections();
    let by_collection: {status: 'available' | 'missing'; items: {name: string; rentals: string; volume: string; price_per_day: string}[]} = {status: 'missing', items: []};
    if (collectionBlocks.length === 1) {
      const block = collectionBlocks[0], tables = block.querySelectorAll('table'), headings = block.querySelectorAll('h2.tm-section-header-text');
      if (headings.length !== 1 || tables.length > 1) invalidCollections();
      if (tables.length) {
        if (!tables[0].classList.contains('tm-table')) invalidCollections();
        const rows = [...tables[0].querySelectorAll('tr')];
        if (rows.length < 1 || rows.length > 201 || rows[0].parentElement?.tagName !== 'THEAD') invalidCollections();
        const expanded = rows[0].children.length === 7;
        const headers = expanded ? ['', 'Collection', 'Rentals', 'Volume', 'Price per day', 'Average duration', 'Share of volume']
          : ['Collection', 'Rentals', 'Volume', 'Price per day'];
        const cells = (row: Element, tag: string) => {
          const values = [...row.children];
          if (values.length !== headers.length || values.some(cell => cell.tagName !== tag || cell.hasAttribute('colspan') || cell.hasAttribute('rowspan') ||
            cell.querySelector('script,style,textarea,title,iframe,noscript,xmp,noembed,noframes'))) invalidCollections();
          return values;
        };
        if (cells(rows[0], 'TH').some((cell, index) => visibleText(cell) !== headers[index] || cell.querySelector('a,img'))) invalidCollections();
        const emptyCells = rows.length === 2 && rows[1].parentElement?.tagName === 'TBODY' ? [...rows[1].children] : [];
        const unknownEmptyState = emptyCells.length === 1 && emptyCells[0].tagName === 'TD' && emptyCells[0].getAttribute('colspan') === String(headers.length) &&
          !emptyCells[0].hasAttribute('rowspan') && !emptyCells[0].querySelector('a,script,style,textarea,title,iframe,noscript,xmp,noembed,noframes') && !/\d/.test(visibleText(emptyCells[0]));
        if (!unknownEmptyState) {
          const linkDestination = (link: Element): string => {
            const href = link.getAttribute('href') || '';
            if (href.length > 2048 || /[\\\u0000-\u0020\u007f]/.test(href) || !/^(?:https:\/\/marketapp\.org\/|\/(?!\/))/.test(href)) invalidCollections();
            const destination = new URL(href, 'https://marketapp.org');
            if (destination.origin !== 'https://marketapp.org' || destination.username || destination.password) invalidCollections();
            return destination.href;
          };
          const items = rows.slice(1).map(row => {
            if (row.parentElement?.tagName !== 'TBODY') invalidCollections();
            const values = cells(row, 'TD'), nameIndex = expanded ? 1 : 0;
            const links = values[nameIndex].querySelectorAll('a'), name = visibleText(values[nameIndex]);
            if (!name || name.length > 200 || /[\u0000-\u001f\u007f]/.test(name) || links.length > 1 || values[nameIndex].querySelector('img') || values.slice(nameIndex + 1).some(cell => cell.querySelector('a,img'))) invalidCollections();
            let destination: string | undefined;
            if (links.length) {
              if (visibleText(links[0]) !== name) invalidCollections();
              destination = linkDestination(links[0]);
            }
            if (expanded) {
              const thumbnailLinks = values[0].querySelectorAll('a');
              if (visibleText(values[0]) || values[0].querySelectorAll('img').length !== 1 || thumbnailLinks.length !== 1 || links.length !== 1 ||
                visibleText(thumbnailLinks[0]) || linkDestination(thumbnailLinks[0]) !== destination) invalidCollections();
            }
            const numbers = values.slice(nameIndex + 1).map(visibleText);
            if (numbers.some(value => value.length > 64)) invalidCollections();
            const [rentals, volume, price_per_day] = numbers;
            return {name, rentals, volume, price_per_day};
          });
          if (new Set(items.map(item => item.name.toLowerCase())).size !== items.length) invalidCollections();
          by_collection = {status: 'available', items};
        }
      }
    }
    const snapshot = { version: 1, source: 'marketapp_personal_rent_page', source_url: url.href,
      wallet, captured_at: new Date().toISOString(), summary, charts, top_items, by_collection };
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
