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
      // FIX: weekly aggregation must be strict ISO-8601 (Monday -> Sunday) per stakeholder
      // requirement, not the old pandas `%U` (Sunday-first) numbering. isoWeekInfo() returns
      // the ISO week-year too (which can differ from the calendar year for a few days around
      // Dec 31/Jan 1) so the year_week string sorts and buckets correctly across year boundaries.
      const { isoYear, week: isoWeek } = isoWeekInfo(d);
      const yearWeek = `${isoYear}-W${String(isoWeek).padStart(2,'0')}`;
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
      // NEW (production feedback, action item #3; converted to a time-series trend per
      // latest stakeholder feedback): Relative Price Index — our PTC relative to the
      // competitor's PTC (RPI = PTC / Comp_ptc). Powers the "RPI vs Qty" trend chart;
      // RPI > 1 means we're priced above the competitor, < 1 means below.
      const rpi = safeDiv(PTC, Comp_ptc);
      // NEW (production feedback, action item #3; converted to a time-series trend per
      // latest stakeholder feedback): OSA × Product Ranking composite — powers the
      // "(OSA × Product Ranking) vs Qty" trend chart.
      const OSA_SKU_val = num(r['OSA_SKU']);
      const Sku_Ranking_val = num(r['Sku_Ranking']);
      const osa_rank_product = (OSA_SKU_val != null && Sku_Ranking_val != null) ? (OSA_SKU_val * Sku_Ranking_val) : null;
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
        discount_pct, rpi, osa_rank_product,
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

  // ISO-8601 week number (Monday = first day of week, week 1 = the week containing the
  // year's first Thursday). Per stakeholder requirement, weekly aggregation buckets must
  // run strictly Monday -> Sunday, so this replaces the previous pandas `%U` (Sunday-first,
  // non-ISO) numbering. Returns both the ISO week number AND the ISO week-year, since the
  // ISO year can differ from the calendar year for a few days around Dec 31 / Jan 1
  // (e.g. 2024-12-30 falls in ISO week "2025-W01").
  function isoWeekInfo(d){
    const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const dayNr = (target.getUTCDay() + 6) % 7; // Mon=0 ... Sun=6
    target.setUTCDate(target.getUTCDate() - dayNr + 3);
    const isoYear = target.getUTCFullYear();
    const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
    const firstThursdayDayNr = (firstThursday.getUTCDay() + 6) % 7;
    firstThursday.setUTCDate(firstThursday.getUTCDate() - firstThursdayDayNr + 3);
    const week = 1 + Math.round((target - firstThursday) / (7 * 86400000));
    return { isoYear, week };
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
  // NEW (stakeholder feedback — RPI/OSA×Ranking converted from per-row scatter to time-series
  // trend lines): `rpi` and `osa_rank_product` are now aggregated (mean) at every interval so
  // renderEdaanRpiTrend()/renderEdaanOsaRankTrend() can plot them as a proper right-axis line
  // alongside Qty Sold, exactly like the other dual-axis time-series charts.
  const DAILY_AGG = {
    total_qty_sold:'sum', PTC:'mean', Comp_ptc:'mean', MRP:'mean', discount_pct:'mean',
    overall_marketing_budget:'mean', Sku_Ranking:'mean', Comp_Ranking:'mean', OSA_SKU:'mean', OSA_Comp:'mean',
    Market_Share:'mean', Category_Units:'sum', Segment_Units:'sum', Segment_Sku_Count:'mean', Store_Count:'mean',
    is_weekend:'max', is_first_week:'max', Is_Fest:'max', Pre_Fest:'max', Post_Fest:'max',
    budget_per_store:'mean', budget_per_unit:'mean', qty_per_store:'mean',
    category_share_proxy:'mean', segment_share_proxy:'mean', unique_cities:'mean', qty_per_city:'mean',
    rpi:'mean', osa_rank_product:'mean'
  };
  const WEEKLY_AGG = {
    total_qty_sold:'sum', PTC:'mean', Comp_ptc:'mean', MRP:'mean', discount_pct:'mean',
    overall_marketing_budget:'mean', Sku_Ranking:'mean', Comp_Ranking:'mean', OSA_SKU:'mean', OSA_Comp:'mean',
    Market_Share:'mean', Category_Units:'sum', Segment_Units:'sum', Segment_Sku_Count:'mean', Store_Count:'mean',
    Is_Fest:'max', Pre_Fest:'max', Post_Fest:'max',
    budget_per_store:'mean', budget_per_unit:'mean', qty_per_store:'mean',
    category_share_proxy:'mean', segment_share_proxy:'mean', unique_cities:'mean', qty_per_city:'mean',
    rpi:'mean', osa_rank_product:'mean'
  };
  const MONTHLY_AGG = {
    total_qty_sold:'sum', PTC:'mean', Comp_ptc:'mean', MRP:'mean', discount_pct:'mean',
    overall_marketing_budget:'mean', Sku_Ranking:'mean', Comp_Ranking:'mean', OSA_SKU:'mean', OSA_Comp:'mean',
    Market_Share:'mean', Category_Units:'sum', Segment_Units:'sum', Segment_Sku_Count:'mean', Store_Count:'mean',
    budget_per_store:'mean', budget_per_unit:'mean', qty_per_store:'mean',
    category_share_proxy:'mean', segment_share_proxy:'mean', unique_cities:'mean', qty_per_city:'mean',
    rpi:'mean', osa_rank_product:'mean'
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
    // FIX (production feedback, action item #1): Qty is now rendered as a LINE across
    // EVERY time interval (daily/weekly/monthly), system-wide, for every dual-axis chart
    // that consumes pickDataset() — previously only 'daily' returned qtyIsLine:true.
    if(interval === 'daily') return { dataset: DAILY, xField: 'date', qtyIsLine: true };
    if(interval === 'weekly') return { dataset: WEEKLY, xField: 'year_week', qtyIsLine: true };
    return { dataset: MONTHLY, xField: 'year_month', qtyIsLine: true };
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
    // FIX (production feedback, action item #2): the Top-5 SKUs (chart2), Market Share
    // (chart6), Segment/MSL pie charts (chart10/chart11), and Unique Cities (chart14)
    // charts have been fully removed from the dashboard, both here and in their HTML.
    renderEdaanChart1(); renderEdaanChart3(); renderEdaanChart4(); renderEdaanChart5();
    renderEdaanChart7(); renderEdaanChart8(); renderEdaanChart9(); renderEdaanChart13();
    renderEdaanChart15(); renderEdaanChart16(); renderEdaanChart17();
    // NEW (production feedback, action item #3 — converted from scatter to time-series
    // trend charts per latest stakeholder feedback; the (PTC - Competitor PTC) vs Qty
    // chart was removed entirely at the same time).
    renderEdaanRpiTrend(); renderEdaanOsaRankTrend();
  }

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
  // 16. FEATURE CORRELATION MATRIX (canvas: edaanChart13) — pure Chart.js scatter-grid
  // heatmap (no chartjs-chart-matrix dependency): points are placed on category x/y
  // scales at (col, row) and colored via a coolwarm-style diverging scale; a custom
  // afterDatasetsDraw plugin prints the numeric correlation value on each cell.
  // ================================================================================
  // FIX: stakeholder requirement — "don't create new features just use all available
  // features and qty in file". This is the exact, stakeholder-specified feature list
  // (total_qty_sold stands in for the qty/target variable, included first), with no
  // additional engineered columns introduced beyond what already exists on the row
  // objects from engineerFeatures (msl_flag, is_weekend, is_first_week, Variant).
  //
  // UPDATE (latest stakeholder review): the candidate pool now also includes the 4
  // newer features that power charts 14-17 — unique_cities, Store_Count, Category_Units,
  // and Segment_Units (already present from the prior round) — so they're available for
  // correlation analysis alongside total_qty_sold and the rest of the original 17.
  const CORR_COLS = [
    "total_qty_sold", "PTC", "Comp_ptc", "overall_marketing_budget", "Sku_Ranking", "OSA_SKU",
    "Market_Share", "is_weekend", "is_first_week", "Is_Fest", "Pre_Fest", "Post_Fest", "MRP",
    "Comp_Ranking", "Segment_Units", "msl_flag", "Variant",
    "unique_cities", "Store_Count", "Category_Units"
  ];

  // FIX: dynamic "zero-variance / null" filter — crucial for when a user narrows the
  // dataset via the SKU/Segment dropdowns. A feature that becomes entirely empty, all
  // null, or constant (zero variance) within the CURRENTLY FILTERED rows produces NaN
  // in Pearson correlation (division by zero in the denominator) and is meaningless to
  // plot anyway (e.g. filtering to a single SKU collapses `Variant` to one constant
  // value for that SKU). Rather than showing a broken/blank row-column, that feature is
  // dropped from the matrix entirely for this specific render — the matrix shrinks to
  // only the features that are actually usable in the current filter context, and grows
  // back to the full candidate list once the filter is cleared.
  function getActiveCorrCols(rows, cols){
    return cols.filter(col => {
      const vals = rows.map(r => r[col]).filter(v => typeof v === 'number' && !Number.isNaN(v));
      if(vals.length === 0) return false; // completely empty / all-null column
      return Math.max(...vals) !== Math.min(...vals); // zero-variance (constant) column
    });
  }

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

    // FIX: dynamic zero-variance / null filter, evaluated against the CURRENTLY FILTERED
    // rows (not the full dataset) — so narrowing to a single SKU or Segment via the master
    // filters correctly shrinks the matrix to only the features that remain meaningful
    // (e.g. `Variant` collapses to one constant value once a single SKU is selected, and
    // is dropped for that render rather than showing a broken/self-correlated row).
    const activeCols = getActiveCorrCols(rows, CORR_COLS);
    const n = activeCols.length;

    const canvas = document.getElementById('edaanChart13');
    if(n === 0){
      // Nothing left to plot after filtering (e.g. every candidate column is constant
      // or empty for the current filter combination) — clear any stale chart and bail.
      if(edaanCharts['edaanChart13']){ edaanCharts['edaanChart13'].destroy(); delete edaanCharts['edaanChart13']; }
      return;
    }

    const columns = activeCols.map(col => rows.map(r => r[col]));

    // FIX: lower-triangular only (j <= i) — Seaborn-style masked heatmap. Removes the
    // symmetric duplicate upper half so each pair is shown exactly once, with the
    // diagonal (self-correlation = 1) running top-left -> bottom-right.
    const points = [];
    for(let i=0;i<n;i++){
      for(let j=0;j<=i;j++){
        const v = i === j ? 1 : pearson(columns[i], columns[j]);
        points.push({ x: activeCols[j], y: activeCols[i], v });
      }
    }
    if(canvas) canvas.style.width = Math.max(900, n * 34) + 'px';

    // FIX: premium tile UI — the point itself is now invisible (radius:0) but keeps a
    // generous hitRadius for hover/tooltip detection. The visible "tile" is drawn by
    // chartjs-plugin-datalabels' own backgroundColor/borderRadius/padding box, which
    // sits flush against neighboring cells like a solid Seaborn-style square, with the
    // correlation value rendered as the label text inside that box.
    const hasDatalabels = typeof ChartDataLabels !== 'undefined';
    const chartConfig = {
      type: 'scatter',
      data: {
        datasets: [{
          data: points,
          pointStyle: 'rect',
          radius: 0,
          hoverRadius: 0,
          hitRadius: 18,
          backgroundColor: 'transparent',
          borderWidth: 0
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label(ctx){ const p = ctx.raw; return `${p.y} × ${p.x}: ${p.v == null ? 'n/a' : p.v.toFixed(3)}`; } } },
          datalabels: hasDatalabels ? {
            display: true,
            borderRadius: 0,
            backgroundColor(context){
              const p = context.dataset.data[context.dataIndex];
              return p ? corrToColor(p.v) : '#e8e8e8';
            },
            color(context){
              const p = context.dataset.data[context.dataIndex];
              const v = p ? p.v : null;
              return (v != null && Math.abs(v) > 0.55) ? '#ffffff' : '#2A1B1E';
            },
            font: { size: 11, weight: '600', family: 'Inter, sans-serif' },
            formatter(value){ return (value.v === null || value.v === undefined) ? '' : value.v.toFixed(2); },
            padding(context){
              // dynamically size the padding so the colored background box fills/flushes
              // against the cell width, rather than leaving gaps between square tiles.
              const area = context.chart.chartArea;
              if(!area) return 10;
              const cellW = (area.right - area.left) / n;
              return Math.max(6, Math.round(cellW / 2 - 8));
            },
            align: 'center',
            anchor: 'center'
          } : false
        },
        scales: {
          x: { type: 'category', labels: activeCols, position: 'top', offset: true, ticks: { autoSkip: false, maxRotation: 90, minRotation: 90, font: { size: 9 } }, grid: { display: false } },
          y: { type: 'category', labels: activeCols, reverse: true, offset: true, ticks: { autoSkip: false, font: { size: 9 } }, grid: { display: false } }
        }
      }
    };
    if(hasDatalabels) chartConfig.plugins = [ChartDataLabels];

    makeChart('edaanChart13', chartConfig);
  }

  // ================================================================================
  // 19. STORE COUNT vs UNITS SOLD (canvas: edaanChart15)
  // ================================================================================
  function renderEdaanChart15(){
    const interval = getInterval();
    const { dataset, xField, qtyIsLine } = pickDataset(interval);
    let rows = applyMasterFilters(dataset);
    rows = aggregate(rows, [xField], { total_qty_sold: 'sum', Store_Count: 'mean' });
    rows.sort(sortByX(xField));
    makeChart('edaanChart15', {
      type: qtyIsLine ? 'line' : 'bar',
      data: {
        labels: rows.map(r => r[xField]),
        datasets: [
          { type: qtyIsLine ? 'line' : 'bar', label: 'Qty Sold', data: rows.map(r => r.total_qty_sold), backgroundColor: 'rgba(74,14,23,0.55)', borderColor: '#4A0E17', yAxisID: 'y', tension: 0.25 },
          { type: 'line', label: 'Store Count', data: rows.map(r => r.Store_Count), borderColor: '#0E7A4E', backgroundColor: '#0E7A4E', yAxisID: 'y1', tension: 0.25 }
        ]
      },
      options: dualAxisOptions('Qty Sold', 'Store Count')
    });
  }

  // ================================================================================
  // 20. CATEGORY UNITS vs UNITS SOLD (canvas: edaanChart16)
  // ================================================================================
  function renderEdaanChart16(){
    const interval = getInterval();
    const { dataset, xField, qtyIsLine } = pickDataset(interval);
    let rows = applyMasterFilters(dataset);
    rows = aggregate(rows, [xField], { total_qty_sold: 'sum', Category_Units: 'sum' });
    rows.sort(sortByX(xField));
    makeChart('edaanChart16', {
      type: qtyIsLine ? 'line' : 'bar',
      data: {
        labels: rows.map(r => r[xField]),
        datasets: [
          { type: qtyIsLine ? 'line' : 'bar', label: 'Qty Sold', data: rows.map(r => r.total_qty_sold), backgroundColor: 'rgba(74,14,23,0.55)', borderColor: '#4A0E17', yAxisID: 'y', tension: 0.25 },
          { type: 'line', label: 'Category Units', data: rows.map(r => r.Category_Units), borderColor: '#C75A45', backgroundColor: '#C75A45', yAxisID: 'y1', tension: 0.25 }
        ]
      },
      options: dualAxisOptions('Qty Sold', 'Category Units')
    });
  }

  // ================================================================================
  // 21. SEGMENT UNITS vs UNITS SOLD  (canvas: edaanChart17)
  // Special requirement: label Segment_Sku_Count, but ONLY at "dip points" (local minima)
  // of the Segment_Units line — a point whose value is lower than BOTH of its immediate
  // neighbors. Implemented via chartjs-plugin-datalabels' per-dataset `datalabels`
  // override (set only on the Segment_Units dataset, so the Qty Sold bars never get a
  // label), using its `display` callback to test the dip condition and `formatter` to
  // render "SKU Count: <value>" from a parallel Segment_Sku_Count array.
  // ================================================================================
  function renderEdaanChart17(){
    const interval = getInterval();
    const { dataset, xField, qtyIsLine } = pickDataset(interval);
    let rows = applyMasterFilters(dataset);
    rows = aggregate(rows, [xField], { total_qty_sold: 'sum', Segment_Units: 'sum', Segment_Sku_Count: 'mean' });
    rows.sort(sortByX(xField));

    const segmentUnitsData = rows.map(r => r.Segment_Units);
    const skuCounts = rows.map(r => r.Segment_Sku_Count);

    const hasDatalabels = typeof ChartDataLabels !== 'undefined';
    const chartOptions = dualAxisOptions('Qty Sold', 'Segment Units');
    // Off by default at the chart level — only the Segment_Units line dataset opts back
    // in via its own per-dataset `datalabels` override below, so the Qty Sold bars never
    // show a label.
    chartOptions.plugins.datalabels = { display: false };

    const segmentUnitsDataset = {
      type: 'line',
      label: 'Segment Units',
      data: segmentUnitsData,
      borderColor: '#8d6a9f',
      backgroundColor: '#8d6a9f',
      yAxisID: 'y1',
      tension: 0.25,
      pointRadius: 3,
      pointHoverRadius: 5
    };

    if(hasDatalabels){
      segmentUnitsDataset.datalabels = {
        // CRITICAL LOGIC: a "dip point" is a local minimum — cur < prev AND cur < next.
        // Edge points (index 0 or the last index) have no second neighbor and never qualify.
        display(context){
          const data = context.dataset.data;
          const i = context.dataIndex;
          if(i <= 0 || i >= data.length - 1) return false;
          const prev = data[i - 1], cur = data[i], next = data[i + 1];
          if(cur === null || cur === undefined || prev === null || prev === undefined || next === null || next === undefined) return false;
          return cur < prev && cur < next;
        },
        formatter(value, context){
          const v = skuCounts[context.dataIndex];
          return (v === null || v === undefined) ? '' : `SKU Count: ${Math.round(v)}`;
        },
        align: 'bottom',
        anchor: 'end',
        color: '#4A0E17',
        font: { size: 10, weight: '600', family: 'Inter, sans-serif' },
        backgroundColor: 'rgba(255,255,255,0.9)',
        borderRadius: 4,
        borderColor: '#8d6a9f',
        borderWidth: 1,
        padding: { top: 3, bottom: 3, left: 5, right: 5 }
      };
    }

    const chartConfig = {
      type: qtyIsLine ? 'line' : 'bar',
      data: {
        labels: rows.map(r => r[xField]),
        datasets: [
          { type: qtyIsLine ? 'line' : 'bar', label: 'Qty Sold', data: rows.map(r => r.total_qty_sold), backgroundColor: 'rgba(74,14,23,0.55)', borderColor: '#4A0E17', yAxisID: 'y', tension: 0.25 },
          segmentUnitsDataset
        ]
      },
      options: chartOptions
    };
    if(hasDatalabels) chartConfig.plugins = [ChartDataLabels];

    makeChart('edaanChart17', chartConfig);
  }

  // ================================================================================
  // NEW (production feedback, action item #3 — RPI vs Qty & (OSA × Product Ranking) vs
  // Qty) — LATEST STAKEHOLDER FEEDBACK: converted from per-row scatter plots into
  // standard time-series trend charts, exactly matching the dual-axis pattern used by
  // charts 3/4/5/15/16 (Qty Sold as a LINE on the left axis, the driver metric as a LINE
  // on the right axis), fully driven by the global Time Interval filter via
  // pickDataset()/aggregate(). The third scatter plot, (PTC − Competitor PTC) vs Qty,
  // has been removed entirely per this feedback round — see the deleted
  // ptc_gap_vs_comp/ptc_gap_pct_vs_comp fields (no longer computed in engineerFeatures)
  // and the deleted edaanScatterPtcGap canvas card in index.html.
  // ================================================================================

  // Trend Chart 1: RPI (Relative Price Index = PTC / Comp_ptc) vs Qty, over time
  function renderEdaanRpiTrend(){
    const interval = getInterval();
    const { dataset, xField, qtyIsLine } = pickDataset(interval);
    let rows = applyMasterFilters(dataset);
    rows = aggregate(rows, [xField], { total_qty_sold: 'sum', rpi: 'mean' });
    rows.sort(sortByX(xField));
    makeChart('edaanRpiTrend', {
      type: qtyIsLine ? 'line' : 'bar',
      data: {
        labels: rows.map(r => r[xField]),
        datasets: [
          { type: qtyIsLine ? 'line' : 'bar', label: 'Qty Sold', data: rows.map(r => r.total_qty_sold), backgroundColor: 'rgba(74,14,23,0.55)', borderColor: '#4A0E17', yAxisID: 'y', tension: 0.25 },
          { type: 'line', label: 'RPI (PTC ÷ Comp PTC)', data: rows.map(r => r.rpi), borderColor: '#C5A059', backgroundColor: '#C5A059', yAxisID: 'y1', tension: 0.25, pointRadius: 3, pointHoverRadius: 5 }
        ]
      },
      options: dualAxisOptions('Qty Sold', 'RPI (PTC ÷ Comp PTC)')
    });
  }

  // Trend Chart 2: (OSA × Product Ranking) vs Qty, over time — dynamic composite metric
  function renderEdaanOsaRankTrend(){
    const interval = getInterval();
    const { dataset, xField, qtyIsLine } = pickDataset(interval);
    let rows = applyMasterFilters(dataset);
    rows = aggregate(rows, [xField], { total_qty_sold: 'sum', osa_rank_product: 'mean' });
    rows.sort(sortByX(xField));
    makeChart('edaanOsaRankTrend', {
      type: qtyIsLine ? 'line' : 'bar',
      data: {
        labels: rows.map(r => r[xField]),
        datasets: [
          { type: qtyIsLine ? 'line' : 'bar', label: 'Qty Sold', data: rows.map(r => r.total_qty_sold), backgroundColor: 'rgba(74,14,23,0.55)', borderColor: '#4A0E17', yAxisID: 'y', tension: 0.25 },
          { type: 'line', label: 'OSA × Product Ranking', data: rows.map(r => r.osa_rank_product), borderColor: '#2E6F9E', backgroundColor: '#2E6F9E', yAxisID: 'y1', tension: 0.25, pointRadius: 3, pointHoverRadius: 5 }
        ]
      },
      options: dualAxisOptions('Qty Sold', 'OSA × Product Ranking')
    });
  }

  // ---------- expose a resize hook so the existing sidebar-toggle resize sweep also catches these charts ----------
  window.edaanResizeAll = function(){
    Object.keys(edaanCharts).forEach(id => { const c = edaanCharts[id]; if(c && typeof c.resize === 'function') c.resize(); });
  };

})();