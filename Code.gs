/**
 * 稻荷神社 回复邮件提醒 —— Google Apps Script 发信端
 *
 * 作用：接收油猴脚本发来的 POST 请求，用你自己的 Gmail 把新回复发到你邮箱。
 * 这段代码跑在 Google 服务器上，部署后你电脑关不关都在。
 *
 * 部署步骤见同目录 README.md。
 */

// ==== 需要你改的两个值 ====
// 1) 收件邮箱：提醒发到哪。可填你任意邮箱（不一定是 Gmail）。
var TO_EMAIL = 'REPLACE_收件邮箱@example.com';

// 2) 校验口令：必须和油猴脚本里的 TOKEN 完全一致（防止别人乱调你的接口）。
//    下面这个是我随机生成的，你可以直接用，也可以换成自己的——两边改成一样即可。
var TOKEN = 'k1tsune_9f3a7c2e5b8140d6';
// ==========================

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);

    if (!data || data.token !== TOKEN) {
      return _text('bad token');
    }

    var to = data.to || TO_EMAIL;
    var subject = data.subject || '稻荷神社 新提醒';
    var html = data.html || data.body || '(空内容)';

    MailApp.sendEmail({
      to: to,
      subject: subject,
      htmlBody: html
    });

    return _text('ok');
  } catch (err) {
    return _text('err: ' + err);
  }
}

// 浏览器直接打开这个 URL 时的响应，用来确认部署成功。
function doGet(e) {
  return _text('kitsune notifier alive');
}

function _text(s) {
  return ContentService.createTextOutput(s).setMimeType(ContentService.MimeType.TEXT);
}

/**
 * 可选：在 Apps Script 编辑器里手动运行这个函数，给自己发一封测试邮件，
 * 用来确认 Gmail 发信权限已授权、收件邮箱正确。
 */
function sendTestEmail() {
  MailApp.sendEmail({
    to: TO_EMAIL,
    subject: '稻荷神社提醒 · 部署测试',
    htmlBody: '如果你收到这封邮件，说明 Apps Script 发信端已经正常工作。'
  });
}
