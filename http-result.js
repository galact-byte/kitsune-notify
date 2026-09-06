'use strict';

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

if (typeof module !== 'undefined') {
  module.exports = {
    classifyGasResponse: classifyGasResponse,
    classifyNoticeError: classifyNoticeError,
    joinUrl: joinUrl,
    shouldRecordSeen: shouldRecordSeen,
    classifyGmTransport: classifyGmTransport,
    classifyNoticePage: classifyNoticePage,
    hasNoticeItems: hasNoticeItems
  };
}
