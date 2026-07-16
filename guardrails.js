/* =====================================================================================
   guardrails.js — PRICE GUARDRAILS for the Pricing Simulator (independent module)
   =====================================================================================
   A self-contained validation module, completely separate from the simulation engine.
   It reads its OWN reference file (GT_Guardrails.csv) and, when the user edits a
   Simulated PTC, returns a verdict the UI reflects as a tooltip. It never touches
   regression / elasticity / VTM / revenue / volume / profit / Firebase / Firestore /
   Scenario Library / EDA — it only READS guardrail data and RETURNS a verdict.

       GT_Guardrails.csv
            │  GuardrailLoader          (fetch + parse, schema-agnostic)
            ▼
       raw rows
            │  GtPriceCalculator        (per-SKU GT Price = avg of city columns, ignore 0s)
            ▼
       GT price map
            │  CompetitionPriceProvider (returns Competition Price if/when the column exists)
            ▼
       GuardrailValidator              (lower = GT Price × LOWER_GT_FACTOR; upper = max(PTC, Comp) × 1.20)
            ▼  verdict → UI tooltip

   FUTURE-PROOF: guardrail updates require replacing ONLY GT_Guardrails.csv. New city
   columns are auto-averaged; a future "Competition Price" column is auto-consumed by the
   validator. All data-shape assumptions live in CONFIG below — nowhere else.
   ===================================================================================== */
