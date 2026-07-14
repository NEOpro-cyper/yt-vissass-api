#!/usr/bin/env node
/**
 * YouTube Download API — Node.js / Express
 *
 * Proxies vidssave.com's backend to get direct download URLs
 * for YouTube videos at 1080P, 720P, 480P, 360P, and audio.
 *
 * Flow (reverse-engineered from vidssave.com):
 *   1. POST media/parse  → video info + resource list
 *   2. POST media/download with resource_content + no_encrypt=1 → task_id
 *   3. GET  media/download_query?task_id=… → download_link (redirect URL)
 *
 * Uses Webshare rotating proxy to bypass IP blocks.
 */

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { HttpsProxyAgent } = require('https-proxy-agent');

// ─── Crash Guard ──────────────────────────────────────────────────────────────
process.on('uncaughtException', (e) => {
  console.error('[UNCAUGHT]', e.stack || e.message || e);
});
process.on('unhandledRejection', (e) => {
  console.error('[UNHANDLED REJECTION]', e);
});

// ─── Async Handler Wrapper for Express 4 ──────────────────────────────────────
// Express 4 doesn't catch async errors — this wrapper ensures they're forwarded
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(err => {
      console.error('[Route Error]', err.message);
      if (!res.headersSent) {
        res.status(502).json({ error: err.message });
      }
    });
  };
}

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8000;
const PROXY_URL = process.env.PROXY_URL || 'http://qijlkvsz-rotate:viryx2zv5njj@p.webshare.io:80';
const API_KEY = process.env.API_KEY || '';
const CACHE_TTL = parseInt(process.env.CACHE_TTL || '1800', 10); // 30 min

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

// ─── Proxy Agent ──────────────────────────────────────────────────────────────
function getProxyAgent() {
  return new HttpsProxyAgent(PROXY_URL);
}

