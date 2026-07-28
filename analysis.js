/* ---------------------------------------------------------------------------
   道館變化分析面板。

   主軸是「單一道館在一天之內，什麼時段被什麼顏色佔據」——
   把變化事件重建成連續的時間區段，畫成 24 小時的色帶。

   資料全部來自 Worker（direct 模式沒有歷史可分析，面板會自動隱藏）：
     /history?date= 當天所有變化事件 → 每個道館的時間軸
     /stats?date=   每 2 分鐘一筆的隊伍佔領數 → 全區趨勢
     /days          有哪些日子留著紀錄
     /state         目前狀態（app.js 已經抓好放在 state.pub）

   圖表是手寫 SVG，沒有引入任何圖表函式庫 —— 這個網站本來就對手機效能
   很敏感（見 config.js 那一串效能設定），沒必要為了幾條色帶多載一包 JS。

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
const SW = 320;          // SVG viewBox 寬度，實際寬度由 CSS 撐滿側欄

const A = {
  date: null, events: null, stats: null, loading: false,
  byGym: new Map(),      // 道館 id -> 當天的易主事件（已排序）
  pick: null,            // 目前選中的道館 id
  q: ''                  // 搜尋字串
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

/* ------------------------------------------------ 重建單一道館的時間軸 ---
   事件只記錄「換手的瞬間」，要畫色帶就得補回中間的區段：
     第一筆事件之前 → 用那筆的 from（誰被搶走的，就是先前的佔領者）
     兩筆事件之間   → 用前一筆的 to
     最後一筆之後   → 用最後一筆的 to，一路延伸到當天結束（或現在）
   當天完全沒有事件的道館，就只能用「現在的顏色」推定整天，標成半透明。 */
