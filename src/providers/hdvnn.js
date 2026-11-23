'use strict';

const BaseProvider = require('./base');
const { stripHtml, cached, qualityFromText } = require('../utils');
const { CONFIG } = require('../config');

// Nguồn HDVNN (hdvnn.xyz) — site "Xem phim Thuyết Minh, Lồng Tiếng".
// - Tìm kiếm: /tim-kiem/<keyword-dạng-slug>.html
// - Chi tiết : /thong-tin-phim/<slug>.html
// - Tập      : /xem-phim/<slug>-episode-id-<id>.html
// - Player   : POST /server/ajax/player {MovieID, EpisodeID} + CSRF + cookie
//   trả src_dp (HLS), src_hd-1/src_vip-1/... (MP4) hoặc src_vnn_* (player VNN).
//   Player VNN nhúng link Google Photos dạng base64 -> tải thẳng MP4 từ Google.

const UA = CONFIG.userAgent;

function cleanText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function querySlug(q) {
  return String(q || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-');
}

// Nhãn audio của HDVNN: "VS-TM" = có cả Vietsub lẫn Thuyết Minh.
// Key src_lt_* luôn là Lồng Tiếng; src_vnn_* mặc định Vietsub.
function audioLabel(text, key = '') {
  if (/_lt_/i.test(key)) return 'Lồng Tiếng';
  const s = String(text || '').toLowerCase();
  const hasTM = /thuy[ếe]t\s*minh|\btm\b/.test(s);
  const hasLT = /l[ồo]ng\s*ti[ếe]ng|\blt\b/.test(s);
  const hasVS = /vietsub|\bvs\b/.test(s);
  if (hasTM && hasVS) return 'Vietsub + TM';
  if (hasTM && hasLT) return 'Thuyết Minh + LT';
  if (hasTM) return 'Thuyết Minh';
  if (hasLT) return 'Lồng Tiếng';
  if (hasVS) return 'Vietsub';
  if (/_vnn_/i.test(key)) return 'Vietsub';
  return 'Vietsub';
}

// Google Photos: hậu tố =m37 (1080p) / =m22 (720p) / =m18 (360p)
function qualityFromGoogle(url) {
  const m = String(url).match(/=m(\d+)(?:$|[?&])/);
  if (!m) return 'HD';
  if (m[1] === '37') return '1080p';
  if (m[1] === '22') return '720p';
  if (m[1] === '18') return '360p';
  return 'HD';
}

function collectCookies(res) {
  let list = [];
  if (typeof res.headers.getSetCookie === 'function') list = res.headers.getSetCookie();
  else {
    const raw = res.headers.get('set-cookie');
    if (raw) list = raw.split(/,\s*(?=[^;,\s]+=)/);
  }
  return list
    .filter(Boolean)
    .map((c) => String(c).split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
}

async function fetchText(url, { headers = {}, timeout = 12000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, redirect: 'follow', signal: ctrl.signal });
    return { res, text: await res.text() };
  } finally {
    clearTimeout(t);
  }
}

class HdvnnProvider extends BaseProvider {
  get base() {
    return String(this.cfg.apiUrl || 'https://hdvnn.xyz').replace(/\/+$/, '');
  }

  get headers() {
    return {
      'User-Agent': UA,
      Referer: `${this.base}/`,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    };
  }

