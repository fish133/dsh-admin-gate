# 管理员密码（admin-gate）

进 Harness 之前先过一道门：

- **管理员**：输密码进入，能力全开。
- **访客**：不输密码进入，按下发的白名单只放行部分 `/api` 端点和 agent 工具。

名字就叫「管理员密码」，设置页里的分区也在这个名字下。

## 为什么闸门在 host 那边

客户端弹个全屏遮罩只能挡住眼睛，挡不住手：页面里的 `fetch('/api/...')` 照样能发。
所以真正的判定全在 host：

| 位置 | 做什么 |
|---|---|
| `connection/request` | 没通过闸门的浏览器请求，`/api` 一律 401；访客模式下再按端点白名单过一遍，越界 403 |
| `tools.guard()` | 访客触发的 agent 回合里，工具只放行白名单内的 |
| `webserver/index-inject` | 页面一加载就 `GET /admin-gate/api/state`，没过闸门就整页换到闸门页 |
| `/admin-gate/*` | 闸门页本身和它的 JSON 接口，不挂在 `/api` 下，所以不依赖 Harness 的 cookie |

即使注入的那段跳转脚本被绕过，`/api` 那里的拒绝仍然在 —— 页面只是外表。

## 状态存在哪

`$DSH_HOME/admin-gate.json`（默认 `/root/.dsh/admin-gate.json`）：

```json
{
  "version": 1,
  "password": { "salt": "...", "hash": "...", "n": 16384, "r": 8, "p": 1 },
  "guest": { "endpoints": ["..."], "tools": ["..."] }
}
```

- 密码是 scrypt 加盐哈希，不存明文，也不进 profile patch（patch 会随升级被覆盖）。
- **忘了密码**：删掉这个文件，重新打开 `/admin-gate` 会引导重设。
- 会话 token 只在内存里，Harness 重启后要重新过闸门。

## 怎么用

1. 第一次访问 `/admin-gate`，页面显示「第一次进来，先给这个门设一个管理员密码」；输入两遍以内的密码（至少 4 位）就进去了。
2. 之后每次进 Harness：`/` 会自动跳到 `/admin-gate`。
3. 在闸门页右侧「管理员设置」里，或者 Web 设置页的「管理员密码」分区里：
   - 改密码（改完会把别的管理员会话踢掉）；
   - 调访客名单（接口一行一个、工具一行一个，存进上面的 json）；
   - 退出闸门。

## 访客为什么第一版会白屏（已修）

第一版把访客的 WebSocket 一起拒了，结果是前端插件（比如思维链翻译）连不上
事件通道，整页报 `Failed to load plugins` / `1 entry did not activate`。
两个原因叠在一起：

1. **流被拒**：`/api/remote.mux` 升级直接 403，前端拿不到实时流；
2. **白名单缺端点**：`cotTranslation/limits`、`pluginManager/listBundles`
   这些是**页面启动就要问**的，少一条就是一屏红字。

现在的做法：

- 升级只要求「过了闸门」，访客的 socket 挂到**访客专用 Peer** 上，
  每条逻辑流再按名单筛（管理员照旧共用 `browserPeer`，完全不受影响）；
- 默认名单补齐了启动需要的端点；
- 状态文件加了 `guest.customized`：**主人没动过名单就跟着默认值走**，
  插件升级补端点能自动生效；主人一保存就锁定他自己的名单，不会被动。

## 给访客什么

默认名单刻意保守 —— 这两个名单决定的是「主人身份能不能被借出去」，不该由我替主人拍板：

- **接口默认只读**：会话列表/历史、工作区文件、模型目录、技能列表、`settings/describe` 等。
  刻意**不含** `session/prompt` —— 一放行访客就能让 agent 干活，而 agent 是以主人身份在这台机器上跑的。
- **工具默认只有 `web_search` / `web_fetch`**。不给 `read` / `bash` / `write`：
  `read` 能读 `~/.dsh` 里的凭据，`bash` 能跑任何命令。

想让访客能聊天，就把 `session/prompt` 加进接口名单；想给读文件的权限，就加 `read`。都是显式选择。

## 已知边界

- **只在浏览器这条路上生效**。本机命令行、API token（`/connect` 换出来的）不走这道门 ——
  它们本来就是主人自己在用，不是「远程访客」。
- 闸门页是自带样式的一页 HTML，不跟随 Harness 主题（它在 Harness 外面）。
- 访客判定按「这次请求是谁发起的」走 `AsyncLocalStorage`，并用 agent 归属兜底；
  如果某个调用链完全绕开 HTTP（例如定时任务自己触发），它会像主人一样被放行。
