#!/usr/bin/env node
/**
 * YouTube Download API — Node.js / Express v3.1
 * 
 * FIX: Uses sticky proxy sessions so the same IP is used for
 * both resolving and downloading vidssave CDN URLs.
 */

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { HttpsProxyAgent } = require('https-proxy-agent');

// ─── Crash Guard ──────────────────────────────────────────────────────────────
process.on('uncaughtException', (e) => console.error('[UNCAUGHT]', e.stack || e.message));
process.on('unhandledRejection', (e) => console.error('[UNHANDLED]', e));

// ─── Async Handler for Express 4 ─────────────────────────────────────────────
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(err => {
      console.error('[Error]', err.message);
      if (!res.headersSent) res.status(502).json({ error: err.message });
    });
  };
}

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8000;
const PROXY_URL = process.env.PROXY_URL || 'http://qijlkvsz-rotate:viryx2zv5njj@p.webshare.io:80';
const API_KEY = process.env.API_KEY || '';
const CACHE_TTL = parseInt(process.env.CACHE_TTL || '1800', 10);

const VIDSSAVE_API = 'https://api.vidssave.com/api/contentsite_api';
const AUTH = '20250901majwlqo';
const DOMAIN = 'api-ak.vidssave.com';

const BROWSER_HEADERS = {
  'Origin': 'https://vidssave.com',
  'Referer': 'https://vidssave.com/youtube-video-downloader-7gt',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'sec-ch-ua': '"Chromium";v="137", "Google Chrome";v="137"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-site',
};

// ─── Sticky Proxy Session ─────────────────────────────────────────────────────
// Webshare sticky proxy format:
//   http://username-session-XXXXXX:password@p.webshare.io:80
// The -session-XXXXXX part keeps the same IP for all requests with that session ID.
// Session lasts up to 30 minutes on Webshare.

/**
 * Generate a sticky proxy URL with a random session ID.
 * All requests using the same session ID will go through the same proxy IP.
 */
function createStickySession() {
  // Parse proxy URL: http://user:pass@host:port
  const match = PROXY_URL.match(/^(https?):\/\/([^:]+):([^@]+)@(.+)$/);
  if (!match) {
    // Can't parse — return original (might not be rotating, that's OK)
    return { proxyUrl: PROXY_URL, sessionId: 'default' };
  }
  const [, protocol, user, pass, host] = match;
  const sessionId = Math.random().toString(36).substring(2, 10);
  
  // Build sticky proxy URL: replace -rotate with -rotate-session-XXXXXX
  let stickyUser;
  if (user.includes('-rotate')) {
    stickyUser = user.replace('-rotate', `-rotate-session-${sessionId}`);
  } else {
    stickyUser = `${user}-session-${sessionId}`;
  }
  
  return {
    proxyUrl: `${protocol}://${stickyUser}:${pass}@${host}`,
    sessionId,
  };
}

/**
 * Create a proxy agent for a specific session.
 * All calls using this agent will go through the same proxy IP.
 */
function getStickyProxyAgent(sessionId) {
  const match = PROXY_URL.match(/^(https?):\/\/([^:]+):([^@]+)@(.+)$/);
  if (!match) return new HttpsProxyAgent(PROXY_URL);
  
  const [, protocol, user, pass, host] = match;
  let stickyUser;
  if (user.includes('-rotate')) {
    stickyUser = user.replace('-rotate', `-rotate-session-${sessionId}`);
  } else {
    stickyUser = `${user}-session-${sessionId}`;
  }
  
  return new HttpsProxyAgent(`${protocol}://${stickyUser}:${pass}@${host}`);
}

// Old rotating proxy (for non-critical calls like parse)
function getProxyAgent() { return new HttpsProxyAgent(PROXY_URL); }

async function fetchWithTimeout(url, options, timeoutMs = 25000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return resp;
  } catch (err) { clearTimeout(timer); throw err; }
}

