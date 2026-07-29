/* ---------------------------------------------------------------------------
   桃園四區地圖 — 蘆竹 / 大園 / 桃園 / 中壢
   資料來自 Niantic 的 GraphQL（realityChannelMapObjectsByS2Cells）。
   CORS 全開（ACAO: *），所以瀏覽器可以直接抓，不需要任何後端。
   道館 / 補給站 / 團體戰 / 活動不需要登入；
   但實測 PGO_POWERSPOT（極巨化能量點）需要 Bearer token 才會回傳，
   沒帶 token 時它不會報錯，只是靜默地不出現。token 由使用者自己貼，存在 localStorage。
--------------------------------------------------------------------------- */
'use strict';

const CFG = window.APP_CONFIG;

// 網址參數可以蓋掉 config.js 的設定，方便手機用不同的間隔而不用另外部署一份：
//   ?refresh=300   每 5 分鐘更新（省流量，每次約 3.3 MB）
//   ?refresh=0     完全不自動更新，只在你按「重新整理」時抓
//   ?basemap=dark  指定底圖
(function applyUrlParams() {
  const p = new URLSearchParams(location.search);
  if (p.has('refresh')) {
    const v = parseInt(p.get('refresh'), 10);
    if (!isNaN(v) && v >= 0) CFG.refreshSec = v;
  }
  if (p.has('powerrefresh')) {
    const v = parseInt(p.get('powerrefresh'), 10);
    if (!isNaN(v) && v >= 0) CFG.powerRefreshSec = v;
  }
  if (p.has('basemap')) CFG.basemap = p.get('basemap');
})();

// 窄螢幕判斷。斷點和 style.css 一致；效能取捨（預設關補給站、視野緩衝大小）都看它。
// 定義在最上面是因為 render() 要用，而 render() 比下面的 UI 程式碼早很多。
const mqMobile = window.matchMedia('(max-width: 820px)');

const TEAM = {
  VALOR:    { c: '#ef4444', n: '紅隊' },
  MYSTIC:   { c: '#3b82f6', n: '藍隊' },
  INSTINCT: { c: '#eab308', n: '黃隊' },
  NEUTRAL:  { c: '#94a3b8', n: '無主' }
};
// 極致超級團體戰（isMegaEnhancedEligible）—— 跟極巨化 / Power Spot 無關，用不同顏色區分
const C_MEGA = '#ec4899', C_STOP = '#0284c7', C_POWER = '#9333ea',
      C_EVENT = '#ea580c';

/* 團體戰星級。實測 rating 的值：
     1/3/5 = 一般星級、6 = 超級(Mega)、11/13/15 = 暗影（減 10 就是星級）
   對應到的 boss：1=Grimer/Pikachu、3=Gengar、5=Solgaleo、6=Mega Salamence、
                 11=Mankey/Phanpy、13=Graveler/Scyther、15=Palkia */
function raidTier(rating) {
  const r = parseInt(rating, 10);
  if (isNaN(r)) return { t: String(rating || '團體戰'), c: '#16a34a', shadow: false };
  if (r === 6) return { t: '超級', c: '#a855f7', shadow: false };
  if (r >= 10) {
    const star = r - 10;
    return { t: `暗影 ${star} 星`, c: '#7e22ce', shadow: true };
  }
  const COL = { 1: '#ec4899', 2: '#ec4899', 3: '#f59e0b', 4: '#f59e0b', 5: '#4f46e5' };
  return { t: `${r} 星`, c: COL[r] || '#16a34a', shadow: false };
}

/* 未孵化的蛋圖示（img/ 底下，由 _make_egg_icons.py 從 APK 素材產生）。
   暗影版是一般蛋套上紫色暗影光暈，星級靠蛋本身的顏色區分。 */
const EGG_IMG = {
  1: 'egg_1.png',  2: 'egg_1.png',          // 1 星（粉紅）
  3: 'egg_3.png',  4: 'egg_3.png',          // 3 星（黃）
  5: 'egg_5.png',                           // 5 星（藍紫）
  6: 'egg_mega.png',                        // 超級
  11: 'egg_s1.png', 12: 'egg_s1.png',       // 暗影 1 星
  13: 'egg_s3.png', 14: 'egg_s3.png',       // 暗影 3 星
  15: 'egg_s5.png'                          // 暗影 5 星
};
function eggImg(rating) {
  return EGG_IMG[parseInt(rating, 10)] || null;
}

/* 把 rating 收斂成側欄篩選用的「級別代號」。
   rating 實測是 1~6 和 11~15，但同一個星級會有相鄰的兩個值
   （例如 1 星有 1 和 2），所以這裡把它們併成同一組，
   對應 index.html 裡 .tier 那七個核取方塊的 value。 */
function tierKey(rating) {
  const r = parseInt(rating, 10);
  if (isNaN(r)) return 'other';
  if (r === 6) return 'mega';
  if (r >= 10) { const s = r - 10; return 's' + (s <= 2 ? 1 : s <= 4 ? 3 : 5); }
  return String(r <= 2 ? 1 : r <= 4 ? 3 : 5);
}

// 蛋 60 分鐘 + 開戰 45 分鐘 = 105 分鐘（實測所有團體戰的 start~end 都剛好 105 分）
const RAID_EGG_MIN = 60, RAID_OPEN_MIN = 45;

const BASEMAPS = {
  voyager: { n: '亮色',
    url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
    o: { subdomains: 'abcd', maxZoom: 20,
         attribution: '&copy; OpenStreetMap &copy; CARTO ｜ 資料 &copy; Niantic' } },
  light: { n: '極簡',
    url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    o: { subdomains: 'abcd', maxZoom: 20,
         attribution: '&copy; OpenStreetMap &copy; CARTO ｜ 資料 &copy; Niantic' } },
  dark: { n: '暗色',
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    o: { subdomains: 'abcd', maxZoom: 20,
         attribution: '&copy; OpenStreetMap &copy; CARTO ｜ 資料 &copy; Niantic' } },
  satellite: { n: '衛星',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    o: { maxZoom: 19, attribution: '&copy; Esri ｜ 資料 &copy; Niantic' } }
};

// 兩趟請求分開：公開那趟不帶 token，能量點那趟才帶。
// 這樣一天下來只有很少的請求會暴露帳號。
// （query 內容跟 local/fetch_local.py、worker/src/index.js 對應）
const DROP_PUBLIC = ['PGO_GYM', 'CA_EVENT', 'PGO_POKESTOP'];
const DROP_POWER = ['PGO_POWERSPOT'];

const QUERY_PUBLIC = `query PogoMap($i: RealityChannelMapObjectsByS2CellsInput!) {
  realityChannelMapObjectsByS2Cells(input: $i) {
    mapObjectsByS2CellsAndTypes { mapObjectsByType { type mapObjects {
      id
      pgoGym { location{latitude longitude} name imageUrl team isMegaEnhancedEligible
               raid { bossName bossImageUrl startTime endTime rating } }
      pgoPokestop { location{latitude longitude} name description imageUrl }
      event { id name coverPhotoUrl eventType address clubId location }
    } } } } }`;

// 能量點那趟只問能量點，payload 小很多
const QUERY_POWER = `query PogoPower($i: RealityChannelMapObjectsByS2CellsInput!) {
  realityChannelMapObjectsByS2Cells(input: $i) {
    mapObjectsByS2CellsAndTypes { mapObjectsByType { type mapObjects {
      id
      pgoPowerspot { location{latitude longitude} name
                     maxBattle{ bossName bossImageUrl rating openTime }
                     overrideMaxBattle{ bossName bossImageUrl rating openTime }
                     overrideBattleStartMinutes overrideBattleEndMinutes }
    } } } } }`;

/* ------------------------------------------------- 經緯度 -> S2 cell --- */
// 拿到能量點後要反推它在哪一格，之後就只查那些格子（不用每次全區掃）
const _POS_TO_IJ = [[0, 1, 3, 2], [0, 2, 3, 1], [3, 2, 0, 1], [3, 1, 0, 2]];
const _POS_TO_ORI = [1, 0, 0, 3];
const _IJ_TO_POS = [[], [], [], []];
for (let o = 0; o < 4; o++) for (let q = 0; q < 4; q++) _IJ_TO_POS[o][_POS_TO_IJ[o][q]] = q;

function latLngToCellId(lat, lng, level) {
  const la = lat * Math.PI / 180, lo = lng * Math.PI / 180;
  const x = Math.cos(la) * Math.cos(lo), y = Math.cos(la) * Math.sin(lo), z = Math.sin(la);
  const abs = [Math.abs(x), Math.abs(y), Math.abs(z)];
  let face = abs.indexOf(Math.max(...abs));
  if ([x, y, z][face] < 0) face += 3;
  let u, v;
  switch (face) {
    case 0: u = y / x; v = z / x; break;
    case 1: u = -x / y; v = z / y; break;
    case 2: u = -x / z; v = -y / z; break;
    case 3: u = z / x; v = y / x; break;
    case 4: u = z / y; v = -x / y; break;
    default: u = -y / z; v = -x / z;
  }
  const st = w => w >= 0 ? 0.5 * Math.sqrt(1 + 3 * w) : 1 - 0.5 * Math.sqrt(1 - 3 * w);
  const n = 1 << level;
  let i = Math.min(n - 1, Math.max(0, Math.floor(st(u) * n)));
  let j = Math.min(n - 1, Math.max(0, Math.floor(st(v) * n)));
  let ori = face & 1, bits = 0n;
  for (let k = level - 1; k >= 0; k--) {
    const ij = (((i >> k) & 1) << 1) | ((j >> k) & 1);
    const pos = _IJ_TO_POS[ori][ij];
    bits = (bits << 2n) | BigInt(pos);
    ori ^= _POS_TO_ORI[pos];
  }
  const tz = BigInt(2 * (30 - level));
  return ((BigInt(face) << 61n) | (bits << (tz + 1n)) | (1n << tz)).toString();
}

