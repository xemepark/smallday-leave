/* 小日子劃假系統（Firestore 版）— 跟 Firebase 連接的部分
 *
 * 網頁原本是把請求送到 Apps Script；這裡攔下那些請求，改成：
 *   讀資料：直接用記憶體裡的資料（Firestore 即時同步進來），幾乎不用等
 *   劃假／取消／代排：用 Firestore 交易寫入（名額、只能改自己的假由資料庫安全規則把關）
 *   管理員改設定：寫回設定文件，並重新算好每個月的名額表
 *
 * Firestore 結構
 *   cfg/main        設定、名額規則、日期覆寫、公休日、人員例外、人員來源（五欄）、管理員、同仁名單、劃假開放時間
 *   months/{yyyy-MM} 這個月的排休 b、名額表 pm/q、已用名額 c
 *   logs/{auto}     操作紀錄
 */
(function () {
  'use strict';
  const C = window.LeaveCore;
  const FS_VERSION = '1.0.0';
  const OWNER = 'xemepark@gmail.com';
  const BOOK_HEADER = ['日期', 'Email', '姓名', '職位', '門市', '類型', '建立時間', '建立者'];
  const LOG_HEADER = ['時間', 'Email', '姓名', '動作', '內容'];
  const READ = ['whoami', 'load', 'adminLoad', 'adminRoster'];
  const TX = ['book', 'cancel', 'adminSetLeave'];

  firebase.initializeApp(window.FIREBASE_CONFIG);
  const auth = firebase.auth();
  const db = firebase.firestore();

  let G = null;                 // 執行 Code.gs 的環境
  let cfg = null;               // cfg/main
  const months = {};            // yyyy-MM → 月份文件
  let authUser;                 // undefined＝還不知道，null＝沒登入
  let readyResolve;
  const ready = new Promise(r => { readyResolve = r; });
  let gotCfg = false, gotMonths = false, unsubs = [];

  const authEmail = () => (auth.currentUser && auth.currentUser.email ? auth.currentUser.email.toLowerCase() : '');

  /* ---------- 把 Firestore 的資料放進記憶體裡的「試算表」 ---------- */
  function rebuildSheets() {
    if (!G) return;
    const t = (cfg && cfg.tables) || {};
    C.TABLES.forEach(name => {
      const rows = t[name] ? C.unpack(JSON.parse(t[name])) : [[]];
      G.sheets[name] = C.makeSheet(name, rows);
    });
    G.sheets[C.SRC] = C.makeSheet(C.SRC, cfg && cfg.staffSrc ? JSON.parse(cfg.staffSrc) : [['姓名', 'Email', '部門', '職稱', '狀態']]);
    let rows = [];
    Object.keys(months).sort().forEach(m => { rows = rows.concat(C.entriesToRows(months[m].b)); });
    G.sheets[C.BOOK] = C.makeSheet(C.BOOK, [BOOK_HEADER].concat(rows));
    if (!G.sheets[C.LOG]) G.sheets[C.LOG] = C.makeSheet(C.LOG, [LOG_HEADER]);
    try { G.bumpVer_(); } catch (e) {}
  }

  function setMonthRows(m, b) {
    const sh = G.sheets[C.BOOK];
    const keep = sh.data.slice(1).filter(r => C.normDate(r[0]).slice(0, 7) !== m);
    sh.data = [BOOK_HEADER].concat(keep, C.entriesToRows(b));
  }
  function monthRows(m) {
    return G.sheets[C.BOOK].data.slice(1).filter(r => C.normDate(r[0]).slice(0, 7) === m);
  }
  function rowsToB(rows) {
    const b = {};
    rows.forEach(r => { const x = C.rowToEntry(r); if (x.d && x.e) b[C.keyOf(x.d, x.e)] = x; });
    return b;
  }

  async function loadCode() {
    const res = await fetch('logic.gs.txt?v=' + FS_VERSION, { cache: 'no-cache' });
    G = C.makeGas(await res.text(), { authEmail });
  }

  function listen() {
    unsubs.forEach(u => u()); unsubs = [];
    unsubs.push(db.doc('cfg/main').onSnapshot(s => {
      cfg = s.exists ? s.data() : null; gotCfg = true; rebuildSheets(); checkReady();
    }, err => { gotCfg = true; checkReady(err); }));
    unsubs.push(db.collection('months').onSnapshot(qs => {
      qs.docChanges().forEach(ch => {
        if (ch.type === 'removed') delete months[ch.doc.id]; else months[ch.doc.id] = ch.doc.data();
      });
      gotMonths = true; rebuildSheets(); checkReady();
    }, err => { gotMonths = true; checkReady(err); }));
  }
  let readyErr = null;
  function checkReady(err) {
    if (err) readyErr = err;
    if (gotCfg && gotMonths) readyResolve();
  }

  /* ---------- 執行 Code.gs 的 doPost ---------- */
  function run(body) {
    const out = G.doPost({ postData: { contents: JSON.stringify(body) } });
    return JSON.parse(out.s);
  }
  const snapshotLog = () => G.sheets[C.LOG].data.length;
  function flushLogs(from) {
    const sh = G.sheets[C.LOG];
    const rows = sh.data.slice(from);
    sh.data = [LOG_HEADER];
    const email = authEmail();
    rows.forEach(r => {
      db.collection('logs').add({ at: String(r[0] || ''), email, name: String(r[2] || ''), action: String(r[3] || ''), detail: String(r[4] || ''),
        ts: firebase.firestore.FieldValue.serverTimestamp() }).catch(() => {});
    });
  }
  const err = (msg, code) => ({ ok: false, error: msg, code });

  /* ---------- 劃假、取消、代排：Firestore 交易 ---------- */
  async function txWrite(body) {
    const date = String(body.date || '');
    const m = date.slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(m)) return run(body);
    const ref = db.doc('months/' + m);
    let result = null;
    try {
      await db.runTransaction(async tx => {
        const snap = await tx.get(ref);
        const doc = snap.exists ? snap.data() : null;
        // 用最新的資料檢查（別人可能剛劃走名額）
        setMonthRows(m, doc ? doc.b : {});
        const logFrom = snapshotLog();
        result = run(body);
        if (!result.ok) { G.sheets[C.LOG].data.length = logFrom; return; }
        if (!doc || !doc.pm) { result = err('這個月份還沒開放劃假（名額表還沒建立），請洽管理員', 'NOT_OPEN'); return; }
        const b = rowsToB(monthRows(m));
        const isAdminAct = body.action === 'adminSetLeave';
        const next = { b, pm: doc.pm, q: doc.q, pub: doc.pub || 0 };
        if (isAdminAct) {
          // 管理員：直接重算每個名額池的已用數
          Object.keys(b).forEach(k => { if (!b[k].sl) b[k].sl = doc.pm[b[k].d + '|' + b[k].r + '|' + b[k].st] || ''; });
          next.c = C.countPools(b, doc.pm);
          next.last = { k: '', s: '', op: 'admin' };
        } else {
          // 同仁：只能動自己這一筆，已用名額 +1 或 -1（安全規則會再檢查一次）
          const me = authEmail();
          const k = C.keyOf(date, me);
          const before = doc.b || {};
          const op = (k in b) && !(k in before) ? 'add' : (!(k in b) && (k in before) ? 'del' : '');
          if (!op) { result = err('資料沒有變動', 'NOCHANGE'); return; }
          const x = op === 'add' ? b[k] : before[k];
          const s = op === 'add' ? (doc.pm[date + '|' + x.r + '|' + x.st] || '') : (x.sl || '');
          if (!s) { result = err('找不到這天的名額設定，請洽管理員', 'NO_RULE'); return; }
          if (op === 'add') b[k].sl = s;
          // 其他人的資料保持原樣
          Object.keys(before).forEach(kk => { if (kk !== k) b[kk] = before[kk]; });
          Object.keys(b).forEach(kk => { if (kk !== k && !(kk in before)) delete b[kk]; });
          next.c = Object.assign({}, doc.c || {});
          next.c[s] = (next.c[s] || 0) + (op === 'add' ? 1 : -1);
          next.last = { k, s, op };
        }
        tx.set(ref, next);
      });
    } catch (e) {
      // 交易失敗：多半是名額被搶走（安全規則擋下），或沒網路
      if (months[m]) setMonthRows(m, months[m].b);
      const denied = e && (e.code === 'permission-denied');
      return err(denied ? '這天的名額剛剛被劃走了，或現在不在開放劃假時間' : '連線失敗，請檢查網路後再試', denied ? 'FULL' : 'NETWORK');
    }
    if (result && result.ok) flushLogs(1);
    return result;
  }

  /* ---------- 管理員改設定：寫回設定文件，並重算名額表 ---------- */
  function tablesFromSheets() {
    const t = {};
    C.TABLES.forEach(name => { t[name] = JSON.stringify(C.pack(G.sheets[name] ? G.sheets[name].data : [[]])); });
    return t;
  }
  function derivedCfg() {
    G.__reset();
    const s = G.getSettings_();
    const staffMap = {};
    (G.getStaff_() || []).forEach(p => { staffMap[p.email] = { role: p.role, store: p.store, active: true, name: p.name }; });
    const admins = (s.admins || []).slice();
    if (s.owner && admins.indexOf(s.owner) < 0) admins.push(s.owner);
    return {
      admins, staffMap, owner: s.owner || '',
      window: { openMs: s.openAt ? s.openAt.getTime() : 0, closeMs: s.closeAt ? s.closeAt.getTime() : 0, months: s.months || [] }
    };
  }

  /** 重新算這些月份的名額表（pm/q），並依現有排休重算已用名額（c） */
  function buildMonthDocs(list, pub) {
    const out = {};
    list.forEach(m => {
      const b = rowsToB(monthRows(m));
      const { pm, q } = C.computePools(G, m, C.combosFor(G, b));
      Object.keys(b).forEach(k => { b[k].sl = pm[b[k].d + '|' + b[k].r + '|' + b[k].st] || ''; });
      out[m] = { b, pm, q, c: C.countPools(b, pm), pub, last: { k: '', s: '', op: 'admin' } };
    });
    return out;
  }
  function monthsToPublish(win) {
    const now = C.fmtDate(new Date(), '', 'yyyy-MM');
    const set = {};
    (win.months || []).forEach(m => { set[m] = 1; });
    Object.keys(months).forEach(m => { if (m >= now) set[m] = 1; });
    return Object.keys(set).sort();
  }

  async function saveAll(extraMonths) {
    const d = derivedCfg();
    const pub = Date.now();
    const next = Object.assign({}, cfg || {}, { tables: tablesFromSheets(), pub, fsVersion: FS_VERSION }, d);
    const list = monthsToPublish(d.window).concat(extraMonths || []).filter((m, i, a) => a.indexOf(m) === i);
    const docs = buildMonthDocs(list, pub);
    const batch = db.batch();
    batch.set(db.doc('cfg/main'), next);
    Object.keys(docs).forEach(m => batch.set(db.doc('months/' + m), docs[m]));
    await batch.commit();
  }

  async function adminWrite(body) {
    // 先抓一次最新資料再改
    const [cs, ms] = await Promise.all([db.doc('cfg/main').get(), db.collection('months').get()]);
    cfg = cs.exists ? cs.data() : null;
    ms.forEach(d => { months[d.id] = d.data(); });
    rebuildSheets();
    const result = run(body);
    if (!result.ok) return result;
    try { await saveAll(); } catch (e) {
      return err(e && e.code === 'permission-denied' ? '沒有權限修改設定' : '儲存失敗，請檢查網路後再試', e && e.code === 'permission-denied' ? 'NOT_ADMIN' : 'NETWORK');
    }
    flushLogs(1);
    return result;
  }

  /** 管理員打開後台時：開放中的月份如果還沒有名額表，就自動建立 */
  async function ensurePublished() {
    if (!cfg) return;
    const em = authEmail();
    if (em !== OWNER && (cfg.admins || []).indexOf(em) < 0) return;
    const d = derivedCfg();
    const need = monthsToPublish(d.window).filter(m => !months[m] || !months[m].pm || (months[m].pub || 0) < (cfg.pub || 0));
    const winChanged = JSON.stringify(d.window) !== JSON.stringify(cfg.window || {});
    if (!need.length && !winChanged) return;
    try { await saveAll(); } catch (e) {}
  }

  /* ---------- 攔下網頁送到 Apps Script 的請求 ---------- */
  async function handle(body) {
    if (authUser === undefined) await new Promise(r => { const u = auth.onAuthStateChanged(x => { u(); r(); }); });
    if (!auth.currentUser) return err('請先登入', 'AUTH');
    await ready;
    if (readyErr && readyErr.code === 'permission-denied') return err('這個帳號（' + authEmail() + '）不在人員名單裡，請洽主管', 'NOT_STAFF');
    if (!cfg) return err('Firestore 版還沒匯入資料，請洽系統擁有者', 'SETUP');
    const a = body.action;
    if (a === 'adminLoad' || a === 'adminRoster') ensurePublished();
    if (READ.indexOf(a) >= 0) return run(body);
    if (TX.indexOf(a) >= 0) return txWrite(body);
    if (a && a.indexOf('admin') === 0) return adminWrite(body);
    return run(body);
  }

  const realFetch = window.fetch.bind(window);
  window.fetch = async function (url, opt) {
    const u = String(url && url.url ? url.url : url);
    // 只攔劃假系統自己的後端網址；派工系統等其他網址照常送出
    // eslint-disable-next-line no-undef
    const api = (typeof CONFIG !== 'undefined' && CONFIG.API_URL) ? CONFIG.API_URL : '';
    if (!api || u.split('?')[0] !== api) return realFetch(url, opt);
    let out;
    if (!opt || !opt.body) {
      out = { ok: true, version: (G && G.VERSION ? G.VERSION : '') + '（Firestore 版 ' + FS_VERSION + '）' };
    } else {
      try { out = await handle(JSON.parse(opt.body)); }
      catch (e) { console.error(e); out = err('系統錯誤：' + (e && e.message ? e.message : e), 'ERROR'); }
    }
    return new Response(JSON.stringify(out), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  /* ---------- 登入：用 Firebase 的 Google 登入，假裝成原本的 Google 登入元件 ---------- */
  let cb = null;
  function fakeToken(email) {
    const enc = o => btoa(unescape(encodeURIComponent(JSON.stringify(o)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return enc({ alg: 'none' }) + '.' + enc({ email, exp: Math.floor(Date.now() / 1000) + 3500 }) + '.fs';
  }
  function signIn() {
    const p = new firebase.auth.GoogleAuthProvider();
    p.setCustomParameters({ prompt: 'select_account' });
    auth.signInWithPopup(p).catch(e => {
      if (e && (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment')) auth.signInWithRedirect(p);
      else if (e && e.code !== 'auth/popup-closed-by-user' && e.code !== 'auth/cancelled-popup-request') alert('登入失敗：' + (e.message || e.code));
    });
  }
  window.google = { accounts: { id: {
    initialize(o) { cb = o && o.callback; },
    renderButton(el) {
      if (!el) return;
      el.innerHTML = '';
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = '使用 Google 帳號登入';
      b.style.cssText = 'font:inherit;font-size:15px;padding:10px 22px;border-radius:999px;border:1px solid #dadce0;background:#fff;color:#3c4043;cursor:pointer;min-width:240px';
      b.onclick = signIn;
      el.appendChild(b);
    },
    prompt() { if (auth.currentUser && cb) cb({ credential: fakeToken(authEmail()) }); },
    disableAutoSelect() { auth.signOut().catch(() => {}); }
  } } };

  let started = false;
  auth.onAuthStateChanged(async user => {
    authUser = user || null;
    if (!user) return;
    if (!started) {
      started = true;
      if (!G) await loadCode();
      listen();
    }
    if (cb) cb({ credential: fakeToken(authEmail()) });
  });

  /* 系統擁有者第一次使用：把試算表版匯出的資料匯入 */
  window.LeaveFS = {
    version: FS_VERSION,
    async importAll(json) {
      if (authEmail() !== OWNER) throw new Error('只有系統擁有者可以匯入');
      if (!G) await loadCode();
      const data = typeof json === 'string' ? JSON.parse(json) : json;
      C.TABLES.forEach(name => { G.sheets[name] = C.makeSheet(name, C.unpack(data.tables[name] || [[]])); });
      G.sheets[C.SRC] = C.makeSheet(C.SRC, data.staffSrc || [['姓名', 'Email', '部門', '職稱', '狀態']]);
      const rows = C.unpack(data.bookings || []);
      G.sheets[C.BOOK] = C.makeSheet(C.BOOK, [BOOK_HEADER].concat(rows));
      G.sheets[C.LOG] = C.makeSheet(C.LOG, [LOG_HEADER]);
      cfg = Object.assign({}, cfg || {}, { staffSrc: JSON.stringify(data.staffSrc || []) });
      const ms = {};
      rows.forEach(r => { const m = C.normDate(r[0]).slice(0, 7); if (m) ms[m] = 1; });
      await saveAll(Object.keys(ms));
      return { tables: C.TABLES.map(n => n + ':' + ((data.tables[n] || []).length)), bookings: rows.length, staff: (data.staffSrc || []).length - 1, months: Object.keys(ms) };
    },
    /** 只更新人員來源（五欄），其他不動 */
    async importStaff(src) {
      const em = authEmail();
      if (em !== OWNER && (!cfg || (cfg.admins || []).indexOf(em) < 0)) throw new Error('只有管理員可以同步人員');
      cfg = Object.assign({}, cfg, { staffSrc: JSON.stringify(src) });
      rebuildSheets();
      await saveAll();
      return (src.length - 1) + ' 人';
    },
    stats: () => ({ months: Object.keys(months), hasCfg: !!cfg, user: authEmail() })
  };
})();
