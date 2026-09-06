// ==UserScript==
// @name         稻荷神社 回复邮件提醒
// @namespace    kitsune-notify
// @version      1.4.0
// @description  轮询 Discuz 提醒页(view=mypost)，发现回复/@/评分等新提醒就通过 Google Apps Script 发到邮箱。支持关机期间累积、下次开浏览器补发。
// @author       you
// @match        https://kitsune.ee/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @connect      script.google.com
// @connect      script.googleusercontent.com
// ==/UserScript==

(function () {
  'use strict';

  // ================== 配置在哪填 ==================
  // 不再把密钥写进代码：安装后点油猴菜单「⚙ 设置」填入
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
  // ------------------------------

  function log() {
    var a = ['[稻荷提醒]'].concat([].slice.call(arguments));
    console.log.apply(console, a);
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
  function openSettings() {
    var cfg = getCfg();
    var url = prompt('① Apps Script 部署 URL（须以 /exec 结尾）：', cfg.url);
    if (url === null) return;
    var token = prompt('② 校验口令 TOKEN（须与 Code.gs 完全一致）：', cfg.token);
    if (token === null) return;
    var email = prompt('③ 收件邮箱（提醒发到哪）：', cfg.email);
    if (email === null) return;
    var atAns = prompt('④ 是否也提醒“被@”(type=at)？填 y 开启，其他关闭（默认关）：', cfg.at ? 'y' : 'n');
    if (atAns === null) return;
    GM_setValue(CFG_URL, String(url).trim());
    GM_setValue(CFG_TOKEN, String(token).trim());
    GM_setValue(CFG_EMAIL, String(email).trim());
    GM_setValue(CFG_AT, /^y/i.test(String(atAns).trim()));
    if (cfgReady()) toast('设置已保存。被@提醒：' + (/^y/i.test(String(atAns).trim()) ? '开' : '关') + '。可点「① 发送测试邮件」验证。');
    else toast('已保存，但有值看起来不对：URL 需以 /exec 结尾、邮箱需含 @、TOKEN 不能空。', 'warn');
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

    // 未登录检测：Discuz 会返回「您需要先登录」
    if (/您需要先登录|action=login/.test(html) && !doc.querySelector('.nts')) {
      return { loggedOut: true, items: [] };
    }

    var dls = doc.querySelectorAll('.nts dl');
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
        reject('还没配置：点油猴菜单「⚙ 设置」填入 Apps Script URL / TOKEN / 收件邮箱');
        return;
      }
      GM_xmlhttpRequest({
        method: 'POST',
        url: cfg.url,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ token: cfg.token, to: cfg.email, subject: subject, html: html }),
        timeout: 20000,
        onload: function (r) {
          if (r.status >= 200 && r.status < 300 && /ok/i.test(r.responseText)) {
            resolve(r.responseText);
          } else {
            reject('Apps Script 返回: ' + r.status + ' ' + r.responseText);
          }
        },
        onerror: function (e) { reject('请求失败: ' + JSON.stringify(e)); },
        ontimeout: function () { reject('请求超时'); }
      });
    });
  }

  // 右下角小 toast（代替原生 alert，避免那种“像 XSS 弹窗”的观感）
  function toast(msg, type) {
    try {
      if (!document.body) { console.log('[稻荷提醒]', msg); return; }
      var wrap = document.getElementById('kitsune-toast-wrap');
      if (!wrap) {
        wrap = document.createElement('div');
        wrap.id = 'kitsune-toast-wrap';
        wrap.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;display:flex;flex-direction:column;gap:8px;pointer-events:none;';
        document.body.appendChild(wrap);
      }
      var color = type === 'error' ? '#c0392b' : (type === 'warn' ? '#b8860b' : '#2f7d32');
      var el = document.createElement('div');
      el.style.cssText = 'pointer-events:auto;max-width:320px;background:#fff;border-left:4px solid ' + color +
        ';box-shadow:0 6px 18px rgba(0,0,0,.16);border-radius:8px;padding:10px 14px;' +
        'font:13px/1.6 system-ui,-apple-system,"Microsoft YaHei",sans-serif;color:#333;' +
        'opacity:0;transform:translateY(8px);transition:opacity .25s,transform .25s;';
      var safe = String(msg).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }).replace(/\n/g, '<br>');
      el.innerHTML = '<b style="color:' + color + '">\uD83E\uDD8A 稻荷提醒</b><br>' + safe;
      wrap.appendChild(el);
      requestAnimationFrame(function () { el.style.opacity = '1'; el.style.transform = 'translateY(0)'; });
      setTimeout(function () {
        el.style.opacity = '0'; el.style.transform = 'translateY(8px)';
        setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 300);
      }, 5000);
    } catch (e) { console.log('[稻荷提醒]', msg); }
  }

  function say(manual, msg, type) { log(msg); if (manual) toast(msg, type); }

  // 拉一个提醒页并解析，返回 {status:'ok'|'blocked'|'loggedout', items}
  function fetchNoticePage(path) {
    return fetch(SITE + path.replace(/^\//, ''), { credentials: 'include' })
      .then(function (r) { return r.text(); })
      .then(function (html) {
        // 频率/安全拦截检测（论坛把请求拦了会返回没有 .nts 的提示页）
        if (/访问过于频繁|刷新过于频繁|请稍(候|后)再试|attackevasive|请求来路|安全提示|抱歉/.test(html) && !/class="nts"/.test(html)) {
          return { status: 'blocked', items: [] };
        }
        var res = parseNotices(html);
        if (res.loggedOut) return { status: 'loggedout', items: [] };
        return { status: 'ok', items: res.items };
      });
  }

  // 轮询一次。manual=true 时每一步都用 toast 反馈结果，方便你验证。
  function poll(manual) {
    // 多标签页协调：间隔内只跑一次（手动触发跳过此限制）
    var now = Date.now();
    var last = GM_getValue(LASTPOLL_KEY, 0);
    if (!manual && now - last < POLL_INTERVAL_MIN * 60 * 1000) return;
    GM_setValue(LASTPOLL_KEY, now);

    var cfg = getCfg();
    var paths = [NOTICE_PATH];
    if (cfg.at) paths.push(AT_PATH);   // 开关开启时才多拉“被@”页

    log('开始检查提醒…' + (cfg.at ? '（含被@）' : ''));
    Promise.all(paths.map(fetchNoticePage))
      .then(function (results) {
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
          say(manual, '首次运行：已把当前 ' + items.length + ' 条设为基线（不发历史）。之后新提醒才发。想立刻看真实邮件：点③再点②。');
          return;
        }

        var fresh = items.filter(function (it) { return !seenSet[it.id]; });
        log('解析到 ' + items.length + ' 条，未通知过 ' + fresh.length + ' 条');

        if (!fresh.length) {
          say(manual, '解析到 ' + items.length + ' 条提醒，但都已通知过（无新提醒）。想重发点③。');
          return;
        }

        var mail = buildEmail(fresh);
        sendEmail(mail.subject, mail.html).then(function () {
          // 发送成功后才登记为已通知，失败则下次重试
          saveSeen(seen.concat(fresh.map(function (it) { return it.id; })));
          say(manual, '已发邮件通知 ' + fresh.length + ' 条，请查收邮箱。');
        }).catch(function (err) {
          say(manual, '解析到新提醒，但发邮件失败：\n' + err, 'error');
        });
      })
      .catch(function (err) { say(manual, '拉取提醒页失败：' + err, 'error'); });
  }

  // ---------- 菜单命令（方便你验证/维护） ----------
  GM_registerMenuCommand('⚙ 设置（URL / TOKEN / 邮箱 / 被@）', openSettings);
  GM_registerMenuCommand('① 发送测试邮件', function () {
    var mail = buildEmail([{ id: 'test', text: '这是一封测试邮件——若收到说明接线成功。', time: new Date().toLocaleString(), link: SITE }]);
    sendEmail(mail.subject.replace('新提醒', '测试'), mail.html)
      .then(function () { toast('测试邮件已发送，请查收邮箱。'); })
      .catch(function (err) { toast('发送失败：' + err, 'error'); });
  });
  GM_registerMenuCommand('② 立即检查一次', function () { poll(true); });
  GM_registerMenuCommand('③ 重发当前提醒(清空去重)', function () {
    GM_setValue(SEEN_KEY, []);
    GM_setValue(INIT_KEY, true); // 保持已初始化，使下次检查把当前提醒当作"新"重发一遍
    toast('已清空去重记录，点「② 立即检查一次」会把当前提醒(最多30条)重新发一遍。');
  });

  // ---------- 启动 ----------
  // 开页后 8 秒先跑一次（补发关机期间累积的），之后每分钟检查是否到轮询点
  setTimeout(function () {
    if (!cfgReady()) { toast('未配置：点油猴菜单「⚙ 设置」填 URL / TOKEN / 收件邮箱后才会发邮件。', 'warn'); return; }
    poll(false);
  }, 8000);
  setInterval(function () { if (cfgReady()) poll(false); }, 60 * 1000);

  log('已加载，轮询间隔 ' + POLL_INTERVAL_MIN + ' 分钟');
})();