/* ------------------------------------------------------------- token --- */
// 實測：PGO_POWERSPOT（極巨化能量點）需要登入才會回傳，其他型別不用。
// token 只存在瀏覽器的 localStorage，不會進 repo、不會傳給第三方。
const TOKEN_KEY = 'niantic_token';
function getToken() {
  try { return (localStorage.getItem(TOKEN_KEY) || '').trim(); } catch (e) { return ''; }
}
function tokenExp(t) {
  try {
    const p = JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return p.exp ? p.exp * 1000 : null;
  } catch (e) { return null; }
}
/* --------------------------------------------- Google Maps API Key --- */
// key 由 GitHub Actions 在部署時從 Secret 注入（附加一行到 config.js），
// 原始碼和 repo 裡都沒有它。本機開發時是空的，搜尋會自動退回 OpenStreetMap。
// window.MAPS_API_KEY 是為了跟 toolbox 的注入方式相容。
function getMapsKey() {
  return ((window.MAPS_API_KEY || CFG.mapsApiKey || '') + '').trim();
}

function authHeader() {
  const t = getToken();
  return t ? { Authorization: 'Bearer ' + t } : {};
}
function updateTokenUI() {
  const t = getToken(), el = $('#tokenState');
  if (!t) {
    el.textContent = '未設定 — 能量點（極巨化）不會顯示';
    el.className = 'tokstate warn';
    return;
  }
  const exp = tokenExp(t);
  if (!exp) { el.textContent = '已設定（無法讀取有效期）'; el.className = 'tokstate ok'; return; }
  const left = exp - Date.now();
  if (left <= 0) {
    el.textContent = '已過期，請重新取得'; el.className = 'tokstate warn';
  } else {
    const d = Math.floor(left / 86400000), h = Math.floor(left % 86400000 / 3600000);
    el.textContent = `已設定，${d} 天 ${h} 小時後過期（${new Date(exp).toLocaleString('zh-TW')}）`;
    el.className = 'tokstate ' + (d < 1 ? 'warn' : 'ok');
  }
}

const state = {
  pub: [],            // 不帶 token 抓到的（道館/補給站/團體戰/活動）
  power: [],          // 帶 token 抓到的（能量點）
  items: [],          // 上面兩者合併，render 用
  cells: [],
  powerCells: [],     // 已知有能量點的格子，之後只查這些
  powerRound: 0,      // 用來決定第幾輪要做全區完整掃描
  lastUpdate: 0, lastPowerUpdate: 0,
  loading: false, loadingPower: false,
  timer: null, powerTimer: null, renderPending: null,

  // ---- 只有 Worker 模式會用到 ----
  // 道館的名稱/座標/圖片和補給站都是靜態的，沒必要每 2 分鐘重抓，
  // 所以留在記憶體裡，只有過期才重新下載。
  wGyms: null, wGymsAt: 0,      // Worker /gyms（每天更新一次）
  wStops: null, wStopsAt: 0,    // Worker /stops（幾個月才變一次）
  since0: 0                     // 監控起點；比它早的佔領時間不可考
};

/* -------------------------------------------- 帶 token 的請求用量統計 --- */
const AUTH_KEY = 'auth_req_count';
function todayKey() { return new Date().toISOString().slice(0, 10); }
function readAuthCount() {
  try {
    const o = JSON.parse(localStorage.getItem(AUTH_KEY) || '{}');
    return o.d === todayKey() ? (o.n | 0) : 0;
  } catch (e) { return 0; }
}
function bumpAuthCount() {
  try {
    localStorage.setItem(AUTH_KEY, JSON.stringify({ d: todayKey(), n: readAuthCount() + 1 }));
  } catch (e) { /* ignore */ }
  updateAuthUI();
}
function updateAuthUI() {
  const el = document.querySelector('#authCount');
  if (el) el.textContent = readAuthCount();
}

/* ---------------------------------------------------------------- 工具 --- */
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function log(msg) {
  const el = $('#log');
  el.textContent = new Date().toLocaleTimeString('zh-TW', { hour12: false }) + ' ' + msg
    + '\n' + el.textContent;
  if (el.textContent.length > 1500) el.textContent = el.textContent.slice(0, 1500);
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

function setStatus(msg) { $('#mapStatus').textContent = msg || ''; }

function parseTime(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
  if (/^\d+$/.test(v)) { const n = +v; return n > 1e12 ? n : n * 1000; }
  const t = Date.parse(v);
  return isNaN(t) ? null : t;
}

const hhmm = ms => new Date(ms).toLocaleTimeString('zh-TW',
  { hour: '2-digit', minute: '2-digit', hour12: false });

function utcMinutesToLocal(min) {
  if (min == null) return null;
  const n = new Date();
  return hhmm(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()) + min * 60000);
}

function countdown(ms) {
  const s = Math.max(0, Math.floor((ms - Date.now()) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/* ------------------------------------------------------------ 抓資料 --- */
async function gqlBatch(cells, query, dropTypes, withAuth) {
  if (withAuth) bumpAuthCount();
  const res = await fetch(CFG.api, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Client-Info': '{"Game":"CAMPFIRE","Language":"zh-TW","Platform":"web_standalone","CampfireVersion":"2026.30.0"}',
      // ★ 只有能量點那趟才帶 token，其他請求完全匿名
      ...(withAuth ? authHeader() : {})
    },
    body: JSON.stringify({
      query,
      variables: {
        i: {
          realityChannelId: CFG.realityChannelId,
          s2CellLevel: CFG.s2CellLevel,
          sourcesByS2Cells: cells.map(c => ({
            s2CellId: c, sources: [{ name: 'PGO', dropTypes }]
          }))
        }
      }
    })
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const js = await res.json();
  if (js.errors) throw new Error(js.errors.map(e => e.message).join('; ').slice(0, 200));
  const out = [];
  for (const cell of js.data.realityChannelMapObjectsByS2Cells.mapObjectsByS2CellsAndTypes) {
    for (const grp of cell.mapObjectsByType) {
      for (const o of grp.mapObjects) { o.type = grp.type; out.push(o); }
    }
  }
  return out;
}

function normalize(raw) {
  const out = [];
  for (const o of raw) {
    if (o.type === 'PGO_GYM' && o.pgoGym) {
      const g = o.pgoGym;
      const it = {
        k: 'gym', id: o.id, lat: g.location.latitude, lng: g.location.longitude,
        n: g.name || '(無名稱道館)', img: g.imageUrl || '',
        team: TEAM[g.team] ? g.team : 'NEUTRAL',
        // 極致超級團體戰資格（不是超級進化，也不是極巨化）
        megaRaid: !!g.isMegaEnhancedEligible
      };
      if (g.raid) {
        const end = parseTime(g.raid.endTime);
        const boss = g.raid.bossName || '';
        it.raid = {
          boss, img: g.raid.bossImageUrl || '',
          start: parseTime(g.raid.startTime), end, rating: g.raid.rating,
          // bossName 空的 = 還沒孵化。孵化時間 = 結束時間往前推 45 分鐘
          egg: !boss,
          hatch: end ? end - RAID_OPEN_MIN * 60000 : null
        };
      }
      out.push(it);
    } else if (o.type === 'PGO_POKESTOP' && o.pgoPokestop) {
      const s = o.pgoPokestop;
      out.push({
        k: 'stop', id: o.id, lat: s.location.latitude, lng: s.location.longitude,
        n: s.name || '(無名稱補給站)', img: s.imageUrl || '', d: s.description || ''
      });
    } else if (o.type === 'PGO_POWERSPOT' && o.pgoPowerspot) {
      const p = o.pgoPowerspot;
      const mb = p.overrideMaxBattle || p.maxBattle || {};
      out.push({
        k: 'power', id: o.id, lat: p.location.latitude, lng: p.location.longitude,
        n: p.name || '(無名稱能量點)', boss: mb.bossName || '', img: mb.bossImageUrl || '',
        rating: mb.rating, open: parseTime(mb.openTime),
        s: p.overrideBattleStartMinutes, e: p.overrideBattleEndMinutes
      });
        } else if (o.type === 'CA_EVENT' && o.event) {
      const e = o.event;
      const loc = (e.location && typeof e.location === 'object') ? e.location : null;
      out.push({
        k: 'event', id: o.id, lat: loc ? loc.latitude : null, lng: loc ? loc.longitude : null,
        n: e.name || '(未命名活動)', img: e.coverPhotoUrl || '',
        addr: e.address || '', etype: e.eventType
      });
    }
  }
  return out;
}

async function fetchDirect(cells, query, dropTypes, withAuth, onProgress) {
  const chunks = [];
  for (let i = 0; i < cells.length; i += CFG.batchSize)
    chunks.push(cells.slice(i, i + CFG.batchSize));
  if (!chunks.length) return [];

  const byId = new Map();
  let done = 0, failed = 0, next = 0;

  async function worker() {
    while (next < chunks.length) {
      const my = next++;
      try {
        for (const it of normalize(await gqlBatch(chunks[my], query, dropTypes, withAuth)))
          byId.set(it.id, it);
      } catch (err) {
        failed++; log(`batch ${my + 1} 失敗: ${err.message}`);
      }
      if (onProgress) onProgress(++done, chunks.length, byId);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CFG.parallel, chunks.length) }, worker));
  if (failed === chunks.length) throw new Error('所有批次都失敗了');
  if (failed) toast(`有 ${failed} 個批次失敗，資料可能不完整`);
  return [...byId.values()];
}

/* ---- Worker 模式 --------------------------------------------------------
   Worker 把資料切成三塊，各自用不同頻率更新，這裡負責在瀏覽器合併起來：

     /state   每 2 分鐘   道館的隊伍與團體戰   約 70 KB 純文字
     /gyms    每天一次    道館名稱/座標/圖片   約 346 KB
     /stops   幾個月一次  補給站與活動         約 2.4 MB

   會這樣切，是因為 Cloudflare 免費方案每次呼叫只有 10ms CPU。
   量過：把補給站那 3.25 MB 一起處理要 18.6ms，一定爆；只處理道館的動態
   欄位是 2.46ms。所以「每 2 分鐘只下載會變的東西」不只是省流量，
   而是這整套能不能跑在免費方案上的前提。
------------------------------------------------------------------------- */
const TEAM_FROM_CODE = { V: 'VALOR', M: 'MYSTIC', I: 'INSTINCT', N: 'NEUTRAL' };

// CFG.source 舊版是指向 /data，新版只要基底網址，兩種寫法都吃
function workerBase() {
  return String(CFG.source).replace(/\/+$/, '').replace(/\/data$/, '');
}

async function getJson(url) {
  const res = await fetch(url);       // 讓瀏覽器照 Cache-Control 快取
  if (!res.ok) throw new Error(url.split('/').pop() + ' HTTP ' + res.status);
  return res.json();
}

async function fetchFromWorker() {
  const base = workerBase();
  const now = Date.now();

  if (!state.wGyms || now - state.wGymsAt > 30 * 60000) {
    state.wGyms = (await getJson(base + '/gyms')).items || [];
    state.wGymsAt = now;
  }
  if (!state.wStops || now - state.wStopsAt > 6 * 3600000) {
    try {
      state.wStops = (await getJson(base + '/stops')).items || [];
      state.wStopsAt = now;
    } catch (err) {
      // 補給站是選用的（要自己跑 local/make_static.py 上傳），沒有也能看道館
      state.wStops = state.wStops || [];
      log('補給站靜態檔還沒上傳到 R2：' + err.message);
    }
  }

  const res = await fetch(base + '/state', { cache: 'no-store' });
  if (!res.ok) throw new Error('state HTTP ' + res.status);
  const text = await res.text();

  // 第一行是 JSON 表頭，其餘每行一個道館：id|隊伍|頭目|開始ms|結束ms|星等
  const nl = text.indexOf('\n');
  const head = JSON.parse(text.slice(0, nl < 0 ? text.length : nl));
  state.lastUpdate = head.t || Date.now();
  const bosses = head.bosses || {};     // 頭目圖片對照表，只有十來種，不必每行重複

  // since0 = 監控起點。比它早的佔領時間是不可考的，只能說「至少多久」。
  state.since0 = head.since0 || 0;

  const dyn = new Map();
  const lines = text.split('\n');
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split('|');
    if (p.length >= 6) dyn.set(p[0], p);
  }

  const out = [];
  for (const g of state.wGyms) {
    const it = {
      k: 'gym', id: g.id, lat: g.lat, lng: g.lng, n: g.n, img: g.img,
      team: 'NEUTRAL', megaRaid: !!g.megaRaid
    };
    const p = dyn.get(g.id);
    if (p) {
      it.team = TEAM_FROM_CODE[p[1]] || 'NEUTRAL';
      if (p[6]) it.since = +p[6] || null;   // 這個隊伍是什麼時候佔下來的
      if (p[4]) {                       // 有結束時間 = 有團體戰
        const boss = p[2] || '', end = +p[4] || null;
        it.raid = {
          boss, img: bosses[boss] || '',
          start: +p[3] || null, end, rating: p[5] || '',
          // bossName 空的 = 還沒孵化。孵化時間 = 結束時間往前推 45 分鐘
          egg: !boss, hatch: end ? end - RAID_OPEN_MIN * 60000 : null
        };
      }
    }
    out.push(it);
  }
  // 上一次每日靜態更新之後才出現的新道館會漏掉，等隔天那輪補上
  return out.concat(state.wStops || []);
}

