// ---------------------------------------------------------------------------
// 設定檔。要改設定只動這個檔案，其他都不用動。
// ---------------------------------------------------------------------------
window.APP_CONFIG = {

  // 資料來源：
  //   'direct' = 瀏覽器直接跟 Niantic 要（不用任何後端，GitHub Pages 直接就能動）
  //   網址字串 = 跟你的 Cloudflare Worker 要快照，例如：
  //              'https://taoyuan-map.你的帳號.workers.dev/data'
  source: 'direct',

  // 一般資料的更新間隔（秒）。0 = 不自動更新。
  // 這一趟「不帶 token」，抓道館 / 補給站 / 團體戰 / 活動。
  // 每次 5 個請求約 3.3 MB，120 秒約等於 100 MB/小時。
  // 網址加 ?refresh=300 可以臨時改成 5 分鐘（手機吃行動網路時好用）。
  refreshSec: 120,

  // 能量點（極巨化）的更新間隔（秒）。這一趟「會帶 token」，也就是會暴露帳號，
  // 所以間隔拉長、而且只在「能量點圖層有打開 + 有設定 token」時才會跑。
  powerRefreshSec: 300,

  // 每幾輪做一次「全區完整掃描」來發現新的能量點位置。
  // 其他輪只查已知有能量點的格子（通常 1 個請求就夠），把帶 token 的請求量壓到最低。
  // 12 輪 × 5 分鐘 = 每小時完整掃一次。
  powerFullSweepEvery: 12,

  // 預設底圖：'voyager'(亮，道路清楚) / 'light'(極簡亮) / 'dark'(暗) / 'satellite'(衛星)
  basemap: 'voyager',

  // 地圖初始位置（桃園車站附近）與縮放
  center: [25.0100, 121.2650],
  zoom: 13,

  // 補給站六千多個，縮太遠不畫，避免卡頓
  stopMinZoom: 14,
  // 放到這個倍率以上，補給站改用圖示（而不是小圓點）
  stopIconZoom: 17,

  // S2 網格預設 level（14 = 道館網格，17 = 補給站網格）
  gridLevel: 17,

  // 小人身上的兩個範圍圈（公尺）
  personRadius: [40, 80],

  // ---- 以下通常不用改 ----
  api: 'https://niantic-social-api.nianticlabs.com/graphql',
  realityChannelId: 'da83476a-c4da-4312-a610-a4f2fc2c37f0',
  s2CellLevel: 14,   // 實測 12/13 會漏 70~95% 的物件，一定要用 14
  batchSize: 200,    // 一個請求帶幾個 cell（實測 400 也安全）
  parallel: 3        // 同時最多幾個請求在飛
};
