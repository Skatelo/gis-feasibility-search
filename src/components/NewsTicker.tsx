import { useEffect, useState } from 'react';
import { Newspaper, ExternalLink } from 'lucide-react';

interface Article {
  title: string;
  link: string;
  image: string | null;
  source: string;
  sourceIcon: string | null;
  pubDate: string | null;
  description: string;
}

type Status = 'loading' | 'ok' | 'error';

const fmtWhen = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

/**
 * Auto-scrolling real estate / construction / housing-market news strip for
 * North Carolina, from Google News (keyless, via the serverless proxy). Cards
 * drift left→right continuously and pause on hover.
 */
export function NewsTicker() {
  const [articles, setArticles] = useState<Article[]>([]);
  const [status, setStatus] = useState<Status>('loading');

  // Auto-update: pull fresh headlines every 10 minutes AND whenever the user
  // returns to the tab. The cache-buster is bucketed to the 10-min window so the
  // CDN/browser still caches within a window (efficient) but new data each window.
  const REFRESH_MS = 10 * 60 * 1000;
  useEffect(() => {
    let cancelled = false;
    let lastLoaded = 0;
    const load = async () => {
      lastLoaded = Date.now();
      try {
        const res = await fetch(`/.netlify/functions/news?t=${Math.floor(Date.now() / REFRESH_MS)}`);
        const ct = res.headers.get('content-type') || '';
        if (!ct.includes('json')) { if (!cancelled) setStatus('error'); return; }
        const data = await res.json();
        if (cancelled) return;
        if (Array.isArray(data.articles) && data.articles.length) {
          setArticles(data.articles.slice(0, 18));
          setStatus('ok');
        } else {
          setStatus('error');
        }
      } catch {
        if (!cancelled) setStatus('error');
      }
    };
    load();
    const id = setInterval(load, REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastLoaded > REFRESH_MS) load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => { cancelled = true; clearInterval(id); document.removeEventListener('visibilitychange', onVisible); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stay invisible while loading or if the feed is unavailable.
  if (status !== 'ok' || articles.length === 0) return null;

  // Duplicate the list so the marquee loops seamlessly.
  const loop = [...articles, ...articles];

  return (
    <section className="news-ticker" aria-label="Real estate news">
      <div className="news-ticker-label">
        <Newspaper size={15} />
        <div className="news-ticker-label-text">
          <span>Real Estate &amp; Housing — NC</span>
          <span className="news-ticker-src">via Google News RSS</span>
        </div>
      </div>
      <div className="news-ticker-viewport">
        <div className="news-ticker-track">
          {loop.map((a, i) => (
            <a key={`${a.link}-${i}`} className="news-card" href={a.link} target="_blank" rel="noreferrer" title={a.title}>
              <div className="news-card-media">
                {a.image ? (
                  <img src={a.image} alt="" loading="lazy" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                ) : (
                  <div className="news-card-noimg"><Newspaper size={20} /></div>
                )}
              </div>
              <div className="news-card-body">
                <div className="news-card-title">{a.title}</div>
                <div className="news-card-meta">
                  {a.sourceIcon && <img className="news-card-favicon" src={a.sourceIcon} alt="" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />}
                  <span className="news-card-source">{a.source || 'News'}</span>
                  {a.pubDate && <span className="news-card-when">· {fmtWhen(a.pubDate)}</span>}
                  <ExternalLink size={11} className="news-card-ext" />
                </div>
              </div>
            </a>
          ))}
        </div>
      </div>
    </section>
  );
}
