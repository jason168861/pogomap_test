/* ---------------------------------------------------------------------------
   道館變化分析面板。

   資料全部來自 Worker（direct 模式沒有歷史可分析，面板會自動隱藏）：
     /stats?date=   每 2 分鐘一筆的隊伍佔領數 → 趨勢圖
     /history?date= 當天所有變化事件         → 時段分布、排行
     /days          有哪些日子留著紀錄
     /state         目前狀態（含每個道館的佔領起始時間）→ 佔領時長排行

   圖表是手寫 SVG，沒有引入任何圖表函式庫 —— 這個網站本來就對手機效能
   很敏感（見 config.js 那一串效能設定），沒必要為了兩張圖多載一包 JS。

   時間一律用瀏覽器本地時間分組，跟 Worker 那邊的台灣時間切檔一致
   （前提是你人在台灣；出國看的話時段分布會偏移）。
--------------------------------------------------------------------------- */
'use strict';

(function () {

const TEAM_KEY = { V: 'VALOR', M: 'MYSTIC', I: 'INSTINCT', N: 'NEUTRAL' };
const ORDER = ['V', 'M', 'I', 'N'];
const col = c => (TEAM[TEAM_KEY[c]] || TEAM.NEUTRAL).c;
const tname = c => (TEAM[TEAM_KEY[c]] || TEAM.NEUTRAL).n;

const A = { date: null, events: null, stats: null, loading: false };

function today() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function getJ(path) {
  const res = await fetch(workerBase() + path);
  if (!res.ok) throw new Error(path.split('?')[0] + ' HTTP ' + res.status);
  return res.json();
}

/* ------------------------------------------------------------ SVG 工具 --- */
const SW = 320;   // 所有圖表共用的 viewBox 寬度，實際顯示寬度由 CSS 撐滿

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

/* --------------------------------------------- 圖一：每小時易主次數 --- */
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
    if (h % 3 === 0) {
      bars += `<text class="axt" x="${(x + bw / 2).toFixed(1)}" y="${H - 6}" ` +
              `text-anchor="middle">${h}</text>`;
    }
  });

  // 最活躍的時段
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

/* ------------------------------------------- 圖二：各隊佔領數趨勢 --- */
function chartShare(stats) {
  if (stats.length < 2) return '';
  const H = 130, L = 28, T = 8, B = 18;
  const t0 = stats[0].t, t1 = stats[stats.length - 1].t;
  const span = Math.max(1, t1 - t0);
  const totalMax = Math.max(...stats.map(s => s.V + s.M + s.I + s.N));

  const x = t => L + ((t - t0) / span) * (SW - L);
  const y = v => (H - B) - (v / totalMax) * (H - B - T);

  // 由下往上堆疊，每一層畫成封閉多邊形
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

  // x 軸每 6 小時一個刻度
  let ticks = '';
  const d0 = new Date(t0);
  for (let h = 0; h <= 24; h += 6) {
    const tt = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate(), h).getTime();
    if (tt < t0 || tt > t1) continue;
    ticks += `<text class="axt" x="${x(tt).toFixed(1)}" y="${H - 6}" text-anchor="middle">${h}</text>`;
  }

  return `<svg viewBox="0 0 ${SW} ${H}" class="chart">` +
         axisY(totalMax, L, T, H - B, 2) + areas + ticks + `</svg>`;
}

/* ------------------------------------------------------------- 排行 --- */
function topFlips(events, names) {
  const cnt = new Map();
  for (const e of events) {
    if (e.t !== 'team') continue;
    cnt.set(e.id, (cnt.get(e.id) || 0) + 1);
  }
  return [...cnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([id, n]) => ({ id, n, name: names.get(id) || '(未知道館)' }));
}

function topHold(items) {
  const now = Date.now();
  return items.filter(i => i.k === 'gym' && i.since)
    .sort((a, b) => a.since - b.since).slice(0, 10)
    .map(i => ({ id: i.id, name: i.n, team: i.team, ms: now - i.since,
                 approx: state.since0 && i.since <= state.since0 + 60000 }));
}

/* ------------------------------------------------------------- 繪製 --- */
function row(html) { return `<div class="arow">${html}</div>`; }

function render() {
  const box = $('#anaBody');
  if (!box) return;

  if (A.loading) { box.innerHTML = '<div class="empty">載入中…</div>'; return; }
  if (!A.events) {
    box.innerHTML = '<div class="empty">按上面的「載入」開始分析。</div>';
    return;
  }

  const names = new Map((state.wGyms || []).map(g => [g.id, g.n]));
  const hourly = chartHourly(A.events);
  const gyms = state.pub.filter(i => i.k === 'gym');

  let h = '';

  if (!hourly.total) {
    h += `<div class="empty">${A.date} 還沒有易主紀錄。<br>
          Worker 是從部署那一刻才開始累積的，資料要跑一段時間才會有東西看。</div>`;
  } else {
    const raidN = A.events.filter(e => e.t === 'raid').length;
    h += `<div class="asum">
            <b>${hourly.total}</b> 次易主
            <span>·</span> 最熱門 <b>${hourly.peak.h}:00</b>（${hourly.peak.n} 次）
            <span>·</span> ${raidN} 次團體戰異動
          </div>`;
    h += `<h3 class="ah">每小時易主次數<span>顏色＝被誰搶走</span></h3>${hourly.svg}`;
  }

  if (A.stats && A.stats.length >= 2) {
    h += `<h3 class="ah">各隊佔領數趨勢<span>每 2 分鐘取樣</span></h3>${chartShare(A.stats)}`;
    const last = A.stats[A.stats.length - 1];
    h += `<div class="alegend">` + ORDER.map(c =>
      `<span><i style="background:${col(c)}"></i>${tname(c)} ${last[c]}</span>`).join('') + `</div>`;
  }

  const flips = topFlips(A.events, names);
  if (flips.length) {
    h += `<h3 class="ah">易主最頻繁<span>${A.date}</span></h3>`;
    h += flips.map(f => row(
      `<span class="an">${esc(f.name)}</span><b>${f.n} 次</b>`)).join('');
  }

  const holds = topHold(gyms);
  if (holds.length) {
    h += `<h3 class="ah">佔領最久<span>目前</span></h3>`;
    h += holds.map(t => row(
      `<i class="adot" style="background:${(TEAM[t.team] || TEAM.NEUTRAL).c}"></i>` +
      `<span class="an">${esc(t.name)}</span>` +
      `<b>${t.approx ? '≥' : ''}${dur(t.ms)}</b>`)).join('');
    if (holds.some(t => t.approx)) {
      h += `<div class="note">「≥」表示監控開始前就已經是那個顏色，實際時間只會更久。</div>`;
    }
  }

  box.innerHTML = h;
}

async function load(date) {
  A.date = date || A.date || today();
  A.loading = true; render();
  try {
    // 兩份分開抓，其中一份掛掉不影響另一份
    const [ev, st] = await Promise.all([
      getJ('/history?date=' + A.date).catch(e => { log('分析：' + e.message); return []; }),
      getJ('/stats?date=' + A.date).catch(() => [])
    ]);
    A.events = ev; A.stats = st;
  } catch (err) {
    toast('分析資料載入失敗：' + err.message);
    A.events = A.events || [];
  } finally {
    A.loading = false; render();
  }
}

/* --------------------------------------------------------------- UI --- */
function mount() {
  // direct 模式沒有 Worker，也就沒有歷史資料可分析
  if (CFG.source === 'direct') return;

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

  // 有哪些日子留著紀錄（保留 30 天）
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