const cache = new Map();
function cacheGet(key) {
  const entry = cache.get(key);
  if (entry && (Date.now() - entry.ts) < CACHE_TTL * 1000) return entry.data;
  cache.delete(key); return null;
}
function cacheSet(key, data) {
  cache.set(key, { ts: Date.now(), data });
  const now = Date.now();
  for (const [k, v] of cache) { if (now - v.ts > CACHE_TTL * 2 * 1000) cache.delete(k); }
}

function extractVideoId(url) {
  if (/^[a-zA-Z0-9_-]{11}$/.test(url)) return url;
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/|youtube\.com\/live\/)([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/watch\?.*v=([a-zA-Z0-9_-]{11})/,
  ];
  for (const pat of patterns) { const m = url.match(pat); if (m) return m[1]; }
  return null;
}

function normalizeUrl(url) {
  url = url.trim();
  if (!url.startsWith('http')) return `https://www.youtube.com/watch?v=${url}`;
  const m = url.match(/https?:\/\/youtu\.be\/([a-zA-Z0-9_-]{11})/);
  if (m) return `https://www.youtube.com/watch?v=${m[1]}`;
  return url;
}

function formatSize(bytes) {
  if (!bytes) return null;
  return Math.round(bytes / 1048576 * 100) / 100;
}

function formatDuration(seconds) {
  if (!seconds) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

// ─── vidssave API ─────────────────────────────────────────────────────────────

/** Step 1: Parse → video info + all formats (FAST: ~1-2s) */
async function vidssaveParse(ytUrl) {
  const body = new URLSearchParams({ auth: AUTH, domain: DOMAIN, origin: 'source', link: ytUrl }).toString();
  const resp = await fetchWithTimeout(`${VIDSSAVE_API}/media/parse`, {
    method: 'POST',
    headers: { ...BROWSER_HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    agent: getProxyAgent(),
  }, 20000);
  const data = await resp.json();
  if (data.status === 0 && data.status_code === 'analyze_risk') throw new Error('Blocked (analyze_risk) — retry');
  if (data.status === 1 || data.data) return data.data;
  throw new Error(data.msg || 'Parse failed');
}

/**
 * Step 2+3: Resolve resourceContent → download URL
 * Uses sticky proxy so the same IP resolves AND downloads the CDN file.
 */
async function vidssaveResolveWithStickyProxy(resourceContent) {
  // Create a sticky session — same IP for all calls below
  const { sessionId } = createStickySession();
  const agent = getStickyProxyAgent(sessionId);
  
  console.log(`[Sticky] Using session ${sessionId} for resolve+download`);

  // Step 2: Request download → task_id
  const body = 'auth=' + AUTH + '&domain=' + DOMAIN + '&request=' + encodeURIComponent(resourceContent) + '&no_encrypt=1';
  const dlResp = await fetchWithTimeout(`${VIDSSAVE_API}/media/download`, {
    method: 'POST',
    headers: { ...BROWSER_HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    agent,
  }, 30000);
  const dlData = await dlResp.json();
  if (!(dlData.status === 1 && dlData.data && dlData.data.task_id)) {
    throw new Error(dlData.msg || 'Download request failed');
  }
  const taskId = dlData.data.task_id;

  // Step 3: Query download → get download_link
  const queryUrl = `${VIDSSAVE_API}/media/download_query?auth=${AUTH}&domain=${DOMAIN}&task_id=${encodeURIComponent(taskId)}&download_domain=vidssave.com&origin=content_site`;

  // Try SSE stream first
  try {
    const resp = await fetchWithTimeout(queryUrl, { headers: { ...BROWSER_HEADERS }, agent }, 30000);
    const text = await resp.text();
    if (text.includes('download_link')) {
      const match = text.match(/"download_link"\s*:\s*"([^"]+)"/);
      if (match) return { downloadLink: match[1], filesize: 0, sessionId };
      try {
        const json = JSON.parse(text.replace(/^event:.*\n/gm, '').replace(/^data:\s*/gm, ''));
        if (json.data && json.data.download_link) return { downloadLink: json.data.download_link, filesize: json.data.filesize || 0, sessionId };
      } catch (e) {}
    }
  } catch (err) {
    console.warn('[SSE stream] failed:', err.message);
  }

  // Polling fallback
  for (let attempt = 1; attempt <= 20; attempt++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const resp = await fetchWithTimeout(queryUrl, { headers: { ...BROWSER_HEADERS }, agent }, 10000);
      const text = await resp.text();
      if (text.includes('download_link')) {
        const match = text.match(/"download_link"\s*:\s*"([^"]+)"/);
        if (match) return { downloadLink: match[1], filesize: 0, sessionId };
        try {
          const json = JSON.parse(text);
          if (json.data && json.data.download_link) return { downloadLink: json.data.download_link, filesize: json.data.filesize || 0, sessionId };
        } catch (e) {}
      }
    } catch (err) {}
  }
  throw new Error('SSE polling timed out');
}