  cardFrom($, el) {
    const $el = $(el);
    const href = $el.attr('href') || '';
    const m = href.match(/\/thong-tin-phim\/([^/?#]+)\.html/);
    if (!m) return null;
    const name = cleanText($el.attr('title') || $el.find('.name-movie').text() || $el.find('img').attr('alt'));
    if (!name) return null;
    const epText = cleanText($el.find('.episode-latest').text());
    const score = cleanText($el.find('.score').text());
    const yearMatch = cleanText($el.text()).match(/\(?(20\d{2})\)?/);
    const isSeries = /\d+\s*\/\s*\d+|tập/i.test(epText) && !/^full$/i.test(epText);
    return {
      slug: m[1],
      name,
      year: yearMatch ? parseInt(yearMatch[1], 10) : null,
      type: isSeries ? 'series' : 'movie',
      poster: $el.find('img').attr('src') || null,
      audio: score || '',
      episodeText: epText
    };
  }

  async search(q) {
    if (!q) return [];
    return cached(`hd:search:${q}`, 10 * 60 * 1000, async () => {
      const slug = querySlug(q);
      const { res, text } = await fetchText(`${this.base}/tim-kiem/${encodeURIComponent(slug)}.html`, {
        headers: this.headers
      });
      if (!res.ok || !text) return [];
      const cheerio = require('cheerio');
      const $ = cheerio.load(text);
      const out = [];
      const seen = new Set();
      $('a[href*="/thong-tin-phim/"]').each((i, el) => {
        const item = this.cardFrom($, el);
        if (!item || seen.has(item.slug)) return;
        seen.add(item.slug);
        out.push(item);
      });
      return out;
    });
  }

  parseEpisodes($) {
    const map = new Map();
    $('a[href*="/xem-phim/"]').each((i, el) => {
      const $el = $(el);
      const href = $el.attr('href') || '';
      if (!/\/xem-phim\//.test(href) || map.has(href)) return;
      const label = cleanText($el.text());
      if (!label || /play_circle/i.test(label)) return;
      const numMatch = label.match(/(\d+)/);
      const isFull = /full/i.test(label);
      map.set(href, {
        name: label,
        url: href,
        num: numMatch ? parseInt(numMatch[1], 10) : isFull ? 1 : null
      });
    });
    return [...map.values()].sort((a, b) => (a.num || 9999) - (b.num || 9999));
  }

  async detail(slug) {
    return cached(`hd:detail:${slug}`, 60 * 60 * 1000, async () => {
      const { res, text } = await fetchText(`${this.base}/thong-tin-phim/${encodeURIComponent(slug)}.html`, {
        headers: this.headers,
        timeout: 15000
      });
      if (!res.ok || !text) return null;
      const cheerio = require('cheerio');
      const $ = cheerio.load(text);
      const name = cleanText($('h1').first().text()) || slug;
      const episodes = this.parseEpisodes($);
      const infoText = cleanText($('.info-movie').text());
      const yearMatch = infoText.match(/\b(19|20)\d{2}\b/);
      const descBlock = $('.ah_content').text();
      const description = stripHtml(
        descBlock.replace(/^\s*Nội dung\s*/i, '')
      ).slice(0, 1200);
      const audio = cleanText($('meta[name="description"]').attr('content'));

      const isSeries = episodes.length > 1 || episodes.some((e) => e.num && e.num > 1);
      const videos = episodes.map((e, idx) => ({
        id: `${this.prefix}${slug}:1:${e.num || idx + 1}`,
        title: e.name && /tập|ep/i.test(e.name) ? e.name : `Tập ${e.num || idx + 1}`,
        season: 1,
        episode: e.num || idx + 1,
        released: new Date().toISOString()
      }));

      return {
        slug,
        name,
        originalName: name,
        year: yearMatch ? parseInt(yearMatch[0], 10) : null,
        type: isSeries ? 'series' : 'movie',
        quality: 'HD',
        lang: audioLabel(audio),
        poster: $('meta[property="og:image"]').attr('content') || null,
        background: $('meta[property="og:image"]').attr('content') || null,
        description,
        audio,
        servers: [{ serverName: audioLabel(audio), items: episodes }],
        videos: isSeries ? videos : undefined
      };
    });
  }

  // Gọi API player của HDVNN cho 1 trang tập
  async loadPlayer(epUrl) {
    return cached(`hd:player:${epUrl}`, 5 * 60 * 1000, async () => {
      const { res, text } = await fetchText(epUrl, { headers: this.headers, timeout: 15000 });
      if (!res.ok || !text) return null;
      const cookie = collectCookies(res);
      const csrf = (text.match(/<meta name="csrf-token" content="([^"]+)"/) || [])[1];
      const movieId = (text.match(/MovieID:\s*(\d+)/) || [])[1];
      const episodeId = (text.match(/EpisodeID:\s*(\d+)/) || [])[1];
      if (!csrf || !movieId || !episodeId) return null;

      const body = new URLSearchParams({ MovieID: movieId, EpisodeID: episodeId });
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      try {
        const r = await fetch(`${this.base}/server/ajax/player`, {
          method: 'POST',
          headers: {
            'User-Agent': UA,
            Referer: epUrl,
            Origin: this.base,
            'X-Requested-With': 'XMLHttpRequest',
            'X-CSRF-TOKEN': csrf,
            Cookie: cookie,
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body,
          signal: ctrl.signal
        });
        if (!r.ok) return null;
        return await r.json();
      } catch {
        return null;
      } finally {
        clearTimeout(t);
      }
    });
  }

  // Player VNN nhúng link Google Photos base64 -> MP4 trực tiếp
  async resolveVnn(embedUrl) {
    if (!embedUrl) return [];
    try {
    const { res, text } = await fetchText(embedUrl, { headers: this.headers, timeout: 12000 });
    if (!res.ok || !text) return [];
    const tokens = [...new Set(text.match(/aHR0c[A-Za-z0-9+/=]+/g) || [])];
    const out = [];
    for (const token of tokens) {
      try {
        const url = Buffer.from(token, 'base64').toString('utf8');
        if (!/^https?:\/\//i.test(url)) continue;
        if (!/googleusercontent|\.mp4|\.m3u8/i.test(url)) continue;
        out.push({ url, quality: qualityFromGoogle(url) });
      } catch { /* ignore */ }
    }
    return out;
    } catch { return []; }
  }

  async streamsFromSlug(slug, type, season, episode) {
    const d = await this.detail(slug);
    if (!d) return [];
    const isMovie = d.type !== 'series';
    const epNum = isMovie ? null : parseInt(episode, 10) || 1;
    const ep = isMovie
      ? d.servers[0].items[0]
      : d.servers[0].items.find((e) => e.num === epNum) || d.servers[0].items[0];
    if (!ep || !ep.url) return [];

    const player = await this.loadPlayer(ep.url);
    if (!player || Number(player.code) !== 200) return [];

    const streams = [];
    const push = (url, quality, audio, isHls) => {
      if (!url) return;
      streams.push(
        this.makeStream({
          movieName: d.name,
          epLabel: isMovie ? 'Full' : `Tập ${epNum}`,
          audio,
          quality,
          url,
          headers: /googleusercontent/i.test(url)
            ? undefined
            : { 'User-Agent': UA, Referer: ep.url }
        })
      );
    };

    for (const [key, raw] of Object.entries(player)) {
      if (!key.startsWith('src_') || !raw || !/^https?:\/\//i.test(String(raw))) continue;
      const url = String(raw).replace(/&amp;/g, '&');
      const audio = audioLabel(d.audio, key);
      if (/\.m3u8(\?|$)/i.test(url)) {
        push(url, 'HD', audio, true);
        continue;
      }
      if (/\.mp4(\?|$)/i.test(url)) {
        push(url, qualityFromText(url, 'HD'), audio);
        continue;
      }
      if (/vk.com|youtube.com|facebook.com/i.test(url)) continue;
      let resolved = [];
      try { resolved = await this.resolveVnn(url); } catch { resolved = []; }
      if (resolved.length) {
        for (const r of resolved) push(r.url, r.quality, audio);
      } else if (/vk\.com|\/video_ext\.php/i.test(url)) {
        // VK không phát trực tiếp được trên TV — bỏ, không đưa external rác
        continue;
      }
    }
    const seen = new Set();
    const unique = streams.filter((s) => { const k = `${s.name}|${s.title}`; if (seen.has(k)) return false; seen.add(k); return true; });
    const rank = (q) => (/4k|2160/i.test(q) ? 5 : /1080/i.test(q) ? 4 : /720/i.test(q) ? 3 : /360/i.test(q) ? 2 : 1);
    return unique.sort((a, b) => rank(b.name) - rank(a.name));
  }

  async listCatalog(kind, extra = {}) {
    const page = Math.max(1, Math.floor((parseInt(extra.skip, 10) || 0) / 20) + 1);
    const wantedSeries = kind === 'bo';
    const { res, text } = await fetchText(`${this.base}/phim-moi-cap-nhap.html?p=${page}`, {
      headers: this.headers,
      timeout: 15000
    });
    if (!res.ok || !text) return [];
    const cheerio = require('cheerio');
    const $ = cheerio.load(text);
    const out = [];
    const seen = new Set();
    $('a[href*="/thong-tin-phim/"]').each((i, el) => {
      const item = this.cardFrom($, el);
      if (!item || seen.has(item.slug)) return;
      if (wantedSeries !== (item.type === 'series')) return;
      seen.add(item.slug);
      out.push(
        this.toMeta(item)
      );
    });
    return out;
  }

  toMeta(it) {
    return {
      id: `${this.prefix}${it.slug}`,
      type: it.type === 'series' ? 'series' : 'movie',
      name: it.name || it.originalName,
      poster: it.poster,
      posterShape: 'poster',
      background: it.poster,
      releaseInfo: [it.audio, it.year].filter(Boolean).join(' · ') || undefined,
      year: it.year || undefined
    };
  }
}

module.exports = { HdvnnProvider };
