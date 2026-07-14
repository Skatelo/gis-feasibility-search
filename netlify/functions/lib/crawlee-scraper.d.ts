export interface CrawleePageResult {
  url: string;
  content: string;
  endpoints?: string[];
}

export interface CrawleeResult {
  results: CrawleePageResult[];
  errors: Array<{ url: string; error: string }>;
  stats: { requested: number; extracted: number; documents: number; elapsedMs: number };
}

export function crawlSources(input: {
  urls: string[];
  queries?: string[];
  maxPages?: number;
  maxDepth?: number;
  maxCharsPerPage?: number;
}): Promise<CrawleeResult>;