(function () {
  'use strict';

  // ------------------------------------------------------------------------------------
  // CONFIG — the ONLY place data-shape assumptions live. Editing this is configuration,
  // not application logic.
  // ------------------------------------------------------------------------------------
  // Lower guardrail relaxation factor. Minimum Allowed Price = GT Price × LOWER_GT_FACTOR.
  // Change ONLY this value to relax/tighten the floor (e.g. 0.80 = allow the simulated price to sit up
  // to 20% below GT Price). It does NOT change the GT Price itself — only the validation threshold.
  var LOWER_GT_FACTOR = 0.90;

  var CONFIG = {
    csvPath: 'GT_Guardrails.csv',
    keyColumn: 'SKU Short Code',
    // Minimum Allowed Price = GT Price × lowerGtFactor (the only knob for the lower guardrail).
    lowerGtFactor: LOWER_GT_FACTOR,
    // Columns that are NOT per-city price points. EVERY other column is treated as a
    // city/region price and averaged into GT Price. Pre-listing likely future metadata
    // columns here keeps them out of the GT average with zero code changes; any genuinely
    // new *city* column (e.g. "Bangalore") is auto-included.
    nonCityColumns: [
      'Segment', 'SKU Short Code', 'Variant Name', 'SKU Size',
      'Region', 'Category', 'Competition Price', 'Competition_Price', 'Comp Price', 'Comp_ptc'
    ],
    // Candidate names for the (future) Competition Price column — first present one wins.
    competitionPriceColumns: ['Competition Price', 'Competition_Price', 'Comp Price', 'Comp_ptc'],
    // Upper guardrail multiplier on Current PTC (RPI cap): Upper = max(PTC, CompPrice) × factor.
    upperMultiplier: 1.20
  };

  function toNum(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = (typeof v === 'number') ? v : parseFloat(String(v).replace(/,/g, '').trim());
    return Number.isFinite(n) ? n : null;
  }
  function norm(s) { return String(s == null ? '' : s).trim(); }
  function keyNorm(s) { return norm(s).toLowerCase(); }

  // ====================================================================================
  // 1) GuardrailLoader — fetch + parse GT_Guardrails.csv into raw row objects (schema-agnostic).
  // ====================================================================================
  var GuardrailLoader = {
    load: function (onDone, onError) {
      if (typeof Papa === 'undefined') { onError && onError(new Error('PapaParse unavailable.')); return; }
      Papa.parse(CONFIG.csvPath, {
        download: true, header: true, dynamicTyping: true, skipEmptyLines: true,
        complete: function (res) {
          var rows = (res && res.data ? res.data : []).filter(function (r) {
            return r && typeof r === 'object' && norm(r[CONFIG.keyColumn]) !== '';
          });
          onDone(rows);
        },
        error: function (err) { onError && onError(err); }
      });
    }
  };

  // ====================================================================================
  // 2) GtPriceCalculator — per-SKU GT Price = average of city columns, ignoring zeros.
  // ====================================================================================
  var GtPriceCalculator = {
    cityColumns: function (sampleRow) {
      var excl = {};
      CONFIG.nonCityColumns.forEach(function (c) { excl[keyNorm(c)] = true; });
      return Object.keys(sampleRow).filter(function (c) { return !excl[keyNorm(c)]; });
    },
    rowGtPrice: function (row, cityCols) {
      var vals = [];
      cityCols.forEach(function (c) {
        var n = toNum(row[c]);
        if (n !== null && n !== 0) vals.push(n); // ignore zero / blank
      });
      if (!vals.length) return null;             // no usable city value
      return vals.reduce(function (a, b) { return a + b; }, 0) / vals.length; // single value → itself
    },
    // Overall GT Price = average of the GT Prices of the SKUs the simulator currently considers.
    // (The simulator operates at an overall level; SKU-level GT Prices are still retained via
    //  getGtPrice() so per-SKU validation can be switched on later with no redesign.)
    overall: function (gtMap, skuList) {
      var vals = (skuList || []).map(function (s) {
        var e = gtMap.get(norm(s));
        return e ? e.gtPrice : null;
      }).filter(function (v) { return v !== null; });
      if (!vals.length) return null;
      return vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
    }
  };

  // ====================================================================================
  // 3) CompetitionPriceProvider — returns a SKU's Competition Price if the column exists.
  //    When that column later appears in the CSV, the validator auto-uses it (no code change).
  // ====================================================================================
  var CompetitionPriceProvider = {
    columnName: null,
    resolveColumn: function (sampleRow) {
      this.columnName = null;
      var lower = {};
      Object.keys(sampleRow).forEach(function (k) { lower[keyNorm(k)] = k; });
      for (var i = 0; i < CONFIG.competitionPriceColumns.length; i++) {
        var hit = lower[keyNorm(CONFIG.competitionPriceColumns[i])];
        if (hit) { this.columnName = hit; break; }
      }
      return this.columnName;
    },
    fromRows: function (rows) {
      if (!this.columnName) return null;
      var col = this.columnName;
      var vals = rows.map(function (r) { return toNum(r[col]); })
        .filter(function (v) { return v !== null && v !== 0; });
      if (!vals.length) return null;
      return vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
    },
    isAvailable: function () { return !!this.columnName; }
  };

  // ====================================================================================
  // 4) GuardrailValidator — pure rule. Lower = GT Price × LOWER_GT_FACTOR; Upper = max(PTC, Comp?) × 1.20.
  // ====================================================================================
  var GuardrailValidator = {
    evaluate: function (ctx) {
      // ctx: { gtPrice, currentPtc, competitionPrice, simulatedPtc }
      var sim = toNum(ctx.simulatedPtc);
      // GT Price is UNCHANGED. The lower validation threshold (Minimum Allowed Price) is GT Price scaled
      // by the configurable LOWER_GT_FACTOR — only the threshold changes, not the GT Price.
      var gtPrice = (ctx.gtPrice === undefined) ? null : ctx.gtPrice;   // SKU-level GT Price (as-is)
      var lower = (gtPrice === null) ? null : gtPrice * CONFIG.lowerGtFactor; // Minimum Allowed Price
      var cur = toNum(ctx.currentPtc);
      var comp = toNum(ctx.competitionPrice);

      // Business rule: the simulated price may not exceed 20% above WHICHEVER IS HIGHER of the Current
      // PTC and the Competition Price (Comp_PTC).  Maximum Allowed Price = max(Current PTC, Comp_PTC) × factor.
      var base = null;
      if (cur !== null) base = cur;
      if (comp !== null && comp !== 0) base = (base === null) ? comp : Math.max(base, comp);
      var upper = (base === null) ? null : base * CONFIG.upperMultiplier;

      var res = { status: 'ok', message: '', lower: lower, upper: upper, competitionUsed: (comp !== null && comp !== 0) };
      if (sim === null) return res;
      if (lower !== null && sim < lower) { res.status = 'below'; res.message = 'This price is below GT Price.'; return res; }
      if (upper !== null && sim > upper) { res.status = 'above'; res.message = 'This price is above RPI Limit.'; return res; }
      return res;
    }
  };

  // ====================================================================================
  // FACADE — ties the modules together and exposes a small, stable API.
  // ====================================================================================
  var state = { ready: false, byCode: new Map(), simulatorSkus: [], overallGtPrice: null, diagnostics: null, readyCbs: [] };

  // Recompute the Overall GT Price (lower guardrail) from the current simulator SKU set.
  function recomputeOverall() {
    state.overallGtPrice = GtPriceCalculator.overall(state.byCode, state.simulatorSkus);
  }

  function buildIndex(rows) {
    state.byCode = new Map();
    if (!rows.length) return;
    var sample = rows[0];
    var cityCols = GtPriceCalculator.cityColumns(sample);
    CompetitionPriceProvider.resolveColumn(sample);
    if (CompetitionPriceProvider.columnName) {
      cityCols = cityCols.filter(function (c) { return keyNorm(c) !== keyNorm(CompetitionPriceProvider.columnName); });
    }
    // Group rows by SKU Short Code (duplicate rows for a SKU are averaged).
    var groups = new Map();
    rows.forEach(function (r) {
      var code = norm(r[CONFIG.keyColumn]);
      if (!code) return;
      if (!groups.has(code)) groups.set(code, []);
      groups.get(code).push(r);
    });
    groups.forEach(function (grp, code) {
      var gts = grp.map(function (r) { return GtPriceCalculator.rowGtPrice(r, cityCols); })
        .filter(function (v) { return v !== null; });
      var gtPrice = gts.length ? gts.reduce(function (a, b) { return a + b; }, 0) / gts.length : null;
      state.byCode.set(code, { gtPrice: gtPrice, competitionPrice: CompetitionPriceProvider.fromRows(grp) });
    });
    recomputeOverall();
    state.diagnostics = { competitionColumn: CompetitionPriceProvider.columnName, skuCount: state.byCode.size, overallGtPrice: state.overallGtPrice };
  }

  function getGtPrice(sku) { var e = state.byCode.get(norm(sku)); return e ? e.gtPrice : null; }
  function getCompetitionPrice(sku) { var e = state.byCode.get(norm(sku)); return e ? e.competitionPrice : null; }

  function validate(input) {
    // input: { sku, currentPtc, simulatedPtc }
    // Lower guardrail = the SKU's OWN GT Price (per-SKU). The Overall GT Price is still computed and
    // exposed via getOverallGtPrice() so an overall-level mode can be re-enabled later without redesign.
    // Competition Price = Comp_PTC. Prefer an explicit value passed by the caller (the app sources
    // Comp_PTC per SKU + selected month); otherwise fall back to a Competition Price column in the
    // guardrail file if one exists. Either way the validator uses max(Current PTC, Comp_PTC) × 1.20.
    var comp = (input.competitionPrice !== undefined && input.competitionPrice !== null)
      ? input.competitionPrice : getCompetitionPrice(input.sku);
    return GuardrailValidator.evaluate({
      gtPrice: getGtPrice(input.sku),
      currentPtc: input.currentPtc,
      competitionPrice: comp,
      simulatedPtc: input.simulatedPtc
    });
  }

  function init() {
    GuardrailLoader.load(function (rows) {
      try {
        buildIndex(rows);
        state.ready = true;
        console.info('[Guardrails] loaded ' + state.byCode.size + ' SKU guardrail(s). Competition column:',
          CompetitionPriceProvider.columnName || '(none yet — using Current PTC × ' + CONFIG.upperMultiplier + ')');
        state.readyCbs.splice(0).forEach(function (cb) { try { cb(); } catch (e) { console.error(e); } });
      } catch (e) { console.error('[Guardrails] failed to build index:', e); }
    }, function (err) { console.error('[Guardrails] failed to load ' + CONFIG.csvPath + ':', err); });
  }

  window.PriceGuardrails = {
    init: init,
    isReady: function () { return state.ready === true; },
    onReady: function (cb) { state.ready ? cb() : state.readyCbs.push(cb); },
    // The simulator supplies its current SKU set; the Overall GT Price (lower guardrail) is its average.
    setSimulatorSkus: function (skus) {
      state.simulatorSkus = Array.isArray(skus) ? skus.slice() : [];
      if (state.ready) { recomputeOverall(); if (state.diagnostics) state.diagnostics.overallGtPrice = state.overallGtPrice; }
    },
    getOverallGtPrice: function () { return state.overallGtPrice; }, // active lower guardrail
    getGtPrice: getGtPrice,                 // per-SKU GT Price (retained for future SKU-level validation)
    getCompetitionPrice: getCompetitionPrice,
    validate: validate,                     // { status:'below'|'above'|'ok', message, lower, upper }
    getDiagnostics: function () { return state.diagnostics; },
    refresh: init,                          // re-read the CSV on demand (e.g. after a data swap)
    _config: CONFIG
  };

  init(); // auto-load on parse (runs in <head>, before the app's inline script)
})();