function timelineFor(gymId, currentTeam) {
  const t0 = dayStart(A.date);
  const end = Math.min(t0 + DAY, Date.now());
  if (end <= t0) return [];
  const evs = A.byGym.get(gymId);

  if (!evs || !evs.length) {
    // 過去的日期不能拿今天的顏色來推——中間可能換過好幾手
    if (A.date !== today() || !currentTeam) return [];
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
// 這樣不管側欄多寬都剛好填滿，時間刻度另外用 HTML 排在下面。
function band(segs, h) {
  const t0 = dayStart(A.date);
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
  if (stats.length < 2) return '';
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

/* ----------------------------------------------------------- 各區塊 --- */
function gymName(id) {
  const g = (state.wGyms || []).find(x => x.id === id);
  return g ? g.n : '(未知道館)';
}
function gymItem(id) {
  return state.pub.find(x => x.k === 'gym' && x.id === id) || null;
}

function sectionDetail() {
  let h = `<h3 class="ah">道館時間軸<span>${A.date}</span></h3>
    <input type="search" id="anaQ" placeholder="搜尋道館名稱…" value="${esc(A.q)}"
           autocomplete="off">`;

  // 搜尋中：列出符合的道館讓使用者挑
  if (A.q) {
    const q = A.q.toLowerCase();
    const hits = (state.wGyms || []).filter(g => g.n.toLowerCase().includes(q)).slice(0, 12);
    h += hits.length
      ? hits.map(g => `<div class="arow pick" data-id="${esc(g.id)}">
           <span class="an">${esc(g.n)}</span>
           <b>${(A.byGym.get(g.id) || []).length} 次</b></div>`).join('')
      : '<div class="empty">找不到符合的道館。</div>';
  }

  if (!A.pick) {
    if (!A.q) h += '<div class="empty">搜尋道館名稱，或點下面清單裡的任一個。</div>';
    return h;
  }

  const it = gymItem(A.pick);
  const segs = timelineFor(A.pick, it && it.team);
  const evs = A.byGym.get(A.pick) || [];

  h += `<div class="apick"><span class="an">${esc(gymName(A.pick))}</span>` +
       (it ? `<button type="button" class="mini" id="anaFly">定位 ↗</button>` : '') + `</div>`;

  if (!segs.length) {
    h += `<div class="empty">${A.date} 這個道館沒有易主紀錄，也無法推定當天的顏色。</div>`;
    return h;
  }

  h += band(segs, 22) + HOUR_AXIS;

  const tot = segTotals(segs);
  h += '<div class="alegend">' + ORDER.filter(c => tot[c] > 0).map(c =>
    `<span><i style="background:${col(c)}"></i>${tname(c)} ${dur(tot[c])}</span>`).join('') +
    `</div><div class="asum">當天易主 <b>${evs.length}</b> 次</div>`;

  if (segs.some(s => s.guess)) {
    h += `<div class="note">半透明的區段是推定的——當天第一次易主之前的顏色，
          只能從那筆事件的「被誰搶走」反推。</div>`;
  }

  // 逐筆事件，最新的在上面
  if (evs.length) {
    h += '<div class="alist">' + evs.slice().reverse().map(e =>
      `<div class="arow"><span class="at">${hhmm(e.at)}</span>
       <i class="adot" style="background:${col(e.from)}"></i>→
       <i class="adot" style="background:${col(e.to)}"></i>
       <span class="an">${tname(e.from)} → ${tname(e.to)}</span></div>`).join('') + '</div>';
  }
  return h;
}

function sectionOverview() {
  const ranked = [...A.byGym.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 15);
  if (!ranked.length) return '';
  let h = `<h3 class="ah">各道館的時段佔據<span>易主最多的 ${ranked.length} 個</span></h3>`;
  for (const [id, evs] of ranked) {
    const it = gymItem(id);
    h += `<div class="astrip pick" data-id="${esc(id)}">
            <div class="atop"><span class="an">${esc(gymName(id))}</span><b>${evs.length} 次</b></div>
            ${band(timelineFor(id, it && it.team), 12)}
          </div>`;
  }
  return h + HOUR_AXIS;
}

/* ------------------------------------------------------------- 繪製 --- */
function render() {
  const box = $('#anaBody');
  if (!box) return;
  if (A.loading) { box.innerHTML = '<div class="empty">載入中…</div>'; return; }
  if (!A.events) { box.innerHTML = '<div class="empty">按「載入」開始分析。</div>'; return; }

  const hourly = chartHourly(A.events);
  let h = '';

  if (!hourly.total) {
    h += `<div class="empty">${A.date} 還沒有易主紀錄。<br>
          Worker 是從部署那一刻才開始累積的，資料要跑一段時間才會有東西看。</div>`;
  } else {
    const raidN = A.events.filter(e => e.t === 'raid').length;
    h += `<div class="asum"><b>${hourly.total}</b> 次易主
          <span>·</span> 最熱門 <b>${hourly.peak.h}:00</b>（${hourly.peak.n} 次）
          <span>·</span> ${A.byGym.size} 個道館換過手
          <span>·</span> ${raidN} 次團體戰異動</div>`;
  }

  h += sectionDetail();
  h += sectionOverview();

  if (hourly.total) h += `<h3 class="ah">全區每小時易主<span>顏色＝被誰搶走</span></h3>${hourly.svg}`;
  if (A.stats && A.stats.length >= 2) {
    h += `<h3 class="ah">全區各隊佔領數<span>每 2 分鐘取樣</span></h3>${chartShare(A.stats)}`;
  }

  box.innerHTML = h;
  wire();
}

function wire() {
  const q = $('#anaQ');
  if (q) {
    q.addEventListener('input', e => {
      A.q = e.target.value;
      const pos = e.target.selectionStart;
      render();
      const nq = $('#anaQ');
      if (nq) { nq.focus(); nq.setSelectionRange(pos, pos); }
    });
  }
  for (const el of document.querySelectorAll('#anaBody .pick')) {
    el.addEventListener('click', () => { A.pick = el.dataset.id; A.q = ''; render(); });
  }
  const fly = $('#anaFly');
  if (fly) fly.addEventListener('click', ev => {
    ev.stopPropagation();
    const it = gymItem(A.pick);
    if (it) flyTo(it);
  });
}

async function load(date) {
  A.date = date || A.date || today();
  A.loading = true; render();
  try {
    const [ev, st] = await Promise.all([
      getJ('/history?date=' + A.date).catch(e => { log('分析：' + e.message); return []; }),
      getJ('/stats?date=' + A.date).catch(() => [])
    ]);
    A.events = ev; A.stats = st;

    // 依道館分組，方便畫每一條時間軸
    A.byGym = new Map();
    for (const e of ev) {
      if (e.t !== 'team') continue;
      if (!A.byGym.has(e.id)) A.byGym.set(e.id, []);
      A.byGym.get(e.id).push(e);
    }
    for (const list of A.byGym.values()) list.sort((a, b) => a.at - b.at);
  } catch (err) {
    toast('分析資料載入失敗：' + err.message);
    A.events = A.events || [];
  } finally {
    A.loading = false; render();
  }
}

/* --------------------------------------------------------------- UI --- */
function mount() {
  if (CFG.source === 'direct') return;      // direct 模式沒有 Worker，也就沒有歷史

  const panel = document.querySelector('#panel');
  const anchor = document.querySelector('#searchGrp');
  if (!panel || !anchor) return;

  const sec = document.createElement('section');
  sec.className = 'grp';
  sec.id = 'anaGrp';
  sec.innerHTML = `
    <h2>道館變化分析</h2>
    <div class="arow2">
      <select id="anaDate"><option value="">今天</option></select>
      <button type="button" id="anaLoad">載入</button>
    </div>
    <div id="anaBody"><div class="empty">按「載入」開始分析。</div></div>`;
  panel.insertBefore(sec, anchor);

  $('#anaLoad').addEventListener('click', () => load($('#anaDate').value || today()));

  getJ('/days').then(days => {
    const sel = $('#anaDate');
    for (const d of days.slice().reverse()) {
      const o = document.createElement('option');
      o.value = d; o.textContent = (d === today() ? d + '（今天）' : d);
      sel.appendChild(o);
    }
  }).catch(() => { /* Worker 還是舊版就沒有這個端點，靜靜略過 */ });
}

if (document.readyState === 'loading')
  document.addEventListener('DOMContentLoaded', mount);
else mount();

})();