function mergeItems() {
  state.items = state.pub.concat(state.power);
}

// ---- 第一趟：公開資料，不帶 token ----
async function refreshPublic() {
  if (state.loading) return;
  state.loading = true;
  $('#btnRefresh').disabled = true;
  const t0 = performance.now();
  try {
    if (CFG.source === 'direct') {
      $('#stats').innerHTML = '抓取中… <b>0%</b>';
      const items = await fetchDirect(state.cells, QUERY_PUBLIC, DROP_PUBLIC, false,
        (done, total, byId) => {
          $('#stats').innerHTML =
            `抓取中… <b>${Math.round(done / total * 100)}%</b> · ${byId.size.toLocaleString()} 個物件`;
          state.pub = [...byId.values()];
          mergeItems(); render();
        });
      state.pub = items;
      state.lastUpdate = Date.now();
    } else {
      $('#stats').textContent = '從 Worker 讀取中…';
      // Worker 只負責道館和補給站；能量點仍然由瀏覽器自己帶 token 去抓
      // （那份需要登入，而且 Worker 免費方案的 CPU 也不夠處理）
      state.pub = await fetchFromWorker();
    }
    mergeItems(); render();
    log(`一般資料更新完成 ${((performance.now() - t0) / 1000).toFixed(1)}s，${state.pub.length} 個物件`);
  } catch (err) {
    toast('更新失敗：' + err.message);
    log('更新失敗: ' + err.message);
    $('#stats').textContent = '更新失敗';
  } finally {
    state.loading = false;
    $('#btnRefresh').disabled = false;
  }
}

// ---- 第二趟：能量點，會帶 token ----
// 只在「有 token」而且「能量點圖層有打開」時才跑，而且優先只查已知有能量點的格子。
function powerLayerOn() {
  const el = document.querySelector('.layer[value="power"]');
  return !el || el.checked;
}

async function refreshPower(force) {
  // Worker 模式下也照跑：能量點需要 token，那是瀏覽器自己的事，
  // 而且 Worker 免費方案的 10ms CPU 不夠再多處理一份資料。
  if (state.loadingPower) return;
  if (!getToken()) return;
  if (!force && !powerLayerOn()) return;

  // 每 powerFullSweepEvery 輪做一次全區掃描來發現新位置，其餘只查已知格子
  const needFull = force || !state.powerCells.length ||
                   state.powerRound % CFG.powerFullSweepEvery === 0;
  const cells = needFull ? state.cells : state.powerCells;
  state.powerRound++;

  state.loadingPower = true;
  try {
    const items = await fetchDirect(cells, QUERY_POWER, DROP_POWER, true, null);
    state.power = items;
    state.lastPowerUpdate = Date.now();

    // 記住哪些格子有能量點（只累加、不清空；時段外查無不代表那格沒有）
    if (items.length) {
      const known = new Set(state.powerCells);
      for (const it of items) known.add(latLngToCellId(it.lat, it.lng, CFG.s2CellLevel));
      state.powerCells = [...known];
      try { localStorage.setItem('power_cells', JSON.stringify(state.powerCells)); }
      catch (e) { /* ignore */ }
    }
    mergeItems(); render();
    log(`能量點更新（${needFull ? '全區' : '已知 ' + cells.length + ' 格'}）：` +
        `${items.length} 個，今天帶 token ${readAuthCount()} 次`);
  } catch (err) {
    log('能量點更新失敗: ' + err.message);
  } finally {
    state.loadingPower = false;
  }
}

async function refresh() {
  await refreshPublic();
  refreshPower(false);
}

/* -------------------------------------------------------------- 地圖 --- */
const map = L.map('map', { zoomControl: true, preferCanvas: true })
  .setView(CFG.center, CFG.zoom);

// ★ 分層：補給站一定要在道館下面，否則它的 canvas 會蓋住道館、讓道館點不到。
// 純裝飾的圖層一律放在低層，而且關掉 pointer-events。
// preferCanvas 模式下 L.circle / L.polygon 會產生一張「覆蓋整個視窗」的 canvas，
// 就算圖形本身 interactive:false，那張 canvas 元素還是會吃掉點擊 ——
// 小人的 40/80 公尺範圍圈原本放在最上層，就是這樣讓整張地圖都點不到的。
map.createPane('pGrid');   map.getPane('pGrid').style.zIndex = 395;
map.createPane('pBorder'); map.getPane('pBorder').style.zIndex = 400;
map.createPane('pRings');  map.getPane('pRings').style.zIndex = 405;
for (const n of ['pGrid', 'pBorder', 'pRings']) map.getPane(n).style.pointerEvents = 'none';
map.createPane('pStops');  map.getPane('pStops').style.zIndex = 420;
map.createPane('pGyms');   map.getPane('pGyms').style.zIndex = 460;
map.createPane('pTop');    map.getPane('pTop').style.zIndex = 480;
map.createPane('pPerson'); map.getPane('pPerson').style.zIndex = 490;

let baseLayer = null;
function setBasemap(key) {
  const b = BASEMAPS[key] || BASEMAPS.voyager;
  if (baseLayer) map.removeLayer(baseLayer);
  baseLayer = L.tileLayer(b.url, b.o).addTo(map);
  document.body.classList.toggle('lightmap', key === 'voyager' || key === 'light');
  for (const el of document.querySelectorAll('.bm'))
    el.classList.toggle('on', el.dataset.bm === key);
  try { localStorage.setItem('basemap', key); } catch (e) { /* 無痕模式 */ }
}

