// ==UserScript==
// @name         稻荷神社 回复邮件提醒
// @namespace    kitsune-notify
// @version      1.5.3
// @description  轮询 Discuz 提醒页(view=mypost)，发现回复/@ 等新提醒就通过 Google Apps Script 发到邮箱。右下角图标打开居中管理面板。
// @author       galact
// @license      MIT
// @match        https://kitsune.ee/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      kitsune.ee
// @connect      script.google.com
// @connect      script.googleusercontent.com
// ==/UserScript==

(function () {
  'use strict';

  // ================== 配置在哪填 ==================
  // 不再把密钥写进代码：点页面右下角图标打开管理面板填入
  //   ① Apps Script 部署 URL（以 /exec 结尾）
  //   ② 校验口令 TOKEN（须与 Code.gs 完全一致）
  //   ③ 收件邮箱（提醒发到哪）
  // 三项存在浏览器本地(GM_setValue)，不进 git 历史。
  var CFG_URL = 'kitsune_cfg_url';
  var CFG_TOKEN = 'kitsune_cfg_token';
  var CFG_EMAIL = 'kitsune_cfg_email';
  var CFG_AT = 'kitsune_cfg_at';   // 是否也提醒“被@”(type=at)，默认关
  // ===============================================

  // ---------- 可调参数 ----------
  var POLL_INTERVAL_MIN = 5;                // 轮询间隔（分钟）
  var NOTICE_PATH = '/home.php?mod=space&do=notice&view=mypost&type=post'; // 「我的帖子」→ 回复(type=post)
  var AT_PATH = '/home.php?mod=space&do=notice&view=mypost&type=at';       // 被@(type=at)，仅开关开启时轮询
  var SITE = 'https://kitsune.ee/';
  var SEEN_KEY = 'kitsune_seen_ids';
  var INIT_KEY = 'kitsune_initialized';
  var LASTPOLL_KEY = 'kitsune_last_poll_ts';
  var MAX_SEEN = 1000;                        // 去重记录上限，防止无限增长
  var PAGE_GAP_MS = 3000;                     // 多提醒页串行拉取的页间隔（毫秒），避免突发请求触发 flood 防御
  var MANUAL_MIN_GAP_S = 30;                  // 手动「立即检查」最小间隔（秒），连点会被拦住
  var MAIL_TIMEOUT_MS = 45000;                // Apps Script 冷启动+发信可能超过 20s
  var MAIL_COOLDOWN_MS = 45000;               // 408/超时后冷却，避免网关已发信再点出第二封
  // ------------------------------

  function log() {
    var a = ['[稻荷提醒]'].concat([].slice.call(arguments));
    console.log.apply(console, a);
  }

  // 与 http-result.js 保持一致（油猴单文件无法 require）
  function classifyGasResponse(status, body) {
    var text = body == null ? '' : String(body);
    var code = Number(status);
    if (code >= 200 && code < 300 && /^\s*ok\s*$/i.test(text)) return { kind: 'ok' };
    if (code === 408 || code === 504 || code === 502) {
      return { kind: 'ambiguous', status: code };
    }
    return { kind: 'error', status: code, body: text };
  }
  function classifyNoticeError(err) {
    var msg = err && err.message ? err.message : String(err);
    if (/Failed to fetch|NetworkError|网络|NS_ERROR_FAILURE/i.test(msg)) {
      return { kind: 'network', message: msg };
    }
    return { kind: 'error', message: msg };
  }
  function joinUrl(site, path) {
    return String(site).replace(/\/$/, '') + '/' + String(path).replace(/^\//, '');
  }
  function shouldRecordSeen(kind) {
    return kind === 'ok' || kind === 'ambiguous';
  }
  function classifyGmTransport(e) {
    var status = e && typeof e.status === 'number' ? e.status : 0;
    var body = e && (e.responseText != null ? e.responseText : e.response);
    var cls = classifyGasResponse(status, body == null ? '' : body);
    if (cls.kind === 'ambiguous') return cls;
    return { kind: 'error', status: status, body: body == null ? '' : String(body) };
  }
  function hasNoticeItems(html) {
    return /<dl\b[^>]*(?:\bnotice\s*=|\bid\s*=\s*["']notice_)/i.test(html);
  }
  function classifyNoticePage(html) {
    var text = html == null ? '' : String(html);
    if (hasNoticeItems(text)) return { status: 'ok' };
    // 不能匹配 attackevasive：Discuz 每页 common.js 都有 attackevasive = '0'
    if (/访问过于频繁|刷新过于频繁/.test(text)) {
      return { status: 'blocked' };
    }
    if (/您需要先登录|请先登录后才能|请先登录/.test(text)) {
      return { status: 'loggedout' };
    }
    return { status: 'ok' };
  }

  // ---------- 配置读写 ----------
  function getCfg() {
    return {
      url: String(GM_getValue(CFG_URL, '') || '').trim(),
      token: String(GM_getValue(CFG_TOKEN, '') || '').trim(),
      email: String(GM_getValue(CFG_EMAIL, '') || '').trim(),
      at: !!GM_getValue(CFG_AT, false)
    };
  }
  function cfgReady(cfg) {
    cfg = cfg || getCfg();
    return /^https:\/\/script\.google\.com\/.*\/exec$/.test(cfg.url) && !!cfg.token && /@/.test(cfg.email);
  }
  var ui = { host: null, overlay: null, form: null, fab: null, toasts: null };

  function ensureUi() {
    if (ui.host && document.documentElement.contains(ui.host)) return true;
    var mount = document.body;
    if (!mount) return false;

    var host = document.getElementById('kitsune-notify-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'kitsune-notify-host';
      host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
      mount.appendChild(host);
    }
    var shadow = host.shadowRoot || host.attachShadow({ mode: 'open' });
    if (shadow.querySelector('form')) {
      ui.host = host;
      ui.overlay = shadow.querySelector('.overlay');
      ui.form = shadow.querySelector('form');
      ui.fab = shadow.querySelector('.fab');
      ui.toasts = shadow.querySelector('.toasts');
      syncFabState();
      return true;
    }
    shadow.innerHTML =
      '<style>' +
      '*{box-sizing:border-box;}' +
      ':host,button,input,label,h2,p,span{' +
        'font-family:"Noto Sans SC","Source Han Sans SC","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;' +
        'color:var(--text);' +
      '}' +
      ':host{' +
        '--bg:#faf8f5;--surface:#fff;--text:#2a1f18;--muted:#6b5e54;' +
        '--border:#e6ddd4;--primary:#9b2c2c;--primary-press:#7f1d1d;' +
        '--ok:#1f7a3a;--warn:#9a6700;--danger:#b42318;--ring:#9b2c2c;' +
      '}' +
      'button{cursor:pointer;touch-action:manipulation;}' +
      'button:focus-visible,input:focus-visible{outline:2px solid var(--ring);outline-offset:2px;}' +
      '.fab{' +
        'pointer-events:auto;position:absolute;right:16px;bottom:16px;z-index:4;' +
        'width:48px;height:48px;border-radius:50%;border:1px solid var(--primary);' +
        'background:var(--primary);color:#fff;display:flex;align-items:center;justify-content:center;' +
        'box-shadow:0 2px 8px rgba(42,31,24,.16);transition:background-color .15s,color .15s;' +
      '}' +
      '.fab:hover,.fab:focus-visible{background:var(--primary-press);}' +
      '.fab[data-ready="0"]{box-shadow:0 0 0 2px var(--warn),0 2px 8px rgba(42,31,24,.16);}' +
      '.fab svg{width:22px;height:22px;display:block;}' +
      '.toasts{' +
        'pointer-events:none;position:absolute;top:24px;left:16px;right:16px;z-index:3;' +
        'display:flex;flex-direction:column;align-items:center;gap:8px;' +
      '}' +
      '.toast{' +
        'pointer-events:auto;width:min(420px,100%);background:var(--surface);color:var(--text);' +
        'border:1px solid var(--border);border-left:4px solid var(--ok);border-radius:10px;' +
        'box-shadow:0 2px 8px rgba(42,31,24,.12);padding:12px 16px;font-size:14px;line-height:1.5;' +
        'opacity:0;transition:opacity .15s ease;word-break:break-word;' +
      '}' +
      '.toast.is-on{opacity:1;}' +
      '.toast.warn{border-left-color:var(--warn);}' +
      '.toast.error{border-left-color:var(--danger);}' +
      '.toast b{display:block;margin-bottom:4px;font-size:12px;letter-spacing:.04em;}' +
      '.overlay{' +
        'display:none;position:absolute;inset:0;z-index:2;align-items:center;justify-content:center;' +
        'padding:16px;background:rgba(42,31,24,.45);pointer-events:auto;' +
      '}' +
      '.overlay.is-open{display:flex;}' +
      '.panel{' +
        'width:min(420px,100%);max-height:min(90vh,720px);overflow:auto;background:var(--surface);' +
        'border:1px solid var(--border);border-radius:10px;box-shadow:0 2px 8px rgba(42,31,24,.18);' +
        'padding:20px 20px 16px;' +
      '}' +
      '.head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px;}' +
      'h2{margin:0;font-size:18px;font-weight:700;line-height:1.3;}' +
      '.icon-btn{' +
        'flex:0 0 44px;width:44px;height:44px;border:1px solid var(--border);border-radius:8px;' +
        'background:var(--bg);color:var(--text);display:flex;align-items:center;justify-content:center;' +
        'transition:background-color .15s;' +
      '}' +
      '.icon-btn:hover{background:var(--border);}' +
      'label.field{display:flex;flex-direction:column;gap:6px;margin-bottom:12px;font-size:13px;font-weight:600;color:var(--text);}' +
      'input[type=url],input[type=password],input[type=email]{' +
        'width:100%;min-height:44px;padding:8px 12px;border:1px solid var(--border);border-radius:8px;' +
        'background:var(--bg);font-size:16px;line-height:1.4;color:var(--text);' +
      '}' +
      'label.check{display:flex;align-items:center;gap:10px;min-height:44px;margin:4px 0 16px;font-size:14px;color:var(--text);}' +
      'label.check input{width:18px;height:18px;accent-color:var(--primary);}' +
      '.row{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px;}' +
      '.row > button{flex:1 1 140px;min-height:44px;padding:0 12px;border-radius:8px;font-size:14px;font-weight:600;line-height:1;transition:background-color .15s,color .15s,opacity .15s;}' +
      '.btn-primary{border:1px solid var(--primary);background:var(--primary);color:#fff;}' +
      '.btn-primary:hover{background:var(--primary-press);}' +
      '.btn-ghost{border:1px solid var(--border);background:var(--bg);color:var(--text);}' +
      '.btn-ghost:hover{background:var(--border);}' +
      '.btn-danger{border:1px solid var(--danger);background:transparent;color:var(--danger);}' +
      '.btn-danger:hover{background:#fde8e6;}' +
      'button:disabled{opacity:.45;cursor:not-allowed;}' +
      '.hint{margin:8px 0 0;font-size:12px;line-height:1.5;color:var(--muted);}' +
      '@media (max-width:420px){.fab{right:12px;bottom:12px;}.toasts{top:12px;left:12px;right:12px;}}' +
      '@media (prefers-reduced-motion:reduce){.toast{transition:none;}.fab,.icon-btn,.row > button{transition:none;}}' +
      '</style>' +
      '<button type="button" class="fab" data-act="open" aria-label="打开稻荷提醒设置" aria-expanded="false" title="稻荷提醒">' +
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 5.2l4.6 3.4L12 3.4l4.4 5.2L21 5.2l-1.7 6.4C19.3 16.4 16 20 12 20s-7.3-3.6-7.3-8.4L3 5.2z"/></svg>' +
      '</button>' +
      '<div class="toasts" aria-live="polite"></div>' +
      '<div class="overlay" role="presentation">' +
        '<div class="panel" role="dialog" aria-modal="true" aria-labelledby="kn-title">' +
          '<div class="head">' +
            '<h2 id="kn-title">稻荷提醒</h2>' +
            '<button type="button" class="icon-btn" data-act="close" aria-label="关闭">' +
              '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.2 3.2l9.6 9.6M12.8 3.2L3.2 12.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>' +
            '</button>' +
          '</div>' +
          '<form>' +
            '<label class="field">部署 URL<input name="url" type="url" autocomplete="off" spellcheck="false" placeholder="https://script.google.com/.../exec"></label>' +
            '<label class="field">校验口令 TOKEN<input name="token" type="password" autocomplete="off"></label>' +
            '<label class="field">收件邮箱<input name="email" type="email" autocomplete="off" placeholder="you@example.com"></label>' +
            '<label class="check"><input name="at" type="checkbox"> 也被 @ 时发邮件</label>' +
            '<div class="row">' +
              '<button type="submit" class="btn-primary">保存</button>' +
              '<button type="button" class="btn-ghost" data-act="close">关闭</button>' +
            '</div>' +
            '<div class="row">' +
              '<button type="button" class="btn-ghost" data-act="test">发送测试邮件</button>' +
              '<button type="button" class="btn-ghost" data-act="poll">立即检查</button>' +
            '</div>' +
            '<div class="row">' +
              '<button type="button" class="btn-danger" data-act="reset">清空去重</button>' +
            '</div>' +
            '<p class="hint">口令与 Apps Script 一致。URL 须以 /exec 结尾。提示出现在页面上方。</p>' +
          '</form>' +
        '</div>' +
      '</div>';

    ui.host = host;
    ui.overlay = shadow.querySelector('.overlay');
    ui.form = shadow.querySelector('form');
    ui.fab = shadow.querySelector('.fab');
    ui.toasts = shadow.querySelector('.toasts');

    shadow.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-act]');
      if (!btn || btn.disabled) return;
      var act = btn.getAttribute('data-act');
      if (act === 'open') {
        if (ui.overlay && ui.overlay.classList.contains('is-open')) closePanel();
        else openPanel();
      }
      else if (act === 'close') closePanel();
      else if (act === 'test') sendTestMail(btn);
      else if (act === 'poll') poll(true);
      else if (act === 'reset') resetSeen();
    });
    ui.overlay.addEventListener('click', function (e) {
      if (e.target === ui.overlay) closePanel();
    });
    ui.form.addEventListener('submit', function (e) {
      e.preventDefault();
      saveFromPanel();
    });
    if (!host._knEsc) {
      host._knEsc = true;
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && ui.overlay && ui.overlay.classList.contains('is-open')) closePanel();
      });
    }
    syncFabState();
    return true;
  }

  function syncFabState() {
    if (!ui.fab) return;
    var ready = cfgReady();
    ui.fab.dataset.ready = ready ? '1' : '0';
    ui.fab.title = ready ? '稻荷提醒' : '稻荷提醒（未配置）';
  }

  function fillPanel() {
    var cfg = getCfg();
    ui.form.url.value = cfg.url;
    ui.form.token.value = cfg.token;
    ui.form.email.value = cfg.email;
    ui.form.at.checked = !!cfg.at;
  }

  function openPanel() {
    if (!ensureUi()) return;
    fillPanel();
    ui.overlay.classList.add('is-open');
    ui.fab.setAttribute('aria-expanded', 'true');
    var first = ui.form.querySelector('input');
    if (first) first.focus();
  }

  function closePanel() {
    if (!ui.overlay) return;
    ui.overlay.classList.remove('is-open');
    if (ui.fab) {
      ui.fab.setAttribute('aria-expanded', 'false');
      ui.fab.focus();
    }
  }

  function saveFromPanel() {
    GM_setValue(CFG_URL, String(ui.form.url.value).trim());
    GM_setValue(CFG_TOKEN, String(ui.form.token.value).trim());
    GM_setValue(CFG_EMAIL, String(ui.form.email.value).trim());
    GM_setValue(CFG_AT, !!ui.form.at.checked);
    syncFabState();
    if (cfgReady()) toast('设置已保存。被@提醒：' + (ui.form.at.checked ? '开' : '关') + '。可点「发送测试邮件」验证。');
    else toast('已保存，但有值看起来不对：URL 需以 /exec 结尾、邮箱需含 @、TOKEN 不能空。', 'warn');
  }

  var mailBusy = false;
  var mailCooldownUntil = 0;

  function setMailButtonsDisabled(disabled) {
    if (!ui.form) return;
    ['test', 'poll'].forEach(function (act) {
      var btn = ui.form.querySelector('[data-act="' + act + '"]');
      if (btn) btn.disabled = disabled;
    });
  }

  function armMailCooldown(ms) {
    mailCooldownUntil = Date.now() + ms;
    setMailButtonsDisabled(true);
    setTimeout(function () {
      if (Date.now() >= mailCooldownUntil && !mailBusy) setMailButtonsDisabled(false);
    }, ms);
  }

  function sendTestMail() {
    var now = Date.now();
    if (mailBusy) {
      toast('正在发送，请等这次结束。', 'warn');
      return;
    }
    if (now < mailCooldownUntil) {
      toast('刚才网关可能已经发出。请先查收邮箱，' + Math.ceil((mailCooldownUntil - now) / 1000) + ' 秒内不要再点，以免重复。', 'warn');
      return;
    }
    mailBusy = true;
    setMailButtonsDisabled(true);
    var mail = buildEmail([{ id: 'test', text: '这是一封测试邮件——若收到说明接线成功。', time: new Date().toLocaleString(), link: SITE }]);
    sendEmail(mail.subject.replace('新提醒', '测试'), mail.html)
      .then(function (res) {
        if (res && res.kind === 'ambiguous') {
          armMailCooldown(MAIL_COOLDOWN_MS);
          toast('网关超时（HTTP ' + res.status + '），邮件多半已发出。请先查收，不要立刻再点。', 'warn');
        } else {
          toast('测试邮件已发送，请查收邮箱。');
        }
      })
      .catch(function (err) { toast('发送失败：' + err, 'error'); })
      .then(function () {
        mailBusy = false;
        if (Date.now() >= mailCooldownUntil) setMailButtonsDisabled(false);
      });
  }

  function resetSeen() {
    GM_setValue(SEEN_KEY, []);
    GM_setValue(INIT_KEY, true);
    toast('已清空去重记录，再点「立即检查」会把当前提醒（最多 30 条）重新发一遍。');
  }

  function openSettings() { openPanel(); }

  function toast(msg, type) {
    try {
      if (!ensureUi()) { log(msg); return; }
      var el = document.createElement('div');
      el.className = 'toast' + (type === 'error' ? ' error' : (type === 'warn' ? ' warn' : ''));
      var title = type === 'error' ? '发送失败' : (type === 'warn' ? '注意' : '稻荷提醒');
      var safe = String(msg).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }).replace(/\n/g, '<br>');
      el.innerHTML = '<b>' + title + '</b>' + safe;
      ui.toasts.appendChild(el);
      requestAnimationFrame(function () { el.classList.add('is-on'); });
      setTimeout(function () {
        el.classList.remove('is-on');
        setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 180);
      }, 5000);
    } catch (e) { log(msg); }
  }

  // 链接白名单：只接受 kitsune.ee 的 http(s) 链接，消除注入面
  function safeLink(raw) {
    if (!raw) return '';
    try {
      var u = new URL(raw, SITE);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
      if (u.hostname !== 'kitsune.ee') return '';
      return u.href;
    } catch (e) { return ''; }
  }

  function getSeen() {
    try { return GM_getValue(SEEN_KEY, []) || []; } catch (e) { return []; }
  }
  function saveSeen(ids) {
    if (ids.length > MAX_SEEN) ids = ids.slice(ids.length - MAX_SEEN);
    GM_setValue(SEEN_KEY, ids);
  }

  // 解析提醒页 HTML → 提醒条目数组
  function parseNotices(html) {
    var doc = new DOMParser().parseFromString(html, 'text/html');

    var dls = doc.querySelectorAll('dl[notice], dl[id^="notice_"]');
    if (!dls.length) dls = doc.querySelectorAll('.nts dl');
    var items = [];
    dls.forEach(function (dl) {
      // 稳定唯一 ID：优先 notice 属性，其次 id="notice_xxx"
      var id = dl.getAttribute('notice');
      if (!id && dl.id) id = dl.id.replace(/^notice_/, '');
      if (!id) return;

      var bodyEl = dl.querySelector('.ntc_body');
      var text = bodyEl ? bodyEl.textContent.replace(/\s+/g, ' ').trim() : '(无内容)';

      var timeEl = dl.querySelector('dt .xg1');
      var time = timeEl ? timeEl.textContent.trim() : '';

      // 提取帖子链接（ntc_body 里第一个指向帖子的链接），并做白名单校验
      var link = '';
      var a = bodyEl && (bodyEl.querySelector('a[href*="forum.php"], a[href*="viewthread"], a[href*="findpost"], a[href*="redirect"]') || bodyEl.querySelector('a[href]'));
      if (a) {
        link = safeLink(a.getAttribute('href') || '');
      }

      items.push({ id: String(id), text: text, time: time, link: link });
    });

    return { loggedOut: false, items: items };
  }

  function buildEmail(newItems) {
    var n = newItems.length;
    var subject = '稻荷神社 · 新提醒 ×' + n;

    var rows = newItems.map(function (it) {
      var linkHtml = it.link
        ? '<a href="' + escapeHtml(it.link) + '" style="color:#c0392b;text-decoration:none;">查看帖子 &rsaquo;</a>'
        : '';
      return (
        '<tr>' +
        '<td style="padding:10px 12px;border-bottom:1px solid #eee;font-size:14px;line-height:1.6;">' +
        '<div>' + escapeHtml(it.text) + '</div>' +
        '<div style="color:#999;font-size:12px;margin-top:4px;">' + escapeHtml(it.time) + '　' + linkHtml + '</div>' +
        '</td></tr>'
      );
    }).join('');

    var html =
      '<div style="font-family:system-ui,-apple-system,Segoe UI,Microsoft YaHei,sans-serif;max-width:640px;">' +
      '<h2 style="font-size:16px;color:#333;margin:0 0 8px;">稻荷神社 有 ' + n + ' 条新提醒</h2>' +
      '<table style="width:100%;border-collapse:collapse;border:1px solid #eee;border-radius:6px;overflow:hidden;">' +
      rows +
      '</table>' +
      '<p style="color:#aaa;font-size:12px;margin-top:12px;">由油猴脚本「稻荷神社 回复邮件提醒」自动发送 · ' + new Date().toLocaleString() + '</p>' +
      '</div>';

    return { subject: subject, html: html };
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function sendEmail(subject, html) {
    return new Promise(function (resolve, reject) {
      var cfg = getCfg();
      if (!cfgReady(cfg)) {
        reject('还没配置：点右下角图标打开面板，填入 Apps Script URL / TOKEN / 收件邮箱');
        return;
      }
      GM_xmlhttpRequest({
        method: 'POST',
        url: cfg.url,
        anonymous: false,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ token: cfg.token, to: cfg.email, subject: subject, html: html }),
        timeout: MAIL_TIMEOUT_MS,
        onload: function (r) {
          var cls = classifyGasResponse(r.status, r.responseText);
          if (cls.kind === 'ok' || cls.kind === 'ambiguous') resolve(cls);
          else reject('Apps Script 返回: ' + r.status + ' ' + r.responseText);
        },
        onerror: function (e) {
          var cls = classifyGmTransport(e);
          if (cls.kind === 'ambiguous') resolve(cls);
          else reject('请求失败: ' + JSON.stringify(e));
        },
        ontimeout: function () { resolve({ kind: 'ambiguous', status: 408 }); }
      });
    });
  }

  function say(manual, msg, type) { log(msg); if (manual) toast(msg, type); }

  function parseNoticeHtml(html) {
    var cls = classifyNoticePage(html);
    if (cls.status === 'blocked') return { status: 'blocked', items: [] };
    if (cls.status === 'loggedout') return { status: 'loggedout', items: [] };
    return { status: 'ok', items: parseNotices(html).items };
  }

  function pageGet(url) {
    var ctx = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;
    var f = ctx.fetch;
    if (typeof f !== 'function') return Promise.reject(new TypeError('Failed to fetch'));
    // 只传 URL 字符串，避免沙箱对象跨 realm 导致 Failed to fetch；同源默认带 cookie。
    return f.call(ctx, url).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    });
  }

  function gmGet(url) {
    return new Promise(function (resolve, reject) {
      GM_xmlhttpRequest({
        method: 'GET',
        url: url,
        anonymous: false,
        headers: { 'Accept': 'text/html', 'Referer': SITE },
        timeout: 20000,
        onload: function (r) {
          if (r.status < 200 || r.status >= 400) reject(new Error('HTTP ' + r.status));
          else resolve(r.responseText || '');
        },
        onerror: function () { reject(new TypeError('Failed to fetch')); },
        ontimeout: function () { reject(new Error('拉取提醒页超时')); }
      });
    });
  }

  // 先走页面 fetch（带登录 cookie）；油猴沙箱/CSP 掐成 Failed to fetch 时改走 GM_xmlhttpRequest。
  function fetchNoticePage(path) {
    var url = joinUrl(SITE, path);
    return pageGet(url).catch(function (err) {
      if (classifyNoticeError(err).kind !== 'network') throw err;
      log('页面 fetch 失败，改用油猴通道', err && err.message);
      return gmGet(url);
    }).then(function (html) {
      var parsed = parseNoticeHtml(html);
      log('提醒页', path, parsed.status, '条目', parsed.items.length);
      if (parsed.status === 'blocked') {
        log('拦截页片段', String(html).replace(/\s+/g, ' ').slice(0, 180));
      }
      return parsed;
    });
  }

  function delay(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }

  // 串行拉多个提醒页，页间隔 PAGE_GAP_MS，避免两个请求同时到达触发 Discuz flood 防御
  function fetchNoticePages(paths) {
    var out = [];
    return paths.reduce(function (p, path, i) {
      return p.then(function () {
        return (i > 0 ? delay(PAGE_GAP_MS) : Promise.resolve())
          .then(function () { return fetchNoticePage(path); })
          .then(function (r) { out.push(r); });
      });
    }, Promise.resolve()).then(function () { return out; });
  }

  // 轮询一次。manual=true 时每一步都用 toast 反馈结果，方便你验证。
  function poll(manual) {
    // 多标签页协调：自动轮询间隔内只跑一次
    var now = Date.now();
    var last = GM_getValue(LASTPOLL_KEY, 0);
    if (!manual && now - last < POLL_INTERVAL_MIN * 60 * 1000) return;
    // 手动连点防护：距上次拉取不足 MANUAL_MIN_GAP_S 秒就拦住，避免被论坛频率拉黑
    if (manual && now - last < MANUAL_MIN_GAP_S * 1000) {
      toast('刚查过（' + Math.ceil((MANUAL_MIN_GAP_S * 1000 - (now - last)) / 1000) + 's 内别连点），避免被论坛频率拦截。', 'warn');
      return;
    }

    var cfg = getCfg();
    var paths = [NOTICE_PATH];
    if (cfg.at) paths.push(AT_PATH);   // 开关开启时才多拉“被@”页（串行、页间隔）

    log('开始检查提醒…' + (cfg.at ? '（含被@）' : ''));
    fetchNoticePages(paths)
      .then(function (results) {
        GM_setValue(LASTPOLL_KEY, now); // 只有真正打到论坛才记节流；Failed to fetch 不占用 30s
        // 任一页被拦/未登录：提示并中止，避免把不完整集当基线
        if (results.some(function (r) { return r.status === 'blocked'; })) {
          say(manual, '论坛拦截了这次请求（访问过于频繁/安全校验）。别连续手点，等几分钟让自动轮询来。', 'warn');
          return;
        }
        if (results.some(function (r) { return r.status === 'loggedout'; })) {
          say(manual, '检测到未登录，请先登录论坛再点。', 'warn');
          return;
        }

        // 合并多页条目，按 notice ID 去重（同一 ID 不会跨类型重复，佝保险）
        var idMap = {};
        var items = [];
        results.forEach(function (res) {
          res.items.forEach(function (it) {
            if (!idMap[it.id]) { idMap[it.id] = 1; items.push(it); }
          });
        });

        var seen = getSeen();
        var seenSet = {};
        seen.forEach(function (id) { seenSet[id] = 1; });

        // 首次运行：提醒页会返回历史(已读+未读，每类最多30条)。把当前全部设为基线、不发，
        // 避免刚装好就被一堆老提醒淹没；之后出现的新提醒才发邮件。
        if (!GM_getValue(INIT_KEY, false)) {
          saveSeen(seen.concat(items.map(function (it) { return it.id; })));
          GM_setValue(INIT_KEY, true);
          say(manual, '首次运行：已把当前 ' + items.length + ' 条设为基线（不发历史）。之后新提醒才发。想立刻看真实邮件：先点「清空去重」再点「立即检查」。');
          return;
        }

        var fresh = items.filter(function (it) { return !seenSet[it.id]; });
        log('解析到 ' + items.length + ' 条，未通知过 ' + fresh.length + ' 条');

        if (!fresh.length) {
          say(manual, '解析到 ' + items.length + ' 条提醒，但都已通知过（无新提醒）。想重发请点「清空去重」。');
          return;
        }

        if (mailBusy || Date.now() < mailCooldownUntil) {
          say(manual, '上一封邮件还在发送或刚超时，请先查收邮箱，稍后再检查。', 'warn');
          return;
        }
        var mail = buildEmail(fresh);
        mailBusy = true;
        sendEmail(mail.subject, mail.html).then(function (res) {
          // 408/超时也登记：Apps Script 往往已经发信，不登记会在下次轮询再发一封
          if (shouldRecordSeen(res && res.kind)) {
            saveSeen(seen.concat(fresh.map(function (it) { return it.id; })));
          }
          if (res && res.kind === 'ambiguous') {
            armMailCooldown(MAIL_COOLDOWN_MS);
            say(manual, '网关超时（HTTP ' + res.status + '），邮件多半已发出。请先查收，不要立刻再点。', 'warn');
          } else {
            say(manual, '已发邮件通知 ' + fresh.length + ' 条，请查收邮箱。');
          }
        }).catch(function (err) {
          say(manual, '解析到新提醒，但发邮件失败：\n' + err, 'error');
        }).then(function () {
          mailBusy = false;
          if (Date.now() >= mailCooldownUntil) setMailButtonsDisabled(false);
        });
      })
      .catch(function (err) {
        var cls = classifyNoticeError(err);
        if (cls.kind === 'network') {
          say(manual, '拉不到提醒页（网络被拦或会话失效）。请确认已登录论坛，稍后重试。不要连点。', 'warn');
        } else {
          say(manual, '拉取提醒页失败：' + err, 'error');
        }
      });
  }

  // 油猴菜单仅作备用入口，主入口是页面右下角图标
  GM_registerMenuCommand('打开稻荷提醒面板', openSettings);

  function mountUi() {
    if (ensureUi()) return;
    setTimeout(mountUi, 200);
  }
  if (document.body) mountUi();
  else document.addEventListener('DOMContentLoaded', mountUi);

  // 开页后 8 秒先跑一次（补发关机期间累积的），之后每分钟检查是否到轮询点
  setTimeout(function () {
    if (!cfgReady()) { toast('未配置：点右下角图标打开面板，填 URL / TOKEN / 收件邮箱后才会发邮件。', 'warn'); return; }
    poll(false);
  }, 8000);
  setInterval(function () { if (cfgReady()) poll(false); }, 60 * 1000);

  log('已加载，轮询间隔 ' + POLL_INTERVAL_MIN + ' 分钟');
})();
