# 管理员密码（admin-gate）

[English](README.en.md) | [中文](README.md)

给 DeepSeek Harness 装一道门——管理员输密码进入，访客免密码进入并按名单放行接口与工具，每个账号的对话互相看不见。

> **本项目由 AI 辅助生成**，代码、测试、文档均由 AI 完成。欢迎自由使用、修改和分发。

## 安装

```bash
dsh plugin --profile web add github:fish133/dsh-admin-gate
```

装好后重启 Harness（或在设置页的「插件」里把它关掉再打开），然后访问 `/admin-gate` 设第一个密码。

想从本地副本装就换成 `dsh plugin --profile web add link:/path/to/dsh-admin-gate`。

## 功能特性

- **管理员密码**：scrypt 加盐哈希，只存哈希不存明文
- **访客免密进入**：按下发的白名单只放行指定 `/api` 端点与 agent 工具
- **多账号**：可以有多个管理员，各自独立密码
- **对话独立**：每个账号只看得到自己开的对话；访客看不到任何管理员的
- **无访客模式**：把访客入口整个关掉，只有管理员能进
- **三种模式**：`admin-only` / `guest` / `open`，随时切换
- **登录限流**：10 分钟内错 5 次锁 5 分钟
- **原子写入**：状态文件先写临时文件再 rename，断电不会留下半个 json

## 三种模式

| 模式 | 谁进得来 | 用途 |
|---|---|---|
| `admin-only`（默认） | 只有管理员 | 无访客模式：门只给主人开 |
| `guest` | 管理员 + 访客 | 访客免密码，按名单放行 |
| `open` | 所有人 | 停用闸门，等于关掉这个插件 |

切到 `admin-only` 时，**已经在场的访客会被立刻踢掉**，不会挂着旧 cookie 继续用。

## 使用说明

1. 第一次访问 `/admin-gate`，页面提示设置管理员密码（至少 4 位），输入后即进入
2. 之后每次进 Harness：`/` 会自动跳到 `/admin-gate`
3. 在闸门页，或 Web 设置页的「管理员密码」分区里：
   - 改密码（改完会把别处的管理员会话踢掉）
   - 加减管理员账号
   - 切模式
   - 调访客名单

## 为什么闸门在 host 那边

客户端弹个全屏遮罩只能挡住眼睛，挡不住手：页面里的 `fetch('/api/...')` 照样能发。
所以真正的判定全在 host：

| 位置 | 做什么 |
|---|---|
| `connection.admit` / `admitConnection` / `authorizeIndex` | 闸门自己决定"你是谁"：发一个带身份标记的 Peer（访客 / 某个账号） |
| `connection/request` | 没过闸门的 `/api` 一律 401；访客模式下再按端点白名单过一遍，越界 403 |
| `sessionController` 方法包装 | 会话方法按 `sessionId` 判归属，不是自己的拒绝或筛掉 |
| `tools.guard()` | 访客触发的 agent 回合里，工具只放行白名单内的 |
| `webserver/index-inject` | 页面一加载就 `GET /admin-gate/api/state`，没过闸门就整页换到闸门页 |
| `/admin-gate/*` | 闸门页与它的 JSON 接口，不挂在 `/api` 下，不依赖 Harness 的 cookie |

即使注入的那段跳转脚本被绕过，`/api` 那里的拒绝仍然在——页面只是外表。

## 对话归属：谁的对话谁才看得见

**光拦 `/api` 端点不够。** `session/list` 放行给访客之后，访客看到的是**所有**
对话的标题；`session/page` 放行之后，只要知道 sessionId 就能读全文。端点名单
管的是"能不能调这个方法"，管不了"这个方法返回的是谁的对话"。

所以另有一层归属判断：

| 层 | 做什么 |
|---|---|
| HTTP | 会话方法按参数里的 `sessionId` 判归属，不是自己的直接抛 |
| 流（WebSocket） | `session/follow` 等流在打开时同样判一次 |
| 列表 | `list` / `search` 不报错，**筛掉**别人的条目（不暴露"存在但你看不到"） |
| 新建 | `create` 谁开的就记在谁名下 |

归属记在状态文件的 `sessions: { "<sessionId>": "acct:<账号id>" | "guest" }`。

- 没登记的老对话算"无主"，只有管理员看得见
- 升级到 v3 时会一次性把磁盘上已有的对话划给**最早创建的那个账号**（那些本来
  就是它开的），之后谁开谁领

## 给访客什么

默认名单刻意保守——这两个名单决定的是「主人身份能不能被借出去」，不该由插件替主人拍板：

- **接口默认只读**：会话列表/历史、工作区文件、模型目录、技能列表、`settings/describe` 等。
  刻意**不含** `session/prompt`——一放行访客就能让 agent 干活，而 agent 是以主人身份在这台机器上跑的。
- **工具默认只有 `web_search` / `web_fetch`**。不给 `read` / `bash` / `write`：
  `read` 能读 `~/.dsh` 里的凭据，`bash` 能跑任何命令。

想让访客能聊天，就把 `session/prompt` 加进接口名单；想给读文件的权限，就加 `read`。都是显式选择。

## 状态存在哪

`$DSH_HOME/admin-gate.json`（默认 `/root/.dsh/admin-gate.json`）：

```json
{
  "version": 3,
  "mode": "guest",
  "accounts": {
    "<id>": { "name": "管理员", "salt": "...", "hash": "...", "n": 16384, "r": 8, "p": 1, "createdAt": 0 }
  },
  "sessions": { "session-abc": "acct:<id>" },
  "guest": { "endpoints": ["..."], "tools": ["..."], "customized": false }
}
```

状态文件里有密码哈希与访客名单，**已经加进 `.gitignore`**，别提交。
忘了密码：删掉这个文件，再访问 `/admin-gate` 重设。

## 开发

```bash
node tests/gate.test.mjs      # host 半边（假 ctx）
node tests/identity.test.mjs  # 身份与归属层
```

## 许可

MIT，见 [LICENSE](LICENSE)。