// tolerance 是「點擊容錯圈」的像素數，開大一點比較好點
const rStop = L.canvas({ pane: 'pStops', padding: .3, tolerance: 12 });

const layers = {
  stop:   L.layerGroup().addTo(map),
  gym:    L.layerGroup().addTo(map),
  power:  L.layerGroup().addTo(map),
  event:  L.layerGroup().addTo(map),
  border: L.layerGroup().addTo(map),
  grid:   L.layerGroup().addTo(map)
};

fetch('data/districts.geojson').then(r => r.json()).then(gj => {
  L.geoJSON(gj, {
    pane: 'pBorder',
    style: { color: '#16a34a', weight: 2, opacity: .75, dashArray: '6,5', fill: false,
             interactive: false }
  }).addTo(layers.border);
}).catch(() => log('區界檔載入失敗（不影響資料）'));

/* ------------------------------------------------------------ 圖示 --- */
function gymDivIcon(it) {
  let html = `<img class="gi" src="img/gym_${it.team}.png" alt="">`;
  if (it.raid) {
    const tier = raidTier(it.raid.rating);
    html += `<i class="ring" style="border-color:${tier.c}"></i>`;
    if (!it.raid.egg && it.raid.img) {
      html += `<img class="gb" src="${esc(it.raid.img)}" alt=""
                    style="border-color:${tier.c}">`;
    } else {
      // 還是蛋：直接畫蛋的圖（暗影版自帶紫色光暈）
      const f = eggImg(it.raid.rating);
      if (f) {
        html += `<img class="gegg" src="img/${f}" alt="" title="${esc(tier.t)}">`;
      } else {
        // rating 是沒看過的值 -> 退回舊的色塊，至少還看得出有蛋
        const n = parseInt(it.raid.rating, 10);
        const label = isNaN(n) ? '?' : (n >= 10 ? n - 10 : n);
        html += `<i class="gegg-dot" style="background:${tier.c}">${label}</i>`;
      }
    }
  }
  if (it.megaRaid) html += `<i class="mega" title="極致超級團體戰"></i>`;
  // iconSize 開到 58x58（圖示本身 36x38，四周多出來的是透明的可點擊範圍）。
  // iconAnchor 的 y 對準道館圖示底部的尖端（8 + 38 = 46）。
  return L.divIcon({
    className: 'gm' + (it.raid ? ' has-raid' : ''),
    html, iconSize: [58, 58], iconAnchor: [29, 46], popupAnchor: [0, -42]
  });
}

const STOP_ICON = L.icon({
  iconUrl: 'img/stop.png', iconSize: [17, 25], iconAnchor: [8, 24], popupAnchor: [0, -22],
  className: 'stopicon'
});

/* ------------------------------------------------------------ popup --- */
// ★ 一律用「地圖層級」的 popup，不綁在 marker 上。
//   綁在 marker 上的話，popup 開啟時 autoPan 會移動地圖 -> 觸發重繪 ->
//   marker 被移除 -> popup 跟著消失。這就是「超出畫面就馬上收起來」的原因。
// ★ keepInView 一定要 false。它會註冊 moveend -> _adjustPan，
//   等於「只要你滑動地圖，就把地圖拉回來讓 popup 保持在畫面內」——
//   手機上資訊視窗比較高時，想滑開看下半部會一直被彈回原位。
//   autoPan 保留：那只在「開啟」和「內容變高」時作用一次，是想要的行為。
const sharedPopup = L.popup({
  autoPan: true, autoPanPadding: [24, 24], keepInView: false,
  maxWidth: 280, closeButton: true
});

function openPopup(latlng, html) {
  sharedPopup.setLatLng(latlng).setContent(html).openOn(map);
  // ★ 不能靠 map 的 'popupopen' 事件來接手：整個網站共用同一個 popup 物件，
  //   而 Leaflet 的 Map.addLayer 對「已經加過的 layer」會直接 return，
  //   所以只有「從關閉變成開啟」那一次會觸發事件，點第二個道館就沒了。
  //   改成每次都明確呼叫，analysis.js 靠這個把當天的顏色變化填進 .gymana。
  if (typeof window.onPopupOpened === 'function') window.onPopupOpened(sharedPopup);
}

// 照片載入失敗就把整個 <img> 藏起來
function photoTag(url) {
  return `<img class="photo" src="${esc(url)}" loading="lazy" alt=""
               onerror="this.style.display='none'">`;
}

function coordFoot(it) {
  return `<div class="coord">${it.lat.toFixed(6)}, ${it.lng.toFixed(6)}</div>
    <a class="nav" target="_blank" rel="noopener"
       href="https://www.google.com/maps/dir/?api=1&destination=${it.lat},${it.lng}">在 Google 地圖開啟 ↗</a>`;
}

// 「3 小時 12 分」這種人看得懂的長度
function dur(ms) {
  const m = Math.max(0, Math.floor(ms / 60000));
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  if (d) return `${d} 天 ${h} 小時`;
  if (h) return `${h} 小時 ${mm} 分`;
  return `${mm} 分`;
}

// 目前這個隊伍佔領多久了。監控開始前就已經是這個顏色的，只能說「至少」。
function holdText(it) {
  if (!it.since) return '';
  const ago = dur(Date.now() - it.since);
  // 佔領時間早於或等於監控起點 = 我們沒看過它易主，真正的時間只會更長
  return (state.since0 && it.since <= state.since0 + 60000)
    ? `已佔領至少 ${ago}` : `已佔領 ${ago}`;
}

function popupGym(it) {
  const t = TEAM[it.team] || TEAM.NEUTRAL;
  let h = `<div class="pop"><h3>${esc(it.n)}</h3>`;
  if (it.img) h += photoTag(it.img);
  h += `<div class="meta"><span class="tag" style="background:${t.c}">${t.n}</span>`;
  if (it.megaRaid) h += ` <span class="tag" style="background:${C_MEGA}">極致超級團體戰</span>`;
  h += `</div>`;
  const hold = holdText(it);
  if (hold) h += `<div class="hold">${t.n}${hold}<span class="since">（${hhmm(it.since)} 起）</span></div>`;
  // 當天的顏色變化時間軸。內容由 analysis.js 在 popup 開啟時填進去
  // （它要先去 Worker 拿當天的變化紀錄，這裡是同步產生 HTML 的，來不及等）。
  // 預設文字不是裝飾：如果 analysis.js 沒載到（例如瀏覽器吃到舊快取），
  // 這行會一直留著，一眼就知道是哪裡壞了，而不是看到一片空白。
  if (CFG.source !== 'direct')
    h += `<div class="gymana" data-id="${esc(it.id)}">
            <div class="gahead">分析尚未載入（analysis.js 沒有接手）</div></div>`;
  if (it.raid) {
    const r = it.raid, tier = raidTier(r.rating);
    h += `<div class="raid">`;
    const ef = r.egg ? eggImg(r.rating) : null;
    if (!r.egg && r.img) h += `<img src="${esc(r.img)}" alt="" onerror="this.style.display='none'">`;
    else if (ef) h += `<img class="eggbig" src="img/${ef}" alt="">`;
    else h += `<div class="eggbig-dot" style="background:${tier.c}">蛋</div>`;
    h += `<div><div class="n">${esc(r.egg ? '未孵化' : r.boss)}</div>`;
    h += `<div class="meta"><span class="tag" style="background:${tier.c}">${tier.t}</span></div>`;
    if (r.egg && r.hatch) {
      h += `<div class="c" data-cd="${r.hatch}">${hhmm(r.hatch)} 孵化，還有 ${countdown(r.hatch)}</div>`;
    } else if (r.end) {
      h += `<div class="c" data-cd="${r.end}">${hhmm(r.end)} 結束，剩 ${countdown(r.end)}</div>`;
    }
    h += `</div></div>`;
  }
  return h + coordFoot(it) + `</div>`;
}

function popupStop(it) {
  let h = `<div class="pop"><h3>${esc(it.n)}</h3>`;
  if (it.img) h += photoTag(it.img);
  if (it.d) h += `<div class="meta">${esc(it.d)}</div>`;
  return h + coordFoot(it) + `</div>`;
}

function popupPower(it) {
  const win = (it.s != null && it.e != null)
    ? `${utcMinutesToLocal(it.s)}–${utcMinutesToLocal(it.e)}` : '';
  let h = `<div class="pop"><h3>${esc(it.n)}</h3>`;
  h += `<div class="meta"><span class="tag" style="background:${C_POWER}">能量點（極巨化）</span></div>`;
  if (it.boss) {
    h += `<div class="raid">`;
    if (it.img) h += `<img src="${esc(it.img)}" alt="" onerror="this.style.display='none'">`;
    h += `<div><div class="n">${esc(it.boss)}</div>
          <div class="meta">${esc(it.rating || '')}</div>`;
    if (win) h += `<div class="c">開放 ${win}</div>`;
    h += `</div></div>`;
  }
  return h + coordFoot(it) + `</div>`;
}

function popupEvent(it) {
  let h = `<div class="pop"><h3>${esc(it.n)}</h3>`;
  if (it.img) h += photoTag(it.img);
  h += `<div class="meta"><span class="tag" style="background:${C_EVENT}">Campfire 活動</span></div>`;
  if (it.addr) h += `<div class="meta">${esc(it.addr)}</div>`;
  return h + (it.lat != null ? coordFoot(it) : '') + `</div>`;
}

