#!/usr/bin/env node
/**
 * YouTube Download API — Node.js / Express
 *
 * Reverse-engineered from vidssave.com — uses their API directly.
 *
 * Flow:
 *   1. POST media/parse → video info + all formats + some direct URLs
 *      - 360P, 128KBPS audio → direct googlevideo URLs (instant)
 *      - 1080P, 720P, 480P → need step 2+3
 *   2. POST media/download with resource_content → task_id
 *   3. GET  media/download_query?task_id=… → SSE stream → download_link
 *
 * Uses Webshare rotating proxy to bypass IP blocks.
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

// ─── Helpers ──────────────────────────────────────────────────────────────────
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

/** Step 2: Request download → task_id */
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

/** Step 3: Read SSE stream → download_link (reads stream directly, no polling delay) */
async function vidssaveQueryDownload(taskId) {
  const queryUrl = `${VIDSSAVE_API}/media/download_query?auth=${AUTH}&domain=${DOMAIN}&task_id=${encodeURIComponent(taskId)}&download_domain=vidssave.com&origin=content_site`;

  // Strategy 1: Read the SSE stream directly (fastest — like the browser)
  try {
    const resp = await fetchWithTimeout(queryUrl, {
      headers: { ...BROWSER_HEADERS },
      agent: getProxyAgent(),
    }, 30000);
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

  // Strategy 2: Fast polling fallback (500ms)
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

/** Get download URL for a single resource */
async function getDownloadUrl(resource) {
  if (resource.download_url && resource.download_mode === 'check_download') {
    return { url: resource.download_url, filesize: resource.size || 0, isDirect: true };
  }
  if (!resource.resource_content) throw new Error(`No resource_content for ${resource.quality}`);
  const taskId = await vidssaveDownload(resource.resource_content);
  const result = await vidssaveQueryDownload(taskId);
  return { url: result.downloadLink, filesize: result.filesize || resource.size || 0, isDirect: false };
}

// ─── Express App ──────────────────────────────────────────────────────────────
const app = express();
app.use(cors());

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({
    service: 'YouTube Download API',
    version: '2.0.0',
    source: 'vidssave.com API + Webshare rotating proxy',
    how_it_works: {
      step1_parse: 'POST media/parse → video info + all formats (FAST: ~1-2s)',
      step2_download: 'POST media/download → task_id (needed for 1080p/720p/480p only)',
      step3_query: 'GET media/download_query → SSE stream → download_link',
      direct_urls: '360P, 128KBPS audio, 48KBPS audio get direct googlevideo URLs from step 1 (instant)',
    },
    endpoints: {
      'GET /parse?url=<YT_URL>': 'FAST (~1-2s) — parse only, returns all formats + direct URLs',
      'GET /download?url=<YT_URL>&quality=1080p': 'Get download URL for quality (~4-7s for 1080p, ~1-2s for 360p)',
      'GET /download-all?url=<YT_URL>': 'Get ALL download URLs (slow — fetches each)',
    },
    qualities: ['1080p', '720p', '480p', '360p', '240p', '144p', 'audio', 'mp3'],
    example: 'GET /parse?url=https://youtu.be/v5LlVB3fqjY',
  });
});

/**
 * GET /parse?url=<YT_URL>
 * FAST: ~1-2s — returns all video info + formats from the parse API directly.
 * Some formats (360P, audio) already have direct download URLs.
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
      downloadMode: r.download_mode || null,
      // Direct URLs already available (360P, audio) — no extra request needed
      downloadUrl: (r.download_url && r.download_mode === 'check_download') ? r.download_url : null,
      // resource_content is needed for step 2 to get download URL for non-direct formats
      resourceContent: r.resource_content || null,
    })),
  });
}));

/**
 * GET /download?url=<YT_URL>&quality=1080p
 * Gets download URL for a specific quality.
 * - 360P, audio: FAST (~1-2s, direct URL from parse)
 * - 1080P, 720P, 480P: SLOW (~4-7s, needs download + SSE flow)
 */
app.get('/download', asyncHandler(async (req, res) => {
  const { url, quality = '1080p' } = req.query;
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
  if (!resource) return res.status(404).json({ error: `Quality ${quality} not available. Available: ${resources.map(r => r.quality).join(', ')}` });

  const dlResult = await getDownloadUrl(resource);
  const result = {
    id: parsed.id || videoId,
    title: parsed.title,
    duration: formatDuration(parsed.duration),
    quality: targetQuality,
    downloadUrl: dlResult.url,
    sizeMB: formatSize(dlResult.filesize),
    isDirectUrl: dlResult.isDirect,
  };

  // For video-only formats (1080P/720P/480P), also get audio URL
  if (resource.type === 'video' && !['360P', '240P', '144P'].includes(targetQuality)) {
    const audioResource = resources.find(r => r.quality === '128KBPS' && r.type === 'audio');
    if (audioResource) {
      try {
        const audioResult = await getDownloadUrl(audioResource);
        result.audioUrl = audioResult.url;
        result.mergeTip = 'ffmpeg -i video.mp4 -i audio.mp3 -c copy output.mp4';
      } catch (e) {
        result.audioError = e.message;
      }
    }
  }

  res.json(result);
}));

/**
 * GET /download-all?url=<YT_URL>
 * Gets ALL download URLs. Slow because it fetches each one.
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
      const dl = await getDownloadUrl(r);
      results.downloads[r.quality] = { url: dl.url, sizeMB: formatSize(dl.filesize), isDirect: dl.isDirect, type: r.type };
    } catch (e) {
      results.downloads[r.quality] = { error: e.message, type: r.type };
    }
  }

  res.json(results);
}));

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  const proxyHost = PROXY_URL.includes('@') ? PROXY_URL.split('@')[1] : PROXY_URL;
  console.log('=== YouTube Download API v2 ===');
  console.log('Port:', PORT, '| Proxy:', proxyHost);
  console.log('Ready!');
});

// Keep event loop alive (proxy agent sockets close after requests)
setInterval(() => {}, 60000);