/** Old resolve (non-sticky) — for /resolve endpoint only */
async function resolveResourceContent(resourceContent) {
  const taskId = await vidssaveDownload(resourceContent);
  const result = await vidssaveQueryDownload(taskId);
  return result;
}

async function vidssaveDownload(resourceContent) {
  const body = 'auth=' + AUTH + '&domain=' + DOMAIN + '&request=' + encodeURIComponent(resourceContent) + '&no_encrypt=1';
  const resp = await fetchWithTimeout(`${VIDSSAVE_API}/media/download`, {
    method: 'POST',
    headers: { ...BROWSER_HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    agent: getProxyAgent(),
  }, 30000);
  const data = await resp.json();
  if (data.status === 1 && data.data && data.data.task_id) return data.data.task_id;
  throw new Error(data.msg || 'Download request failed');
}

async function vidssaveQueryDownload(taskId) {
  const queryUrl = `${VIDSSAVE_API}/media/download_query?auth=${AUTH}&domain=${DOMAIN}&task_id=${encodeURIComponent(taskId)}&download_domain=vidssave.com&origin=content_site`;
  try {
    const resp = await fetchWithTimeout(queryUrl, { headers: { ...BROWSER_HEADERS }, agent: getProxyAgent() }, 30000);
    const text = await resp.text();
    if (text.includes('download_link')) {
      const match = text.match(/"download_link"\s*:\s*"([^"]+)"/);
      if (match) return { downloadLink: match[1], filesize: 0 };
      try {
        const json = JSON.parse(text.replace(/^event:.*\n/gm, '').replace(/^data:\s*/gm, ''));
        if (json.data && json.data.download_link) return { downloadLink: json.data.download_link, filesize: json.data.filesize || 0 };
      } catch (e) {}
    }
  } catch (err) {
    console.warn('[SSE stream] failed:', err.message);
  }
  for (let attempt = 1; attempt <= 20; attempt++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const resp = await fetchWithTimeout(queryUrl, { headers: { ...BROWSER_HEADERS }, agent: getProxyAgent() }, 10000);
      const text = await resp.text();
      if (text.includes('download_link')) {
        const match = text.match(/"download_link"\s*:\s*"([^"]+)"/);
        if (match) return { downloadLink: match[1], filesize: 0 };
        try {
          const json = JSON.parse(text);
          if (json.data && json.data.download_link) return { downloadLink: json.data.download_link, filesize: json.data.filesize || 0 };
        } catch (e) {}
      }
    } catch (err) {}
  }
  throw new Error('SSE polling timed out');
}