// ─── Fetch with Timeout ──────────────────────────────────────────────────────
async function fetchWithTimeout(url, options, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return resp;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ─── In-Memory Cache ──────────────────────────────────────────────────────────
const cache = new Map();

function cacheGet(key) {
  const entry = cache.get(key);
  if (entry && (Date.now() - entry.ts) < CACHE_TTL * 1000) {
    return entry.data;
  }
  cache.delete(key);
  return null;
}

function cacheSet(key, data) {
  cache.set(key, { ts: Date.now(), data });
  const now = Date.now();
  for (const [k, v] of cache) {
    if (now - v.ts > CACHE_TTL * 2 * 1000) cache.delete(k);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function extractVideoId(url) {
  if (/^[a-zA-Z0-9_-]{11}$/.test(url)) return url;
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/|youtube\.com\/live\/)([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/watch\?.*v=([a-zA-Z0-9_-]{11})/,
  ];
  for (const pat of patterns) {
    const m = url.match(pat);
    if (m) return m[1];
  }
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
  const mb = bytes / (1024 * 1024);
  return Math.round(mb * 100) / 100;
}

function formatDuration(seconds) {
  if (!seconds) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

// ─── vidssave API Calls ──────────────────────────────────────────────────────

async function vidssaveParse(ytUrl, retryCount = 3) {
  const body = new URLSearchParams({
    auth: AUTH, domain: DOMAIN, origin: 'source', link: ytUrl,
  }).toString();

  for (let attempt = 1; attempt <= retryCount; attempt++) {
    try {
      const resp = await fetchWithTimeout(`${VIDSSAVE_API}/media/parse`, {
        method: 'POST',
        headers: { ...BROWSER_HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        agent: getProxyAgent(),
      }, 30000);

      const data = await resp.json();

      if (data.status === 0 && data.status_code === 'analyze_risk') {
        console.warn(`[parse] analyze_risk on attempt ${attempt}/${retryCount}`);
        if (attempt < retryCount) { await new Promise(r => setTimeout(r, 1500)); continue; }
      }

      if (data.status === 1 || data.data) return data.data;
      throw new Error(data.msg || 'Parse failed');
    } catch (err) {
      if (attempt === retryCount) throw err;
      console.warn(`[parse] Attempt ${attempt} failed: ${err.message}`);
      await new Promise(r => setTimeout(r, 1500));
    }
  }
}

async function vidssaveDownload(resourceContent, retryCount = 3) {
  const body = 'auth=' + AUTH + '&domain=' + DOMAIN +
    '&request=' + encodeURIComponent(resourceContent) + '&no_encrypt=1';

  for (let attempt = 1; attempt <= retryCount; attempt++) {
    try {
      const resp = await fetchWithTimeout(`${VIDSSAVE_API}/media/download`, {
        method: 'POST',
        headers: { ...BROWSER_HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        agent: getProxyAgent(),
      }, 60000);

      const data = await resp.json();
      if (data.status === 1 && data.data && data.data.task_id) return data.data.task_id;
      throw new Error(data.msg || 'Download request failed');
    } catch (err) {
      if (attempt === retryCount) throw err;
      console.warn(`[download] Attempt ${attempt} failed: ${err.message}`);
      await new Promise(r => setTimeout(r, 1500));
    }
  }
}

async function vidssaveQueryDownload(taskId) {
  const queryUrl = `${VIDSSAVE_API}/media/download_query?auth=${AUTH}&domain=${DOMAIN}&task_id=${encodeURIComponent(taskId)}&download_domain=vidssave.com&origin=content_site`;

  for (let attempt = 1; attempt <= 15; attempt++) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const resp = await fetchWithTimeout(queryUrl, {
        headers: { ...BROWSER_HEADERS },
        agent: getProxyAgent(),
      }, 15000);

      const text = await resp.text();

      if (text.includes('download_link')) {
        const match = text.match(/"download_link"\s*:\s*"([^"]+)"/);
        if (match) return { downloadLink: match[1], filesize: 0 };

        try {
          const json = JSON.parse(text);
          if (json.data && json.data.download_link) {
            return { downloadLink: json.data.download_link, filesize: json.data.filesize || 0 };
          }
        } catch (e) {}
      }

      console.log(`[SSE poll] Attempt ${attempt}: no download_link yet`);
    } catch (err) {
      console.warn(`[SSE poll] Attempt ${attempt} error: ${err.message}`);
    }
  }

  throw new Error('SSE polling timed out — download link not received');
}

async function getDownloadUrl(resource, retryCount = 2) {
  if (resource.download_url && resource.download_mode === 'check_download') {
    console.log(`[download] ${resource.quality} has direct URL`);
    return { url: resource.download_url, filesize: resource.size || 0, isDirect: true, note: 'Direct Google video URL' };
  }

  if (!resource.resource_content) throw new Error(`No resource_content for ${resource.quality}`);

  for (let attempt = 1; attempt <= retryCount; attempt++) {
    try {
      console.log(`[download] Requesting ${resource.quality} (attempt ${attempt})...`);
      const taskId = await vidssaveDownload(resource.resource_content);
      console.log(`[download] Got task_id for ${resource.quality}, polling...`);
      const result = await vidssaveQueryDownload(taskId);
      console.log(`[download] Got download link for ${resource.quality}`);
      return { url: result.downloadLink, filesize: result.filesize || resource.size || 0, isDirect: false, note: 'Vidssave redirect URL — follows to Google video server' };
    } catch (err) {
      console.warn(`[download] ${resource.quality} attempt ${attempt} failed: ${err.message}`);
      if (attempt === retryCount) throw err;
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

async function getVideoInfo(ytUrl, { includeUrls = false, quality = null } = {}) {
  const fullUrl = normalizeUrl(ytUrl);
  const videoId = extractVideoId(fullUrl);

  const cacheKey = `info:${fullUrl}`;
  const cached = cacheGet(cacheKey);
  let parsed;
  if (cached) {
    console.log(`[cache] Hit for ${videoId}`);
    parsed = cached;
  } else {
    parsed = await vidssaveParse(fullUrl);
    cacheSet(cacheKey, parsed);
  }

  const resources = parsed.resources || [];
  const formats = resources.map(r => ({
    quality: r.quality, type: r.type, format: r.format,
    sizeBytes: r.size || 0, sizeMB: formatSize(r.size),
    hasDirectUrl: !!(r.download_url && r.download_mode === 'check_download'),
  }));

  const result = {
    id: parsed.id || videoId, title: parsed.title,
    thumbnail: parsed.thumbnail, durationSeconds: parsed.duration,
    durationHms: formatDuration(parsed.duration), formats,
  };

  if (quality) {
    const qualityMap = {
      '1080P':'1080P','720P':'720P','480P':'480P','360P':'360P',
      '240P':'240P','144P':'144P','AUDIO':'128KBPS','MP3':'128KBPS',
      'M4A':'128KBPS','128KBPS':'128KBPS','256KBPS':'256KBPS','48KBPS':'48KBPS',
    };
    const targetQuality = qualityMap[quality.toUpperCase().replace('P','P')] || quality.toUpperCase();
    const resource = resources.find(r => r.quality === targetQuality && r.type === 'video') ||
                     resources.find(r => r.quality === targetQuality && r.type === 'audio');
    if (!resource) throw new Error(`Quality ${quality} not available. Available: ${resources.map(r => r.quality).join(', ')}`);

    const dlResult = await getDownloadUrl(resource);
    result.downloadUrl = dlResult.url;
    result.downloadSizeMB = formatSize(dlResult.filesize);
    result.isDirectUrl = dlResult.isDirect;
    result.note = dlResult.note;
    result.requestedQuality = targetQuality;

    if (resource.type === 'video' && targetQuality !== '360P') {
      const audioResource = resources.find(r => r.quality === '128KBPS' && r.type === 'audio');
      if (audioResource) {
        try {
          const audioResult = await getDownloadUrl(audioResource);
          result.audioUrl = audioResult.url;
          result.audioNote = audioResult.note;
        } catch (e) {
          result.audioNote = `Failed to get audio URL: ${e.message}`;
        }
      }
    }
  }

  if (includeUrls && !quality) {
    result.downloadUrls = {};
    for (const r of resources) {
      try {
        const dlResult = await getDownloadUrl(r);
        result.downloadUrls[r.quality] = { url: dlResult.url, sizeMB: formatSize(dlResult.filesize), isDirect: dlResult.isDirect };
      } catch (e) {
        result.downloadUrls[r.quality] = { error: e.message };
      }
    }
  }

  return result;
}

// ─── Auth Middleware ───────────────────────────────────────────────────────────
function requireApiKey(req, res, next) {
  if (!API_KEY) return next();
  const key = req.headers['x-api-key'];
  if (key !== API_KEY) return res.status(401).json({ error: 'Invalid API key' });
  next();
}

// ─── Express App ──────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// ─── Routes (all wrapped with asyncHandler for Express 4 compatibility) ──────

app.get('/', (req, res) => {
  res.json({
    service: 'YouTube Download API (Node.js)',
    version: '1.0.0',
    source: 'vidssave.com proxy + Webshare rotating proxy',
    endpoints: {
      'GET /info?url=<YT_URL>': 'Video metadata + format list',
      'GET /download?url=<YT_URL>&quality=1080p': 'Direct download URL for quality',
      'GET /download?url=<YT_URL>&quality=720p': '720p download URL',
      'GET /download?url=<YT_URL>&quality=360p': '360p direct URL (video+audio)',
      'GET /download?url=<YT_URL>&quality=audio': 'Best audio download URL',
      'GET /formats?url=<YT_URL>': 'Quick format list (no URLs fetched)',
      'GET /all-urls?url=<YT_URL>': 'All download URLs (slow — fetches each)',
      'GET /health': 'Health + proxy check',
    },
    qualities: ['1080p', '720p', '480p', '360p', '240p', '144p', 'audio', 'mp3'],
    example: 'GET /download?url=https://youtu.be/v5LlVB3fqjY&quality=1080p',
  });
});

app.get('/health', asyncHandler(async (req, res) => {
  try {
    const resp = await fetchWithTimeout(`${VIDSSAVE_API}/media/parse`, {
      method: 'POST',
      headers: { ...BROWSER_HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ auth: AUTH, domain: DOMAIN, origin: 'source', link: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }).toString(),
      agent: getProxyAgent(),
    }, 15000);
    const data = await resp.json();
    const proxyOk = data.status === 1 || !!data.data;
    res.json({
      status: proxyOk ? 'ok' : 'degraded',
      proxy: PROXY_URL.split('@')[1] || PROXY_URL,
      proxyWorking: proxyOk,
      cacheSize: cache.size,
      uptime: process.uptime(),
    });
  } catch (e) {
    res.json({
      status: 'degraded',
      proxy: PROXY_URL.split('@')[1] || PROXY_URL,
      proxyWorking: false,
      error: e.message,
      cacheSize: cache.size,
      uptime: process.uptime(),
    });
  }
}));

app.get('/info', requireApiKey, asyncHandler(async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing ?url= parameter' });
  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: 'Invalid YouTube URL or video ID' });

  const info = await getVideoInfo(url, { includeUrls: false });
  res.json(info);
}));

app.get('/formats', requireApiKey, asyncHandler(async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing ?url= parameter' });
  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: 'Invalid YouTube URL or video ID' });

  const info = await getVideoInfo(url, { includeUrls: false });
  res.json({ id: info.id, title: info.title, duration: info.durationHms, formats: info.formats });
}));

