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
  const FS_VERSION = '1.3.1';
  const OWNER = 'xemepark@gmail.com';
  const BOOK_HEADER = ['日期', 'Email', '姓名', '職位', '門市', '類型', '建立時間', '建立者'];
  const LOG_HEADER = ['時間', 'Email', '姓名', '動作', '內容'];
  const READ = ['whoami', 'load', 'adminLoad', 'adminRoster'];
  const TX = ['book', 'cancel', 'submit', 'adminSetLeave', 'adminSubmitFor'];
  const SUBMIT_HEADER = ['月份', 'Email', '送出時間', '操作者'];

  firebase.initializeApp(window.FIREBASE_CONFIG);
  const auth = firebase.auth();
  const db = firebase.firestore();

  let G = null;                 // 執行 Code.gs 的環境
  let cfg = null;               // cfg/main
  const months = {};            // yyyy-MM → 月份文件
  let authUser;                 // undefined＝還不知道，null＝沒登入
  let readyResolve;
  let ready = new Promise(r => { readyResolve = r; });
  let gotCfg = false, gotMonths = false, unsubs = [];
  // 換帳號或重新登入時，整個重新讀一次（不沿用上一次的錯誤）
  function restart() {
    unsubs.forEach(u => u()); unsubs = [];
    ready = new Promise(r => { readyResolve = r; });
    gotCfg = false; gotMonths = false; readyErr = null; cfg = null;
    Object.keys(months).forEach(k => delete months[k]);
    listen();
  }

  const realEmail = () => (auth.currentUser && auth.currentUser.email ? auth.currentUser.email.toLowerCase() : '');
  /* ---------- 測試模式：管理員用某位同仁的身分操作（只有同仁頁面、只在測試模式） ---------- */
  const AS_KEY = 'fsActAs';
  const isRealAdmin = () => { const em = realEmail(); return !!em && (em === OWNER || !!(cfg && (cfg.admins || []).indexOf(em) >= 0)); };
  function actAs() {
    if (!window.FS_ALLOW_ACT_AS || !cfg || !cfg.testMode || !isRealAdmin()) return '';
    let as = '';
    try { as = sessionStorage.getItem(AS_KEY) || ''; } catch (e) {}
    return as && (cfg.staffMap || {})[as] ? as : '';
  }
  // 系統裡「我是誰」：測試模式模擬同仁時是那位同仁，其他時候是登入的帳號
  const authEmail = () => actAs() || realEmail();

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
    let subRows = [];
    Object.keys(months).sort().forEach(m => { subRows = subRows.concat(subToRows(m, months[m].sub)); });
    G.sheets[C.SUBMIT] = C.makeSheet(C.SUBMIT, [SUBMIT_HEADER].concat(subRows));
    if (!G.sheets[C.LOG]) G.sheets[C.LOG] = C.makeSheet(C.LOG, [LOG_HEADER]);
    try { G.bumpVer_(); } catch (e) {}
  }

  function setMonthRows(m, b) {
    const sh = G.sheets[C.BOOK];
    const keep = sh.data.slice(1).filter(r => C.normDate(r[0]).slice(0, 7) !== m);
    sh.data = [BOOK_HEADER].concat(keep, C.entriesToRows(b));
  }
  /* 送出紀錄 ⇄ 月份文件的 sub：{ email: { a: 時間, b: 操作者 } } */
  function subToRows(m, sub) {
    return Object.keys(sub || {}).map(e => [m, e, (sub[e] && sub[e].a) || '', (sub[e] && sub[e].b) || '']);
  }
  function setMonthSub(m, sub) {
    const sh = G.sheets[C.SUBMIT];
    const keep = sh.data.slice(1).filter(r => String(r[0]) !== m);
    sh.data = [SUBMIT_HEADER].concat(keep, subToRows(m, sub));
  }
  function subFromSheet(m) {
    const out = {};
    G.sheets[C.SUBMIT].data.slice(1).forEach(r => {
      if (String(r[0]).slice(0, 7) !== m) return;
      const e = C.normEmail(r[1]);
      const at = r[2] instanceof Date ? C.fmtDate(r[2], '', 'yyyy-MM-dd HH:mm') : String(r[2] || '');
      if (e) out[e] = { a: at, b: C.normEmail(r[3]) };
    });
    return out;
  }
  /** 這個月的順序、輪到誰（照 Code.gs 算），加上送出紀錄 */
  function monthMeta(m) {
    G.__reset();
    const x = G.monthMeta_(m);
    return { ord: x.ord, oi: x.oi, turn: x.turn, sub: subFromSheet(m) };
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
    if (err) { readyErr = err; console.warn('[fs] 讀取失敗', err.code, err.message); }
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
    const email = realEmail();
    const as = actAs();
    rows.forEach(r => {
      db.collection('logs').add({ at: String(r[0] || ''), email, name: String(r[2] || ''), action: String(r[3] || ''),
        detail: (as ? '［測試模式：' + email + ' 模擬］' : '') + String(r[4] || ''),
        ts: firebase.firestore.FieldValue.serverTimestamp() }).catch(() => {});
    });
  }
  const err = (msg, code) => ({ ok: false, error: msg, code });

  /* ---------- 劃假、取消、代排：Firestore 交易 ---------- */
  /** 試算表 ↔ Firestore 同步：交給 Apps Script 後端做（用 Firebase 登入憑證證明是管理員） */
  async function syncWithSheet(op) {
    try {
      const tok = await auth.currentUser.getIdToken();
      // eslint-disable-next-line no-undef
      const res = await realFetch(CONFIG.API_URL, { method: 'POST', body: JSON.stringify({ action: 'fsSync', op, fbToken: tok }) });
      return await res.json();
    } catch (e) {
      return err('連不到試算表後端，請檢查網路後再試', 'NETWORK');
    }
  }
  async function txWrite(body) {
    const date = String(body.date || '');
    const m = date ? date.slice(0, 7) : String(body.month || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(m)) return run(body);
    const ref = db.doc('months/' + m);
    let result = null;
    try {
      await db.runTransaction(async tx => {
        const snap = await tx.get(ref);
        const doc = snap.exists ? snap.data() : null;
        // 用最新的資料檢查（別人可能剛劃走名額）
        setMonthRows(m, doc ? doc.b : {});
        setMonthSub(m, doc ? doc.sub : {});
        const logFrom = snapshotLog();
        result = run(body);
        if (!result.ok) { G.sheets[C.LOG].data.length = logFrom; return; }
        if (!doc || !doc.pm) { result = err('這個月份還沒開放劃假（名額表還沒建立），請洽管理員', 'NOT_OPEN'); return; }
        const b = rowsToB(monthRows(m));
        const isAdminAct = body.action.indexOf('admin') === 0;
        // 其他欄位（順序、送出紀錄…）原樣保留，只改這次有動到的
        const next = Object.assign({}, doc, { b });
        if (isAdminAct) {
          // 管理員：直接重算每個名額池的已用數、順序、輪到誰
          Object.keys(b).forEach(k => { if (!b[k].sl) b[k].sl = doc.pm[b[k].d + '|' + b[k].r + '|' + b[k].st] || ''; });
          next.c = C.countPools(b, doc.pm);
          Object.assign(next, monthMeta(m));
          next.last = { k: '', s: '', op: 'admin' };
        } else if (body.action === 'submit') {
          // 同仁送出：只動自己的送出紀錄、自己這一組輪到誰（安全規則會再檢查）
          const me = authEmail();
          const meta = monthMeta(m);
          const st = (cfg.staffMap || {})[me] || {};
          const cg = st.role + '|全公司';
          const g = (cg in (doc.turn || {})) ? cg : st.role + '|' + st.store;
          delete next.b; next.b = doc.b;
          next.sub = Object.assign({}, doc.sub || {}, { [me]: meta.sub[me] || { a: '', b: me } });
          next.turn = Object.assign({}, doc.turn || {});
          if (g in next.turn) next.turn[g] = meta.turn[g] || '';
          next.last = { k: '', s: '', op: 'submit' };
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
      return err(denied ? '這天的名額剛剛被劃走了，或管理員剛剛暫停劃假' : '連線失敗，請檢查網路後再試', denied ? 'FULL' : 'NETWORK');
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
      window: { mode: s.mode || '自動', openMs: s.openAt ? s.openAt.getTime() : 0, closeMs: s.closeAt ? s.closeAt.getTime() : 0, months: s.months || [] }
    };
  }

  /** 重新算這些月份的名額表（pm/q），並依現有排休重算已用名額（c） */
  function buildMonthDocs(list, pub) {
    const out = {};
    list.forEach(m => {
      const b = rowsToB(monthRows(m));
      const { pm, q } = C.computePools(G, m, C.combosFor(G, b));
      Object.keys(b).forEach(k => { b[k].sl = pm[b[k].d + '|' + b[k].r + '|' + b[k].st] || ''; });
      out[m] = Object.assign({ b, pm, q, c: C.countPools(b, pm), pub, last: { k: '', s: '', op: 'admin' } }, monthMeta(m));
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
    if (!isRealAdmin() || actAs()) return;
    const d = derivedCfg();
    const need = monthsToPublish(d.window).filter(m => !months[m] || !months[m].pm || (months[m].pub || 0) < (cfg.pub || 0));
    const winChanged = JSON.stringify(d.window) !== JSON.stringify(cfg.window || {});
    if (!need.length && !winChanged) return;
    try { await saveAll(); } catch (e) {}
  }

  const PICKED_KEY = 'fsActPicked';
  function showPicker(fs) {
    const list = window.LeaveFS.staffList().sort((x, y) => (x.store + x.role + x.name).localeCompare(y.store + y.role + y.name, 'zh-Hant'));
    const wrap = document.createElement('div');
    wrap.id = 'fsPick';
    wrap.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(40,30,25,.55);display:flex;align-items:flex-end;justify-content:center';
    wrap.innerHTML = '<div style="background:#fffaf5;width:min(480px,100%);max-height:88vh;display:flex;flex-direction:column;border-radius:18px 18px 0 0;padding:16px 16px calc(16px + env(safe-area-inset-bottom));font-size:15px;color:#3a2e28;box-shadow:0 -6px 30px rgba(0,0,0,.2)">' +
      '<div style="font-weight:700;font-size:17px">🧪 測試模式：要用誰的身分進入？</div>' +
      '<div style="font-size:13px;color:#8a7b70;margin:4px 0 10px">選一位同仁，就會看到他的劃假畫面；劃假、許願、送出都會真的寫入。</div>' +
      '<button type="button" data-self="1" style="font:inherit;border:1.5px solid #3a2e28;background:#3a2e28;color:#fff;border-radius:12px;padding:11px;margin-bottom:10px;cursor:pointer">用我自己的身分（' + (fs.real || '') + '）進入</button>' +
      '<input type="search" placeholder="搜尋姓名、門市、職務" style="font:inherit;border:1px solid #e4d8cc;border-radius:10px;padding:9px 11px;margin-bottom:8px">' +
      '<div class="lst" style="overflow:auto;display:grid;gap:6px;padding-bottom:4px"></div></div>';
    document.body.appendChild(wrap);
    const box = wrap.querySelector('.lst'), q = wrap.querySelector('input');
    const draw = () => {
      const k = q.value.trim();
      box.innerHTML = '';
      list.filter(p => !k || (p.name + p.store + p.role + p.email).indexOf(k) >= 0).forEach(p => {
        const b = document.createElement('button');
        b.type = 'button';
        b.style.cssText = 'font:inherit;text-align:left;border:1px solid #e4d8cc;background:#fff;border-radius:10px;padding:10px 12px;cursor:pointer;display:flex;justify-content:space-between;gap:8px';
        b.innerHTML = '<b></b><span style="color:#8a7b70;font-size:13px"></span>';
        b.querySelector('b').textContent = p.name;
        b.querySelector('span').textContent = p.store + '・' + p.role;
        b.onclick = () => { window.LeaveFS.actAs(p.email); location.href = 'index.html'; };
        box.appendChild(b);
      });
      if (!box.children.length) box.innerHTML = '<div style="color:#8a7b70;font-size:13px;padding:8px">找不到符合的同仁</div>';
    };
    q.oninput = draw; draw();
    wrap.querySelector('[data-self]').onclick = () => {
      try { sessionStorage.setItem(PICKED_KEY, '1'); sessionStorage.removeItem(AS_KEY); } catch (e) {}
      wrap.remove();
      if (window.FS_ALLOW_ACT_AS && fs.as) location.reload();
    };
  }

  /** 系統擁有者切換測試／上線模式 */
  async function setTestMode(on) {
    if (realEmail() !== OWNER) return err('只有系統擁有者可以切換測試／上線模式', 'NOT_OWNER');
    try { await db.doc('cfg/main').update({ testMode: on }); } catch (e) { return err('切換失敗，請檢查網路後再試', 'NETWORK'); }
    if (cfg) cfg.testMode = on;
    db.collection('logs').add({ at: C.fmtDate(new Date(), '', 'yyyy-MM-dd HH:mm:ss'), email: realEmail(), name: '系統擁有者', action: on ? '切換成測試模式' : '切換成上線模式', detail: '',
      ts: firebase.firestore.FieldValue.serverTimestamp() }).catch(() => {});
    return { ok: true, message: on ? '已切換成測試模式：管理員可以模擬同仁' : '已切換成上線模式' };
  }

  /* ---------- 攔下網頁送到 Apps Script 的請求 ---------- */
  async function handle(body) {
    if (authUser === undefined) await new Promise(r => { const u = auth.onAuthStateChanged(x => { u(); r(); }); });
    if (!auth.currentUser) return err('請先登入', 'AUTH');
    await ready;
    if (readyErr) { restart(); await ready; }   // 失敗就重讀一次（例如剛登入、權杖還沒生效）
    if (readyErr && readyErr.code === 'permission-denied') return err('這個帳號（' + realEmail() + '）不在人員名單裡，請洽主管', 'NOT_STAFF');
    if (!cfg) return err('Firestore 版還沒匯入資料，請洽系統擁有者', 'SETUP');
    const a = body.action;
    if (a === 'fsSetTestMode') return setTestMode(!!body.on);
    const as = actAs();
    if (as) {
      if (a && a.indexOf('admin') === 0) return err('測試模式模擬同仁中，不能做管理員的動作', 'NOT_ADMIN');
      body.idToken = fakeToken(as);
    }
    if (a === 'fsSync') return as ? err('模擬同仁中不能同步', 'NOT_ADMIN') : syncWithSheet(body.op);
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
      try {
        out = await handle(JSON.parse(opt.body));
        if (out && typeof out === 'object' && cfg && auth.currentUser) out.fs = { test: !!cfg.testMode, admin: isRealAdmin(), owner: realEmail() === OWNER, real: realEmail(), as: actAs() };
      }
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
    disableAutoSelect() { try { sessionStorage.removeItem(AS_KEY); sessionStorage.removeItem(PICKED_KEY); } catch (e) {} if (!cfg && realEmail() === OWNER) return; auth.signOut().catch(() => {}); }
  } } };

  let lastUid = null;
  auth.onAuthStateChanged(async user => {
    authUser = user || null;
    if (!user) { lastUid = null; unsubs.forEach(u => u()); unsubs = []; return; }
    if (user.uid !== lastUid) {
      lastUid = user.uid;
      if (!G) await loadCode();
      restart();
    }
    if (cb) cb({ credential: fakeToken(authEmail()) });
  });

  /* 系統擁有者第一次使用：把試算表版匯出的資料匯入 */
  window.LeaveFS = {
    version: FS_VERSION,
    /** 測試模式：可以模擬的同仁（姓名、門市、職務） */
    staffList() {
      const m = (cfg && cfg.staffMap) || {};
      return Object.keys(m).filter(e => m[e].active).map(e => ({ email: e, name: m[e].name || e, role: m[e].role || '', store: m[e].store || '' }));
    },
    actAs(email) { try { if (email) sessionStorage.setItem(AS_KEY, email); else sessionStorage.removeItem(AS_KEY); sessionStorage.setItem(PICKED_KEY, '1'); } catch (e) {} },
    /** 測試模式：管理員一進系統先選要模擬誰（這個分頁選過就不再問） */
    maybePickActAs(fs) {
      let picked = '';
      try { picked = sessionStorage.getItem(PICKED_KEY) || ''; } catch (e) {}
      if (!fs || !fs.test || !fs.admin || fs.as || picked || document.getElementById('fsPick')) return;
      showPicker(fs);
    },
    pickActAs(fs) { showPicker(fs || {}); },
    actingAs() { return actAs(); },
    async importAll(json) {
      if (realEmail() !== OWNER) throw new Error('只有系統擁有者可以匯入');
      if (!G) await loadCode();
      const data = typeof json === 'string' ? JSON.parse(json) : json;
      C.TABLES.forEach(name => { G.sheets[name] = C.makeSheet(name, C.unpack(data.tables[name] || [[]])); });
      G.sheets[C.SRC] = C.makeSheet(C.SRC, data.staffSrc || [['姓名', 'Email', '部門', '職稱', '狀態']]);
      const rows = C.unpack(data.bookings || []);
      G.sheets[C.BOOK] = C.makeSheet(C.BOOK, [BOOK_HEADER].concat(rows));
      G.sheets[C.LOG] = C.makeSheet(C.LOG, [LOG_HEADER]);
      G.sheets[C.SUBMIT] = C.makeSheet(C.SUBMIT, [SUBMIT_HEADER]);
      cfg = Object.assign({}, cfg || {}, { staffSrc: JSON.stringify(data.staffSrc || []) });
      const ms = {};
      rows.forEach(r => { const m = C.normDate(r[0]).slice(0, 7); if (m) ms[m] = 1; });
      await saveAll(Object.keys(ms));
      return { tables: C.TABLES.map(n => n + ':' + ((data.tables[n] || []).length)), bookings: rows.length, staff: (data.staffSrc || []).length - 1, months: Object.keys(ms) };
    },
    /** 只更新人員來源（五欄），其他不動 */
    async importStaff(src) {
      const em = realEmail();
      if (em !== OWNER && (!cfg || (cfg.admins || []).indexOf(em) < 0)) throw new Error('只有管理員可以同步人員');
      cfg = Object.assign({}, cfg, { staffSrc: JSON.stringify(src) });
      rebuildSheets();
      await saveAll();
      return (src.length - 1) + ' 人';
    },
    stats: () => ({ months: Object.keys(months), hasCfg: !!cfg, user: authEmail() })
  };
})();
