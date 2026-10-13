import { useState } from 'react';
import { Icon } from './Icons';
import { analyticsImageUrl } from './data/analyticsImages';

interface ThumbnailProps { src?: string; kind: 'gift' | 'collection'; label: string }

export function AnalyticsThumbnail({ src, kind, label }: ThumbnailProps) {
  const url = analyticsImageUrl(src);
  // A changed source gets a fresh image/error state, including A → B → A.
  return <ThumbnailImage key={url || 'missing'} src={url} kind={kind} label={label} />;
}

function ThumbnailImage({ src, kind, label }: ThumbnailProps) {
  const [failed, setFailed] = useState(false);
  return <span className="gift-rental-avatar" title={label} role="img" aria-label={label}>
    <Icon name={kind === 'collection' ? 'layers' : 'gift'} size={22} />
    {src && !failed && <img src={src} alt="" width={38} height={38} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />}
  </span>;
}
