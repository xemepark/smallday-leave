/* 小日子劃假系統（Firestore 版）— 核心
 * 直接在瀏覽器裡執行同一份 Code.gs（劃假規則、名額、連休…全部沿用），
 * 只是把「試算表」換成記憶體裡的表格，資料從 Firestore 讀進來、寫回 Firestore。
 * 這個檔案不碰 Firebase，Node 測試也能用。
 */
(function (root) {
  'use strict';

  const TABLES = ['設定', '人員', '名額規則', '日期覆寫', '公休日', '部門對照', '職稱對照', '劃假順序'];
  const BOOK = '劃假紀錄';
  const LOG = '操作紀錄';
  const SUBMIT = '送出紀錄';   // 存在每個月份文件的 sub 裡
  const SRC = '__人員來源';

  /* ---------- 日期放進 Firestore 前轉成數字，拿出來再轉回日期 ---------- */
  function pack(rows) {
    return rows.map(r => r.map(v => (v instanceof Date) ? { __d: v.getTime() } : (v === undefined ? '' : v)));
  }
  function unpack(rows) {
    return (rows || []).map(r => r.map(v => (v && typeof v === 'object' && '__d' in v) ? new Date(v.__d) : v));
  }

  /* ---------- 模擬 Apps Script 的試算表 ---------- */
  function makeSheet(name, data) {
    const sheet = {
      name, data: data || [],
      getDataRange() {
        const w = Math.max(0, ...sheet.data.map(r => r.length));
        return { getValues: () => sheet.data.map(r => { const x = r.slice(); while (x.length < w) x.push(''); return x.map(v => v === undefined ? '' : v); }) };
      },
      getLastRow: () => sheet.data.length,
      getMaxRows: () => Math.max(1000, sheet.data.length),
      getLastColumn: () => Math.max(0, ...sheet.data.map(x => x.length)),
      appendRow(row) { sheet.data.push(row.slice()); },
      deleteRow(i) { sheet.data.splice(i - 1, 1); },
      deleteRows(i, n) { sheet.data.splice(i - 1, n || 1); },
      insertRowAfter() {}, setFrozenRows() {}, autoResizeColumns() {}, setColumnWidth() {},
      getRange(r, c, nr, nc) { return rangeOf(sheet, r, c, nr, nc); },
      clear() { sheet.data = []; },
      getName: () => name
    };
    return sheet;
  }
  function rangeOf(sheet, r, c, nr, nc) {
    nr = nr || 1; nc = nc || 1;
    const api = {
      getValues() {
        const out = [];
        for (let i = 0; i < nr; i++) {
          const row = sheet.data[r - 1 + i] || [];
          const o = [];
          for (let j = 0; j < nc; j++) { const v = row[c - 1 + j]; o.push(v === undefined ? '' : v); }
          out.push(o);
        }
        return out;
      },
      getValue() { return api.getValues()[0][0]; },
      setValues(vals) {
        vals.forEach((row, i) => {
          while (sheet.data.length < r + i) sheet.data.push([]);
          row.forEach((v, j) => { sheet.data[r - 1 + i][c - 1 + j] = v; });
        });
        return proxy;
      },
      setValue(v) { return api.setValues([[v]]); },
      clearContent() {
        for (let i = 0; i < nr; i++) { const row = sheet.data[r - 1 + i]; if (row) for (let j = 0; j < nc; j++) row[c - 1 + j] = ''; }
        return proxy;
      }
    };
    const proxy = new Proxy(api, { get: (t, k) => (k in t ? t[k] : () => proxy) });
    return proxy;
  }

  function fmtDate(d, zone, fmt) {
    const t = new Date(d.getTime() + 8 * 3600e3);
    const p = n => String(n).padStart(2, '0');
    return fmt.replace('yyyy', t.getUTCFullYear()).replace('MM', p(t.getUTCMonth() + 1))
      .replace('dd', p(t.getUTCDate())).replace('HH', p(t.getUTCHours()))
      .replace('mm', p(t.getUTCMinutes())).replace('ss', p(t.getUTCSeconds()))
      .replace(/\bM\b/, t.getUTCMonth() + 1).replace(/\bd\b/, t.getUTCDate());
  }

  /**
   * 建立一個執行 Code.gs 的環境。
   * opts.authEmail(): 目前登入者的 Email（取代向 Google 驗證 ID Token）
   */
  function makeGas(codeText, opts) {
    const sheets = {};
    const cache = {};
    const external = { getSheetByName: () => sheets[SRC] || null };
    const ss = {
      getSheetByName: n => sheets[n] || null,
      insertSheet: n => (sheets[n] = makeSheet(n)),
      setSpreadsheetTimeZone() {}
    };
    const settingValue = key => {
      const sh = sheets['設定'];
      if (!sh) return '';
      const row = sh.data.find(r => String(r[0]).trim() === key);
      return row ? String(row[1] || '').trim() : '';
    };
    const shim = {
      SpreadsheetApp: { getActiveSpreadsheet: () => ss, flush() {}, openById: () => external },
      LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock() {}, releaseLock() {} }) },
      CacheService: { getScriptCache: () => {
        // 表格都在記憶體裡，不用快取；只留「資料版本」（自動更新比對用）和登入快取
        const off = k => k.indexOf('r3_') === 0 || k.indexOf('staff_') === 0 || k.indexOf('tok_') === 0;
        const get = k => off(k) ? null : (cache[k] == null ? null : cache[k]);
        return {
          get, put: (k, v) => { if (!off(k)) cache[k] = String(v); }, remove: k => { delete cache[k]; },
          getAll: ks => { const o = {}; ks.forEach(k => { const v = get(k); if (v != null) o[k] = v; }); return o; },
          putAll: m => { Object.keys(m).forEach(k => { if (!off(k)) cache[k] = String(m[k]); }); }
        };
      } },
      UrlFetchApp: { fetch() {
        const email = opts && opts.authEmail ? opts.authEmail() : '';
        if (!email) return { getResponseCode: () => 400, getContentText: () => '{}' };
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify({
          aud: settingValue('CLIENT_ID'), email, email_verified: 'true',
          exp: String(Math.floor(Date.now() / 1000) + 3000)
        }) };
      } },
      Utilities: {
        formatDate: fmtDate,
        computeDigest: (alg, s) => { const out = []; let h = 0; for (const ch of String(s)) { h = (h * 31 + ch.codePointAt(0)) >>> 0; out.push(h & 255); } return out.slice(-32); },
        base64EncodeWebSafe: b => b.map(x => (x & 255).toString(16).padStart(2, '0')).join(''),
        DigestAlgorithm: { SHA_256: 'sha256' }
      },
      ContentService: { createTextOutput: s => ({ s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } },
      console: (typeof console !== 'undefined') ? console : { log() {} }
    };
    const exportsList = ['doPost', 'readContext_', 'slot_', 'getSettings_', 'getStaff_', 'loadStaffAll_',
      'roleList_', 'monthDays_', 'normEmail_', 'normDate_', 'normType_', 'bumpVer_', 'dayType_', 'isControlled_', 'monthMeta_', 'VERSION'];
    const body = codeText +
      '\nfunction __reset(){ for (const k in MEMO_) delete MEMO_[k]; FRESH_ = true; }' +
      '\nreturn {' + exportsList.map(n => n + ': (typeof ' + n + " !== 'undefined' ? " + n + ' : null)').join(',') + ', __reset };';
    const names = Object.keys(shim);
    // eslint-disable-next-line no-new-func
    const fn = new Function(...names, body);
    const G = fn(...names.map(n => shim[n]));
    G.sheets = sheets;
    G.cache = cache;
    return G;
  }

  /* ---------- 劃假紀錄：試算表的一列 ⇄ Firestore 月份文件裡的一筆 ---------- */
  function normDate(v) {
    if (v instanceof Date) return fmtDate(v, '', 'yyyy-MM-dd');
    const m = String(v || '').trim().match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
    return m ? m[1] + '-' + String(+m[2]).padStart(2, '0') + '-' + String(+m[3]).padStart(2, '0') : '';
  }
  const normEmail = v => String(v || '').trim().toLowerCase();
  const keyOf = (d, e) => d + '_' + normEmail(e);
  function rowToEntry(r) {
    const d = normDate(r[0]);
    const at = r[6] instanceof Date ? fmtDate(r[6], '', 'yyyy-MM-dd HH:mm:ss') : String(r[6] || '');
    return { d, e: normEmail(r[1]), n: String(r[2] || ''), r: String(r[3] || ''), st: String(r[4] || ''),
      t: String(r[5] || ''), at, by: normEmail(r[7]) };
  }
  function entryToRow(x) { return [x.d, x.e, x.n, x.r, x.st, x.t, x.at || '', x.by || '']; }
  function entriesToRows(b) {
    return Object.keys(b || {}).map(k => b[k]).sort((a, c) => (a.at || '').localeCompare(c.at || '') || (a.d + a.e).localeCompare(c.d + c.e)).map(entryToRow);
  }

  /* ---------- 名額池：每天 × 職務 × 門市 → 屬於哪一個名額池、名額多少 ---------- */
  function poolKey(date, role, store, slot) {
    if (slot.unlimited) return date + '|' + role + '|' + store + '|不限';
    return date + '|' + role + '|' + slot.scope;
  }

  /**
   * 算出一個月份的名額表：
   * pm: { '日期|職務|門市': 名額池 }，q: { 名額池: 名額（-1＝不限，0＝不能劃） }
   * combos：要算的 [職務, 門市]
   */
  function computePools(G, month, combos) {
    G.__reset();
    const ctx = G.readContext_(month);
    const days = G.monthDays_(month);
    const pm = {}, q = {};
    days.forEach(day => {
      const date = day.date || day;
      combos.forEach(([role, store]) => {
        const slot = G.slot_(ctx, { role, store }, date);
        const k = poolKey(date, role, store, slot);
        pm[date + '|' + role + '|' + store] = k;
        let quota = slot.unlimited ? -1 : (slot.quota === null || slot.quota === undefined ? 0 : Number(slot.quota));
        if (slot.holiday) quota = 0;
        q[k] = quota;
      });
    });
    return { pm, q };
  }

  /** 依劃假紀錄重算每個名額池已經用掉幾個 */
  function countPools(b, pm) {
    const c = {};
    Object.keys(b || {}).forEach(k => {
      const x = b[k];
      const s = x.sl || pm[x.d + '|' + x.r + '|' + x.st];
      if (s) c[s] = (c[s] || 0) + 1;
    });
    return c;
  }

  /** 職務 × 門市的組合：現在的同仁 ＋ 這個月已經有排休的人 */
  function combosFor(G, b) {
    G.__reset();
    const set = {};
    (G.getStaff_() || []).forEach(p => { if (p.role && p.store) set[p.role + '|' + p.store] = [p.role, p.store]; });
    Object.keys(b || {}).forEach(k => { const x = b[k]; if (x.r && x.st) set[x.r + '|' + x.st] = [x.r, x.st]; });
    return Object.keys(set).map(k => set[k]);
  }

  root.LeaveCore = { TABLES, BOOK, LOG, SRC, SUBMIT, pack, unpack, makeSheet, makeGas, normDate, normEmail, keyOf,
    rowToEntry, entryToRow, entriesToRows, poolKey, computePools, countPools, combosFor, fmtDate };
})(typeof window !== 'undefined' ? window : globalThis);