const POPUP = { gym: popupGym, stop: popupStop, power: popupPower, event: popupEvent };
const popupFor = it => POPUP[it.k](it);

/* -------------------------------------------------------------- 繪製 --- */
// ★ 增量更新：只加新的、只刪走掉的，已經在畫面上的 marker 原封不動。
//   這樣重繪不會把使用者正在看的東西砍掉，效能也好很多。
const drawn = { gym: new Map(), stop: new Map(), power: new Map(), event: new Map() };

function syncLayer(kind, wanted, makeMarker, sigOf) {
  const cur = drawn[kind], lay = layers[kind];
  for (const [id, rec] of cur) {
    const it = wanted.get(id);
    if (!it || sigOf(it) !== rec.sig) { lay.removeLayer(rec.m); cur.delete(id); }
  }
  for (const [id, it] of wanted) {
    if (cur.has(id)) continue;
    const m = makeMarker(it);
    m.on('click', () => openPopup([it.lat, it.lng], popupFor(it)));
    lay.addLayer(m);
    cur.set(id, { m, sig: sigOf(it) });
  }
}

function filters() {
  const on = sel => new Set([...document.querySelectorAll(sel + ':checked')].map(e => e.value));
  return {
    layer: on('.layer'), team: on('.team'), tier: on('.tier'),
    onlyRaid: $('#onlyRaid').checked, onlyMega: $('#onlyMega').checked,
    onlyEgg: $('#onlyEgg').checked
  };
}

/* 側欄的清單只跟「資料 + 篩選」有關，跟地圖看哪裡無關。
   拖曳/縮放時重建整份團體戰清單（每列都有圖）是白做工，手機上很有感，
   所以分成兩種重繪：移動地圖只更新標記，資料或篩選變了才連側欄一起更新。 */
let panelDirty = true;

function scheduleRender(withPanel = true) {
  if (withPanel) panelDirty = true;
  if (state.renderPending) return;
  state.renderPending = requestAnimationFrame(() => {
    state.renderPending = null;
    const p = panelDirty; panelDirty = false;
    render(p);
  });
}

function render(withPanel = true) {
  const f = filters();
  const zoom = map.getZoom();
  const mob = mqMobile.matches;
  // 縮太遠：標記全部不畫（側欄的統計數字照算，那是全部資料不是畫面上的）
  const tooFar = zoom < CFG.markerMinZoom;
  // 這個迴圈要跑上萬筆，所以先把邊界拆成四個數字比大小，
  // 不要每筆都 b.contains([lat,lng]) —— 那會多配置一個 LatLng 物件。
  const b = map.getBounds().pad(mob ? CFG.viewPadMobile : CFG.viewPad);
  const vN = b.getNorth(), vS = b.getSouth(), vE = b.getEast(), vW = b.getWest();
  const inView = it => !tooFar && it.lat != null &&
    it.lat <= vN && it.lat >= vS && it.lng <= vE && it.lng >= vW;
  const counts = { gym: 0, stop: 0, power: 0, event: 0, raid: 0,
                   VALOR: 0, MYSTIC: 0, INSTINCT: 0, NEUTRAL: 0, mega: 0, egg: 0 };
  // 各星級各有幾個（側欄的星數篩選旁邊會顯示）
  const tiers = { 1: 0, 3: 0, 5: 0, mega: 0, s1: 0, s3: 0, s5: 0, other: 0 };

  const want = { gym: new Map(), stop: new Map(), power: new Map(), event: new Map() };
  const raids = [], powers = [];

  for (const it of state.items) {
    switch (it.k) {
      case 'gym': {
        counts.gym++; counts[it.team]++;
        if (it.megaRaid) counts.mega++;
        const tk = it.raid ? tierKey(it.raid.rating) : null;
        if (it.raid) {
          counts.raid++; raids.push(it); tiers[tk]++;
          if (it.raid.egg) counts.egg++;
        }
        if (!f.layer.has('gym') || !f.team.has(it.team)) break;
        if (f.onlyRaid && !it.raid) break;
        if (f.onlyEgg && !(it.raid && it.raid.egg)) break;
        if (f.onlyMega && !it.megaRaid) break;
        // 星數篩選只約束有團體戰的道館；沒團體戰的交給上面那幾個開關決定
        if (tk && !f.tier.has(tk)) break;
        if (inView(it)) want.gym.set(it.id, it);
        break;
      }
      case 'stop':
        counts.stop++;
        if (f.layer.has('stop') && zoom >= CFG.stopMinZoom && inView(it))
          want.stop.set(it.id, it);
        break;
      case 'power':
        counts.power++; powers.push(it);
        if (f.layer.has('power') && inView(it)) want.power.set(it.id, it);
        break;
      case 'event':
        counts.event++;
        if (f.layer.has('event') && inView(it)) want.event.set(it.id, it);
        break;
    }
  }

  const useStopIcon = zoom >= CFG.stopIconZoom;
  syncLayer('stop', want.stop,
    it => useStopIcon
      ? L.marker([it.lat, it.lng], { icon: STOP_ICON, pane: 'pStops' })
      : L.circleMarker([it.lat, it.lng], {
          renderer: rStop, pane: 'pStops', radius: 4, color: '#fff', weight: 1.5,
          fillColor: C_STOP, fillOpacity: .95 }),
    () => (useStopIcon ? 'i' : 'c'));

  // 縮小時「沒有團體戰的」道館改畫小圓點：一個 <i>、純背景色，
  // 不載圖也不套 drop-shadow 濾鏡（那個濾鏡每個標記都是一次合成，數量一多手機就卡）。
  // 有團體戰的一律保留完整圖示，不然縮一下就找不到蛋了。
  const gymDot = it => zoom < (mob ? CFG.gymIconZoomMobile : CFG.gymIconZoom) && !it.raid;
  syncLayer('gym', want.gym,
    it => gymDot(it)
      ? L.marker([it.lat, it.lng], {
          pane: 'pGyms', title: it.n,
          icon: L.divIcon({
            className: 'gdot',
            html: `<i style="background:${(TEAM[it.team] || TEAM.NEUTRAL).c}"></i>`,
            iconSize: [14, 14], iconAnchor: [7, 7], popupAnchor: [0, -6] }) })
      : L.marker([it.lat, it.lng], {
          icon: gymDivIcon(it), pane: 'pGyms', riseOnHover: true,
          zIndexOffset: it.raid ? 1000 : 0, title: it.n }),
    // 圓點/圖示的切換也要進 signature，跨過門檻時才會重建
    it => `${gymDot(it) ? 'd' : 'i'}|${it.team}|${it.megaRaid}|` +
          `${it.raid ? it.raid.boss + it.raid.end : ''}`);

  syncLayer('power', want.power,
    it => L.marker([it.lat, it.lng], {
      pane: 'pTop', riseOnHover: true, title: it.n,
      icon: L.divIcon({ className: 'ps',
        html: (it.img ? `<img src="${esc(it.img)}" alt="">` : '') + '<i></i>',
        iconSize: [40, 40], iconAnchor: [20, 20], popupAnchor: [0, -18] }) }),
    it => it.boss || '');

  syncLayer('event', want.event,
    it => L.marker([it.lat, it.lng], {
      pane: 'pTop', title: it.n,
      icon: L.divIcon({ className: 'ev', html: '<i></i>', iconSize: [22, 22],
                        iconAnchor: [11, 11], popupAnchor: [0, -10] }) }),
    () => 'e');

  if (f.layer.has('border')) map.addLayer(layers.border); else map.removeLayer(layers.border);

  // 畫面上團體戰太多就停掉脈動動畫（見 config 的 maxPulseRings）。
  // 用 body class 一次切換全部，不用重建任何 marker。
  let ringCount = 0;
  for (const it of want.gym.values()) if (it.raid) ringCount++;
  document.body.classList.toggle('nopulse', ringCount > CFG.maxPulseRings);

  // 這行跟縮放有關（縮太遠時要提示），所以移動地圖也要更新
  $('#stats').innerHTML =
    `<b>${counts.stop.toLocaleString()}</b> 補給站 · <b>${counts.gym.toLocaleString()}</b> 道館 · ` +
    `<b>${counts.raid}</b> 團體戰 · ` +
    `<b>${counts.power}</b> 能量點` +
    (tooFar ? ' · <b>放大才會顯示標記</b>' : '');

  // ---- 以下只跟資料/篩選有關，拖曳縮放時整段跳過 ----
  if (!withPanel) return;

  // ---- 數字 ----
  $('#cGym').textContent   = counts.gym.toLocaleString();
  $('#cStop').textContent  = zoom < CFG.stopMinZoom
    ? counts.stop.toLocaleString() + '（放大顯示）' : counts.stop.toLocaleString();
  $('#cPower').textContent = counts.power;
  $('#cEvent').textContent = counts.event;
  $('#cRaid').textContent  = counts.raid;
  $('#cPower2').textContent = counts.power;
  $('#cMega').textContent  = counts.mega.toLocaleString();
  $('#cEgg').textContent   = counts.egg;
  for (const k of ['1', '3', '5', 'mega', 's1', 's3', 's5']) {
    const el = $('#k' + k);
    if (el) el.textContent = tiers[k];
  }
  for (const t of Object.keys(TEAM)) $('#t' + t).textContent = counts[t].toLocaleString();
  if (state.lastUpdate) $('#clock').textContent = '更新於 ' + hhmm(state.lastUpdate);

  renderRaidList(raids);
  renderPowerList(powers);
  if (personMarker) updatePersonPopup(false);
}

