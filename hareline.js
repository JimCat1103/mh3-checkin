/**
 * hareline.js — Frontend module for reading Hareline run data from the
 * Google Sheets publish-to-web CSV (instead of the Apps Script getInfo
 * Web App), with localStorage stale-while-revalidate caching.
 *
 * Data source: Google Sheets publish-to-web (CSV) of the "Hareline" tab only.
 * Other tabs of the source spreadsheet (e.g. #NNN run sheets, RunnerStats)
 * are NOT published and remain private.
 *
 * Column order of the CSV (positional, no header):
 *   A  number       e.g. #930 or 930
 *   B  date         e.g. 2026/04/01
 *   C  hare
 *   D  coHare
 *   E  restaurant
 *   F  (特跑 flag, unused here)
 *   G  (開放申請 flag, unused here)
 *
 * Public API on window.HarelineCache:
 *   readHareline(onData, onError)
 *     - onData({ rows, source, info, status, isTestMode, startHour })
 *         Called once (cache only) or twice (cache first, then fresh if
 *         content differs). `source` is "cache" or "fresh".
 *     - onError(err)
 *         Called only when there is no usable cache AND the fetch failed.
 *         err.message ∈ { "network", "http", "parse" }.
 *
 *   getNextRunInfo(rows, now = new Date())
 *     - Pure function. Returns the same shape the Apps Script getInfo
 *       action used to return: { status, info, isTestMode, startHour }.
 */

