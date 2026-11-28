#!/usr/bin/env python3
"""把 Firestore 版的網頁（fs/index.html、fs/admin.html）轉成試算表版（根目錄的 index.html、admin.html）。
兩版畫面和功能一樣，差別只在：試算表版用 Google 登入直接打 Apps Script，不載入 Firebase。
用法：python3 tools/sheets_from_fs.py  （在 repo 根目錄執行）"""
import re, sys, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENGINE = open(os.path.join(ROOT, 'fs', 'engine.js'), encoding='utf-8').read()
# 直接沿用 Firestore 版的「選擇模擬同仁」畫面
i = ENGINE.index('  function showPicker(fs) {')
j = ENGINE.index('\n  }\n', i) + len('\n  }\n')
PICKER = ENGINE[i:j]

def shim(allow_act):
    return """<script>
/* 試算表版：測試模式（系統擁有者切換；管理員可以模擬同仁），資料由 Apps Script 回傳 */
window.FS_ALLOW_ACT_AS = %s;
(function(){
  const AS_KEY = 'fsActAs', PICKED_KEY = 'fsActPicked';
  let cur = null;
%s
  window.LeaveFS = {
    sheets: true,
    _set(fs){ cur = fs; },
    staffList(){ return ((cur && cur.staff) || []).map(p => Object.assign({}, p)); },
    actAs(email){ try { if (email) sessionStorage.setItem(AS_KEY, email); else sessionStorage.removeItem(AS_KEY); sessionStorage.setItem(PICKED_KEY, '1'); } catch (e) {} },
    actingAs(){ try { return sessionStorage.getItem(AS_KEY) || ''; } catch (e) { return ''; } },
    maybePickActAs(fs){
      let picked = '';
      try { picked = sessionStorage.getItem(PICKED_KEY) || ''; } catch (e) {}
      if (!fs || !fs.test || !fs.admin || fs.as || picked || document.getElementById('fsPick')) return;
      cur = fs; showPicker(fs);
    },
    pickActAs(fs){ cur = fs || cur; showPicker(fs || cur || {}); }
  };
})();
</script>
<script src="https://accounts.google.com/gsi/client" async defer onload="onGsiLoad()"></script>
""" % ('true' if allow_act else 'false', PICKER)

def convert(name, allow_act):
    s = open(os.path.join(ROOT, 'fs', name), encoding='utf-8').read()
    def rep(a, b, n=1):
        nonlocal s
        c = s.count(a)
        if c < n: sys.exit('%s：找不到要換的內容：%s' % (name, a[:60]))
        s = s.replace(a, b)
    s = s.replace('（Firestore 版）', '')
    s = s.replace("'../dispatch.html'", "'dispatch.html'").replace("'../admin.html#dperm'", "'admin.html#dperm'")
    s = re.sub(r"var b='B([0-9a-z]+)'", r"var b='S\1'", s)
    # Firebase 那一段換成 Google 登入
    i = s.index('<!-- Firestore 版：登入和資料都改走 Firebase -->')
    j = s.index('<script>onGsiLoad();</script>', i) + len('<script>onGsiLoad();</script>')
    s = s[:i] + shim(allow_act) + s[j:]
    if name == 'index.html':
        rep("const POLL_MS = 5000;", "const POLL_MS = 30000;")
        rep("  const body = JSON.stringify(Object.assign({ action, idToken: state.token }, extra || {}));",
            "  const act = window.LeaveFS ? LeaveFS.actingAs() : '';\n  const body = JSON.stringify(Object.assign({ action, idToken: state.token }, act ? { actAs: act } : {}, extra || {}));")
        rep("  if (data.fs) renderTestBar(data.fs);", "  if (data.fs){ if (window.LeaveFS) LeaveFS._set(data.fs); renderTestBar(data.fs); }")
        rep("  store.del('token');\n  if (window.google && google.accounts) google.accounts.id.disableAutoSelect();",
            "  store.del('token');\n  try { sessionStorage.removeItem('fsActAs'); sessionStorage.removeItem('fsActPicked'); } catch(e){}\n  if (window.google && google.accounts) google.accounts.id.disableAutoSelect();")
    else:
        rep("  if (data.fs) renderTestAdm(data.fs);", "  if (data.fs){ if (window.LeaveFS) LeaveFS._set(data.fs); renderTestAdm(data.fs); }")
        rep("  if (h === 'dperm') location.replace('admin.html#dperm');", "  if (h === 'dperm') openDperm();")
        rep("$('#dList').appendChild(el('li', '', e.code === 'AUTH' ? '派工系統還不認得這個版本的登入，請從選單的「派工權限」到舊版後台設定' : e.message)); }",
            "$('#dList').appendChild(el('li', '', e.message)); if (e.code === 'AUTH') handleError(e); }")
        rep("function logout(msg){ state.token = null;", "function logout(msg){ try { sessionStorage.removeItem('fsActAs'); sessionStorage.removeItem('fsActPicked'); } catch(e){} state.token = null;")
        # 跟 Firestore 同步只屬於 Firestore 版
        rep("  .secthd{", "  #syncField{display:none!important}\n  .secthd{")
        s = s.replace("  { id: 'dperm',    label: '派工權限', href: 'admin.html#dperm', show: me => me.admin },   // 派工系統還是用 Google 登入，先用舊版後台設定",
                      "  { id: 'dperm',    label: '派工權限', href: 'admin.html#dperm', show: me => me.admin },")
    if 'firebase' in s.lower() and name == 'index.html':
        sys.exit(name + '：還有 Firebase 的東西沒拿掉')
    open(os.path.join(ROOT, name), 'w', encoding='utf-8').write(s)
    print('已產生', name)

convert('index.html', True)
convert('admin.html', False)
