/* =====================================================================================
   firebase.js — KRBL Pricing Simulator · Scenario Library persistence backend
   =====================================================================================
   PURPOSE
   -------
   Replaces the old browser-localStorage Scenario Library store with Google Cloud
   Firestore so the Scenario Library becomes a single, shared, permanently persistent
   source of truth:

     ✓ Refresh page              → scenarios remain
     ✓ Logout / login again      → scenarios remain
     ✓ Browser restart           → scenarios remain
     ✓ Different browser         → SAME scenarios
     ✓ Different laptop / user   → SAME scenarios

   All scenario documents live in a single top-level Firestore collection: "scenarios".
   Every user opening the site reads and writes the same collection, so everyone sees
   the identical library.

   INTEGRATION NOTES
   -----------------
   - Uses the Firebase "compat" SDK (loaded as classic <script> tags in index.html),
     which exposes a global `firebase` object. This keeps the whole app as plain,
     non-module scripts so it runs identically whether opened via file:// or over http.
   - This file is loaded AFTER the two firebase-*-compat.js CDN scripts and BEFORE the
     app's own inline <script>, so `window.KRBLFirestore` is guaranteed to exist by the
     time the inline app code runs.
   - Nothing here touches the simulation engine, regression logic, elasticity/price
     calculations, KPIs, charts, CSV parsing, methodology, or UI — persistence only.
   ===================================================================================== */
(function () {
  'use strict';

  // ----- Firebase project configuration (provided by the business) -----
  var firebaseConfig = {
    apiKey: "AIzaSyB98kIAK2ISUj2bshoFGDX561HU_CDQG34",
    authDomain: "krbl-dashboard.firebaseapp.com",
    projectId: "krbl-dashboard",
    storageBucket: "krbl-dashboard.firebasestorage.app",
    messagingSenderId: "879673150124",
    appId: "1:879673150124:web:eb623de0c5bac62243ad09"
  };

  var COLLECTION = 'scenarios';

  var db = null;
  var ready = false;

  // ----- Initialize Firebase + Firestore (guarded so a missing SDK / bad network
  //       never throws during page load and crashes the dashboard) -----
  try {
    if (typeof firebase === 'undefined' || !firebase.initializeApp) {
      throw new Error('Firebase compat SDK not loaded — check the CDN <script> tags in index.html.');
    }
    // Avoid "app already exists" if this file is somehow evaluated twice.
    if (!firebase.apps || !firebase.apps.length) {
      firebase.initializeApp(firebaseConfig);
    }
    db = firebase.firestore();

    // Best-effort offline cache. If it fails (e.g. multiple tabs, unsupported browser,
    // private mode) we simply continue online-only — never fatal.
    try {
      db.enablePersistence({ synchronizeTabs: true }).catch(function (err) {
        console.warn('Firestore offline persistence unavailable (continuing online-only):', err && err.code);
      });
    } catch (persistErr) {
      console.warn('Firestore offline persistence could not be enabled:', persistErr);
    }

    ready = true;
  } catch (initErr) {
    console.error('Firebase initialization failed — Scenario Library will be unavailable:', initErr);
    ready = false;
  }

  function ensureReady() {
    if (!ready || !db) {
      throw new Error('Firestore is not initialized.');
    }
  }

  // A Firestore document cannot store `undefined` values — strip them out (and drop any
  // accidental function values) so a malformed scenario object never rejects the write.
  function sanitizeForFirestore(value) {
    if (value === null || value === undefined) return null;
    if (Array.isArray(value)) {
      return value.map(function (v) { return sanitizeForFirestore(v); });
    }
    if (typeof value === 'function') return null;
    if (typeof value === 'object') {
      var out = {};
      Object.keys(value).forEach(function (k) {
        var v = value[k];
        if (v === undefined || typeof v === 'function') return; // skip
        out[k] = sanitizeForFirestore(v);
      });
      return out;
    }
    // Numbers/strings/booleans pass through; guard against NaN (invalid in Firestore).
    if (typeof value === 'number' && !isFinite(value)) return null;
    return value;
  }

  /**
   * saveScenarioToFirestore(scenario)
   * Creates (or overwrites) a Firestore document holding the COMPLETE scenario object.
   * Uses the scenario's own `id` as the document id so save/delete/load stay consistent.
   * Returns the stored scenario (with a guaranteed string id).
   */
  function saveScenarioToFirestore(scenario) {
    ensureReady();
    if (!scenario || typeof scenario !== 'object') {
      return Promise.reject(new Error('saveScenarioToFirestore: invalid scenario object.'));
    }
    var id = scenario.id != null ? String(scenario.id) : String(Date.now());
    var payload = sanitizeForFirestore(Object.assign({}, scenario, { id: id }));
    // createdAtMs = stable numeric sort key so the library renders in a deterministic
    // (oldest → newest) order across every device, mirroring the old push-append order.
    if (payload.createdAtMs == null) {
      var fromId = parseInt(id, 10);
      payload.createdAtMs = isFinite(fromId) ? fromId : Date.now();
    }
    return db.collection(COLLECTION).doc(id).set(payload).then(function () {
      return payload;
    });
  }

  /**
   * loadScenariosFromFirestore()
   * Reads EVERY document from the scenarios collection and returns them as an array,
   * sorted oldest → newest so the Scenario Library ordering is stable everywhere.
   */
  function loadScenariosFromFirestore() {
    ensureReady();
    return db.collection(COLLECTION).get().then(function (snapshot) {
      var out = [];
      snapshot.forEach(function (doc) {
        var data = doc.data() || {};
        // Skip obviously invalid documents rather than letting them break rendering.
        if (!data || typeof data !== 'object') return;
        data.id = doc.id;
        out.push(data);
      });
      out.sort(function (a, b) {
        var ka = sortKey(a), kb = sortKey(b);
        return ka - kb;
      });
      return out;
    });
  }

  function sortKey(s) {
    if (s && typeof s.createdAtMs === 'number' && isFinite(s.createdAtMs)) return s.createdAtMs;
    var fromId = s && s.id != null ? parseInt(String(s.id), 10) : NaN;
    return isFinite(fromId) ? fromId : 0;
  }

  /**
   * deleteScenarioFromFirestore(id)
   * Permanently removes a single scenario document.
   */
  function deleteScenarioFromFirestore(id) {
    ensureReady();
    if (id == null) return Promise.reject(new Error('deleteScenarioFromFirestore: missing id.'));
    return db.collection(COLLECTION).doc(String(id)).delete();
  }

  /**
   * updateScenarioInFirestore(id, patch)
   * Merges a partial update into an existing scenario document (kept for completeness /
   * future use — e.g. renaming a saved scenario without recreating it).
   */
  function updateScenarioInFirestore(id, patch) {
    ensureReady();
    if (id == null) return Promise.reject(new Error('updateScenarioInFirestore: missing id.'));
    var clean = sanitizeForFirestore(patch || {});
    return db.collection(COLLECTION).doc(String(id)).set(clean, { merge: true });
  }

  // ----- Public surface consumed by the app's inline script -----
  window.KRBLFirestore = {
    isReady: function () { return ready === true; },
    collectionName: COLLECTION,
    saveScenarioToFirestore: saveScenarioToFirestore,
    loadScenariosFromFirestore: loadScenariosFromFirestore,
    deleteScenarioFromFirestore: deleteScenarioFromFirestore,
    updateScenarioInFirestore: updateScenarioInFirestore
  };
})();