/* ------------------------------------------------------------ 側欄清單 --- */
// thumb 可以是：圖片網址字串 / {img, egg} 本地蛋圖 / {text, bg} 佔位物件 / 空值
// 重點：沒有圖就「不要」產生 <img>。src="" 會被畫成一個空的灰框（很醜），
// 而且部分瀏覽器還會把它當成一個請求。
function thumbEl(t) {
  const d = document.createElement('div');
  d.className = 'ph';
  if (t && t.text) {
    d.textContent = t.text;
    if (t.bg) { d.style.background = t.bg; d.style.color = '#fff'; }
  }
  return d;
}

function row(thumb, a, b, onclick) {
  const d = document.createElement('div');
  d.className = 'row';
  let el;
  if (typeof thumb === 'string' && thumb) {
    el = document.createElement('img');
    el.loading = 'lazy';
    el.alt = '';
    // 圖掛掉（404 / 被擋）就換成佔位，不要留破圖
    el.addEventListener('error', () => el.replaceWith(thumbEl(null)), { once: true });
    el.src = thumb;
  } else if (thumb && thumb.img) {
    // 本地的蛋圖：四周有透明留白，要 contain 不能 cover，不然會被裁掉
    el = document.createElement('img');
    el.alt = '';
    if (thumb.egg) el.className = 'egg';
    el.src = thumb.img;
  } else {
    el = thumbEl(thumb);
  }
  const t = document.createElement('div');
  t.className = 't';
  t.innerHTML = `<div class="a">${esc(a)}</div><div class="b">${esc(b)}</div>`;
  d.append(el, t);
  d.addEventListener('click', onclick);
  return d;
}

function flyTo(it) {
  map.flyTo([it.lat, it.lng], Math.max(map.getZoom(), 16));
  map.once('moveend', () => openPopup([it.lat, it.lng], popupFor(it)));
}

function renderRaidList(raids) {
  const box = $('#raidList');
  box.textContent = '';
  if (!raids.length) { box.innerHTML = '<div class="empty">目前沒有團體戰</div>'; return; }
  // 已開戰的排前面（可以直接去打），再來才是快孵化的
  raids.slice().sort((a, b) => {
    if (a.raid.egg !== b.raid.egg) return a.raid.egg ? 1 : -1;
    const ka = a.raid.egg ? a.raid.hatch : a.raid.end;
    const kb = b.raid.egg ? b.raid.hatch : b.raid.end;
    return (ka || 0) - (kb || 0);
  }).forEach(it => {
    const r = it.raid, tier = raidTier(r.rating);
    const ef = r.egg ? eggImg(r.rating) : null;
    const thumb = r.egg ? (ef ? { img: 'img/' + ef, egg: true } : { text: '蛋', bg: tier.c })
                        : (r.img || { text: '⚔' });
    const rowEl = row(thumb, r.egg ? `${tier.t}蛋` : r.boss, `${tier.t} · ${it.n}`,
      () => flyTo(it));
    const key = r.egg ? r.hatch : r.end;
    if (key) {
      const cd = document.createElement('div');
      cd.className = 'b cd'; cd.dataset.cd = key;
      cd.dataset.pre = r.egg ? '孵化 ' : '結束 ';
      rowEl.querySelector('.t').appendChild(cd);
    }
    box.appendChild(rowEl);
  });
  tickCountdowns();
}

function renderPowerList(powers) {
  const box = $('#powerList');
  box.textContent = '';
  if (!powers.length) {
    box.innerHTML = '<div class="empty">目前沒有能量點。' +
      (getToken() ? '目前這個時段可能沒有 Max Battle。'
                  : '<b>能量點需要 Niantic token 才會回傳</b>，請在下面貼上你的 token。') +
      '</div>';
    return;
  }
  for (const it of powers) {
    const win = (it.s != null && it.e != null)
      ? `${utcMinutesToLocal(it.s)}–${utcMinutesToLocal(it.e)}` : '';
    box.appendChild(row(it.img || { text: '⚡', bg: C_POWER }, it.boss || 'Max Battle',
      (win ? win + ' · ' : '') + it.n, () => flyTo(it)));
  }
}

function tickCountdowns() {
  // 側欄收起來時（手機預設就是收起來的）它只是被 translateX 移出畫面，DOM 還活著。
  // 每秒往幾百個看不到的元素寫 textContent 是純浪費，所以收起來就整段跳過。
  // 地圖上開著的 popup 一定要更新，那個使用者看得到。
  const roots = [];
  const panel = $('#panel');
  if (!panel.classList.contains('hidden')) roots.push(panel);
  const pop = document.querySelector('.leaflet-popup-pane');
  if (pop) roots.push(pop);

  const now = Date.now();
  for (const root of roots) {
    for (const el of root.querySelectorAll('[data-cd]')) {
      const end = +el.dataset.cd;
      const pre = el.dataset.pre || '';
      el.textContent = (end - now <= 0)
        ? (pre ? pre + '已到' : '已結束')
        : pre + countdown(end);
    }
  }
}
setInterval(tickCountdowns, 1000);

/* -------------------------------------------------------- S2 網格 --- */
const MAX_CELLS = 6000, MAX_ITER = 30000;
const gridOn = () => $('#gridOn').checked;
const gridLevel = () => parseInt($('#gridLevel').value, 10);

function drawGrid() {
  layers.grid.clearLayers();
  if (!gridOn()) { setStatus(''); return; }
  const level = gridLevel();
  const b = map.getBounds().pad(0.15);
  const c = map.getCenter();
  let start;
  try { start = S2.S2Cell.FromLatLng({ lat: c.lat, lng: c.lng }, level); }
  catch (e) { setStatus('此位置無法計算網格'); return; }

  const stack = [start], seen = {}, cells = [];
  let iter = 0;
  while (stack.length && iter < MAX_ITER) {
    iter++;
    const cell = stack.pop();
    const key = cell.toHilbertQuadkey();
    if (seen[key]) continue;
    seen[key] = true;
    const corners = cell.getCornerLatLngs();
    let laMin = Infinity, laMax = -Infinity, loMin = Infinity, loMax = -Infinity;
    for (const p of corners) {
      if (p.lat < laMin) laMin = p.lat; if (p.lat > laMax) laMax = p.lat;
      if (p.lng < loMin) loMin = p.lng; if (p.lng > loMax) loMax = p.lng;
    }
    if (!(laMin <= b.getNorth() && laMax >= b.getSouth() &&
          loMin <= b.getEast() && loMax >= b.getWest())) continue;
    cells.push(corners);
    if (cells.length > MAX_CELLS) {
      setStatus(`L${level} 網格太密（畫面內超過 ${MAX_CELLS} 格），請放大地圖`);
      layers.grid.clearLayers();
      return;
    }
    for (const nb of cell.getNeighbors())
      if (!seen[nb.toHilbertQuadkey()]) stack.push(nb);
  }
  for (const corners of cells) {
    L.polygon(corners.map(p => [p.lat, p.lng]), {
      pane: 'pGrid', color: '#dc2626', weight: 1, opacity: .55, fill: false, interactive: false
    }).addTo(layers.grid);
  }
  setStatus(`L${level}：畫面內 ${cells.length} 格`);
}

/* ---------------------------------------------------------- 定位 --- */
let locateBtn = null;
function locateMe() {
  if (!navigator.geolocation) { toast('此裝置不支援定位'); return; }
  setStatus('定位中…');
  if (locateBtn) locateBtn.classList.add('busy');
  navigator.geolocation.getCurrentPosition(pos => {
    const { latitude: lat, longitude: lng, accuracy: acc } = pos.coords;
    placePerson(L.latLng(lat, lng));
    map.flyTo([lat, lng], Math.max(map.getZoom(), 17));
    setStatus(`已定位並放上小人（誤差約 ${Math.round(acc)} 公尺）`);
    if (locateBtn) locateBtn.classList.remove('busy');
  }, err => {
    toast(err.code === 1 ? '你拒絕了定位權限' : err.code === 3 ? '定位逾時' : '定位失敗');
    setStatus('');
    if (locateBtn) locateBtn.classList.remove('busy');
  }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });
}

const LocateControl = L.Control.extend({
  options: { position: 'topleft' },
  onAdd() {
    const c = L.DomUtil.create('div', 'leaflet-bar locate-control');
    const a = L.DomUtil.create('a', '', c);
    a.href = '#'; a.title = '定位到我的位置';
    a.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" ' +
      'd="M12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm8.94 3c-.46-4.17-3.77-7.48' +
      '-7.94-7.94V1h-2v2.06C6.83 3.52 3.52 6.83 3.06 11H1v2h2.06c.46 4.17 3.77 7.48 7.94 7.94V23h2' +
      'v-2.06c4.17-.46 7.48-3.77 7.94-7.94H23v-2h-2.06zM12 19c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 ' +
      '7 7-3.13 7-7 7z"/></svg>';
    locateBtn = c;
    L.DomEvent.on(a, 'click', e => { L.DomEvent.stop(e); locateMe(); });
    return c;
  }
});
map.addControl(new LocateControl());

/* ------------------------------------------------------ 可拖曳小人 --- */
const [R40, R80] = CFG.personRadius;
let personMarker = null, personC40 = null, personC80 = null;
const personIcon = L.divIcon({
  html: '<div class="person">🧍</div>', className: 'person-wrap',
  iconSize: [30, 30], iconAnchor: [15, 28]
});

