/* ---------------------------------------------------------------------------
   道館變化分析。

   主軸是「單一道館在某一天之內，什麼時段被什麼顏色佔據」——
   把變化事件重建成連續的時間區段，畫成 24 小時的色帶，直接顯示在
   地圖上那個道館的 popup 裡。日期可以在 popup 上直接切換。

   資料來源（Worker，direct 模式沒有歷史，整個面板會自動隱藏）：
     /history?date= 某一天的所有變化事件 → 每個道館的時間軸
     /stats?date=   每 2 分鐘一筆的隊伍佔領數 → 全區趨勢
     /days          有哪些日子留著紀錄（保留 30 天）

   圖表是手寫 SVG，沒有引入任何圖表函式庫 —— 這個網站對手機效能很敏感
   （見 config.js 那一串效能設定），沒必要為了幾條色帶多載一包 JS。

   時間一律用瀏覽器本地時間，跟 Worker 那邊按台灣時間切檔一致
   （前提是你人在台灣；出國看的話時段會偏移）。
--------------------------------------------------------------------------- */
'use strict';

(function () {

const TEAM_KEY = { V: 'VALOR', M: 'MYSTIC', I: 'INSTINCT', N: 'NEUTRAL' };
const CODE = { VALOR: 'V', MYSTIC: 'M', INSTINCT: 'I', NEUTRAL: 'N' };
const ORDER = ['V', 'M', 'I', 'N'];
const col = c => (TEAM[TEAM_KEY[c]] || TEAM.NEUTRAL).c;
const tname = c => (TEAM[TEAM_KEY[c]] || TEAM.NEUTRAL).n;
const DAY = 86400000;
const SW = 320;            // SVG viewBox 寬度，實際寬度由 CSS 撐滿
const HIST_TTL = 180000;   // 「今天」的紀錄快取多久（過去的日期不會再變，永久快取）

const A = {
  date: null,              // 目前在看哪一天（popup 和側欄共用）
  dates: null,             // /days 的清單
  cache: new Map(),        // date -> { events, byGym, at }
  pending: new Map(),      // date -> 進行中的請求，避免連點時重複抓
  stats: null, statsDate: null,
  loading: false
};

function today() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function dayStart(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

async function getJ(path) {
  const res = await fetch(workerBase() + path);
  if (!res.ok) throw new Error(path.split('?')[0] + ' HTTP ' + res.status);
  return res.json();
}

/* --------------------------------------------------------- 取資料 --- */
// 過去的日期抓過就永久留著（不會再變）；只有「今天」需要定期重抓。
function ensureDay(date) {
  const hit = A.cache.get(date);
  if (hit && (date !== today() || Date.now() - hit.at < HIST_TTL)) return Promise.resolve(hit);
  if (A.pending.has(date)) return A.pending.get(date);

  const p = getJ('/history?date=' + date)
    .then(ev => store(date, ev))
    .catch(err => { log('分析：' + err.message); return store(date, []); })
    .finally(() => A.pending.delete(date));
  A.pending.set(date, p);
  return p;
}

function store(date, events) {
  const byGym = new Map();
  for (const e of events) {
    if (e.t !== 'team') continue;
    if (!byGym.has(e.id)) byGym.set(e.id, []);
    byGym.get(e.id).push(e);
  }
  for (const list of byGym.values()) list.sort((a, b) => a.at - b.at);
  const entry = { events, byGym, at: Date.now() };
  A.cache.set(date, entry);
  return entry;
}

function ensureDates() {
  if (A.dates) return Promise.resolve(A.dates);
  return getJ('/days')
    .then(d => (A.dates = d.slice().sort().reverse()))
    .catch(() => (A.dates = []));
}

/* ------------------------------------------------ 重建單一道館的時間軸 ---
   事件只記錄「換手的瞬間」，要畫色帶就得補回中間的區段：
     第一筆事件之前 → 用那筆的 from（誰被搶走的，就是先前的佔領者）
     兩筆事件之間   → 用前一筆的 to
     最後一筆之後   → 用最後一筆的 to，一路延伸到當天結束（或現在）
   當天完全沒有事件的道館，只有在查「今天」時才用現在的顏色推定整天，
   標成半透明；查過去的日期不能這樣推，因為中間可能換過好幾手。 */
function timelineFor(gymId, currentTeam, date) {
  const t0 = dayStart(date);
  const end = Math.min(t0 + DAY, Date.now());
  if (end <= t0) return [];

  const entry = A.cache.get(date);
  const evs = entry && entry.byGym.get(gymId);

  if (!evs || !evs.length) {
    if (date !== today() || !currentTeam) return [];
    return [{ a: t0, b: end, c: CODE[currentTeam] || 'N', guess: true }];
  }

  const segs = [];
  let cur = evs[0].from, t = t0;
  for (const e of evs) {
    if (e.at > t && e.at <= end) segs.push({ a: t, b: e.at, c: cur, guess: t === t0 });
    cur = e.to; t = Math.max(t, Math.min(e.at, end));
  }
  if (end > t) segs.push({ a: t, b: end, c: cur });
  return segs;
}

function segTotals(segs) {
  const o = { V: 0, M: 0, I: 0, N: 0 };
  for (const g of segs) o[g.c] = (o[g.c] || 0) + (g.b - g.a);
  return o;
}

/* --------------------------------------------------------- 色帶 SVG --- */
// preserveAspectRatio=none：色帶只有純色方塊，橫向拉伸沒有副作用，
// 這樣不管容器多寬都剛好填滿；時間刻度另外用 HTML 排在下面。
function band(segs, h, date) {
  const t0 = dayStart(date);
  const x = t => ((t - t0) / DAY) * SW;
  let s = `<svg viewBox="0 0 ${SW} ${h}" class="band" preserveAspectRatio="none">`;
  s += `<rect x="0" y="0" width="${SW}" height="${h}" fill="#0f1720"/>`;
  for (const g of segs) {
    const a = Math.max(0, x(g.a)), b = Math.min(SW, x(g.b));
    if (b <= a) continue;
    s += `<rect x="${a.toFixed(2)}" y="0" width="${(b - a).toFixed(2)}" height="${h}" ` +
         `fill="${col(g.c)}"${g.guess ? ' fill-opacity=".5"' : ''}/>`;
  }
  return s + '</svg>';
}

const HOUR_AXIS = '<div class="bandax">' +
  [0, 6, 12, 18, 24].map(h => `<span>${h}</span>`).join('') + '</div>';

/* ------------------------------------------------------- 全區的圖表 --- */
function axisY(max, x, y0, y1, ticks) {
  let s = '';
  for (let i = 0; i <= ticks; i++) {
    const v = Math.round(max * i / ticks);
    const y = y1 - (y1 - y0) * i / ticks;
    s += `<line class="ax" x1="${x}" y1="${y.toFixed(1)}" x2="${SW}" y2="${y.toFixed(1)}"/>`;
    s += `<text class="axt" x="${x - 3}" y="${(y + 3).toFixed(1)}" text-anchor="end">${v}</text>`;
  }
  return s;
}

function chartHourly(events) {
  const buckets = Array.from({ length: 24 }, () => ({ V: 0, M: 0, I: 0, N: 0 }));
  let total = 0;
  for (const e of events) {
    if (e.t !== 'team') continue;
    const h = new Date(e.at).getHours();
    if (buckets[h][e.to] !== undefined) { buckets[h][e.to]++; total++; }
  }
  if (!total) return { svg: '', total: 0, peak: null };

  const H = 130, L = 28, T = 8, B = 18;
  const max = Math.max(1, ...buckets.map(b => b.V + b.M + b.I + b.N));
  const bw = (SW - L) / 24;

  let bars = '';
  buckets.forEach((b, h) => {
    let y = H - B;
    const x = L + h * bw;
    for (const c of ORDER) {
      if (!b[c]) continue;
      const hh = (b[c] / max) * (H - B - T);
      y -= hh;
      bars += `<rect x="${(x + 0.6).toFixed(1)}" y="${y.toFixed(1)}" ` +
              `width="${(bw - 1.2).toFixed(1)}" height="${hh.toFixed(1)}" fill="${col(c)}"/>`;
    }
    if (h % 3 === 0) bars += `<text class="axt" x="${(x + bw / 2).toFixed(1)}" y="${H - 6}" ` +
                             `text-anchor="middle">${h}</text>`;
  });

  let peakH = 0, peakN = -1;
  buckets.forEach((b, h) => {
    const n = b.V + b.M + b.I + b.N;
    if (n > peakN) { peakN = n; peakH = h; }
  });
  return {
    svg: `<svg viewBox="0 0 ${SW} ${H}" class="chart">${axisY(max, L, T, H - B, 2)}${bars}</svg>`,
    total, peak: { h: peakH, n: peakN }
  };
}

function chartShare(stats) {
  if (!stats || stats.length < 2) return '';
  const H = 130, L = 28, T = 8, B = 18;
  const t0 = stats[0].t, t1 = stats[stats.length - 1].t;
  const span = Math.max(1, t1 - t0);
  const max = Math.max(...stats.map(s => s.V + s.M + s.I + s.N));
  const x = t => L + ((t - t0) / span) * (SW - L);
  const y = v => (H - B) - (v / max) * (H - B - T);

  let areas = '';
  const base = stats.map(() => 0);
  for (const c of ORDER) {
    const top = stats.map((s, i) => base[i] + s[c]);
    const up = stats.map((s, i) => `${x(s.t).toFixed(1)},${y(top[i]).toFixed(1)}`).join(' ');
    const down = stats.map((s, i) => `${x(s.t).toFixed(1)},${y(base[i]).toFixed(1)}`)
                      .reverse().join(' ');
    areas += `<polygon points="${up} ${down}" fill="${col(c)}" fill-opacity=".85"/>`;
    stats.forEach((s, i) => { base[i] = top[i]; });
  }
  let ticks = '';
  const d0 = new Date(t0);
  for (let h = 0; h <= 24; h += 6) {
    const tt = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate(), h).getTime();
    if (tt < t0 || tt > t1) continue;
    ticks += `<text class="axt" x="${x(tt).toFixed(1)}" y="${H - 6}" text-anchor="middle">${h}</text>`;
  }
  return `<svg viewBox="0 0 ${SW} ${H}" class="chart">` +
         axisY(max, L, T, H - B, 2) + areas + ticks + `</svg>`;
}

/* --------------------------------------------------------- popup 內容 --- */
function gymName(id) {
  const g = (state.wGyms || []).find(x => x.id === id);
  return g ? g.n : '(未知道館)';
}
function gymItem(id) {
  return state.pub.find(x => x.k === 'gym' && x.id === id) || null;
}

// 日期下拉。清單來自 /days（Worker 保留 30 天），今天一定會在裡面。
function dateSelect(date) {
  const list = (A.dates && A.dates.length ? A.dates.slice() : []);
  if (!list.includes(today())) list.push(today());
  // 目前在看的日期一定要在清單裡，否則下拉會顯示成別的日期，跟內容對不上
  if (date && !list.includes(date)) list.push(date);
  list.sort().reverse();                       // ISO 日期字串的字典序＝時間序
  return `<select class="gadate">` + list.map(d =>
    `<option value="${d}"${d === date ? ' selected' : ''}>${d === today() ? '今天' : d}</option>`
  ).join('') + `</select>`;
}

function gymPanelHtml(id, date) {
  const it = gymItem(id);
  const segs = timelineFor(id, it && it.team, date);
  const entry = A.cache.get(date);
  const evs = (entry && entry.byGym.get(id)) || [];

  let h = `<div class="gahead"><span>顏色變化</span>${dateSelect(date)}</div>`;

  if (!segs.length) {
    return h + `<div class="gamsg">這一天沒有易主紀錄${
      date === today() ? '' : '，也無法推定當天的顏色'}。</div>`;
  }

  h += `<div class="gamsg">易主 <b>${evs.length}</b> 次</div>`;
  h += band(segs, 16, date) + HOUR_AXIS;

  const tot = segTotals(segs);
  h += '<div class="galeg">' + ORDER.filter(c => tot[c] > 0).map(c =>
    `<span><i style="background:${col(c)}"></i>${tname(c)} ${dur(tot[c])}</span>`).join('') + '</div>';

  if (evs.length) {
    h += '<div class="galist">' + evs.slice(-6).reverse().map(e =>
      `<div><span class="at">${hhmm(e.at)}</span>
        <i class="adot" style="background:${col(e.from)}"></i>→<i class="adot"
        style="background:${col(e.to)}"></i> ${tname(e.from)} → ${tname(e.to)}</div>`).join('') +
      (evs.length > 6 ? `<div class="more">…共 ${evs.length} 次</div>` : '') + '</div>';
  }
  if (segs.some(s => s.guess)) h += '<div class="more">半透明＝推定的區段</div>';
  return h;
}

/* ------------------------------------------------- 掛進道館的 popup --- */
// ⚠ 千萬不能呼叫 popup.update()。Leaflet 的 DivOverlay.update() 會走到
//   _updateContent()，而那一行是 `node.innerHTML = this._content` ——
//   用「原本 setContent 傳進去的那份字串」把整個內容重寫一次，
//   我們剛填進 .gymana 的東西會被洗掉，畫面又變回預設文字。
//   只呼叫重算版面/位置的那幾個，它們不碰內容。
function reflow(popup) {
  if (!popup) return;
  try {
    if (popup._updateLayout) popup._updateLayout();
    if (popup._updatePosition) popup._updatePosition();
    if (popup._adjustPan) popup._adjustPan();
  } catch (e) { /* Leaflet 內部 API，換版本失效就算了，不影響內容 */ }
}

function fillGymana(el, popup) {
  if (!el || !el.dataset.id) return;
  const id = el.dataset.id;
  A.date = A.date || today();

  const draw = () => {
    // 填之前再確認一次：使用者可能已經點去別的道館了
    if (el.dataset.id !== id || !el.isConnected) return;
    el.innerHTML = gymPanelHtml(id, A.date);
    const sel = el.querySelector('.gadate');
    if (sel) sel.addEventListener('change', ev => {
      A.date = ev.target.value;
      el.innerHTML = `<div class="gamsg">載入 ${A.date} 的紀錄…</div>`;
      reflow(popup);
      ensureDay(A.date).then(draw);
      syncSidebarDate();
    });
    reflow(popup);
  };

  const entry = A.cache.get(A.date);
  const fresh = entry && (A.date !== today() || Date.now() - entry.at < HIST_TTL);
  if (fresh && A.dates) { draw(); return; }

  el.innerHTML = '<div class="gamsg">載入變化紀錄…</div>';
  Promise.all([ensureDates(), ensureDay(A.date)]).then(draw);
}

function hookPopup() {
  // 用 app.js 明確呼叫的 window.onPopupOpened，而不是 map 的 'popupopen' 事件 ——
  // 整個網站共用同一個 popup 物件，那個事件只有第一次開啟會觸發。
  window.onPopupOpened = popup => {
    const root = popup && popup.getElement && popup.getElement();
    if (root) fillGymana(root.querySelector('.gymana'), popup);
  };
  // 備援：萬一有哪條路徑不是走 app.js 的 openPopup()。fillGymana 是冪等的。
  if (typeof map !== 'undefined' && map.on) {
    map.on('popupopen', ev => {
      const root = ev.popup && ev.popup.getElement && ev.popup.getElement();
      if (root) fillGymana(root.querySelector('.gymana'), ev.popup);
    });
  }
}

/* ----------------------------------------------------------- 側欄 --- */
function sectionTop() {
  const entry = A.cache.get(A.date);
  if (!entry) return '';
  const ranked = [...entry.byGym.entries()]
    .sort((a, b) => b[1].length - a[1].length).slice(0, 12);
  if (!ranked.length) return '';
  let h = `<h3 class="ah">易主最頻繁<span>點一下跳到地圖</span></h3>`;
  for (const [id, evs] of ranked) {
    h += `<div class="arow gofly" data-id="${esc(id)}">
            <span class="an">${esc(gymName(id))}</span><b>${evs.length} 次</b></div>`;
  }
  return h;
}

function render() {
  const box = $('#anaBody');
  if (!box) return;
  if (A.loading) { box.innerHTML = '<div class="empty">載入中…</div>'; return; }

  const entry = A.cache.get(A.date);
  // 還沒按「載入全區統計」時這裡是空的 —— 單一道館的分析在地圖的 popup 上
  if (!entry || A.statsDate !== A.date) { box.innerHTML = ''; return; }

  const hourly = chartHourly(entry.events);
  let h = '';
  if (!hourly.total) {
    h += `<div class="empty">${A.date} 還沒有易主紀錄。<br>
          Worker 是從部署那一刻才開始累積的，資料要跑一段時間才會有東西看。</div>`;
  } else {
    const raidN = entry.events.filter(e => e.t === 'raid').length;
    h += `<div class="asum"><b>${hourly.total}</b> 次易主
          <span>·</span> 最熱門 <b>${hourly.peak.h}:00</b>（${hourly.peak.n} 次）
          <span>·</span> ${entry.byGym.size} 個道館換過手
          <span>·</span> ${raidN} 次團體戰異動</div>`;
  }
  h += sectionTop();
  if (hourly.total) h += `<h3 class="ah">全區每小時易主<span>顏色＝被誰搶走</span></h3>${hourly.svg}`;
  if (A.stats && A.stats.length >= 2) {
    h += `<h3 class="ah">全區各隊佔領數<span>每 2 分鐘取樣</span></h3>${chartShare(A.stats)}`;
  }
  box.innerHTML = h;
  wire();
}

function wire() {
  for (const el of document.querySelectorAll('#anaBody .gofly')) {
    el.addEventListener('click', () => {
      const it = gymItem(el.dataset.id);
      if (!it) return;
      flyTo(it);
      map.once('moveend', () => openPopup([it.lat, it.lng], popupFor(it)));
    });
  }
}

// popup 上換了日期，側欄的下拉也跟著同步（兩邊共用 A.date，不要各說各話）
function syncSidebarDate() {
  const sel = $('#anaDate');
  if (sel && sel.value !== A.date) sel.value = A.date;
}

async function load(date) {
  A.date = date || A.date || today();
  syncSidebarDate();
  A.loading = true; render();
  try {
    const [, st] = await Promise.all([
      ensureDay(A.date),
      getJ('/stats?date=' + A.date).catch(() => [])
    ]);
    A.stats = st; A.statsDate = A.date;
  } catch (err) {
    toast('分析資料載入失敗：' + err.message);
  } finally {
    A.loading = false; render();
  }
}

/* --------------------------------------------------------------- UI --- */
function mount() {
  if (CFG.source === 'direct') return;      // direct 模式沒有 Worker，也就沒有歷史

  hookPopup();
  A.date = today();

  const panel = document.querySelector('#panel');
  if (!panel) return;

  const sec = document.createElement('section');
  sec.className = 'grp';
  sec.id = 'anaGrp';
  sec.innerHTML = `
    <h2>道館變化分析</h2>
    <div class="note" style="margin-top:0">點地圖上任何一個道館，
      它的資訊視窗裡就有當天的顏色變化時間軸，也可以在那邊直接換日期。</div>
    <div class="arow2">
      <select id="anaDate"><option value="">今天</option></select>
      <button type="button" id="anaLoad">載入全區統計</button>
    </div>
    <div id="anaBody"></div>`;

  // ★ 定位點不能用 #searchGrp：窄螢幕時 app.js 的 placeSearch() 會把它搬到
  //   #searchHost（浮在地圖上的搜尋列），此時它已經不是 #panel 的子節點，
  //   insertBefore 會丟例外，整段面板就不見了。#raidGrp 不會被搬動。
  const anchor = document.querySelector('#raidGrp');
  if (anchor && anchor.parentNode === panel) panel.insertBefore(sec, anchor);
  else panel.appendChild(sec);

  $('#anaLoad').addEventListener('click', () => load($('#anaDate').value || today()));
  $('#anaDate').addEventListener('change', e => { A.date = e.target.value || today(); });

  ensureDates().then(days => {
    const sel = $('#anaDate');
    if (!sel) return;
    sel.innerHTML = '';
    const list = days.slice();
    if (!list.includes(today())) list.unshift(today());
    for (const d of list) {
      const o = document.createElement('option');
      o.value = d; o.textContent = (d === today() ? '今天' : d);
      sel.appendChild(o);
    }
    sel.value = A.date;
  });

  // 寫進側欄最下面的 log。不用開 Console 就能確認這個模組有沒有跑起來。
  log('分析模組已就緒（點道館看時間軸）');
}

// 例外要自己接：classic script 丟出去的錯誤只會進 Console，
// 而使用者通常不會去看，結果就是 popup 一直顯示預設文字卻不知道為什麼。
function safeMount() {
  try { mount(); }
  catch (err) {
    if (typeof log === 'function') log('分析模組啟動失敗：' + err.message);
    console.error('analysis.js mount 失敗:', err);
  }
}

if (document.readyState === 'loading')
  document.addEventListener('DOMContentLoaded', safeMount);
else safeMount();

})();