(function () {
  'use strict';

  // ---- Hardcoded configuration ----------------------------------------
  // These constants mirror the Apps Script configuration at the time of
  // introduction. Update the Apps Script side in lockstep if changed.
  var START_HOUR = 0;
  var END_HOUR = 22;
  var OPEN_DAYS_BEFORE = 7;

  var HARELINE_CSV_URL =
    'https://docs.google.com/spreadsheets/d/e/2PACX-1vSECQ_WdGfJrpvZCR2qHyynE_QRx_A378MWGgNtbkKEyg8PdzBqMMgdAO0wUtezoHoixIfuj74mXgwg/pub?gid=0&single=true&output=csv';

  var CACHE_KEY = 'mh3_hareline_v1';
  var CACHE_VERSION = 1;

  // ---- CSV parser (RFC 4180 subset) -----------------------------------

  /**
   * Tokenize one CSV line into fields. Handles double-quoted fields with
   * embedded commas, and escaped quotes ("") inside quoted fields.
   */
  function tokenizeLine(line) {
    var fields = [];
    var cur = '';
    var inQuotes = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line.charAt(i);
      if (inQuotes) {
        if (ch === '"') {
          if (i + 1 < line.length && line.charAt(i + 1) === '"') {
            cur += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          cur += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === ',') {
          fields.push(cur);
          cur = '';
        } else {
          cur += ch;
        }
      }
    }
    fields.push(cur);
    return fields;
  }

  /**
   * Split CSV text into logical lines, respecting quoted newlines.
   * Handles both \r\n and \n line endings.
   */
  function splitCsvLines(text) {
    var lines = [];
    var cur = '';
    var inQuotes = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      if (ch === '"') {
        inQuotes = !inQuotes;
        cur += ch;
      } else if (!inQuotes && (ch === '\n' || ch === '\r')) {
        if (ch === '\r' && i + 1 < text.length && text.charAt(i + 1) === '\n') {
          i++;
        }
        lines.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
    if (cur.length > 0) lines.push(cur);
    return lines;
  }

  /**
   * Parse a Hareline CSV string into an array of row objects. First row
   * is skipped if it does not look like a data row (first cell not matching
   * ^#?\d+$). Rows with empty first column are ignored.
   * Throws Error if input is not parseable.
   */
  function parseHareline(text) {
    if (typeof text !== 'string') {
      throw new Error('parse: input is not a string');
    }
    var lines = splitCsvLines(text);
    if (lines.length === 0) return [];

    var startIdx = 0;
    var firstFields = tokenizeLine(lines[0]);
    var firstCell = (firstFields[0] || '').trim();
    // Decision: 首行是否為表頭採用「嘗試解析」策略
    // If the first cell does not match "#?123", treat it as a header.
    if (!/^#?\d+$/.test(firstCell)) {
      startIdx = 1;
    }

    var rows = [];
    for (var i = startIdx; i < lines.length; i++) {
      var raw = lines[i];
      if (raw == null) continue;
      var fields = tokenizeLine(raw);
      var first = (fields[0] || '').trim();
      if (first === '') continue; // skip empty rows
      var numberStr = first.replace(/^#+/, '');
      rows.push({
        number: numberStr,
        date: (fields[1] || '').trim(),
        hare: (fields[2] || '').trim(),
        coHare: (fields[3] || '').trim(),
        restaurant: (fields[4] || '').trim()
      });
    }
    return rows;
  }

  // ---- localStorage cache ---------------------------------------------

  function isValidRow(r) {
    return r && typeof r.number === 'string'
      && typeof r.date === 'string'
      && typeof r.hare === 'string'
      && typeof r.coHare === 'string'
      && typeof r.restaurant === 'string';
  }

  function readCache() {
    var raw;
    try {
      raw = window.localStorage.getItem(CACHE_KEY);
    } catch (e) {
      // localStorage can throw in private mode / disabled
      return null;
    }
    if (!raw) return null;
    var parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      removeCache();
      return null;
    }
    if (!parsed || parsed.version !== CACHE_VERSION) {
      removeCache();
      return null;
    }
    if (!Array.isArray(parsed.rows) || parsed.rows.length === 0) {
      removeCache();
      return null;
    }
    for (var i = 0; i < parsed.rows.length; i++) {
      if (!isValidRow(parsed.rows[i])) {
        removeCache();
        return null;
      }
    }
    return parsed;
  }

  function writeCache(rows, fetchedAt) {
    var payload = {
      version: CACHE_VERSION,
      fetchedAt: fetchedAt,
      rows: rows
    };
    try {
      window.localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
    } catch (e) {
      // Quota exceeded or disabled — non-fatal
    }
  }

  function removeCache() {
    try {
      window.localStorage.removeItem(CACHE_KEY);
    } catch (e) {
      // ignore
    }
  }

  // ---- Date / status logic (ported from Apps Script getNextRunInfo) ---

  function getNextWednesday(from) {
    var d = new Date(from.getTime());
    var day = d.getDay();
    var diff = (3 - day + 7) % 7;
    d.setDate(d.getDate() + diff);
    return d;
  }

  function formatDate(d) {
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var dd = String(d.getDate()).padStart(2, '0');
    return y + '/' + m + '/' + dd;
  }

  function parseSheetDate(s) {
    // Accepts "2026/04/01" (primary) and YYYY-MM-DD as fallback.
    // Returns local-time Date at midnight, or null if unparseable.
    if (!s) return null;
    var parts = String(s).trim().split(/[\/\-]/);
    if (parts.length !== 3) return null;
    var y = parseInt(parts[0], 10);
    var mo = parseInt(parts[1], 10);
    var dy = parseInt(parts[2], 10);
    if (isNaN(y) || isNaN(mo) || isNaN(dy)) return null;
    var d = new Date(y, mo - 1, dy, 0, 0, 0, 0);
    return d;
  }

  /**
   * Compute next run info equivalent to Apps Script getNextRunInfo().
   * Pure function — depends only on inputs and hardcoded constants.
   */
  function getNextRunInfo(rows, now) {
    now = now || new Date();
    var currentHour = now.getHours();

    var baseDate = new Date(now.getTime());
    // If today is Wednesday and already past END_HOUR, skip to next week.
    if (now.getDay() === 3 && currentHour >= END_HOUR) {
      baseDate.setDate(baseDate.getDate() + 7);
    }

    var targetDate = getNextWednesday(baseDate);
    var targetMidnight = new Date(
      targetDate.getFullYear(),
      targetDate.getMonth(),
      targetDate.getDate(),
      0, 0, 0, 0
    );
    var targetDateStr = formatDate(targetMidnight);

    var nowMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);

    var foundRun = null;
    if (Array.isArray(rows)) {
      for (var i = 0; i < rows.length; i++) {
        var rowDate = parseSheetDate(rows[i].date);
        if (!rowDate) continue;
        if (rowDate.getTime() === targetMidnight.getTime()) {
          foundRun = {
            number: rows[i].number,
            hare: rows[i].hare || '尚未提供',
            coHare: rows[i].coHare || '尚未提供',
            restaurant: rows[i].restaurant || '',
            dateStr: targetDateStr
          };
          break;
        }
      }
    }
    if (!foundRun) {
      foundRun = {
        number: 'Unknown',
        hare: '尚未提供',
        coHare: '尚未提供',
        restaurant: '',
        dateStr: targetDateStr
      };
    }

    // Status
    var diffMs = targetMidnight.getTime() - nowMidnight.getTime();
    var diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

    var status;
    if (diffDays > OPEN_DAYS_BEFORE) {
      status = 'waiting';
    } else if (diffDays === 0) {
      status = (currentHour < START_HOUR || currentHour >= END_HOUR) ? 'waiting' : 'open';
    } else {
      status = 'open';
    }

    var isTestMode = (START_HOUR === 0 && OPEN_DAYS_BEFORE === 7);

    return {
      status: status,
      info: foundRun,
      isTestMode: isTestMode,
      startHour: START_HOUR
    };
  }

  // ---- Network fetch ---------------------------------------------------

  function fetchFromCsv() {
    // Add a cache-buster tied to a 1-minute window to mitigate Google CDN
    // staleness while still allowing intermediate caches to work.
    var minuteBucket = Math.floor(Date.now() / 60000);
    var url = HARELINE_CSV_URL + '&t=' + minuteBucket;

    return window.fetch(url, { method: 'GET', credentials: 'omit' })
      .then(function (res) {
        if (!res.ok) {
          var httpErr = new Error('http');
          httpErr.status = res.status;
          throw httpErr;
        }
        return res.text();
      }, function (networkErr) {
        var e = new Error('network');
        e.cause = networkErr;
        throw e;
      })
      .then(function (text) {
        try {
          return parseHareline(text);
        } catch (parseErr) {
          var e = new Error('parse');
          e.cause = parseErr;
          throw e;
        }
      });
  }

  // ---- Public read orchestration (stale-while-revalidate) --------------

  function buildPayload(rows, source, now) {
    var info = getNextRunInfo(rows, now);
    return {
      rows: rows,
      source: source,
      info: info.info,
      status: info.status,
      isTestMode: info.isTestMode,
      startHour: info.startHour
    };
  }

  function readHareline(onData, onError) {
    var cache = readCache();
    var hasCache = !!cache;
    var cachedRowsJson = hasCache ? JSON.stringify(cache.rows) : null;

    if (hasCache) {
      // Immediate callback with cached rows.
      try {
        onData(buildPayload(cache.rows, 'cache'));
      } catch (cbErr) {
        console.error('HarelineCache onData(cache) threw', cbErr);
      }
    }

    fetchFromCsv().then(function (freshRows) {
      var freshJson = JSON.stringify(freshRows);
      if (hasCache && freshJson === cachedRowsJson) {
        // Unchanged — only bump fetchedAt in cache.
        writeCache(cache.rows, Date.now());
        return;
      }
      // Either no cache, or content changed.
      writeCache(freshRows, Date.now());
      try {
        onData(buildPayload(freshRows, 'fresh'));
      } catch (cbErr) {
        console.error('HarelineCache onData(fresh) threw', cbErr);
      }
    }, function (err) {
      var category = (err && err.message) || 'network';
      if (hasCache) {
        console.warn('HarelineCache: background fetch failed (' + category + '), keeping cache', err);
        return;
      }
      if (typeof onError === 'function') {
        try {
          onError(err instanceof Error ? err : new Error(category));
        } catch (cbErr) {
          console.error('HarelineCache onError threw', cbErr);
        }
      }
    });
  }

  // ---- GAS pre-warm ----------------------------------------------------
  //
  // Fire-and-forget POST to the Apps Script Web App to wake its V8 container
  // before the user submits anything. The container cold-start (2~8s) is
  // absorbed by the user's read/fill time after page load.
  //
  // Intentional design:
  //   - mode: 'no-cors' avoids a CORS preflight (Apps Script does not emit
  //     CORS headers). The response is opaque; we do not need to read it.
  //   - keepalive: true lets the request finish even if the user navigates
  //     away before the response arrives.
  //   - No client-side throttle: every page load sends one ping. Container
  //     recycling is unpredictable; skipping is more costly than pinging.
  //   - Completely silent on failure: no console.* under any path, no
  //     rejection propagated, no retry.
  //
  // Note: apiUrl is accepted as a parameter (not hardcoded) so hareline.js
  // stays decoupled from the Apps Script endpoint constant that lives in
  // each page.
  function prewarmGas(apiUrl) {
    try {
      if (!apiUrl || typeof window.fetch !== 'function') return;
      window.fetch(apiUrl, {
        method: 'POST',
        mode: 'no-cors',
        keepalive: true,
        body: JSON.stringify({ action: 'ping' })
      }).catch(function () { /* silent */ });
    } catch (e) {
      // silent
    }
  }

  // ---- Expose public API ----------------------------------------------

  window.HarelineCache = {
    readHareline: readHareline,
    getNextRunInfo: getNextRunInfo,
    prewarmGas: prewarmGas,
    // Exposed for testing / verification only — not part of the public contract.
    _internals: {
      parseHareline: parseHareline,
      tokenizeLine: tokenizeLine,
      splitCsvLines: splitCsvLines,
      getNextWednesday: getNextWednesday,
      formatDate: formatDate,
      parseSheetDate: parseSheetDate,
      CACHE_KEY: CACHE_KEY,
      HARELINE_CSV_URL: HARELINE_CSV_URL,
      START_HOUR: START_HOUR,
      END_HOUR: END_HOUR,
      OPEN_DAYS_BEFORE: OPEN_DAYS_BEFORE
    }
  };
})();
