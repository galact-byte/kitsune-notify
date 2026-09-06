# kitsune-notify 维护笔记（项目记忆）

> 给未来的自己/协作者/AI 看的事实与决策记录。改代码前先读这份。

## 这是什么

在 Discuz 论坛 **kitsune.ee（稻荷神社）** 的帖子/回复被别人**回复**时，自动发邮件到自己邮箱。
两半组成：

- `kitsune-notify.user.js`：油猴脚本，跑在浏览器里，轮询提醒页、去重、触发发信。
- `Code.gs`：Google Apps Script，部署成 Web App，收到 POST 后用自己的 Gmail 发信（跑在 Google 服务器，发信不需要开电脑）。

## 论坛事实（排查必备）

- 论坛程序：**Discuz! X3.5**；站名 稻荷神社；当前账号用户名 `galact`。
- **访问代理**：本机 agent/脚本直连 **DNS 解析不了 kitsune.ee**，抓取/调试必须走代理 `http://127.0.0.1:7890`（本机 Clash）。浏览器里的油猴脚本用的是浏览器自身网络，不受此限。
- **原生邮件提醒不可用**：管理员把 设置→提醒（`ac=notice`）入口从菜单去掉了，直链会被踢回个人资料页。所以只能自建。
- **提醒页**：`home.php?mod=space&do=notice&view=mypost&type=post`（“帖子”标签=回复）。
  - 控制器 `source/include/space/space_notice.php`：`view` 缺省=mypost；mypost 默认 type 取第一个有未读的子类型，`post`=回复。
  - 该页 `fetch_all_by_uid($uid, new=-1, ...)` 返回**已读+未读**，单页 30 条。**打开该页会把该类型标记已读、清红点。**
- **提醒条目 HTML 结构**（对齐官方模板 `template/default/home/space_notice.htm`）：
  ```html
  <div class="nts">
    <dl class="cl" notice="<ID>" id="notice_<ID>">
      <dt><span class="xg1 xw0">时间</span></dt>
      <dd class="ntc_body">某人 回复了您在帖子 ... 中的楼层 <a href="forum.php?...">查看</a></dd>
    </dl>
  </div>
  ```
  去重键 = `dl` 的 `notice="<ID>"`（唯一稳定）。正文取 `.ntc_body` 的 textContent。

## 关键设计决策（别踩回坑）

- **首次运行基线**：提醒页返回历史 30 条，装好第一次**只登记为基线、不发**（否则一装好被老回复淹没）。用 `GM_setValue('kitsune_initialized')` 区分“首次”与“手动重发”。
- **type=post**：URL 锁死回复类型，确定性优于依赖 deftype。要加“被@”就再轮询一条 `type=at`。
- **多标签协调**：`kitsune_last_poll_ts` + 共享 `kitsune_seen_ids`，多个论坛标签页只发一次。
- **发送成功才登记 seen**：失败下次重试，不丢提醒。
- **频率拦截检测**：连点会触发 Discuz 频率防御（IP 短暂拉黑），拿到的是拦截页；脚本识别到会提示“别连点”。正常 5 分钟轮询不会触发。
- **发信鉴权**：Apps Script `/exec` 是“任何人可访问”，靠 `TOKEN` 挡。不是 XSS——对面只跑固定代码、只发到固定邮箱。

## 已验证状态

- ① 测试邮件、② 立即检查：**真机通过，邮箱能收到**（2026-09-06）。
- 两份代码 `node --check` 语法通过。

## 已知限制

- 油猴脚本只在**浏览器开着 + 论坛标签页在**时才轮询；关机/关浏览器期间不实时，但**下次开浏览器会补发**累积的新回复。
- 单页 30 条，离线期间 >30 条回复的最旧部分可能漏（极端情况）。
- 后台读取提醒页会清该类型站内红点（换来邮件）。

## 待办 / 下一步

- [x] **把密钥移出代码**（v1.3.0）：加「⚙ 设置」菜单，`URL/TOKEN/收件邮箱` 存 `GM_setValue`（键 `kitsune_cfg_url/_token/_email`）；脚本随 POST 传 `to`，Code.gs 已支持 `data.to` 兜底。代码无密钥。
- [x] `buildEmail` 链接 `href` 白名单（v1.3.0）：`safeLink()` 只放行 host=kitsune.ee 的 http(s) 链接，且 href 已 `escapeHtml`。
- [x] 仓库骨架：`.gitignore`（AGENTS.md/CLAUDE.md/GEMINI.md/.omc/HANDOFF.md/*.local）、`config.example`、README 改为“菜单填密钥”。
- [ ] 可选：增加 `type=at`（被@）提醒。
- [ ] **待真机验证**：v1.3.0 重新导入 Tampermonkey → 点「⚙ 设置」填三项 → 「① 测试邮件」能收到。

## 维护提示

- 改完跑 `node --check kitsune-notify.user.js`。
- `Code.gs` 与油猴脚本里的 `TOKEN` 必须一致。
- 抓论坛页调试：带 `--proxy http://127.0.0.1:7890`。