app.get('/download', requireApiKey, asyncHandler(async (req, res) => {
  const { url, quality = '1080p' } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing ?url= parameter' });
  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: 'Invalid YouTube URL or video ID' });

  console.log('[/download] Request:', quality, 'for', videoId);

  const info = await getVideoInfo(url, { quality });
  console.log('[/download] Got info, sending response');
  res.json({
    id: info.id, title: info.title, duration: info.durationHms,
    quality: info.requestedQuality, downloadUrl: info.downloadUrl,
    audioUrl: info.audioUrl || null, sizeMB: info.downloadSizeMB,
    isDirectUrl: info.isDirectUrl, note: info.note,
    audioNote: info.audioNote || null,
    mergeTip: info.audioUrl ? 'ffmpeg -i video.mp4 -i audio.mp3 -c copy output.mp4' : null,
  });
  console.log('[/download] Response sent for', quality);
}));

app.get('/all-urls', requireApiKey, asyncHandler(async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing ?url= parameter' });
  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: 'Invalid YouTube URL or video ID' });

  const info = await getVideoInfo(url, { includeUrls: true });
  res.json(info);
}));

// ─── Start Server ─────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  const proxyHost = PROXY_URL.includes('@') ? PROXY_URL.split('@')[1] : PROXY_URL;
  console.log('=== YouTube Download API (Node.js) ===');
  console.log('Port:', PORT);
  console.log('Proxy:', proxyHost);
  console.log('Docs: http://localhost:' + PORT + '/');
  console.log('Ready!');
});

// Keep the Node.js event loop alive — without this, the process exits
// when there are no active handles (proxy agent sockets close after requests)
setInterval(() => {}, 60000);