// ─── Express App ──────────────────────────────────────────────────────────────
const app = express();
app.use(cors());

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({
    service: 'YouTube Download API',
    version: '3.1.0',
    source: 'vidssave.com API + Webshare sticky proxy',
    endpoints: {
      'GET /parse?url=<YT_URL>': 'Parse — returns all formats',
      'GET /resolve?rc=<token>': 'Resolve resourceContent → download URL',
      'GET /download?url=<YT>&quality=1080p': 'One-shot: parse + resolve',
      'GET /download-all?url=<YT>': 'Parse + resolve ALL qualities',
      'GET /stream?url=<YT>&quality=1080p': 'Parse + resolve + stream through proxy (sticky session)',
    },
  });
});

/**
 * GET /parse?url=<YT_URL>
 */
app.get('/parse', asyncHandler(async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing ?url=' });
  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: 'Invalid YouTube URL' });

  const fullUrl = normalizeUrl(url);
  const cacheKey = `parse:${fullUrl}`;
  let parsed = cacheGet(cacheKey);
  if (!parsed) {
    parsed = await vidssaveParse(fullUrl);
    cacheSet(cacheKey, parsed);
  }

  const resources = parsed.resources || [];
  res.json({
    id: parsed.id || videoId,
    title: parsed.title,
    thumbnail: parsed.thumbnail,
    durationSeconds: parsed.duration,
    durationHms: formatDuration(parsed.duration),
    formats: resources.map(r => ({
      quality: r.quality,
      type: r.type,
      format: r.format,
      sizeBytes: r.size || 0,
      sizeMB: formatSize(r.size),
      downloadUrl: (r.download_url && r.download_mode === 'check_download') ? r.download_url : null,
      resourceContent: r.resource_content || null,
    })),
  });
}));

/**
 * GET /resolve?rc=<resourceContent>
 */
app.get('/resolve', asyncHandler(async (req, res) => {
  const { rc } = req.query;
  if (!rc) return res.status(400).json({ error: 'Missing ?rc=<resourceContent>' });
  const result = await resolveResourceContent(rc);
  res.json({ downloadUrl: result.downloadLink, filesize: result.filesize || 0, sizeMB: formatSize(result.filesize) });
}));

app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

app.post('/resolve', asyncHandler(async (req, res) => {
  const rc = req.body.rc || req.body.resourceContent || req.query.rc;
  if (!rc) return res.status(400).json({ error: 'Missing resourceContent' });
  const result = await resolveResourceContent(rc);
  res.json({ downloadUrl: result.downloadLink, filesize: result.filesize || 0, sizeMB: formatSize(result.filesize) });
}));

/**
 * GET /download?url=<YT_URL>&quality=1080p
 */