// 統計小人周圍 40 / 80 公尺內的補給站與道館數
function countAround(ll) {
  const mLat = 110574, mLng = 111320 * Math.cos(ll.lat * Math.PI / 180);
  const dLat = R80 / mLat, dLng = R80 / mLng;
  const c = { s40: 0, g40: 0, s80: 0, g80: 0 };
  for (const it of state.items) {
    if (it.k !== 'stop' && it.k !== 'gym') continue;
    if (Math.abs(it.lat - ll.lat) > dLat || Math.abs(it.lng - ll.lng) > dLng) continue;
    const dx = (it.lng - ll.lng) * mLng, dy = (it.lat - ll.lat) * mLat;
    const d2 = dx * dx + dy * dy;
    if (d2 > R80 * R80) continue;
    if (it.k === 'gym') { c.g80++; if (d2 <= R40 * R40) c.g40++; }
    else               { c.s80++; if (d2 <= R40 * R40) c.s40++; }
  }
  return c;
}

function personHtml(ll, c) {
  return `<div class="pop"><h3>🧍 小人位置</h3>
    <div class="meta">${R40} 公尺內：🔵 ${c.s40} 補給站　🏛 ${c.g40} 道館<br>
      ${R80} 公尺內：🔵 ${c.s80} 補給站　🏛 ${c.g80} 道館</div>
    <div class="coord">${ll.lat.toFixed(6)}, ${ll.lng.toFixed(6)}</div>
    <a class="nav" target="_blank" rel="noopener"
       href="https://www.google.com/maps/dir/?api=1&destination=${ll.lat},${ll.lng}">在 Google 地圖開啟 ↗</a>
    </div>`;
}

function updatePersonPopup(open) {
  if (!personMarker) return;
  const ll = personMarker.getLatLng();
  const html = personHtml(ll, countAround(ll));
  if (open) openPopup(ll, html);
  else if (map.hasLayer(sharedPopup) &&
           sharedPopup.getLatLng().equals(ll, 1e-9)) sharedPopup.setContent(html);
}

function placePerson(latlng) {
  if (!personMarker) {
    personMarker = L.marker(latlng, {
      icon: personIcon, draggable: true, pane: 'pPerson', title: '拖曳我來移動'
    }).addTo(map);
    // 圈畫在低層（pRings），只有小人本身留在最上層。
    // 小人是 DOM marker，只佔自己那一小塊，不會擋到別的東西。
    personC80 = L.circle(latlng, { radius: R80, pane: 'pRings', color: '#2563eb', weight: 2,
      fillColor: '#3b82f6', fillOpacity: .1, interactive: false }).addTo(map);
    personC40 = L.circle(latlng, { radius: R40, pane: 'pRings', color: '#ea580c', weight: 2,
      fillColor: '#fb923c', fillOpacity: .15, interactive: false }).addTo(map);
    personMarker.on('drag', e => {
      const p = e.target.getLatLng();
      personC80.setLatLng(p); personC40.setLatLng(p);
    });
    personMarker.on('dragend', () => updatePersonPopup(true));
    personMarker.on('click', () => updatePersonPopup(true));
    $('#pegReset').style.display = 'block';
  } else {
    personMarker.setLatLng(latlng);
    personC80.setLatLng(latlng); personC40.setLatLng(latlng);
  }
  updatePersonPopup(true);
}

function removePerson() {
  for (const l of [personMarker, personC40, personC80]) if (l) map.removeLayer(l);
  personMarker = personC40 = personC80 = null;
  $('#pegReset').style.display = 'none';
  if (map.hasLayer(sharedPopup)) map.closePopup(sharedPopup);
}

// 拖曳（用 Pointer Events，滑鼠和觸控同一套；iOS 的原生 HTML5 拖放要長按才會啟動）
(function initPegDrag() {
  const peg = $('#pegIcon'), mapEl = $('#map');
  let ghost = null;
  const moveGhost = e => { ghost.style.left = e.clientX + 'px'; ghost.style.top = e.clientY + 'px'; };
  const killGhost = () => { if (ghost) { ghost.remove(); ghost = null; } };

  peg.addEventListener('pointerdown', e => {
    e.preventDefault();
    peg.setPointerCapture(e.pointerId);
    ghost = document.createElement('div');
    ghost.textContent = '🧍';
    ghost.style.cssText = 'position:fixed;z-index:9999;font-size:34px;line-height:34px;' +
      'pointer-events:none;transform:translate(-50%,-100%)';
    moveGhost(e);
    document.body.appendChild(ghost);
  });
  peg.addEventListener('pointermove', e => { if (ghost) moveGhost(e); });
  peg.addEventListener('pointerup', e => {
    if (!ghost) return;
    killGhost();
    const r = mapEl.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    if (x >= 0 && y >= 0 && x <= r.width && y <= r.height)
      placePerson(map.containerPointToLatLng(L.point(x, y)));
  });
  peg.addEventListener('pointercancel', killGhost);
  $('#pegReset').addEventListener('click', removePerson);
})();

/* ---------------------------------------------------- 座標讀值 / 點地圖 --- */
map.on('mousemove', e => {
  $('#coordbox').textContent =
    `${e.latlng.lat.toFixed(6)}, ${e.latlng.lng.toFixed(6)}`;
});
// 注意：地圖的 click 上「不要開 popup」。
// Leaflet 的 marker 點擊事件會往上冒泡到地圖，如果地圖也監聽 click 並開 popup，
// 就會把 marker 剛開好的 popup 內容蓋掉，看起來就像「點不到那個點」。
// （下面搜尋那一段有掛一個 map.on('click')，但它只收合手機版的搜尋列，不碰 popup。）
// 想看座標的話，左下角的 #coordbox 已經跟著滑鼠即時顯示了。

/* -------------------------------------------------------------- 搜尋 --- */
// 窄螢幕時側欄是整頁的抽屜，搜尋擺在裡面等於「要先開側欄才能搜」，很反直覺。
// 所以窄螢幕就把整個搜尋區塊搬到地圖上方的浮動列，寬螢幕再搬回側欄原位。
// （mqMobile 定義在檔案最上面）
function placeSearch() {
  const grp = $('#searchGrp');
  const host = mqMobile.matches ? $('#searchHost') : $('#panel');
  if (grp.parentNode !== host) {
    if (host.id === 'panel') host.insertBefore(grp, $('#tokenGrp'));
    else host.appendChild(grp);
  }
  // 換到手機版時預設收合；回到桌機版就把狀態清掉
  document.body.classList.toggle('searchmini', mqMobile.matches);
}
mqMobile.addEventListener('change', placeSearch);

// 手機版的搜尋列平常收成一顆放大鏡，展開後才佔一整條。
// 收合時要順便把輸入和結果清掉，否則下次展開會看到上一次的殘留。
function collapseSearch() {
  if (!mqMobile.matches) return;
  const q = $('#q');
  q.blur();
  q.value = '';
  q.closest('.qbar').classList.remove('has');   // 清除鈕跟著收起來
  $('#qList').textContent = '';
  document.body.classList.add('searchmini');
}
function expandSearch() {
  document.body.classList.remove('searchmini');
  const q = $('#q');
  q.focus();
  // iOS 上剛顯示的元素要等一個 frame 才聚焦得上
  requestAnimationFrame(() => q.focus());
}
$('#searchMini').addEventListener('click', expandSearch);

// 點地圖上的空白處就收回去（有打字的話留著，免得誤觸把輸入弄丟）
map.on('click', () => { if (!$('#q').value.trim()) collapseSearch(); });

// 選了搜尋結果之後：手機版把鍵盤和結果收掉，不然整張地圖都被結果清單擋住
function pick(fn) {
  return () => {
    if (mqMobile.matches) collapseSearch();
    fn();
  };
}

function renderSearch(q) {
  const box = $('#qList');
  box.textContent = '';
  if (!q) return;
  const hits = state.items
    .filter(i => i.lat != null && (i.n || '').toLowerCase().includes(q)).slice(0, 40);
  if (!hits.length) {
    box.innerHTML = '<div class="empty">資料裡找不到。按 <b>Enter</b> 可以改搜尋地點</div>';
    return;
  }
  const LABEL = { gym: '道館', stop: '補給站', power: '能量點', event: '活動' };
  const FALLBACK = { stop: { text: '🔵' }, power: { text: '⚡', bg: C_POWER },
                     event: { text: '🔥', bg: C_EVENT } };
  for (const it of hits) {
    const thumb = it.img ||
      (it.k === 'gym' ? `img/gym_${it.team}.png` : FALLBACK[it.k]);
    box.appendChild(row(thumb, it.n, LABEL[it.k], pick(() => flyTo(it))));
  }
}

// 按 Enter 搜地點：有 Google API key 就用 Google Places，否則退回 Nominatim
let searchMarker = null;
function gotoPlace(name, addr, lat, lng) {
  map.flyTo([lat, lng], Math.max(map.getZoom(), 16));
  if (searchMarker) map.removeLayer(searchMarker);
  searchMarker = L.marker([lat, lng], { pane: 'pPerson', title: name }).addTo(map);
  map.once('moveend', () => {
    openPopup([lat, lng], `<div class="pop"><h3>${esc(name)}</h3>` +
      (addr ? `<div class="meta">${esc(addr)}</div>` : '') +
      `<div class="coord">${lat.toFixed(6)}, ${lng.toFixed(6)}</div>
       <a class="nav" target="_blank" rel="noopener"
          href="https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}">在 Google 地圖開啟 ↗</a>
       </div>`);
  });
}

async function searchGoogle(q) {
  const c = map.getCenter();
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': getMapsKey(),
      'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location'
    },
    body: JSON.stringify({
      textQuery: q, languageCode: 'zh-TW', maxResultCount: 8,
      locationBias: { circle: { center: { latitude: c.lat, longitude: c.lng }, radius: 50000 } }
    })
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'Google 錯誤');
  const list = (data.places || []).map(pl => ({
    name: pl.displayName ? pl.displayName.text : '(無名稱)',
    addr: pl.formattedAddress || '',
    lat: pl.location.latitude, lng: pl.location.longitude
  }));
  return list;
}

