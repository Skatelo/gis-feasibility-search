// GIS search history (recently searched addresses). Local in localStorage,
// synced across devices via Supabase (user_sync) when the account is cloud-backed.
import { syncEnabled, syncGet, syncSet } from './syncStore';

export interface SearchHistoryItem {
  address: string;
  county: string;
}

const LS_KEY = 'gis_search_history';
const SYNC_KEY = 'search_history';
const MAX = 8;

function normalize(items: any[]): SearchHistoryItem[] {
  return (Array.isArray(items) ? items : [])
    .map((it) => (typeof it === 'string' ? { address: it, county: '' } : { address: it?.address || '', county: it?.county || '' }))
    .filter((it) => it.address);
}

function readLocal(): SearchHistoryItem[] {
  try { return normalize(JSON.parse(localStorage.getItem(LS_KEY) || '[]')); } catch { return []; }
}
function writeLocal(items: SearchHistoryItem[]): void {
  try { localStorage.setItem(LS_KEY, JSON.stringify(items)); } catch { /* ignore */ }
}

export async function getSearchHistory(): Promise<SearchHistoryItem[]> {
  const local = readLocal();
  if (!syncEnabled()) return local;
  const cloud = await syncGet<SearchHistoryItem[]>(SYNC_KEY);
  if (cloud === undefined) {
    if (local.length) await syncSet(SYNC_KEY, local);
    return local;
  }
  const normalized = normalize(cloud);
  writeLocal(normalized);
  return normalized;
}

export async function addSearchHistory(address: string, county: string): Promise<SearchHistoryItem[]> {
  const existing = readLocal().filter((it) => it.address.toLowerCase() !== address.toLowerCase());
  const updated = [{ address, county }, ...existing].slice(0, MAX);
  writeLocal(updated);
  if (syncEnabled()) await syncSet(SYNC_KEY, updated);
  return updated;
}