app.get('/download', asyncHandler(async (req, res) => {
  const { url, quality = '1080p' } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing ?url=' });
  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: 'Invalid YouTube URL' });

  const fullUrl = normalizeUrl(url);
  const cacheKey = `parse:${fullUrl}`;
  let parsed = cacheGet(cacheKey);
  if (!parsed) { parsed = await vidssaveParse(fullUrl); cacheSet(cacheKey, parsed); }

  const resources = parsed.resources || [];
  const qualityMap = {
    '1080P':'1080P','720P':'720P','480P':'480P','360P':'360P',
    '240P':'240P','144P':'144P','AUDIO':'128KBPS','MP3':'128KBPS',
    'M4A':'128KBPS','128KBPS':'128KBPS','256KBPS':'256KBPS','48KBPS':'48KBPS',
  };
  const targetQuality = qualityMap[quality.toUpperCase().replace('P','P')] || quality.toUpperCase();
  const resource = resources.find(r => r.quality === targetQuality && r.type === 'video') ||
                   resources.find(r => r.quality === targetQuality && r.type === 'audio');
  if (!resource) return res.status(404).json({ error: `Quality ${quality} not available. Available: ${resources.map(r => r.quality).join(', ')}` });

  if (resource.download_url && resource.download_mode === 'check_download') {
    return res.json({ id: parsed.id || videoId, title: parsed.title, duration: formatDuration(parsed.duration), quality: targetQuality, downloadUrl: resource.download_url, sizeMB: formatSize(resource.size), isDirectUrl: true });
  }

  if (!resource.resource_content) return res.status(400).json({ error: `No resource_content for ${targetQuality}` });

  // Use sticky proxy for resolve
  const dlResult = await vidssaveResolveWithStickyProxy(resource.resource_content);
  const result = {
    id: parsed.id || videoId,
    title: parsed.title,
    duration: formatDuration(parsed.duration),
    quality: targetQuality,
    downloadUrl: dlResult.downloadLink,
    sizeMB: formatSize(dlResult.filesize || resource.size),
    isDirectUrl: false,
  };

  if (resource.type === 'video' && !['360P', '240P', '144P'].includes(targetQuality)) {
    const audioResource = resources.find(r => r.quality === '128KBPS' && r.type === 'audio');
    if (audioResource) {
      try {
        if (audioResource.download_url && audioResource.download_mode === 'check_download') {
          result.audioUrl = audioResource.download_url;
        } else if (audioResource.resource_content) {
          const audioResult = await vidssaveResolveWithStickyProxy(audioResource.resource_content);
          result.audioUrl = audioResult.downloadLink;
        }
        result.mergeTip = 'ffmpeg -i video.mp4 -i audio.mp3 -c copy output.mp4';
      } catch (e) { result.audioError = e.message; }
    }
  }

  res.json(result);
}));

/**
 * GET /download-all?url=<YT_URL>
 */
app.get('/download-all', asyncHandler(async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing ?url=' });
  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: 'Invalid YouTube URL' });

  const fullUrl = normalizeUrl(url);
  const cacheKey = `parse:${fullUrl}`;
  let parsed = cacheGet(cacheKey);
  if (!parsed) { parsed = await vidssaveParse(fullUrl); cacheSet(cacheKey, parsed); }

  const resources = parsed.resources || [];
  const results = { id: parsed.id || videoId, title: parsed.title, duration: formatDuration(parsed.duration), downloads: {} };

  for (const r of resources) {
    try {
      if (r.download_url && r.download_mode === 'check_download') {
        results.downloads[r.quality] = { url: r.download_url, sizeMB: formatSize(r.size), isDirect: true, type: r.type };
      } else if (r.resource_content) {
        const dl = await vidssaveResolveWithStickyProxy(r.resource_content);
        results.downloads[r.quality] = { url: dl.downloadLink, sizeMB: formatSize(dl.filesize || r.size), isDirect: false, type: r.type };
      } else {
        results.downloads[r.quality] = { error: 'No download method', type: r.type };
      }
    } catch (e) {
      results.downloads[r.quality] = { error: e.message, type: r.type };
    }
  }

  res.json(results);
}));

/**
 * GET /stream?url=<YT_URL>&quality=1080p&filename=video.mp4
 * 
 * KEY FIX: Uses sticky proxy session so the same IP resolves the download URL
 * AND downloads the CDN file. vidssave CDN sign is IP-bound.
 */