async function searchNominatim(q) {
  const c = map.getCenter();
  const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8' +
    '&accept-language=zh-TW&q=' + encodeURIComponent(q) +
    `&viewbox=${c.lng - .3},${c.lat + .3},${c.lng + .3},${c.lat - .3}`;
  const arr = await (await fetch(url, { headers: { Accept: 'application/json' } })).json();
  return (arr || []).map(a => ({
    name: a.name || a.display_name, addr: a.display_name,
    lat: +a.lat, lng: +a.lon
  }));
}

// 預設用 Google 地圖搜尋；沒有 key、或 Google 出錯／查無結果時，自動改用 OpenStreetMap
async function searchAddress(q) {
  const box = $('#qList');
  const hasKey = !!getMapsKey();
  box.innerHTML = `<div class="empty">${hasKey ? 'Google 地圖' : 'OpenStreetMap'} 搜尋中…</div>`;

  let list = null, via = '', fallbackWhy = '';
  if (hasKey) {
    try {
      list = await searchGoogle(q);
      via = 'Google 地圖';
      if (!list.length) { fallbackWhy = 'Google 查無結果'; list = null; }
    } catch (e) {
      fallbackWhy = 'Google 失敗：' + e.message;
      log('Google 搜尋失敗，改用 OpenStreetMap：' + e.message);
      list = null;
    }
  }

  if (!list) {
    if (fallbackWhy) box.innerHTML = `<div class="empty">${esc(fallbackWhy)}，改用 OpenStreetMap…</div>`;
    try {
      list = await searchNominatim(q);
      via = 'OpenStreetMap' + (fallbackWhy ? '（Google 沒結果）' : '');
    } catch (e) {
      box.innerHTML = `<div class="empty">搜尋失敗：${esc(e.message)}</div>`;
      return;
    }
  }

  box.textContent = '';
  if (!list.length) { box.innerHTML = '<div class="empty">找不到這個地點</div>'; return; }
  const hint = document.createElement('div');
  hint.className = 'empty';
  hint.style.cssText = 'padding:2px;font-size:10px';
  hint.textContent = '結果來自 ' + via;
  box.appendChild(hint);
  for (const a of list) {
    box.appendChild(row({ text: '📍' }, a.name, a.addr,
      pick(() => gotoPlace(a.name, a.addr, a.lat, a.lng))));
  }
}

$('#q').addEventListener('input', e => {
  const v = e.target.value.trim();
  e.target.closest('.qbar').classList.toggle('has', !!v);
  renderSearch(v.toLowerCase());
});
$('#q').addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    const v = e.target.value.trim();
    if (v) { searchAddress(v); e.target.blur(); }   // 手機收鍵盤，結果才看得到
  }
});
// 收掉結果之後再點回搜尋框，把剛才的篩選結果叫回來
$('#q').addEventListener('focus', e => {
  const v = e.target.value.trim();
  if (v && !$('#qList').firstChild) renderSearch(v.toLowerCase());
});
$('#qClear').addEventListener('click', () => {
  // 手機版：本來就是空的還按清除 = 想關掉搜尋列，直接收合
  if (mqMobile.matches && !$('#q').value) { collapseSearch(); return; }
  $('#q').value = '';
  $('#q').closest('.qbar').classList.remove('has');
  $('#qList').textContent = '';
  if (!mqMobile.matches) $('#q').focus();
});

/* -------------------------------------------------------------- 事件 --- */
// 用箭頭函式包起來：直接傳 render 的話事件物件會變成第一個參數
for (const el of document.querySelectorAll('.layer,.team,.tier,#onlyRaid,#onlyMega,#onlyEgg'))
  el.addEventListener('change', () => scheduleRender());
// 星數的全選 / 全不選
for (const [id, on] of [['#tierAll', true], ['#tierNone', false]]) {
  const b = $(id);
  if (b) b.addEventListener('click', () => {
    for (const c of document.querySelectorAll('.tier')) c.checked = on;
    scheduleRender();
  });
}
// 把能量點圖層打開時，如果還沒抓過就補抓一次（平常關著就完全不會帶 token 出去）
document.querySelector('.layer[value="power"]').addEventListener('change', e => {
  if (e.target.checked && getToken() && !state.power.length) refreshPower(false);
});
for (const el of document.querySelectorAll('.bm'))
  el.addEventListener('click', () => setBasemap(el.dataset.bm));
$('#gridOn').addEventListener('change', drawGrid);
$('#gridLevel').addEventListener('change', drawGrid);
$('#tokenSave').addEventListener('click', () => {
  const v = $('#tokenInput').value.trim().replace(/^Bearer\s+/i, '');
  try {
    if (v) localStorage.setItem(TOKEN_KEY, v); else localStorage.removeItem(TOKEN_KEY);
  } catch (e) { toast('瀏覽器不允許儲存（無痕模式？）'); return; }
  $('#tokenInput').value = '';
  updateTokenUI();
  toast(v ? '已儲存，抓取能量點中…' : '已清除');
  if (v) refreshPower(true); else { state.power = []; mergeItems(); render(); }
});
$('#tokenClear').addEventListener('click', () => {
  try { localStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ }
  $('#tokenInput').value = '';
  updateTokenUI(); toast('已清除');
  state.power = []; mergeItems(); render();
});
$('#btnRefresh').addEventListener('click', refresh);
function togglePanel(hide) {
  const p = $('#panel');
  const h = hide === undefined ? !p.classList.contains('hidden') : hide;
  p.classList.toggle('hidden', h);
  // 小人控制盒要跟著側欄讓位（CSS 的 ~ 選擇器在這個 DOM 順序下不管用，改用 body class）
  document.body.classList.toggle('nopanel', h);
  setTimeout(() => map.invalidateSize(), 200);
}
$('#btnPanel').addEventListener('click', () => togglePanel());
// 移動地圖只重畫標記，側欄清單不動（false = 不含側欄）
map.on('moveend zoomend', () => { scheduleRender(false); drawGrid(); });

/* -------------------------------------------------------------- 啟動 --- */
(async function init() {
  // 手機預設收起側欄，桌機預設展開；搜尋列在手機是浮在地圖上的，不跟著側欄收合
  togglePanel(mqMobile.matches);
  placeSearch();

  // 補給站數量最多，手機上是主要的卡頓來源 -> 預設關掉（使用者仍可自己打開）
  if (CFG.stopDefaultOff === true ||
      (CFG.stopDefaultOff === 'mobile' && mqMobile.matches)) {
    document.querySelector('.layer[value="stop"]').checked = false;
  }

  let bm = CFG.basemap;
  if (!new URLSearchParams(location.search).has('basemap')) {
    try { bm = localStorage.getItem('basemap') || CFG.basemap; } catch (e) { /* ignore */ }
  }
  setBasemap(bm);

  // S2 網格 level 選單
  const sel = $('#gridLevel');
  const NOTE = { 14: '（道館網格）', 17: '（補給站網格）' };
  for (let l = 10; l <= 20; l++) {
    const o = document.createElement('option');
    o.value = l; o.textContent = 'L' + l + (NOTE[l] || '');
    if (l === CFG.gridLevel) o.selected = true;
    sel.appendChild(o);
  }

  updateTokenUI();
  updateAuthUI();
  $('#searchVia').textContent = getMapsKey() ? 'Google 地圖' : 'OpenStreetMap（沒有注入 API key）';
  try {
    state.powerCells = JSON.parse(localStorage.getItem('power_cells') || '[]');
  } catch (e) { state.powerCells = []; }

  // 兩種模式的流量差 100 倍以上，寫死一個數字會誤導人
  const perRound = CFG.source === 'direct' ? '每次約 3.3 MB' : '每次約 30 KB';
  $('#autoLabel').textContent = CFG.refreshSec > 0
    ? `一般資料每 ${CFG.refreshSec} 秒（不帶 token），${perRound}`
    : '一般資料自動更新已關閉';
  $('#powerLabel').textContent = CFG.powerRefreshSec > 0
    ? `能量點每 ${CFG.powerRefreshSec} 秒（帶 token）` : '能量點自動更新已關閉';
  $('#srcLabel').textContent = CFG.source === 'direct' ? '瀏覽器直接抓 Niantic' : 'Cloudflare Worker';

  // 兩種模式都要載：Worker 模式雖然不用它抓道館，但畫 S2 網格、
  // 以及瀏覽器自己抓能量點（那份 Worker 不做）都需要格子清單。檔案只有 19 KB。
  try {
    state.cells = await (await fetch('data/cells.json')).json();
    $('#cellCount').textContent = state.cells.length.toLocaleString() +
      (CFG.source === 'direct' ? '' : '（道館由 Worker 抓）');
  } catch (e) {
    toast('cells.json 載入失敗'); log('cells.json 載入失敗: ' + e.message); return;
  }

  await refreshPublic();
  drawGrid();
  refreshPower(false);

  if (CFG.refreshSec > 0) {
    state.timer = setInterval(() => {
      if (!document.hidden) refreshPublic();
    }, CFG.refreshSec * 1000);
  }
  // 能量點獨立計時，而且分頁在背景時不跑（省 token 用量）
  if (CFG.powerRefreshSec > 0) {
    state.powerTimer = setInterval(() => {
      if (!document.hidden) refreshPower(false);
    }, CFG.powerRefreshSec * 1000);
  }
})();
