// Снимок публичной статистики YouTube-канала -> youtube.json (ветка data).
// Запускается из .github/workflows/youtube-stats.yml. Нужен секрет YT_API_KEY (YouTube Data API v3).
// Использование: node youtube-stats.mjs <путь к youtube.json>
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const KEY = process.env.YT_API_KEY;
const CHANNEL = process.env.YT_CHANNEL_ID;
const OUT = process.argv[2] || 'youtube.json';
const KEEP_FULL_DAYS = 14;          // последние 14 дней — все снимки, старше — один снимок в сутки

if (!KEY) { console.log('::warning::Секрет YT_API_KEY не задан — пропускаю сбор статистики'); process.exit(0); }
if (!CHANNEL) { console.error('YT_CHANNEL_ID не задан'); process.exit(1); }

async function api(path, params) {
  const u = new URL('https://www.googleapis.com/youtube/v3/' + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set('key', KEY);
  const r = await fetch(u);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status} ${j.error?.message || ''}`.trim());   // ключ в текст ошибки не попадает
  return j;
}
const num = x => (x == null ? null : Number(x));
function seconds(iso) {          // PT1M5S -> 65
  const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || '') || [];
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
}

const ch = (await api('channels', { part: 'snippet,statistics,contentDetails', id: CHANNEL })).items?.[0];
if (!ch) throw new Error('канал не найден: ' + CHANNEL);

// все загрузки канала (до 500 последних)
const ids = [];
let pageToken = '';
for (let page = 0; page < 10; page++) {
  const p = await api('playlistItems', { part: 'contentDetails', playlistId: ch.contentDetails.relatedPlaylists.uploads, maxResults: 50, ...(pageToken ? { pageToken } : {}) })
    .catch(e => (e.message.includes('404') ? { items: [] } : Promise.reject(e)));      // у пустого канала плейлиста ещё нет
  ids.push(...(p.items || []).map(i => i.contentDetails.videoId));
  if (!(pageToken = p.nextPageToken)) break;
}
const videos = [];
for (let i = 0; i < ids.length; i += 50) {
  const r = await api('videos', { part: 'snippet,statistics,contentDetails,status', id: ids.slice(i, i + 50).join(',') });
  for (const v of r.items || []) {
    if (v.status?.privacyStatus && v.status.privacyStatus !== 'public') continue;
    videos.push({
      id: v.id,
      title: v.snippet.title,
      published: v.snippet.publishedAt,
      duration: seconds(v.contentDetails.duration),
      thumb: v.snippet.thumbnails?.medium?.url || v.snippet.thumbnails?.default?.url || '',
      views: num(v.statistics.viewCount) ?? 0,
      likes: num(v.statistics.likeCount),
      comments: num(v.statistics.commentCount),
    });
  }
}
videos.sort((a, b) => b.published.localeCompare(a.published));

const now = new Date().toISOString();
const st = ch.statistics;
const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};
const snap = {
  ts: now,
  views: videos.reduce((s, v) => s + v.views, 0),          // сумма по роликам — обновляется быстрее, чем счётчик канала
  channelViews: num(st.viewCount),
  subs: st.hiddenSubscriberCount ? null : num(st.subscriberCount),
  videos: videos.length,
  v: Object.fromEntries(videos.map(v => [v.id, v.views])),
};

// история: свежие снимки целиком, старые — последний снимок каждых суток (UTC)
const cutoff = Date.now() - KEEP_FULL_DAYS * 86400000;
const old = new Map(), recent = [];
for (const s of [...(prev.history || []), snap]) {
  if (new Date(s.ts).getTime() >= cutoff) recent.push(s);
  else old.set(s.ts.slice(0, 10), s);
}
const history = [...old.values(), ...recent].sort((a, b) => a.ts.localeCompare(b.ts));

const out = {
  version: 1,
  updated: now,
  channel: {
    id: ch.id,
    title: ch.snippet.title,
    handle: ch.snippet.customUrl || '',
    thumb: ch.snippet.thumbnails?.medium?.url || ch.snippet.thumbnails?.default?.url || '',
    views: snap.views,
    channelViews: snap.channelViews,
    subs: snap.subs,
    hiddenSubs: !!st.hiddenSubscriberCount,
    videos: snap.videos,
  },
  videos,
  history,
};
writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
console.log(`${ch.snippet.title}: ${snap.views} просмотров, ${snap.subs ?? 'скрыто'} подписчиков, ${videos.length} роликов; снимков в истории: ${history.length}`);
