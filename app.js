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
// 地點搜尋用。沒設就退回 OpenStreetMap 的 Nominatim（免費但結果較差）。
// 存在 localStorage，不會進 repo；也可以寫在 config.js 的 mapsApiKey。
const GKEY_KEY = 'maps_api_key';
function getMapsKey() {
  try {
    return (localStorage.getItem(GKEY_KEY) || CFG.mapsApiKey || '').trim();
  } catch (e) { return (CFG.mapsApiKey || '').trim(); }
}
function updateMapsKeyUI() {
  const el = $('#gkeyState');
  if (!el) return;
  const k = getMapsKey();
  el.textContent = k ? `已設定（…${k.slice(-6)}），搜尋使用 Google 地圖`
                     : '未設定，搜尋使用 OpenStreetMap';
  el.className = 'tokstate ' + (k ? 'ok' : 'warn');
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
  timer: null, powerTimer: null, renderPending: null
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

async function fetchFromWorker(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('Worker HTTP ' + res.status);
  const js = await res.json();
  state.lastUpdate = js.t || Date.now();
  return js.items || [];
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
      const items = await fetchFromWorker(CFG.source);
      state.pub = items.filter(i => i.k !== 'power');
      state.power = items.filter(i => i.k === 'power');
      state.lastPowerUpdate = state.lastUpdate;
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
  if (CFG.source !== 'direct') return;      // Worker 模式由 Worker 那邊負責
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
      // 還是蛋：顯示星級，用顏色區分等級
      const n = parseInt(it.raid.rating, 10);
      const label = n === 6 ? 'M' : isNaN(n) ? '?' : (n >= 10 ? n - 10 : n);
      html += `<i class="gegg" style="background:${tier.c}">${label}</i>`;
    }
  }
  if (it.megaRaid) html += `<i class="mega" title="極致超級團體戰"></i>`;
  // iconSize 開到 44x44（圖示本身還是 28x29，四周多出來的是透明的可點擊範圍）。
  // 手機的建議觸控目標是 44px，滑鼠也比較好瞄。
  return L.divIcon({
    className: 'gm' + (it.raid ? ' has-raid' : ''),
    html, iconSize: [44, 44], iconAnchor: [22, 35], popupAnchor: [0, -32]
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
const sharedPopup = L.popup({
  autoPan: true, autoPanPadding: [24, 24], keepInView: true,
  maxWidth: 280, closeButton: true
});

function openPopup(latlng, html) {
  sharedPopup.setLatLng(latlng).setContent(html).openOn(map);
}

function coordFoot(it) {
  return `<div class="coord">${it.lat.toFixed(6)}, ${it.lng.toFixed(6)}</div>
    <a class="nav" target="_blank" rel="noopener"
       href="https://www.google.com/maps/dir/?api=1&destination=${it.lat},${it.lng}">在 Google 地圖開啟 ↗</a>`;
}

function popupGym(it) {
  const t = TEAM[it.team] || TEAM.NEUTRAL;
  let h = `<div class="pop"><h3>${esc(it.n)}</h3>`;
  if (it.img) h += `<img class="photo" src="${esc(it.img)}" loading="lazy" alt="">`;
  h += `<div class="meta"><span class="tag" style="background:${t.c}">${t.n}</span>`;
  if (it.megaRaid) h += ` <span class="tag" style="background:${C_MEGA}">極致超級團體戰</span>`;
  h += `</div>`;
  if (it.raid) {
    const r = it.raid, tier = raidTier(r.rating);
    h += `<div class="raid">`;
    if (!r.egg && r.img) h += `<img src="${esc(r.img)}" alt="">`;
    else h += `<div class="eggbig" style="background:${tier.c}">蛋</div>`;
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
  if (it.img) h += `<img class="photo" src="${esc(it.img)}" loading="lazy" alt="">`;
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
    if (it.img) h += `<img src="${esc(it.img)}" alt="">`;
    h += `<div><div class="n">${esc(it.boss)}</div>
          <div class="meta">${esc(it.rating || '')}</div>`;
    if (win) h += `<div class="c">開放 ${win}</div>`;
    h += `</div></div>`;
  }
  return h + coordFoot(it) + `</div>`;
}

function popupEvent(it) {
  let h = `<div class="pop"><h3>${esc(it.n)}</h3>`;
  if (it.img) h += `<img class="photo" src="${esc(it.img)}" loading="lazy" alt="">`;
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
    layer: on('.layer'), team: on('.team'),
    onlyRaid: $('#onlyRaid').checked, onlyMega: $('#onlyMega').checked
  };
}

function scheduleRender() {
  if (state.renderPending) return;
  state.renderPending = requestAnimationFrame(() => {
    state.renderPending = null; render();
  });
}

function render() {
  const f = filters();
  const zoom = map.getZoom();
  const b = map.getBounds().pad(0.25);
  const inView = it => it.lat != null && b.contains([it.lat, it.lng]);
  const counts = { gym: 0, stop: 0, power: 0, event: 0, raid: 0,
                   VALOR: 0, MYSTIC: 0, INSTINCT: 0, NEUTRAL: 0, mega: 0 };

  const want = { gym: new Map(), stop: new Map(), power: new Map(), event: new Map() };
  const raids = [], powers = [];

  for (const it of state.items) {
    switch (it.k) {
      case 'gym': {
        counts.gym++; counts[it.team]++;
        if (it.megaRaid) counts.mega++;
        if (it.raid) { counts.raid++; raids.push(it); }
        if (!f.layer.has('gym') || !f.team.has(it.team)) break;
        if (f.onlyRaid && !it.raid) break;
        if (f.onlyMega && !it.megaRaid) break;
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
        if (f.layer.has('power')) want.power.set(it.id, it);
        break;
      case 'event':
        counts.event++;
        if (f.layer.has('event') && it.lat != null) want.event.set(it.id, it);
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

  syncLayer('gym', want.gym,
    it => L.marker([it.lat, it.lng], {
      icon: gymDivIcon(it), pane: 'pGyms', riseOnHover: true,
      zIndexOffset: it.raid ? 1000 : 0, title: it.n }),
    it => `${it.team}|${it.megaRaid}|${it.raid ? it.raid.boss + it.raid.end : ''}`);

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

  // ---- 數字 ----
  $('#cGym').textContent   = counts.gym.toLocaleString();
  $('#cStop').textContent  = zoom < CFG.stopMinZoom
    ? counts.stop.toLocaleString() + '（放大顯示）' : counts.stop.toLocaleString();
  $('#cPower').textContent = counts.power;
  $('#cEvent').textContent = counts.event;
  $('#cRaid').textContent  = counts.raid;
  $('#cPower2').textContent = counts.power;
  $('#cMega').textContent  = counts.mega.toLocaleString();
  for (const t of Object.keys(TEAM)) $('#t' + t).textContent = counts[t].toLocaleString();

  $('#stats').innerHTML =
    `<b>${counts.stop.toLocaleString()}</b> 補給站 · <b>${counts.gym.toLocaleString()}</b> 道館 · ` +
    `<b>${counts.raid}</b> 團體戰 · ` +
    `<b>${counts.power}</b> 能量點`;
  if (state.lastUpdate) $('#clock').textContent = '更新於 ' + hhmm(state.lastUpdate);

  renderRaidList(raids);
  renderPowerList(powers);
  if (personMarker) updatePersonPopup(false);
}

/* ------------------------------------------------------------ 側欄清單 --- */
function row(img, a, b, onclick) {
  const d = document.createElement('div');
  d.className = 'row';
  d.innerHTML = `<img src="${esc(img || '')}" loading="lazy" alt="">` +
    `<div class="t"><div class="a">${esc(a)}</div><div class="b">${esc(b)}</div></div>`;
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
    const rowEl = row(r.egg ? '' : r.img, r.egg ? `${tier.t}蛋` : r.boss,
      `${tier.t} · ${it.n}`, () => flyTo(it));
    if (r.egg) {
      const im = rowEl.querySelector('img');
      im.replaceWith(Object.assign(document.createElement('div'), {
        className: 'eggthumb', textContent: '蛋'
      }));
      rowEl.querySelector('.eggthumb').style.background = tier.c;
    }
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
    box.appendChild(row(it.img, it.boss || 'Max Battle',
      (win ? win + ' · ' : '') + it.n, () => flyTo(it)));
  }
}

function tickCountdowns() {
  for (const el of document.querySelectorAll('[data-cd]')) {
    const end = +el.dataset.cd;
    const pre = el.dataset.pre || '';
    el.textContent = (end - Date.now() <= 0)
      ? (pre ? pre + '已到' : '已結束')
      : pre + countdown(end);
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
// 注意：這裡刻意「不要」加 map.on('click')。
// Leaflet 的 marker 點擊事件會往上冒泡到地圖，如果地圖也監聽 click 並開 popup，
// 就會把 marker 剛開好的 popup 內容蓋掉，看起來就像「點不到那個點」。
// 想看座標的話，左下角的 #coordbox 已經跟著滑鼠即時顯示了。

/* -------------------------------------------------------------- 搜尋 --- */
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
  for (const it of hits) box.appendChild(row(it.img, it.n, LABEL[it.k], () => flyTo(it)));
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

async function searchGoogle(q, box) {
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

async function searchAddress(q) {
  const box = $('#qList');
  const useGoogle = !!getMapsKey();
  box.innerHTML = `<div class="empty">用 ${useGoogle ? 'Google 地圖' : 'OpenStreetMap'} 搜尋中…</div>`;
  try {
    const list = useGoogle ? await searchGoogle(q, box) : await searchNominatim(q);
    box.textContent = '';
    if (!list.length) { box.innerHTML = '<div class="empty">找不到這個地點</div>'; return; }
    for (const a of list) {
      box.appendChild(row('', a.name, a.addr, () => gotoPlace(a.name, a.addr, a.lat, a.lng)));
    }
  } catch (e) {
    box.innerHTML = `<div class="empty">搜尋失敗：${esc(e.message)}</div>`;
    log('地點搜尋失敗: ' + e.message);
  }
}

$('#q').addEventListener('input', e => renderSearch(e.target.value.trim().toLowerCase()));
$('#q').addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    const v = e.target.value.trim();
    if (v) searchAddress(v);
  }
});

/* -------------------------------------------------------------- 事件 --- */
for (const el of document.querySelectorAll('.layer,.team,#onlyRaid,#onlyMega'))
  el.addEventListener('change', render);
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
$('#gkeySave').addEventListener('click', () => {
  const v = $('#gkeyInput').value.trim();
  try {
    if (v) localStorage.setItem(GKEY_KEY, v); else localStorage.removeItem(GKEY_KEY);
  } catch (e) { toast('瀏覽器不允許儲存'); return; }
  $('#gkeyInput').value = '';
  updateMapsKeyUI();
  toast(v ? '已儲存，搜尋改用 Google 地圖' : '已清除，搜尋改用 OpenStreetMap');
});
$('#gkeyClear').addEventListener('click', () => {
  try { localStorage.removeItem(GKEY_KEY); } catch (e) { /* ignore */ }
  $('#gkeyInput').value = ''; updateMapsKeyUI(); toast('已清除');
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
map.on('moveend zoomend', () => { scheduleRender(); drawGrid(); });

/* -------------------------------------------------------------- 啟動 --- */
(async function init() {
  // 手機預設收起側欄，桌機預設展開
  togglePanel(window.matchMedia('(max-width: 820px)').matches);

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
  updateMapsKeyUI();
  try {
    state.powerCells = JSON.parse(localStorage.getItem('power_cells') || '[]');
  } catch (e) { state.powerCells = []; }

  $('#autoLabel').textContent = CFG.refreshSec > 0
    ? `一般資料每 ${CFG.refreshSec} 秒（不帶 token）` : '一般資料自動更新已關閉';
  $('#powerLabel').textContent = CFG.powerRefreshSec > 0
    ? `能量點每 ${CFG.powerRefreshSec} 秒（帶 token）` : '能量點自動更新已關閉';
  $('#srcLabel').textContent = CFG.source === 'direct' ? '瀏覽器直接抓 Niantic' : 'Cloudflare Worker';

  if (CFG.source === 'direct') {
    try {
      state.cells = await (await fetch('data/cells.json')).json();
      $('#cellCount').textContent = state.cells.length.toLocaleString();
    } catch (e) {
      toast('cells.json 載入失敗'); log('cells.json 載入失敗: ' + e.message); return;
    }
  } else {
    $('#cellCount').textContent = '（由 Worker 負責）';
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
