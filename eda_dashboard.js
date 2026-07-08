/* =====================================================================================
   EDA ANALYSIS — FULLY CLIENT-SIDE (PapaParse + Chart.js), ZERO BACKEND DEPENDENCY
   =====================================================================================
   Faithful JavaScript translation of `pricing_features_eda.py` (Colab export). Every
   pandas groupby/resample step, feature-engineering formula, and matplotlib/seaborn
   chart in that script has a corresponding block below — see the section comments,
   which mirror the "## N. <Title>" markdown headers in the Python source.

   Loads Pricing_Features.csv (client-side, via PapaParse) — no Flask/app.py, no
   server round-trip of any kind. Everything from CSV parsing through feature
   engineering, daily/weekly/monthly aggregation, and all 13 chart renders happens
   in the browser.
   ===================================================================================== */
(function(){
  'use strict';

  const CSV_PATH = 'Pricing_Features.csv';

  // ---------- STATE ----------
  let RAW = [];        // one row per (SKU, date) — after feature engineering (mirrors `df` in Python)
  let DAILY = [];       // grouped by (date, Short Code, Segment)      — mirrors `daily_sku`
  let WEEKLY = [];       // grouped by (year_week, Short Code, Segment) — mirrors `weekly_sku`
  let MONTHLY = [];      // grouped by (year_month, Short Code, Segment)— mirrors `monthly_sku`
  let edaanLoaded = false;
  let edaanLoading = false;
  const edaanCharts = {}; // Chart.js instances keyed by canvas id, so we can destroy+recreate on filter change

  // ================================================================================
  // 1. LOAD DATA  (mirrors "## 2. Load Data" — pd.read_excel -> Papa.parse)
  // ================================================================================
  function initEdaAnalysisTab(){
    if(edaanLoaded){ renderAllEdaanCharts(); return; }
    if(edaanLoading) return;
    edaanLoading = true;
    setEdaanStatus('Loading dataset…');
    Papa.parse(CSV_PATH, {
      download: true,
      header: true,
      dynamicTyping: true,
      skipEmptyLines: true,
      complete: function(results){
        try{
          if(results.errors && results.errors.length){
            console.warn('PapaParse reported', results.errors.length, 'row-level issue(s):', results.errors.slice(0,5));
          }
          RAW = engineerFeatures(results.data);
          buildAggregates();
          edaanLoaded = true;
          edaanLoading = false;
          populateEdaanFilterOptions();
          setEdaanStatus(summarizeDataset(RAW));
          renderAllEdaanCharts();
        } catch(err){
          edaanLoading = false;
          console.error('EDA Analysis: failed to process dataset', err);
          setEdaanStatus('Failed to process dataset — see browser console for details.');
        }
      },
      error: function(err){
        edaanLoading = false;
        console.error('EDA Analysis: failed to fetch/parse CSV', err);
        setEdaanStatus('Failed to load Pricing_Features.csv — see browser console for details.');
      }
    });
  }
  window.initEdaAnalysisTab = initEdaAnalysisTab;

  function setEdaanStatus(msg){
    const el = document.getElementById('edaanDataStatus');
    if(el) el.textContent = msg;
  }

  function summarizeDataset(rows){
    if(!rows.length) return 'Dataset loaded, but 0 usable rows.';
    const skus = new Set(rows.map(r => r['Short Code'])).size;
    const dates = rows.map(r => r.date).sort();
    return `Loaded ${rows.length.toLocaleString()} rows · ${skus} SKUs · ${dates[0]} → ${dates[dates.length-1]}`;
  }

  // ================================================================================
  // 4. FEATURE ENGINEERING (mirrors "## 4. Feature Engineering")
  // Calendar, pricing, availability/ranking, and budget/distribution/share features,
  // plus the `festival_phase` classifier. Lag/rolling features (qty_lag_1, qty_lag_7,
  // ptc_lag_1, qty_7d_avg, qty_30d_avg) are intentionally omitted — none of the 13
  // charts below reference them, so replicating them client-side would add real
  // computational cost (per-SKU sort + shift/rolling windows) for zero visual payoff.
  // ================================================================================
  function engineerFeatures(rows){
    const out = [];
    for(const r of rows){
      if(!r || !r['date'] || !r['Short Code']) continue; // skip blank trailing rows etc.
      const dateStr = normalizeDateStr(r['date']);
      if(!dateStr) continue;
      const d = new Date(dateStr + 'T00:00:00Z');
      const year = d.getUTCFullYear();
      const month = d.getUTCMonth() + 1;
      const day = d.getUTCDate();
      const jsDow = d.getUTCDay();               // 0=Sun...6=Sat
      const pyDow = (jsDow + 6) % 7;              // 0=Mon...6=Sun (matches pandas dt.dayofweek)
      const isWeekend = (pyDow === 5 || pyDow === 6) ? 1 : 0;
      const isFirstWeek = day <= 7 ? 1 : 0;
      const yearWeek = `${year}-W${String(strftimeU(d)).padStart(2,'0')}`;
      const yearMonth = `${year}-${String(month).padStart(2,'0')}`;
      const quarter = Math.ceil(month / 3);

      const MRP = num(r['MRP']);
      const PTC = num(r['PTC']);
      const Comp_ptc = num(r['Comp_ptc']);
      const Store_Count = num(r['Store_Count']);
      const total_qty_sold = num(r['total_qty_sold']);
      const overall_marketing_budget = num(r['overall_marketing_budget']);
      const unique_cities = num(r['unique_cities']);
      const Category_Units = num(r['Category_Units']);
      const Segment_Units = num(r['Segment_Units']);

      const discount_pct = safeDiv(MRP !== 0 ? (MRP - PTC) : null, MRP);
      const ptc_gap_vs_comp = (PTC != null && Comp_ptc != null) ? (PTC - Comp_ptc) : null;
      const ptc_gap_pct_vs_comp = (Comp_ptc !== 0 && Comp_ptc != null && PTC != null) ? (PTC - Comp_ptc) / Comp_ptc : null;
      const budget_per_store = safeDiv(overall_marketing_budget, Store_Count);
      const qty_per_store = safeDiv(total_qty_sold, Store_Count);
      const qty_per_city = safeDiv(total_qty_sold, unique_cities);
      const budget_per_unit = safeDiv(overall_marketing_budget, total_qty_sold);
      const category_share_proxy = safeDiv(total_qty_sold, Category_Units);
      const segment_share_proxy = safeDiv(total_qty_sold, Segment_Units);

      const Is_Fest = num(r['Is_Fest']) || 0;
      const Pre_Fest = num(r['Pre_Fest']) || 0;
      const Post_Fest = num(r['Post_Fest']) || 0;
      const festival_phase = Is_Fest === 1 ? 'Festival' : (Pre_Fest === 1 ? 'Pre-Festival' : (Post_Fest === 1 ? 'Post-Festival' : 'Normal'));
      // msl_flag — binary encoding of the `msl/non-msl` string column, needed by the
      // Feature Correlation Matrix (Pearson correlation only works on numeric fields).
      const msl_flag = String(r['msl/non-msl']).trim().toLowerCase() === 'msl' ? 1 : 0;

      out.push({
        item_id: r['item_id'], item_name: r['item_name'],
        'Short Code': r['Short Code'], 'Segment': r['Segment'],
        'Variant Name': r['Variant Name'], 'Variant': r['Variant'],
        'msl/non-msl': r['msl/non-msl'], msl_flag,
        date: dateStr, year, month, day, quarter,
        year_week: yearWeek, year_month: yearMonth,
        is_weekend: isWeekend, is_first_week: isFirstWeek,
        total_qty_sold, unique_cities, MRP, PTC,
        Comp_sku: r['Comp_sku'], Comp_ptc,
        Sku_Ranking: num(r['Sku_Ranking']), Comp_Ranking: num(r['Comp_Ranking']),
        overall_marketing_budget, Store_Count,
        Category_Units, Market_Share: num(r['Market_Share']),
        OSA_SKU: num(r['OSA_SKU']), OSA_Comp: num(r['OSA_Comp']),
        Segment_Units, Segment_Sku_Count: num(r['Segment_Sku_Count']),
        Is_Fest, Pre_Fest, Post_Fest, festival_phase,
        discount_pct, ptc_gap_vs_comp, ptc_gap_pct_vs_comp,
        budget_per_store, qty_per_store, qty_per_city, budget_per_unit,
        category_share_proxy, segment_share_proxy
      });
    }
    return out;
  }

  function num(v){
    if(v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  function safeDiv(numerator, denominator){
    if(numerator === null || denominator === null || denominator === 0) return null;
    return numerator / denominator;
  }
  function normalizeDateStr(v){
    if(v instanceof Date) return ymd(v);
    const s = String(v).trim();
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if(m) return `${m[1]}-${m[2]}-${m[3]}`;
    const parsed = new Date(s);
    return Number.isNaN(parsed.getTime()) ? null : ymd(parsed);
  }
  function ymd(d){ return d.toISOString().slice(0,10); }

  // strftime("%U") — week number with Sunday as first day of week; all days before the
  // year's first Sunday are week 0. Matches pandas' `date.dt.strftime("%Y-W%U")` exactly
  // (which is deliberately NOT the same as ISO week numbering).
  function strftimeU(d){
    const jan1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const jan1Dow = jan1.getUTCDay(); // 0=Sun
    const dayOfYear = Math.round((d - jan1) / 86400000);
    const firstSundayIndex = (7 - jan1Dow) % 7;
    if(dayOfYear < firstSundayIndex) return 0;
    return Math.floor((dayOfYear - firstSundayIndex) / 7) + 1;
  }

  // ================================================================================
  // GENERIC GROUPBY/AGG ENGINE — the JS stand-in for pandas .groupby().agg({...})
  // ================================================================================
  function aggregate(rows, keyFields, aggDict){
    const groups = new Map();
    for(const r of rows){
      const key = keyFields.map(k => r[k]).join('');
      let bucket = groups.get(key);
      if(!bucket){ bucket = []; groups.set(key, bucket); }
      bucket.push(r);
    }
    const out = [];
    for(const bucket of groups.values()){
      const obj = {};
      keyFields.forEach(k => obj[k] = bucket[0][k]);
      for(const field in aggDict){
        const how = aggDict[field];
        const vals = [];
        for(const r of bucket){ const v = r[field]; if(v !== null && v !== undefined && !Number.isNaN(v)) vals.push(v); }
        if(how === 'sum') obj[field] = vals.reduce((a,b)=>a+b, 0);
        else if(how === 'mean') obj[field] = vals.length ? vals.reduce((a,b)=>a+b, 0) / vals.length : null;
        else if(how === 'max') obj[field] = vals.length ? Math.max(...vals) : null;
      }
      out.push(obj);
    }
    return out;
  }
  function sortByX(xField){ return (a,b) => a[xField] < b[xField] ? -1 : (a[xField] > b[xField] ? 1 : 0); }

  // ---------- 7/8/9. DAILY / WEEKLY / MONTHLY AGGREGATION DICTS (mirror the Python dicts exactly) ----------
  const DAILY_AGG = {
    total_qty_sold:'sum', PTC:'mean', Comp_ptc:'mean', MRP:'mean', discount_pct:'mean',
    overall_marketing_budget:'mean', Sku_Ranking:'mean', Comp_Ranking:'mean', OSA_SKU:'mean', OSA_Comp:'mean',
    Market_Share:'mean', Category_Units:'sum', Segment_Units:'sum', Store_Count:'mean',
    is_weekend:'max', is_first_week:'max', Is_Fest:'max', Pre_Fest:'max', Post_Fest:'max',
    budget_per_store:'mean', budget_per_unit:'mean', qty_per_store:'mean',
    category_share_proxy:'mean', segment_share_proxy:'mean', unique_cities:'mean', qty_per_city:'mean'
  };
  const WEEKLY_AGG = {
    total_qty_sold:'sum', PTC:'mean', Comp_ptc:'mean', MRP:'mean', discount_pct:'mean',
    overall_marketing_budget:'mean', Sku_Ranking:'mean', Comp_Ranking:'mean', OSA_SKU:'mean', OSA_Comp:'mean',
    Market_Share:'mean', Category_Units:'sum', Segment_Units:'sum', Store_Count:'mean',
    Is_Fest:'max', Pre_Fest:'max', Post_Fest:'max',
    budget_per_store:'mean', budget_per_unit:'mean', qty_per_store:'mean',
    category_share_proxy:'mean', segment_share_proxy:'mean', unique_cities:'mean', qty_per_city:'mean'
  };
  const MONTHLY_AGG = {
    total_qty_sold:'sum', PTC:'mean', Comp_ptc:'mean', MRP:'mean', discount_pct:'mean',
    overall_marketing_budget:'mean', Sku_Ranking:'mean', Comp_Ranking:'mean', OSA_SKU:'mean', OSA_Comp:'mean',
    Market_Share:'mean', Category_Units:'sum', Segment_Units:'sum', Store_Count:'mean',
    budget_per_store:'mean', budget_per_unit:'mean', qty_per_store:'mean',
    category_share_proxy:'mean', segment_share_proxy:'mean', unique_cities:'mean', qty_per_city:'mean'
  };

  function buildAggregates(){
    DAILY = aggregate(RAW, ['date','Short Code','Segment'], DAILY_AGG).sort(sortByX('date'));
    WEEKLY = aggregate(RAW, ['year_week','Short Code','Segment'], WEEKLY_AGG).sort(sortByX('year_week'));
    MONTHLY = aggregate(RAW, ['year_month','Short Code','Segment'], MONTHLY_AGG).sort(sortByX('year_month'));
  }

  // ================================================================================
  // MASTER FILTERS (SKU / Segment / Time Interval) — applied dynamically to every chart
  // ================================================================================
  function getSkuFilter(){ const el = document.getElementById('skuFilter'); return el ? el.value : 'ALL'; }
  function getSegmentFilter(){ const el = document.getElementById('segmentFilter'); return el ? el.value : 'ALL'; }
  function getInterval(){ const el = document.getElementById('timeFilter'); return el ? el.value : 'weekly'; }

  function applyMasterFilters(rows){
    const sku = getSkuFilter();
    const seg = getSegmentFilter();
    return rows.filter(r => (sku === 'ALL' || r['Short Code'] === sku) && (seg === 'ALL' || r['Segment'] === seg));
  }

  // Picks the correct pre-aggregated table + x-axis field + chart kind for the currently
  // selected Time Interval (mirrors the `if freq=="daily"/"weekly"/"monthly"` branches
  // that recur throughout the Python script, e.g. sections 7, 8, 9).
  function pickDataset(interval){
    if(interval === 'daily') return { dataset: DAILY, xField: 'date', qtyIsLine: true };
    if(interval === 'weekly') return { dataset: WEEKLY, xField: 'year_week', qtyIsLine: false };
    return { dataset: MONTHLY, xField: 'year_month', qtyIsLine: false };
  }

  function populateEdaanFilterOptions(){
    const skuSel = document.getElementById('skuFilter');
    const segSel = document.getElementById('segmentFilter');
    if(!skuSel || !segSel) return;
    const skus = Array.from(new Set(RAW.map(r => r['Short Code']))).sort();
    const segs = Array.from(new Set(RAW.map(r => r['Segment']))).sort();
    const prevSku = skuSel.value, prevSeg = segSel.value;
    skuSel.innerHTML = '<option value="ALL">All SKUs</option>' + skus.map(s => `<option value="${escapeAttr(s)}">${escapeHtml(s)}</option>`).join('');
    segSel.innerHTML = '<option value="ALL">All Segments</option>' + segs.map(s => `<option value="${escapeAttr(s)}">${escapeHtml(s)}</option>`).join('');
    if(prevSku && skus.includes(prevSku)) skuSel.value = prevSku;
    if(prevSeg && segs.includes(prevSeg)) segSel.value = prevSeg;
  }
  function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function escapeAttr(s){ return escapeHtml(s); }

  window.onEdaanFiltersChanged = function(){ renderAllEdaanCharts(); };

  function renderAllEdaanCharts(){
    if(!edaanLoaded) return;
    renderEdaanChart1(); renderEdaanChart2(); renderEdaanChart3(); renderEdaanChart4(); renderEdaanChart5();
    renderEdaanChart6(); renderEdaanChart7(); renderEdaanChart8(); renderEdaanChart9(); renderEdaanChart10();
    renderEdaanChart11(); renderEdaanChart13();
  }
  window.renderEdaanChart2 = renderEdaanChart2; // wired directly to the Top-5 chart's own Time Frame dropdown

  // ---------- shared Chart.js helpers ----------
  function makeChart(canvasId, config){
    const canvas = document.getElementById(canvasId);
    if(!canvas) return null;
    if(edaanCharts[canvasId]){ edaanCharts[canvasId].destroy(); delete edaanCharts[canvasId]; }
    const chart = new Chart(canvas, config);
    edaanCharts[canvasId] = chart;
    return chart;
  }
  function dualAxisOptions(leftLabel, rightLabel, reverseRight){
    return {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { position: 'top', labels: { boxWidth: 12, font: { size: 11 } } } },
      scales: {
        x: { ticks: { maxRotation: 70, minRotation: 0, autoSkip: true, maxTicksLimit: 24, font: { size: 10 } } },
        y: { type: 'linear', position: 'left', title: { display: true, text: leftLabel, font: { size: 11 } } },
        y1: { type: 'linear', position: 'right', title: { display: true, text: rightLabel, font: { size: 11 } }, grid: { drawOnChartArea: false }, reverse: !!reverseRight }
      }
    };
  }
  const edaanValueLabelPlugin = {
    id: 'edaanValueLabels',
    afterDatasetsDraw(chart){
      const { ctx } = chart;
      chart.data.datasets.forEach((ds, dsIndex) => {
        const meta = chart.getDatasetMeta(dsIndex);
        if(meta.hidden) return;
        meta.data.forEach((el, index) => {
          const value = ds.data[index];
          if(value === null || value === undefined) return;
          ctx.save();
          ctx.fillStyle = '#4A0E17';
          ctx.font = '600 11px Inter, sans-serif';
          const pos = el.tooltipPosition ? el.tooltipPosition() : { x: el.x, y: el.y };
          const label = Number(value).toLocaleString(undefined, { maximumFractionDigits: 0 });
          if(chart.options.indexAxis === 'y'){
            ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
            ctx.fillText(label, pos.x + 6, pos.y);
          } else {
            ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
            ctx.fillText(label, pos.x, pos.y - 4);
          }
          ctx.restore();
        });
      });
    }
  };

  // ================================================================================
  // 5. QUANTITY vs PTC vs COMPETITOR PTC vs MRP vs DISCOUNT %  (canvas: edaanChart1)
  // ================================================================================
  function renderEdaanChart1(){
    const interval = getInterval();
    const { dataset, xField, qtyIsLine } = pickDataset(interval);
    let rows = applyMasterFilters(dataset);
    rows = aggregate(rows, [xField], { total_qty_sold:'sum', PTC:'mean', Comp_ptc:'mean', MRP:'mean', discount_pct:'mean' });
    rows.sort(sortByX(xField));
    makeChart('edaanChart1', {
      type: qtyIsLine ? 'line' : 'bar',
      data: {
        labels: rows.map(r => r[xField]),
        datasets: [
          { type: qtyIsLine ? 'line' : 'bar', label: 'Qty Sold', data: rows.map(r => r.total_qty_sold), backgroundColor: 'rgba(74,14,23,0.55)', borderColor: '#4A0E17', yAxisID: 'y', order: 2, tension: 0.25 },
          { type: 'line', label: 'PTC', data: rows.map(r => r.PTC), borderColor: '#C5A059', backgroundColor: '#C5A059', yAxisID: 'y1', tension: 0.25, order: 1 },
          { type: 'line', label: 'Comp PTC', data: rows.map(r => r.Comp_ptc), borderColor: '#2E6F9E', backgroundColor: '#2E6F9E', yAxisID: 'y1', tension: 0.25, order: 1 },
          { type: 'line', label: 'MRP', data: rows.map(r => r.MRP), borderColor: '#0E7A4E', backgroundColor: '#0E7A4E', yAxisID: 'y1', tension: 0.25, order: 1 },
          { type: 'line', label: 'Discount %', data: rows.map(r => r.discount_pct != null ? r.discount_pct * 100 : null), borderColor: '#C75A45', backgroundColor: '#C75A45', yAxisID: 'y1', tension: 0.25, order: 1, borderDash: [4,3] }
        ]
      },
      options: dualAxisOptions('Qty Sold', 'Price (₹) / Discount %')
    });
  }

  // ================================================================================
  // 6. TOP 5 SKUs BY UNITS SOLD  (canvas: edaanChart2) — has its OWN Time Frame control
  // ================================================================================
  function filterByTimeFrame(rows, timeFrame){
    if(!rows.length || timeFrame === 'overall') return rows;
    const maxDateStr = rows.reduce((m, r) => r.date > m ? r.date : m, rows[0].date);
    const maxD = new Date(maxDateStr + 'T00:00:00Z');
    let startD, endD = maxD;
    if(timeFrame === 'last_week'){
      startD = new Date(maxD); startD.setUTCDate(startD.getUTCDate() - 6);
    } else if(timeFrame === 'last_month'){
      const firstThisMonth = new Date(Date.UTC(maxD.getUTCFullYear(), maxD.getUTCMonth(), 1));
      const lastDayLastMonth = new Date(firstThisMonth); lastDayLastMonth.setUTCDate(lastDayLastMonth.getUTCDate() - 1);
      startD = new Date(Date.UTC(lastDayLastMonth.getUTCFullYear(), lastDayLastMonth.getUTCMonth(), 1));
      endD = lastDayLastMonth;
    } else if(timeFrame === 'this_month'){
      startD = new Date(Date.UTC(maxD.getUTCFullYear(), maxD.getUTCMonth(), 1));
    } else if(timeFrame === 'last_3_months'){
      startD = new Date(Date.UTC(maxD.getUTCFullYear(), maxD.getUTCMonth() - 3, maxD.getUTCDate()));
    } else {
      return rows;
    }
    const startStr = ymd(startD), endStr = ymd(endD);
    return rows.filter(r => r.date >= startStr && r.date <= endStr);
  }
  function renderEdaanChart2(){
    if(!edaanLoaded) return;
    const tfEl = document.getElementById('edaanTop5TimeFrame');
    const timeFrame = tfEl ? tfEl.value : 'overall';
    let rows = applyMasterFilters(RAW);
    rows = filterByTimeFrame(rows, timeFrame);
    const agg = aggregate(rows, ['Short Code'], { total_qty_sold: 'sum' });
    agg.sort((a,b) => b.total_qty_sold - a.total_qty_sold);
    const top5 = agg.slice(0, 5).reverse(); // reverse so the #1 SKU renders at the TOP of the horizontal bar
    makeChart('edaanChart2', {
      type: 'bar',
      data: { labels: top5.map(r => r['Short Code']), datasets: [{ label: 'Total Units Sold', data: top5.map(r => r.total_qty_sold), backgroundColor: '#C5A059', borderRadius: 4 }] },
      options: {
        indexAxis: 'y', responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { x: { title: { display: true, text: 'Total Units Sold' } }, y: { title: { display: true, text: 'SKU' } } },
        layout: { padding: { right: 60 } }
      },
      plugins: [edaanValueLabelPlugin]
    });
  }

  // ================================================================================
  // 7. MARKETING BUDGET vs UNITS SOLD  (canvas: edaanChart3)
  // ================================================================================
  function renderEdaanChart3(){
    const interval = getInterval();
    const { dataset, xField, qtyIsLine } = pickDataset(interval);
    let rows = applyMasterFilters(dataset);
    rows = aggregate(rows, [xField], { total_qty_sold: 'sum', overall_marketing_budget: 'mean' });
    rows.sort(sortByX(xField));
    makeChart('edaanChart3', {
      type: qtyIsLine ? 'line' : 'bar',
      data: {
        labels: rows.map(r => r[xField]),
        datasets: [
          { type: qtyIsLine ? 'line' : 'bar', label: 'Qty Sold', data: rows.map(r => r.total_qty_sold), backgroundColor: 'rgba(74,14,23,0.55)', borderColor: '#4A0E17', yAxisID: 'y', tension: 0.25 },
          { type: 'line', label: 'Marketing Budget', data: rows.map(r => r.overall_marketing_budget), borderColor: '#C5A059', backgroundColor: '#C5A059', yAxisID: 'y1', tension: 0.25 }
        ]
      },
      options: dualAxisOptions('Qty Sold', 'Marketing Budget (₹)')
    });
  }

  // ================================================================================
  // 8. PRODUCT RANKING vs COMPETITOR RANKING vs UNITS  (canvas: edaanChart4)
  // ================================================================================
  function renderEdaanChart4(){
    // FIX: previously hardcoded to the MONTHLY table regardless of the master Time
    // Interval filter. Now uses pickDataset() like charts 1/3/5/6 so daily/weekly/monthly
    // selections are all honored, and both the ranking lines and the units bar render
    // correctly across every interval.
    const interval = getInterval();
    const { dataset, xField, qtyIsLine } = pickDataset(interval);
    let rows = applyMasterFilters(dataset);
    rows = aggregate(rows, [xField], { total_qty_sold: 'sum', Sku_Ranking: 'mean', Comp_Ranking: 'mean' });
    rows.sort(sortByX(xField));
    makeChart('edaanChart4', {
      type: qtyIsLine ? 'line' : 'bar',
      data: {
        labels: rows.map(r => r[xField]),
        datasets: [
          { type: qtyIsLine ? 'line' : 'bar', label: 'Qty Sold', data: rows.map(r => r.total_qty_sold), backgroundColor: 'rgba(74,14,23,0.55)', borderColor: '#4A0E17', yAxisID: 'y', tension: 0.25 },
          { type: 'line', label: 'SKU Ranking', data: rows.map(r => r.Sku_Ranking), borderColor: '#C5A059', backgroundColor: '#C5A059', yAxisID: 'y1', tension: 0.25 },
          { type: 'line', label: 'Competitor Ranking', data: rows.map(r => r.Comp_Ranking), borderColor: '#2E6F9E', backgroundColor: '#2E6F9E', yAxisID: 'y1', tension: 0.25 }
        ]
      },
      options: dualAxisOptions('Qty Sold', 'Ranking (1 = Best)', true)
    });
  }

  // ================================================================================
  // 9. OSA (ON-SHELF AVAILABILITY) vs UNITS SOLD  (canvas: edaanChart5)
  // ================================================================================
  function renderEdaanChart5(){
    const interval = getInterval();
    const { dataset, xField, qtyIsLine } = pickDataset(interval);
    let rows = applyMasterFilters(dataset);
    rows = aggregate(rows, [xField], { total_qty_sold: 'sum', OSA_SKU: 'mean', OSA_Comp: 'mean' });
    rows.sort(sortByX(xField));
    makeChart('edaanChart5', {
      type: qtyIsLine ? 'line' : 'bar',
      data: {
        labels: rows.map(r => r[xField]),
        datasets: [
          { type: qtyIsLine ? 'line' : 'bar', label: 'Qty Sold', data: rows.map(r => r.total_qty_sold), backgroundColor: 'rgba(74,14,23,0.55)', borderColor: '#4A0E17', yAxisID: 'y', tension: 0.25 },
          { type: 'line', label: 'OSA SKU', data: rows.map(r => r.OSA_SKU), borderColor: '#0E7A4E', backgroundColor: '#0E7A4E', yAxisID: 'y1', tension: 0.25 },
          { type: 'line', label: 'OSA Competitor', data: rows.map(r => r.OSA_Comp), borderColor: '#C75A45', backgroundColor: '#C75A45', yAxisID: 'y1', tension: 0.25 }
        ]
      },
      options: dualAxisOptions('Qty Sold', 'OSA')
    });
  }

  // ================================================================================
  // 10. MARKET SHARE vs UNITS SOLD  (canvas: edaanChart6)
  // ================================================================================
  function renderEdaanChart6(){
    // FIX: previously hardcoded to the MONTHLY table regardless of the master Time
    // Interval filter. Now uses pickDataset() like charts 1/3/5 so daily/weekly/monthly
    // selections are all honored.
    const interval = getInterval();
    const { dataset, xField, qtyIsLine } = pickDataset(interval);
    let rows = applyMasterFilters(dataset);
    rows = aggregate(rows, [xField], { total_qty_sold: 'sum', Market_Share: 'mean' });
    rows.sort(sortByX(xField));
    makeChart('edaanChart6', {
      type: qtyIsLine ? 'line' : 'bar',
      data: {
        labels: rows.map(r => r[xField]),
        datasets: [
          { type: qtyIsLine ? 'line' : 'bar', label: 'Total Units Sold', data: rows.map(r => r.total_qty_sold), backgroundColor: 'rgba(197,160,89,0.65)', borderColor: '#C5A059', yAxisID: 'y', tension: 0.25 },
          { type: 'line', label: 'Avg Market Share (%)', data: rows.map(r => r.Market_Share != null ? r.Market_Share * 100 : null), borderColor: '#4A0E17', backgroundColor: '#4A0E17', yAxisID: 'y1', tension: 0.25 }
        ]
      },
      options: dualAxisOptions('Total Units Sold', 'Market Share (%)')
    });
  }

  // ================================================================================
  // GENERIC "category over time" renderer — powers charts 11, 12, 13 (Festival / First
  // Week / Weekend), each of which is daily-line (hue by category) in Python OR a
  // weekly/monthly bar (stacked for Festival, grouped for First Week & Weekend).
  // ================================================================================
  function pivotByCategory(rows, xField, catField, valField){
    const xVals = Array.from(new Set(rows.map(r => r[xField]))).sort();
    const catVals = Array.from(new Set(rows.map(r => r[catField]))).sort((a,b) => a > b ? 1 : (a < b ? -1 : 0));
    const map = new Map();
    rows.forEach(r => map.set(`${r[xField]}${r[catField]}`, r[valField]));
    const series = catVals.map(cat => ({ cat, data: xVals.map(x => map.get(`${x}${cat}`) || 0) }));
    return { xVals, series };
  }
  function renderCategoryTimeChart(canvasId, catField, catLabelFn, catColorFn, stackedForBar){
    const interval = getInterval();
    let xField, isLine;
    if(interval === 'daily'){ xField = 'date'; isLine = true; }
    else if(interval === 'weekly'){ xField = 'year_week'; isLine = false; }
    else { xField = 'year_month'; isLine = false; }
    const rows = applyMasterFilters(RAW);
    const agg = aggregate(rows, [xField, catField], { total_qty_sold: 'sum' });
    const { xVals, series } = pivotByCategory(agg, xField, catField, 'total_qty_sold');
    const datasets = series.map(s => ({
      type: isLine ? 'line' : 'bar',
      label: catLabelFn(s.cat),
      data: s.data,
      borderColor: catColorFn(s.cat),
      backgroundColor: isLine ? catColorFn(s.cat) : hexToRgba(catColorFn(s.cat), 0.7),
      tension: 0.25, fill: false, borderWidth: 2
    }));
    makeChart(canvasId, {
      type: isLine ? 'line' : 'bar',
      data: { labels: xVals, datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { position: 'top', labels: { boxWidth: 12, font: { size: 11 } } } },
        scales: {
          x: { stacked: !isLine && stackedForBar, ticks: { maxRotation: 70, minRotation: 0, autoSkip: true, maxTicksLimit: 24, font: { size: 10 } } },
          y: { stacked: !isLine && stackedForBar, title: { display: true, text: 'Qty Sold', font: { size: 11 } } }
        }
      }
    });
  }
  function hexToRgba(hex, alpha){
    const h = hex.replace('#','');
    const r = parseInt(h.substring(0,2),16), g = parseInt(h.substring(2,4),16), b = parseInt(h.substring(4,6),16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  // 11. FESTIVAL IMPACT ANALYSIS (canvas: edaanChart7)
  const FESTIVAL_COLORS = { 'Festival': '#FF3333', 'Pre-Festival': '#FFC000', 'Post-Festival': '#00B050', 'Normal': '#808080' };
  function festivalPhaseRank(phase){
    return phase === 'Festival' ? 3 : (phase === 'Pre-Festival' ? 2 : (phase === 'Post-Festival' ? 1 : 0));
  }
  function renderEdaanChart7(){
    const interval = getInterval();
    if(interval !== 'daily'){
      // Weekly / Monthly: unchanged — stacked bar, one series per festival phase.
      renderCategoryTimeChart('edaanChart7', 'festival_phase', v => v, v => FESTIVAL_COLORS[v] || FESTIVAL_COLORS['Normal'], true);
      return;
    }
    // FIX (Daily view): the old code built one separate line dataset PER festival phase,
    // each holding 0s on every date outside that phase — Chart.js then plotted those
    // zeros as real data points, producing a "zigzag to zero" line for every phase.
    // Now: ONE continuous 'Qty Sold' line across all dates, with each point's color
    // driven by that date's Festival_Phase via a pointBackgroundColor array.
    const rows = applyMasterFilters(RAW);
    let agg = aggregate(rows, ['date'], { total_qty_sold: 'sum' });
    const phaseByDate = new Map();
    rows.forEach(r => {
      const cur = phaseByDate.get(r.date);
      if(!cur || festivalPhaseRank(r.festival_phase) > festivalPhaseRank(cur)) phaseByDate.set(r.date, r.festival_phase);
    });
    agg.sort(sortByX('date'));
    const labels = agg.map(r => r.date);
    const data = agg.map(r => r.total_qty_sold);
    const pointColors = labels.map(d => FESTIVAL_COLORS[phaseByDate.get(d)] || FESTIVAL_COLORS['Normal']);
    makeChart('edaanChart7', {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'Qty Sold',
          data,
          borderColor: '#B7ADA4',
          backgroundColor: 'transparent',
          borderWidth: 1.5,
          fill: false,
          tension: 0.15,
          pointRadius: 4,
          pointHoverRadius: 6,
          pointBackgroundColor: pointColors,
          pointBorderColor: pointColors
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            display: true, position: 'top',
            labels: {
              boxWidth: 12, font: { size: 11 },
              generateLabels(){
                return Object.keys(FESTIVAL_COLORS).map(k => ({ text: k, fillStyle: FESTIVAL_COLORS[k], strokeStyle: FESTIVAL_COLORS[k], pointStyle: 'circle' }));
              }
            }
          }
        },
        scales: {
          x: { ticks: { maxRotation: 70, minRotation: 0, autoSkip: true, maxTicksLimit: 24, font: { size: 10 } } },
          y: { title: { display: true, text: 'Qty Sold', font: { size: 11 } } }
        }
      }
    });
  }

  // 12. FIRST WEEK EFFECT vs UNITS (canvas: edaanChart8)
  function renderEdaanChart8(){
    const interval = getInterval();
    if(interval === 'daily'){
      // FIX (Daily view): the old code built two separate line datasets ('First Week'
      // and 'Rest of Month'), each holding 0s on every date outside its own bucket —
      // Chart.js then plotted those zeros as real points, producing a messy zigzag
      // dropping to zero. Now: ONE continuous 'Qty Sold' line across all dates, with
      // each point's color driven by that date's day-of-month via pointBackgroundColor
      // (day <= 7 => Gold, day > 7 => Dark Brown/Maroon).
      const rows = applyMasterFilters(RAW);
      const agg = aggregate(rows, ['date'], { total_qty_sold: 'sum' });
      agg.sort(sortByX('date'));
      const labels = agg.map(r => r.date);
      const data = agg.map(r => r.total_qty_sold);
      const pointColors = labels.map(d => (parseInt(d.slice(8, 10), 10) <= 7) ? '#C8A26A' : '#591717');
      makeChart('edaanChart8', {
        type: 'line',
        data: {
          labels,
          datasets: [{
            label: 'Qty Sold',
            data,
            borderColor: '#B7ADA4',
            backgroundColor: 'transparent',
            borderWidth: 1.5,
            fill: false,
            tension: 0.15,
            pointRadius: 4,
            pointHoverRadius: 6,
            pointBackgroundColor: pointColors,
            pointBorderColor: pointColors
          }]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: {
              display: true, position: 'top',
              labels: {
                boxWidth: 12, font: { size: 11 },
                generateLabels(){
                  return [
                    { text: 'First Week (Day ≤ 7)', fillStyle: '#C8A26A', strokeStyle: '#C8A26A', pointStyle: 'circle' },
                    { text: 'Rest of Month', fillStyle: '#591717', strokeStyle: '#591717', pointStyle: 'circle' }
                  ];
                }
              }
            }
          },
          scales: {
            x: { ticks: { maxRotation: 70, minRotation: 0, autoSkip: true, maxTicksLimit: 24, font: { size: 10 } } },
            y: { title: { display: true, text: 'Qty Sold', font: { size: 11 } } }
          }
        }
      });
      return;
    }
    // FIX (Weekly view): now a Stacked Bar Chart, same treatment as Monthly — two
    // datasets ('First Week (Day ≤ 7)' and 'Rest of Month') stacked on top of each
    // other, with stacked:true applied to both the x and y axes.
    renderCategoryTimeChart('edaanChart8', 'is_first_week',
      v => (v === 1 ? 'First Week (Day ≤ 7)' : 'Rest of Month'),
      v => (v === 1 ? '#C8A26A' : '#591717'), true);
  }

  // 13. WEEKEND EFFECT vs UNITS (canvas: edaanChart9)
  function renderEdaanChart9(){
    const interval = getInterval();
    if(interval === 'daily'){
      // FIX: single 'bar' dataset, one bar per day, colored per-day via getDay():
      // Weekend (Sat/Sun) = Light Orange, Weekday = Light Blue.
      let rows = applyMasterFilters(DAILY);
      rows = aggregate(rows, ['date'], { total_qty_sold: 'sum' });
      rows.sort(sortByX('date'));
      makeChart('edaanChart9', {
        type: 'bar',
        data: {
          labels: rows.map(r => r.date),
          datasets: [{
            label: 'Qty Sold',
            data: rows.map(r => r.total_qty_sold),
            backgroundColor: rows.map(r => {
              const dow = new Date(r.date + 'T00:00:00Z').getUTCDay(); // 0=Sun...6=Sat
              return (dow === 0 || dow === 6) ? '#F5B041' : '#5DADE2';
            }),
            borderRadius: 2
          }]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { ticks: { maxRotation: 70, minRotation: 0, autoSkip: true, maxTicksLimit: 24, font: { size: 10 } } },
            y: { title: { display: true, text: 'Qty Sold', font: { size: 11 } } }
          }
        }
      });
      return;
    }
    // Weekly & Monthly: stacked bar chart showing Weekday/Weekend stacked.
    renderCategoryTimeChart('edaanChart9', 'is_weekend',
      v => (v === 1 ? 'Weekend' : 'Weekday'),
      v => (v === 1 ? '#F5B041' : '#5DADE2'), true);
  }

  // ================================================================================
  // 14. SEGMENT CONTRIBUTION (canvas: edaanChart10) — pie
  // 15. MSL / NON-MSL CONTRIBUTION (canvas: edaanChart11) — pie
  // ================================================================================
  const PIE_PALETTE = ['#4A0E17', '#C5A059', '#0E7A4E', '#2E6F9E', '#C75A45', '#8d6a9f', '#3f7d5c'];
  function renderPieChart(canvasId, groupField){
    const rows = applyMasterFilters(RAW);
    const agg = aggregate(rows, [groupField], { total_qty_sold: 'sum' });
    agg.sort((a,b) => b.total_qty_sold - a.total_qty_sold);
    makeChart(canvasId, {
      type: 'pie',
      data: {
        labels: agg.map(r => String(r[groupField])),
        datasets: [{ data: agg.map(r => r.total_qty_sold), backgroundColor: agg.map((_, i) => PIE_PALETTE[i % PIE_PALETTE.length]) }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
          tooltip: {
            callbacks: {
              label(ctx){
                const total = ctx.dataset.data.reduce((a,b)=>a+b,0);
                const pct = total ? (ctx.raw / total * 100).toFixed(1) : '0.0';
                return `${ctx.label}: ${Number(ctx.raw).toLocaleString()} units (${pct}%)`;
              }
            }
          }
        }
      }
    });
  }
  function renderEdaanChart10(){ renderPieChart('edaanChart10', 'Segment'); }
  function renderEdaanChart11(){ renderPieChart('edaanChart11', 'msl/non-msl'); }

  // ================================================================================
  // 16. FEATURE CORRELATION MATRIX (canvas: edaanChart13) — pure Chart.js scatter-grid
  // heatmap (no chartjs-chart-matrix dependency): points are placed on category x/y
  // scales at (col, row) and colored via a coolwarm-style diverging scale; a custom
  // afterDatasetsDraw plugin prints the numeric correlation value on each cell.
  // ================================================================================
  // FIX: narrowed to a focused set of pricing/ranking/availability/calendar features
  // (was a broader 28-column list). Includes two newly engineered/derived fields:
  // msl_flag (binary encoding of `msl/non-msl`, see engineerFeatures) and Variant
  // (raw numeric weight-variant field straight from PapaParse dynamicTyping).
  const CORR_COLS = [
    "PTC", "Comp_ptc", "budget_per_store", "budget_per_unit", "Sku_Ranking", "Comp_Ranking",
    "OSA_SKU", "OSA_Comp", "Market_Share", "is_weekend", "is_first_week", "Is_Fest", "Pre_Fest",
    "Post_Fest", "MRP", "Segment_Units", "Segment_Sku_Count", "msl_flag", "Variant"
  ];
  function pearson(xs, ys){
    let n=0, sx=0, sy=0;
    for(let i=0;i<xs.length;i++){ const x=xs[i], y=ys[i]; if(x==null||y==null||Number.isNaN(x)||Number.isNaN(y)) continue; n++; sx+=x; sy+=y; }
    if(n < 2) return null;
    const mx = sx/n, my = sy/n;
    let num=0, dx2=0, dy2=0;
    for(let i=0;i<xs.length;i++){ const x=xs[i], y=ys[i]; if(x==null||y==null||Number.isNaN(x)||Number.isNaN(y)) continue; const dx=x-mx, dy=y-my; num+=dx*dy; dx2+=dx*dx; dy2+=dy*dy; }
    const denom = Math.sqrt(dx2*dy2);
    return denom === 0 ? null : num/denom;
  }
  function corrToColor(v){
    if(v === null || Number.isNaN(v)) return '#e8e8e8';
    const t = Math.max(-1, Math.min(1, v));
    if(t >= 0){ const c = Math.round(255 - 170*t); return `rgb(255,${c},${c})`; }
    const at = -t; const c = Math.round(255 - 170*at); return `rgb(${c},${c},255)`;
  }
  function renderEdaanChart13(){
    const rows = applyMasterFilters(RAW);
    const n = CORR_COLS.length;
    const columns = CORR_COLS.map(col => rows.map(r => r[col]));
    const matrix = [];
    for(let i=0;i<n;i++){
      matrix.push(new Array(n).fill(null));
    }
    for(let i=0;i<n;i++){
      for(let j=i;j<n;j++){
        const c = i === j ? 1 : pearson(columns[i], columns[j]);
        matrix[i][j] = c; matrix[j][i] = c;
      }
    }
    const points = [];
    for(let i=0;i<n;i++){
      for(let j=0;j<n;j++){
        points.push({ x: CORR_COLS[j], y: CORR_COLS[i], v: matrix[i][j] });
      }
    }
    const canvas = document.getElementById('edaanChart13');
    if(canvas) canvas.style.width = Math.max(900, n * 34) + 'px';

    const heatmapValuePlugin = {
      id: 'edaanHeatmapValues',
      afterDatasetsDraw(chart){
        const { ctx } = chart;
        const meta = chart.getDatasetMeta(0);
        meta.data.forEach((el, idx) => {
          const v = chart.data.datasets[0].data[idx].v;
          if(v === null || v === undefined) return;
          ctx.save();
          ctx.font = '600 11px Inter, sans-serif';
          ctx.fillStyle = Math.abs(v) > 0.55 ? '#ffffff' : '#2A1B1E';
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(v.toFixed(2), el.x, el.y);
          ctx.restore();
        });
      }
    };

    makeChart('edaanChart13', {
      type: 'scatter',
      data: {
        datasets: [{
          data: points,
          pointStyle: 'rect',
          radius: 14,
          hoverRadius: 14,
          backgroundColor: points.map(p => corrToColor(p.v))
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label(ctx){ const p = ctx.raw; return `${p.y} × ${p.x}: ${p.v == null ? 'n/a' : p.v.toFixed(3)}`; } } }
        },
        scales: {
          x: { type: 'category', labels: CORR_COLS, position: 'top', offset: true, ticks: { autoSkip: false, maxRotation: 90, minRotation: 90, font: { size: 9 } }, grid: { display: false } },
          y: { type: 'category', labels: CORR_COLS, reverse: true, offset: true, ticks: { autoSkip: false, font: { size: 9 } }, grid: { display: false } }
        }
      },
      plugins: [heatmapValuePlugin]
    });
  }

  // ---------- expose a resize hook so the existing sidebar-toggle resize sweep also catches these charts ----------
  window.edaanResizeAll = function(){
    Object.keys(edaanCharts).forEach(id => { const c = edaanCharts[id]; if(c && typeof c.resize === 'function') c.resize(); });
  };

})();