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

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch('/.netlify/functions/news');
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
    const id = setInterval(load, 30 * 60 * 1000); // refresh every 30 min
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // Stay invisible while loading or if the feed is unavailable.
  if (status !== 'ok' || articles.length === 0) return null;

  // Duplicate the list so the marquee loops seamlessly.
  const loop = [...articles, ...articles];

  return (
    <section className="news-ticker" aria-label="Real estate news">
      <div className="news-ticker-label">
        <Newspaper size={15} />
        <span>Real Estate &amp; Housing — NC</span>
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
