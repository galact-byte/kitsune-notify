'use strict';

var assert = require('assert');
var lib = require('../http-result.js');

assert.deepStrictEqual(lib.classifyGasResponse(200, 'ok'), { kind: 'ok' });
assert.deepStrictEqual(lib.classifyGasResponse(200, 'OK\n'), { kind: 'ok' });
assert.deepStrictEqual(lib.classifyGasResponse(408, ''), { kind: 'ambiguous', status: 408 });
assert.deepStrictEqual(lib.classifyGasResponse(504, 'timeout'), { kind: 'ambiguous', status: 504 });
assert.deepStrictEqual(lib.classifyGasResponse(502, ''), { kind: 'ambiguous', status: 502 });
assert.deepStrictEqual(lib.classifyGasResponse(0, ''), { kind: 'error', status: 0, body: '' });
assert.deepStrictEqual(
  lib.classifyGasResponse(200, 'bad token'),
  { kind: 'error', status: 200, body: 'bad token' }
);
assert.deepStrictEqual(
  lib.classifyGasResponse(500, 'err: boom'),
  { kind: 'error', status: 500, body: 'err: boom' }
);

assert.strictEqual(lib.classifyNoticeError(new TypeError('Failed to fetch')).kind, 'network');
assert.strictEqual(lib.classifyNoticeError(new Error('HTTP 403')).kind, 'error');

assert.strictEqual(
  lib.joinUrl('https://kitsune.ee/', '/home.php?mod=space&do=notice&view=mypost&type=post'),
  'https://kitsune.ee/home.php?mod=space&do=notice&view=mypost&type=post'
);

assert.strictEqual(lib.shouldRecordSeen('ok'), true);
assert.strictEqual(lib.shouldRecordSeen('ambiguous'), true);
assert.strictEqual(lib.shouldRecordSeen('error'), false);

// Tampermonkey 把 Apps Script 408 丢进 onerror，对象带 status:408、正文为空
assert.deepStrictEqual(
  lib.classifyGmTransport({
    readyState: 4,
    responseHeaders: '',
    status: 408,
    statusText: 'Failed to fetch'
  }),
  { kind: 'ambiguous', status: 408 }
);
assert.deepStrictEqual(
  lib.classifyGmTransport({ status: 0, statusText: 'error' }),
  { kind: 'error', status: 0, body: '' }
);

// Discuz 语言包几乎每页都有「抱歉」；自定义主题可能没有 class="nts"
var noticeNoNts =
  '<html><body>var L={"oops":"抱歉，指定的主题不存在"};' +
  '<dl notice="42" id="notice_42"><dd class="ntc_body">有人回复了您</dd></dl>' +
  '</body></html>';
assert.strictEqual(lib.classifyNoticePage(noticeNoNts).status, 'ok');

var langOnly = '<html><script>DISCUZ_LANG={"sorry":"抱歉","wait":"请稍候再试","sec":"安全提示"}</script><form action="member.php?mod=logging&action=login"></form></html>';
assert.strictEqual(lib.classifyNoticePage(langOnly).status, 'ok');

var emptyInbox = '<html><body><div>暂无新提醒</div><script>LANG={"sorry":"抱歉"}</script></body></html>';
assert.strictEqual(lib.classifyNoticePage(emptyInbox).status, 'ok');

// kitsune.ee 每页 common.js 都有 attackevasive = '0'；不能当作拦截页
var discuzChrome =
  '<html><head><title>论坛</title></head><body>' +
  "<script>var cookiepre = 'hQps_2132_', attackevasive = '0', disallowfloat = 'newthread';</script>" +
  '<div class="pbm">暂无新提醒</div></body></html>';
assert.strictEqual(lib.classifyNoticePage(discuzChrome).status, 'ok');

var flood =
  '<html><title>提示信息</title><p>抱歉，您的访问过于频繁，请稍候再试</p></html>';
assert.strictEqual(lib.classifyNoticePage(flood).status, 'blocked');

var loginPage =
  '<html><title>提示信息 -  稻荷神社</title><p>请先登录后才能继续浏览</p>' +
  '<form action="member.php?mod=logging&action=login"></form></html>';
assert.strictEqual(lib.classifyNoticePage(loginPage).status, 'loggedout');

console.log('http-result tests passed');