app.get('/stream', asyncHandler(async (req, res) => {
  const { url, quality = '1080p', filename } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing ?url=' });
  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: 'Invalid YouTube URL' });

  const fullUrl = normalizeUrl(url);
  const cacheKey = `parse:${fullUrl}`;
  let parsed = cacheGet(cacheKey);
  if (!parsed) {
    parsed = await vidssaveParse(fullUrl);
    cacheSet(cacheKey, parsed);
  }

  const resources = parsed.resources || [];
  const qualityMap = {
    '1080P':'1080P','720P':'720P','480P':'480P','360P':'360P',
    '240P':'240P','144P':'144P','AUDIO':'128KBPS','MP3':'128KBPS',
    'M4A':'128KBPS','128KBPS':'128KBPS','256KBPS':'256KBPS','48KBPS':'48KBPS',
  };
  const targetQuality = qualityMap[quality.toUpperCase().replace('P','P')] || quality.toUpperCase();
  const resource = resources.find(r => r.quality === targetQuality && r.type === 'video') ||
                   resources.find(r => r.quality === targetQuality && r.type === 'audio');
  if (!resource) return res.status(404).json({ error: `Quality ${quality} not available` });

  // Direct googlevideo URL — redirect browser (no proxy needed)
  if (resource.download_url && resource.download_mode === 'check_download') {
    return res.redirect(resource.download_url);
  }

  if (!resource.resource_content) return res.status(400).json({ error: 'No download method available' });

  // ─── Sticky proxy session: same IP for resolve + download ────
  const { sessionId } = createStickySession();
  const stickyAgent = getStickyProxyAgent(sessionId);

  console.log(`[Stream] Using sticky session ${sessionId} for ${targetQuality}`);

  // Resolve through sticky proxy (same IP)
  const dlResult = await vidssaveResolveWithStickyProxy(resource.resource_content);
  const downloadUrl = dlResult.downloadLink;
  const isVidssaveCDN = downloadUrl && downloadUrl.includes('vidssave.com');

  if (!downloadUrl) return res.status(502).json({ error: 'Failed to get download URL' });

  // googlevideo URL from resolve — redirect directly
  if (!isVidssaveCDN && downloadUrl.includes('googlevideo.com')) {
    return res.redirect(downloadUrl);
  }

  const safeFilename = filename || `youtube-${videoId}-${targetQuality}.${resource.type === 'audio' ? 'mp3' : 'mp4'}`;

  // Download CDN file through the SAME sticky proxy IP that resolved it
  console.log(`[Stream] Downloading ${targetQuality} via sticky session ${sessionId}: ${downloadUrl.substring(0, 80)}...`);

  const streamHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
    'Referer': 'https://vidssave.com/',
    'Origin': 'https://vidssave.com',
    'Accept': '*/*',
  };

  const rangeHeader = req.headers['range'];
  if (rangeHeader) streamHeaders['Range'] = rangeHeader;

  // Use the SAME sticky agent that resolved the URL
  const resolveSessionId = dlResult.sessionId;
  const downloadAgent = resolveSessionId ? getStickyProxyAgent(resolveSessionId) : stickyAgent;

  const upstream = await fetchWithTimeout(downloadUrl, {
    headers: streamHeaders,
    agent: downloadAgent,
    redirect: 'follow',
  }, 120000);

  if (!upstream.ok && upstream.status !== 206) {
    console.error(`[Stream] Upstream ${upstream.status} for ${downloadUrl.substring(0, 80)}`);
    return res.status(upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502)
      .json({ error: `Download failed: HTTP ${upstream.status}. Link may have expired.` });
  }

  // Stream back with proper headers
  const contentType = upstream.headers.get('content-type');
  const contentLength = upstream.headers.get('content-length');
  const contentRange = upstream.headers.get('content-range');

  res.setHeader('Content-Type', contentType || 'video/mp4');
  if (contentLength) res.setHeader('Content-Length', contentLength);
  if (contentRange) res.setHeader('Content-Range', contentRange);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(safeFilename)}"`);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges, Content-Disposition');
  res.setHeader('Cache-Control', 'public, max-age=300');

  res.status(upstream.status);
  upstream.body.pipe(res);

  req.on('close', () => {
    try { upstream.body.destroy(); } catch (e) {}
  });
}));

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  const proxyHost = PROXY_URL.includes('@') ? PROXY_URL.split('@')[1] : PROXY_URL;
  console.log('=== YouTube Download API v3.1 ===');
  console.log('Port:', PORT, '| Proxy:', proxyHost);
  console.log('FIX: Sticky proxy sessions — same IP for resolve + CDN download');
  console.log('Ready!');
});

setInterval(() => {}, 60000);
