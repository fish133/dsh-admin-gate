// 管理员密码（admin-gate）—— host 半边
//
// 进 Harness 之前先过一道门：
//   · 管理员：输密码进去，能力全开。
//   · 访客：不输密码，按名单放行接口与工具。
//   · 无访客：门只给管理员开，访客入口整个关掉。
//   · 多账号：可以有好几个管理员账号，各自独立密码。
//
// 为什么闸门在 host 而不在客户端：
//   客户端弹个遮罩只挡眼睛，页面里的 fetch('/api/...') 照样能发。真正的拒绝
//   在服务端：没过闸门的浏览器拿不到 /api，访客的端点还要再过一遍白名单。
//   页面跳一下是外表，服务端这份拒绝才是本体。
//
// 闸门页自己必须「不用登录也能打开」，所以它不挂在 /api 下，而是 /admin-gate/*
// 这一组自有路由（HTML + JSON），也不依赖 Harness 的 cookie。
//
// 状态存 $DSH_HOME/admin-gate.json（scrypt 加盐哈希），不进 profile patch ——
// patch 会被升级覆盖，密码不该跟着漂。

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { AsyncLocalStorage } from 'node:async_hooks';

export const name = 'admin-gate';
// 路由挂在 webServer 上；connection / tools 都是可选的，不写进 inject，
// 免得在没装它们的组合里整个插件不激活。
export const inject = ['webServer'];

const COOKIE = 'dsh-admin-gate';

/**
 * 挂在 Peer 上的「这人是哪个身份」标记。
 *
 * 用 Symbol 而不是 principal 字段：principal 的形状是 Harness 的契约，往里塞
 * 自定义键迟早被 schema 校验打回来；而 Peer 只是我们放进连接里的一层壳。
 */
const GATE_IDENTITY = Symbol.for('dsh.adminGate.identity');
const ROUTE = '/admin-gate';
const STATE_VERSION = 3;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SCRYPT = { n: 16384, r: 8, p: 1, len: 64 };

/** 登录失败后的冷却。 */
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 10 * 60 * 1000;
const LOCKOUT_MS = 5 * 60 * 1000;

/**
 * 门的三种模式：
 *   admin-only —— 只给管理员开，访客入口关闭（无访客模式）
 *   guest      —— 管理员 + 访客（访客按名单）
 *   open       —— 闸门停用，谁都能直接进（等于关掉这个插件）
 */
const MODES = ['admin-only', 'guest', 'open'];

/**
 * 访客默认能调的 /api 端点：能看见工作区、会话和模型目录，改不了一样。
 *
 * 刻意**不含** session/prompt —— 一放行，访客就能让 agent 干活，而 agent 是
 * 以主人的身份在这台机器上跑的。想让访客能聊天，就自己把 session/prompt
 * 加进名单，这是明确的取舍，不该由默认值替主人决定。
 *
 * 这份名单要**够页面正常启动**：前端一加载就会问会话、模型目录、插件清单、
 * 传输恢复参数，少一个就是一屏红字（"Failed to load plugins" 就是这么来的）。
 */
const DEFAULT_GUEST_ENDPOINTS = [
  'session/list', 'session/page', 'session/follow', 'session/projections',
  'session/modelCatalog', 'session/search', 'session/attachment',
  'session/listMetadata', 'session/canOpenWorkspacePath',
  'workspace/follow', 'workspaceFiles/read', 'workspaceFiles/readBytes',
  'workspaceFiles/list', 'workspaceFiles/stat', 'workspaceFiles/changes',
  'job/list', 'job/follow', 'schedule/list', 'skills/list',
  'agentPresets/list', 'agentPresets/read', 'settings/describe',
  'llm/listProviders', 'llm/listConfigurableProviders', 'fileReferences/list',
  'messageFeedback/list', 'remoteAccess/follow', 'account/getState',
  'pluginManager/listBundles', 'pluginManager/listPlugins',
  'pluginManager/registries', 'pluginInventory/list',
  'cotTranslation/limits', 'cotTranslation/translate',
];

/**
 * 访客默认能用的工具：只留联网查资料。
 *
 * 不默认给 read / glob / grep / bash / write：它们是**主人身份**在这台机器上
 * 跑的工具，read 能读 ~/.dsh 里的凭据，bash 能跑任何命令。
 */
const DEFAULT_GUEST_TOOLS = ['web_search', 'web_fetch'];

/**
 * 一条端点是否放行给访客。
 *
 * 支持三种写法：
 *   `session/list`   精确匹配
 *   `session/*`      前缀通配（`*` 在末尾、前缀非空）
 *   `*`              全放行
 *
 * 中间通配（`a*b`）**不支持** —— 旧实现里它会把 `ab` 也放过去，是个漏洞。
 * 遇到这种写法当字面量处理，不猜主人想干什么。
 */
function guestAllows(endpoints, endpoint) {
  for (const pattern of endpoints) {
    if (typeof pattern !== 'string' || pattern === '') continue;
    if (pattern === endpoint) return true;
    if (pattern === '*') return true;
    if (pattern.endsWith('*') && !pattern.slice(0, -1).includes('*')) {
      const prefix = pattern.slice(0, -1);
      if (prefix !== '' && endpoint.startsWith(prefix)) return true;
    }
  }
  return false;
}

// ------------------------------------------------- 身份与归属（纯函数）
//
// 「这段对话是谁的」——访客看不得管理员的，管理员甲也看不得管理员乙的。
//
// 状态里一张 `sessions: { sessionId -> 身份键 }` 记着归属，身份键形如
// `acct:<账号id>` 或 `guest`。没登记的老会话算无主：只有管理员看得见。

/** Peer -> { kind: 'admin'|'guest', accountId?, accountName? } */
const peerIdentity = new WeakMap();

/** 一个身份的身份键。 */
function identityKey(who) {
  return who.kind === 'guest' ? 'guest' : `acct:${who.accountId ?? 'unknown'}`;
}

/** 从一次调用的参数里把 sessionId 抠出来（会话方法的参数只有两种形状）。 */
function sessionIdOf(request) {
  if (request === null || typeof request !== 'object') return undefined;
  if (typeof request.sessionId === 'string') return request.sessionId;
  const address = request.address;
  if (address !== null && typeof address === 'object') {
    if (typeof address.sessionId === 'string') return address.sessionId;
    if (typeof address.childSessionId === 'string') return address.childSessionId;
  }
  return undefined;
}

/** 这段对话归 `who` 吗。没登记的算无主：只有管理员看得见。 */
function ownsSession(state, who, sessionId) {
  const owner = state?.sessions?.[sessionId];
  if (owner === undefined) return who.kind === 'admin';
  return owner === identityKey(who);
}

// ------------------------------------------------------------------ 存储

function statePath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'admin-gate.json');
}

/** 一份全新的状态。 */
function emptyState() {
  return {
    version: STATE_VERSION,
    mode: 'admin-only',
    accounts: {},
    // 会话归属：sessionId -> 身份键（acct:<账号id>）。闸门在里面判「这段对话是谁的」。
    sessions: {},
    guest: {
      endpoints: [...DEFAULT_GUEST_ENDPOINTS],
      tools: [...DEFAULT_GUEST_TOOLS],
      customized: false,
    },
  };
}

/**
 * 把 v1 老状态（单个 password）迁成 v2（accounts 表）。
 * @param {any} parsed - 磁盘上读到的原始对象。
 */
function migrate(parsed) {
  const base = emptyState();
  const version = Number(parsed?.version) || 1;

  let accounts = {};
  if (version < 2) {
    // v1 → v2：{ password: {...} } 变成一个叫「管理员」的账号
    if (parsed?.password && typeof parsed.password.hash === 'string') {
      accounts = {
        [randomBytes(8).toString('hex')]: {
          name: '管理员',
          salt: parsed.password.salt,
          hash: parsed.password.hash,
          n: parsed.password.n,
          r: parsed.password.r,
          p: parsed.password.p,
          createdAt: Date.now(),
        },
      };
    }
  } else if (parsed?.accounts && typeof parsed.accounts === 'object') {
    accounts = parsed.accounts;
  }

  // v2 → v3 只是多了一张会话归属表；没有就空着，老会话按「主账号」兜底认领。
  let sessions = {};
  if (parsed?.sessions && typeof parsed.sessions === 'object' && !Array.isArray(parsed.sessions)) {
    for (const [id, owner] of Object.entries(parsed.sessions)) {
      if (typeof id === 'string' && id !== '' && typeof owner === 'string' && owner !== '') sessions[id] = owner;
    }
  }

  const mode = MODES.includes(parsed?.mode) ? parsed.mode : 'admin-only';
  const customized = parsed?.guest?.customized === true;

  return {
    version: STATE_VERSION,
    mode,
    accounts,
    sessions,
    guest: {
      endpoints: customized && Array.isArray(parsed?.guest?.endpoints)
        ? parsed.guest.endpoints
        : base.guest.endpoints,
      tools: customized && Array.isArray(parsed?.guest?.tools)
        ? parsed.guest.tools
        : base.guest.tools,
      customized,
    },
  };
}

async function loadState() {
  try {
    const raw = await readFile(statePath(), 'utf8');
    const parsed = JSON.parse(raw);
    const state = migrate(parsed);
    // 老版本读进来是迁过的：顺手写回去，否则每次启动都要再迁一遍，
    // 而且磁盘上一直是旧格式，排查时容易看错。
    if (Number(parsed?.version) !== STATE_VERSION) {
      try { await saveState(state); } catch { /* 写不进去也不影响本次使用 */ }
    }
    return state;
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.warn('[admin-gate] 状态文件读不动，按未设置处理：%s', error?.message ?? error);
    }
    return emptyState();
  }
}

/**
 * 写状态：先写临时文件再 rename，避免写到一半断电留下半个 json。
 */
async function saveState(state) {
  const path = statePath();
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

/** 有没有设置过密码的账号。 */
function hasAccounts(state) {
  return Object.keys(state.accounts ?? {}).length > 0;
}

/** 账号表 -> UI 用的精简列表。 */
function accountList(state) {
  return Object.entries(state.accounts ?? {}).map(([id, account]) => ({
    id,
    name: typeof account?.name === 'string' && account.name !== '' ? account.name : '管理员',
    createdAt: Number(account?.createdAt) || 0,
  })).sort((a, b) => a.createdAt - b.createdAt);
}

// ------------------------------------------------------------- 密码哈希

function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT.len, { N: SCRYPT.n, r: SCRYPT.r, p: SCRYPT.p });
  return {
    salt: salt.toString('base64'),
    hash: hash.toString('base64'),
    n: SCRYPT.n, r: SCRYPT.r, p: SCRYPT.p,
  };
}

function verifyPassword(password, record) {
  if (!record || typeof record.hash !== 'string' || typeof record.salt !== 'string') return false;
  try {
    const salt = Buffer.from(record.salt, 'base64');
    const expected = Buffer.from(record.hash, 'base64');
    const actual = scryptSync(password, salt, expected.length, {
      N: record.n ?? SCRYPT.n, r: record.r ?? SCRYPT.r, p: record.p ?? SCRYPT.p,
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/**
 * 拿一个密码去所有账号里试，命中就返回那个账号。
 * 不短路：所有账号都要比完，免得靠响应时间猜出"第几个账号对了"。
 * @returns {{ id: string, name: string } | undefined}
 */
function matchAccount(state, password) {
  let hit;
  for (const [id, account] of Object.entries(state.accounts ?? {})) {
    if (verifyPassword(password, account)) {
      hit ??= { id, name: account.name ?? '管理员' };
    }
  }
  return hit;
}

// --------------------------------------------------------------- HTTP 小工具

/**
 * 从 Cookie 头里取一个值。
 * 解码失败（畸形百分号编码）不抛异常——返回原样字符串，让上层比对时自然不认。
 * 旧实现这里会抛 URIError，一个畸形 cookie 就能让整个请求 500。
 */
function readCookie(req, key) {
  const header = req.headers?.cookie;
  if (typeof header !== 'string') return undefined;
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at === -1) continue;
    if (part.slice(0, at).trim() !== key) continue;
    const raw = part.slice(at + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return undefined;
}

function sendJson(res, status, value, extraHeaders = {}) {
  if (res.headersSent) return;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(JSON.stringify(value));
}

function sendHtml(res, status, html) {
  if (res.headersSent) return;
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(html);
}

async function readJsonBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed !== null && typeof parsed === 'object' ? parsed : {};
  } catch {
    throw new Error('请求体不是 JSON');
  }
}

function cookieHeader(token, maxAgeSeconds) {
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

function clearCookieHeader() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

// ------------------------------------------------------------------ 闸门页

const GATE_CSS = `
  :root { color-scheme: light dark; --fg:#1b1f24; --dim:#6b7480; --bg:#f6f7f9; --card:#fff; --line:#dfe3e8; --brand:#247bbf; --err:#c0392b; --ok:#2e9e5b; }
  @media (prefers-color-scheme: dark) { :root { --fg:#e8eaed; --dim:#9aa3ad; --bg:#16181c; --card:#1e2126; --line:#31363d; --brand:#5aa9e6; --err:#ff7b6b; --ok:#4ec97f; } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; padding:24px 16px; background:var(--bg); color:var(--fg);
         font:15px/1.6 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
  .card { width:min(460px, 100%); background:var(--card); border:1px solid var(--line);
          border-radius:14px; padding:26px 24px 20px; box-shadow:0 10px 40px rgb(0 0 0 / .08); }
  h1 { margin:0 0 4px; font-size:19px; letter-spacing:.2px; }
  h2 { font-size:14px; margin:0 0 12px; color:var(--fg); }
  .sub { margin:0 0 18px; color:var(--dim); font-size:13px; }
  .tabs { display:flex; gap:8px; margin-bottom:16px; }
  .tabs button { flex:1; padding:9px 0; border-radius:9px; border:1px solid var(--line); background:transparent;
                 color:var(--fg); font:inherit; font-size:13px; cursor:pointer; }
  .tabs button[aria-selected="true"] { border-color:var(--brand); color:var(--brand); font-weight:600; }
  .tabs button:disabled { opacity:.4; cursor:not-allowed; }
  label { display:block; font-size:13px; color:var(--dim); margin:0 0 6px; }
  input, select, textarea { width:100%; padding:10px 12px; border-radius:9px; border:1px solid var(--line);
          background:transparent; color:var(--fg); font:inherit; }
  textarea { min-height:88px; resize:vertical; font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12px; }
  select { cursor:pointer; }
  input:focus, select:focus, textarea:focus { outline:2px solid color-mix(in srgb, var(--brand) 45%, transparent); outline-offset:1px; border-color:var(--brand); }
  .row { margin-bottom:14px; }
  .go { width:100%; padding:11px 0; border-radius:9px; border:0; background:var(--brand); color:#fff;
        font:inherit; font-weight:600; cursor:pointer; }
  .go:disabled { opacity:.55; cursor:default; }
  .ghost { padding:8px 14px; border-radius:8px; border:1px solid var(--line); background:transparent;
           color:var(--fg); font:inherit; font-size:13px; cursor:pointer; }
  .danger { color:var(--err); border-color:var(--err); }
  .hint { margin:14px 0 0; font-size:12px; color:var(--dim); line-height:1.55; }
  .err { color:var(--err); font-size:13px; min-height:20px; margin:10px 0 0; }
  .ok { color:var(--ok); font-size:13px; min-height:20px; margin:10px 0 0; }
  .guest-only, .admin-only, .panel { display:none; }
  [data-mode="guest"] .guest-only { display:block; }
  [data-mode="admin"] .admin-only { display:block; }
  .panel[data-open="true"] { display:block; border-top:1px solid var(--line); margin-top:18px; padding-top:16px; }
  .acct { display:flex; align-items:center; gap:10px; padding:8px 10px; border:1px solid var(--line);
          border-radius:8px; margin-bottom:8px; font-size:13px; }
  .acct .name { flex:1; }
  .acct .when { color:var(--dim); font-size:12px; }
  code { font-size:12px; padding:1px 5px; border-radius:5px; background:color-mix(in srgb, var(--fg) 8%, transparent); }
`;

function gatePageHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>管理员密码</title>
<style>${GATE_CSS}</style>
</head>
<body data-mode="admin">
  <form class="card" id="gate" autocomplete="on">
    <h1>管理员密码</h1>
    <p class="sub" id="sub">请输入管理员密码进入。</p>
    <div class="tabs" role="tablist">
      <button type="button" role="tab" id="tab-admin" aria-selected="true">管理员</button>
      <button type="button" role="tab" id="tab-guest" aria-selected="false">访客登录</button>
    </div>
    <div class="row admin-only" id="pw-row">
      <label for="pw">密码</label>
      <input id="pw" type="password" autocomplete="current-password">
    </div>
    <div class="guest-only">
      <p class="hint" style="margin:0 0 14px" id="guest-hint">访客不用密码，但只能看，不能改。</p>
    </div>
    <button class="go" id="go" type="submit">进入</button>
    <p class="err" id="err"></p>
    <p class="hint" id="tail"></p>

    <div class="panel" id="panel">
      <h2>管理员设置</h2>

      <div class="row">
        <label for="mode">门的模式</label>
        <select id="mode">
          <option value="admin-only">仅管理员（关闭访客入口）</option>
          <option value="guest">管理员 + 访客</option>
          <option value="open">停用闸门（谁都能进）</option>
        </select>
        <p class="hint" id="mode-hint" style="margin-top:6px"></p>
      </div>

      <h2 style="margin-top:18px">管理员账号</h2>
      <div id="accounts"></div>
      <div class="row" style="margin-top:10px">
        <label for="new-name">新账号名</label>
        <input id="new-name" type="text" placeholder="比如：小号、备用">
      </div>
      <div class="row">
        <label for="new-pass">新账号密码（至少 4 位）</label>
        <input id="new-pass" type="password" autocomplete="new-password">
      </div>
      <div class="row"><button class="ghost" type="button" id="add-account">添加账号</button></div>

      <h2 style="margin-top:18px">改当前账号密码</h2>
      <div class="row">
        <label for="cur">当前密码</label>
        <input id="cur" type="password" autocomplete="current-password">
      </div>
      <div class="row">
        <label for="next">新密码（至少 4 位）</label>
        <input id="next" type="password" autocomplete="new-password">
      </div>
      <div class="row">
        <button class="ghost" type="button" id="save-pw">改密码</button>
        <button class="ghost danger" type="button" id="logout">退出闸门</button>
      </div>

      <h2 style="margin-top:18px">访客能拿到什么</h2>
      <p class="hint" style="margin:0 0 10px">一行一个。接口是 /api 端点名，工具是 agent 能调的工具名。<code>session/*</code> 这种结尾 * 表示整组。</p>
      <div class="row">
        <label for="eps">放行的接口</label>
        <textarea id="eps" spellcheck="false"></textarea>
      </div>
      <div class="row">
        <label for="tools">放行的工具</label>
        <textarea id="tools" spellcheck="false"></textarea>
      </div>
      <div class="row">
        <button class="ghost" type="button" id="save-policy">保存访客名单</button>
        <button class="ghost" type="button" id="reset-policy">恢复默认名单</button>
      </div>
      <p class="hint" id="policy-hint"></p>
      <p class="ok" id="panel-ok"></p>
    </div>
  </form>
<script>
(function () {
  var mode = 'admin';
  var state = null;
  var form = document.getElementById('gate');
  var err = document.getElementById('err');
  var ok = document.getElementById('panel-ok');
  var sub = document.getElementById('sub');
  var tail = document.getElementById('tail');
  var pw = document.getElementById('pw');
  var go = document.getElementById('go');
  var panel = document.getElementById('panel');
  var tabGuest = document.getElementById('tab-guest');

  var MODE_TEXT = {
    'admin-only': '只有管理员能进，访客入口已关闭。',
    'guest': '管理员输密码；访客免密码进入，只能看不能改。',
    'open': '闸门已停用，任何人都能直接进入。慎用。'
  };

  function applyMode(next) {
    if (next === 'guest' && state && !state.guestAllowed) next = 'admin';
    mode = next;
    document.body.dataset.mode = next;
    document.getElementById('tab-admin').setAttribute('aria-selected', next === 'admin' ? 'true' : 'false');
    tabGuest.setAttribute('aria-selected', next === 'guest' ? 'true' : 'false');
    err.textContent = '';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function renderAccounts(list) {
    var box = document.getElementById('accounts');
    if (!list || list.length === 0) { box.innerHTML = '<p class="hint" style="margin:0">还没有账号。</p>'; return; }
    box.innerHTML = list.map(function (a) {
      return '<div class="acct"><span class="name">' + esc(a.name) + '</span>' +
        '<button class="ghost danger" type="button" data-del="' + esc(a.id) + '">删除</button></div>';
    }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('[data-del]'), function (btn) {
      btn.onclick = function () { removeAccount(btn.getAttribute('data-del')); };
    });
  }

  function render() {
    var s = state;
    if (!s) return;
    if (!s.configured) {
      sub.textContent = '第一次进来，先给这个门设一个管理员密码。';
      go.textContent = '设置密码并进入';
      tail.innerHTML = '密码只存在本机（scrypt 加盐哈希）。忘了就删掉 <code>' + esc(s.statePath) + '</code> 再打开这里重设。';
    } else if (s.entered && s.isAdmin) {
      sub.textContent = '你已经过闸门了。可以回 Harness，或在这里改设置。';
      go.textContent = '回到 Harness';
      tail.innerHTML = '';
      panel.dataset.open = 'true';
    } else {
      sub.textContent = '请输入管理员密码进入。';
      go.textContent = '进入';
      tail.innerHTML = '忘了密码？删掉 <code>' + esc(s.statePath) + '</code> 再打开这里重设。';
      panel.dataset.open = 'false';
    }

    // 访客入口是否可用
    tabGuest.disabled = !s.guestAllowed;
    if (!s.guestAllowed && mode === 'guest') applyMode('admin');

    document.getElementById('guest-hint').textContent = s.guestAllowed
      ? '访客不用密码：能看不能改。当前放行接口 ' + s.guestEndpoints + ' 个、工具 ' + s.guestTools + ' 个。'
      : '这个门没开访客入口。';

    if (s.guest) {
      document.getElementById('eps').value = (s.guest.endpoints || []).join('\\n');
      document.getElementById('tools').value = (s.guest.tools || []).join('\\n');
    }
    var policyHint = document.getElementById('policy-hint');
    if (policyHint && s.guest) {
      policyHint.textContent = s.guestCustomized
        ? '当前是自定义名单：插件升级不会再自动补端点。'
        : '当前是默认名单：插件升级会自动补上新端点。';
    }

    var sel = document.getElementById('mode');
    if (sel && s.mode) sel.value = s.mode;
    var mh = document.getElementById('mode-hint');
    if (mh) mh.textContent = MODE_TEXT[s.mode] || '';

    renderAccounts(s.accounts);
  }

  function post(path, body) {
    return fetch('${ROUTE}/api/' + path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); });
  }

  function loadState() {
    return fetch('${ROUTE}/api/state', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (s) { state = s; render(); })
      .catch(function () { sub.textContent = '读不到闸门状态，请刷新重试。'; });
  }

  document.getElementById('tab-admin').onclick = function () { applyMode('admin'); pw && pw.focus(); };
  tabGuest.onclick = function () { applyMode('guest'); };

  form.onsubmit = function (event) {
    event.preventDefault();
    err.textContent = '';
    if (state && state.entered) { location.replace('/'); return; }
    go.disabled = true;
    var payload = { mode: mode };
    if (mode === 'admin') payload.password = pw.value;
    var action = (state && !state.configured && mode === 'admin') ? 'setup' : 'login';
    post(action, payload)
      .then(function (result) {
        if (!result.ok || !result.body.ok) throw new Error(result.body.error || '进不去');
        location.replace('/');
      })
      .catch(function (error) {
        err.textContent = error.message || '进不去';
        go.disabled = false;
      });
  };

  document.getElementById('mode').onchange = function () {
    ok.textContent = '';
    post('mode', { mode: this.value })
      .then(function (r) {
        if (!r.ok || !r.body.ok) throw new Error(r.body.error || '改不了');
        ok.textContent = '模式已更新。';
        return loadState();
      })
      .catch(function (e) { ok.textContent = e.message; });
  };

  document.getElementById('add-account').onclick = function () {
    ok.textContent = '';
    post('account', {
      name: document.getElementById('new-name').value,
      password: document.getElementById('new-pass').value,
    }).then(function (r) {
      if (!r.ok || !r.body.ok) throw new Error(r.body.error || '加不了');
      ok.textContent = '账号已添加。';
      document.getElementById('new-name').value = '';
      document.getElementById('new-pass').value = '';
      return loadState();
    }).catch(function (e) { ok.textContent = e.message; });
  };

  function removeAccount(id) {
    if (!confirm('确定删掉这个账号？')) return;
    ok.textContent = '';
    post('account/remove', { id: id }).then(function (r) {
      if (!r.ok || !r.body.ok) throw new Error(r.body.error || '删不了');
      ok.textContent = '账号已删除。';
      return loadState();
    }).catch(function (e) { ok.textContent = e.message; });
  }

  document.getElementById('save-pw').onclick = function () {
    ok.textContent = '';
    post('password', { current: document.getElementById('cur').value, next: document.getElementById('next').value })
      .then(function (r) {
        if (!r.ok || !r.body.ok) throw new Error(r.body.error || '改不了');
        ok.textContent = '密码已更新。';
        document.getElementById('cur').value = '';
        document.getElementById('next').value = '';
        return loadState();
      }).catch(function (e) { ok.textContent = e.message; });
  };

  document.getElementById('save-policy').onclick = function () {
    ok.textContent = '';
    var lines = function (id) {
      return document.getElementById(id).value.split('\\n').map(function (x) { return x.trim(); }).filter(Boolean);
    };
    post('policy', { endpoints: lines('eps'), tools: lines('tools') })
      .then(function (r) {
        if (!r.ok || !r.body.ok) throw new Error(r.body.error || '存不了');
        ok.textContent = '访客名单已保存。';
        return loadState();
      }).catch(function (e) { ok.textContent = e.message; });
  };

  var resetBtn = document.getElementById('reset-policy');
  if (resetBtn) resetBtn.onclick = function () {
    ok.textContent = '';
    post('policy/reset', {}).then(function (r) {
      if (!r.ok || !r.body.ok) throw new Error(r.body.error || '恢复不了');
      ok.textContent = '已恢复默认名单。';
      return loadState();
    }).catch(function (e) { ok.textContent = e.message; });
  };

  document.getElementById('logout').onclick = function () {
    post('logout', {}).then(function () { location.replace('${ROUTE}'); });
  };

  loadState();
})();
</script>
</body>
</html>`;
}

// ------------------------------------------------------------------ 插件体

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  /** token -> { mode, accountId, createdAt, lastSeen } */
  const sessions = new Map();
  /** 被判定为「访客在用」的 agent id。 */
  const guestAgents = new Set();
  /** 把「这一串异步操作是谁发起的」带进 agent 循环；工具拦截靠它认人。 */
  const als = new AsyncLocalStorage();

  /**
   * 状态缓存：每个请求都读盘既慢又会互相打架。
   * 这里缓存一份，写状态时同步更新；文件被外部改了（比如手删）就靠 mtime 兜底。
   */
  let cached = null;
  let cachedAt = 0;
  const STATE_TTL_MS = 2000;

  const readState = async (force = false) => {
    const now = Date.now();
    if (!force && cached !== null && now - cachedAt < STATE_TTL_MS) return cached;
    cached = await loadState();
    cachedAt = now;
    return cached;
  };
  const writeState = async (next) => {
    await saveState(next);
    cached = next;
    cachedAt = Date.now();
    return next;
  };

  /** 闸门是否已启用（= 有账号 且 模式不是 open）。 */
  const gateActive = async () => {
    const state = await readState();
    if (state.mode === 'open') return false;
    return hasAccounts(state);
  };

  // 启动时先读一遍，让状态就位。
  readState(true).catch(() => {});

  /** 登录失败计数：`<scope>:<ip>` -> { count, firstAt, lockedUntil } */
  const failures = new Map();
  const failureKey = (req) => {
    const ip = req.socket?.remoteAddress ?? 'unknown';
    return `login:${ip}`;
  };
  const isLockedOut = (req) => {
    const record = failures.get(failureKey(req));
    if (record === undefined) return 0;
    if (record.lockedUntil !== undefined && record.lockedUntil > Date.now()) {
      return Math.ceil((record.lockedUntil - Date.now()) / 1000);
    }
    return 0;
  };
  const noteFailure = (req) => {
    const key = failureKey(req);
    const now = Date.now();
    const record = failures.get(key);
    if (record === undefined || now - record.firstAt > FAILURE_WINDOW_MS) {
      failures.set(key, { count: 1, firstAt: now });
      return;
    }
    record.count += 1;
    if (record.count >= MAX_FAILURES) {
      record.lockedUntil = now + LOCKOUT_MS;
      record.count = 0;
      record.firstAt = now;
    }
  };
  const clearFailures = (req) => failures.delete(failureKey(req));

  const gateOf = (req) => {
    const token = readCookie(req, COOKIE);
    if (token === undefined) return undefined;
    const entry = sessions.get(token);
    if (entry === undefined) return undefined;
    entry.lastSeen = Date.now();
    return entry;
  };

  // ---- 1. 挡住没通过闸门的 /api，以及访客越界的端点 -------------------
  //
  // 先看「这门到底启用没有」：没账号、或者模式是 open，一切照旧放行。
  // 插件刚装上、主人还没来得及设密码时如果直接拦，他自己的页面会当场 401
  // 掉线 —— 等于插件把人锁在门外。
  const guardConnection = async (req, res, next) => {
    try {
      const state = await readState();
      const gate = gateOf(req);
      const path = new URL(req.url ?? '/', 'http://gate.invalid').pathname;

      // 闸门没启用：谁都能过
      if (state.mode === 'open' || !hasAccounts(state)) {
        return gate === undefined ? next() : als.run(gate, () => next());
      }

      if (gate === undefined) {
        return sendJson(res, 401, {
          ok: false,
          error: 'gate.locked',
          message: '还没通过管理员密码。打开 /admin-gate 过闸门再回来。',
        });
      }

      if (gate.mode === 'guest') {
        const endpoint = path.replace(/^\/api\//, '');
        if (!guestAllows(state.guest.endpoints, endpoint)) {
          return sendJson(res, 403, {
            ok: false,
            error: 'gate.guest-forbidden',
            message: `访客模式不允许调用 ${endpoint}`,
          });
        }
      }

      return als.run(gate, () => next());
    } catch (error) {
      // 闸门自己出问题也不能把整个服务带崩：宁可放行也比 500 好，
      // 但要留下日志（这里没有 logger，用 console 兜底）。
      console.warn('[admin-gate] 闸门判断失败，本次放行：%s', error?.message ?? error);
      return next();
    }
  };
  ctx.on('connection/request', guardConnection);

  // ---- 2. 兜底：在 pre-step 记下这个 agent 归谁 ------------------------
  ctx.on('agent/pre-step', function (payload, next) {
    const gate = als.getStore();
    if (gate !== undefined) {
      if (gate.mode === 'guest') guestAgents.add(payload.agent.id);
      else guestAgents.delete(payload.agent.id);
    }
    return next();
  });

  ctx.on('agent/disposed', (payload) => {
    guestAgents.delete(payload.agent.id);
  });

  // ---- 3. 工具名单（真正拦在 dispatch 前） ----------------------------
  //
  // 每次判断都现读名单，不用闭包里的旧 Set —— 主人改完名单要立刻生效，
  // 而不是等下一次 readState 或重启。
  const toolsService = ctx.get('tools');
  if (toolsService !== undefined) {
    ctx.effect(() => toolsService.guard((execution) => {
      const byRequest = als.getStore()?.mode === 'guest';
      const byAgent = execution.agent !== undefined && guestAgents.has(execution.agent.id);
      if (!byRequest && !byAgent) return undefined;
      // guard 是同步的，不能 await；用缓存里那份（2 秒内）就够。
      const allowed = cached?.guest?.tools ?? DEFAULT_GUEST_TOOLS;
      if (allowed.includes(execution.name)) return undefined;
      return `访客模式不允许使用工具 ${execution.name}`;
    }), 'admin-gate: 访客工具白名单');
  }

  // ---- 4. 闸门页 + 它自己的 JSON 接口 ---------------------------------
  const handleGate = async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://gate.invalid').pathname;
    const method = req.method ?? 'GET';

    if (path === ROUTE || path === `${ROUTE}/`) {
      if (method !== 'GET' && method !== 'HEAD') return sendJson(res, 405, { ok: false, error: 'method' });
      return sendHtml(res, 200, gatePageHtml());
    }

    const state = await readState();
    const gate = gateOf(req);
    const isAdmin = gate?.mode === 'admin';

    if (path === `${ROUTE}/api/state`) {
      return sendJson(res, 200, {
        ok: true,
        configured: hasAccounts(state),
        entered: gate !== undefined,
        mode: gate?.mode ?? null,
        isAdmin,
        gateMode: state.mode,
        guestAllowed: state.mode === 'guest',
        accountName: gate?.accountName ?? null,
        accounts: isAdmin ? accountList(state) : [],
        guestEndpoints: state.guest.endpoints.length,
        guestTools: state.guest.tools.length,
        guest: isAdmin ? state.guest : undefined,
        guestCustomized: state.guest.customized === true,
        statePath: statePath(),
      });
    }

    if (path === `${ROUTE}/api/setup`) {
      if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method' });
      if (hasAccounts(state)) return sendJson(res, 409, { ok: false, error: '已经设过密码了，用登录。' });
      const body = await readJsonBody(req);
      const password = typeof body.password === 'string' ? body.password : '';
      if (password.length < 4) return sendJson(res, 400, { ok: false, error: '密码至少 4 位' });
      const id = randomBytes(8).toString('hex');
      const next = {
        ...state,
        accounts: { ...state.accounts, [id]: { name: '管理员', ...hashPassword(password), createdAt: Date.now() } },
      };
      await writeState(next);
      const token = randomBytes(32).toString('base64url');
      sessions.set(token, { mode: 'admin', accountId: id, accountName: '管理员', createdAt: Date.now(), lastSeen: Date.now() });
      return sendJson(res, 200, { ok: true, mode: 'admin' }, {
        'set-cookie': cookieHeader(token, Math.floor(SESSION_TTL_MS / 1000)),
      });
    }

    if (path === `${ROUTE}/api/login`) {
      if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method' });
      const lockedFor = isLockedOut(req);
      if (lockedFor > 0) {
        return sendJson(res, 429, { ok: false, error: `试错太多次，请等 ${lockedFor} 秒再试。` });
      }

      const body = await readJsonBody(req);
      const wantMode = body.mode === 'guest' ? 'guest' : 'admin';

      if (wantMode === 'guest') {
        // 无访客模式 / 停用闸门 都不该走到这里
        if (state.mode !== 'guest') {
          return sendJson(res, 403, { ok: false, error: '这个门没开访客入口。' });
        }
        const token = randomBytes(32).toString('base64url');
        sessions.set(token, { mode: 'guest', createdAt: Date.now(), lastSeen: Date.now() });
        return sendJson(res, 200, { ok: true, mode: 'guest' }, {
          'set-cookie': cookieHeader(token, Math.floor(SESSION_TTL_MS / 1000)),
        });
      }

      if (!hasAccounts(state)) return sendJson(res, 409, { ok: false, error: '还没设置密码，请先设置。' });
      const password = typeof body.password === 'string' ? body.password : '';
      const account = matchAccount(state, password);
      if (account === undefined) {
        noteFailure(req);
        return sendJson(res, 401, { ok: false, error: '密码不对。' });
      }
      clearFailures(req);
      const token = randomBytes(32).toString('base64url');
      sessions.set(token, {
        mode: 'admin', accountId: account.id, accountName: account.name,
        createdAt: Date.now(), lastSeen: Date.now(),
      });
      return sendJson(res, 200, { ok: true, mode: 'admin', account: account.name }, {
        'set-cookie': cookieHeader(token, Math.floor(SESSION_TTL_MS / 1000)),
      });
    }

    if (path === `${ROUTE}/api/logout`) {
      const token = readCookie(req, COOKIE);
      if (token !== undefined) sessions.delete(token);
      return sendJson(res, 200, { ok: true }, { 'set-cookie': clearCookieHeader() });
    }

    // ---- 以下都是管理员专属 ----
    if (!isAdmin) {
      return sendJson(res, 403, {
        ok: false,
        error: gate === undefined ? 'gate.locked' : 'gate.admin-only',
        message: '只有管理员能改这些设置。',
      });
    }

    if (path === `${ROUTE}/api/mode`) {
      if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method' });
      const body = await readJsonBody(req);
      if (!MODES.includes(body.mode)) return sendJson(res, 400, { ok: false, error: '未知模式' });
      const next = await writeState({ ...state, mode: body.mode });
      // 关掉访客入口时，把已经在场的访客踢出去，免得他们挂着旧 cookie 继续用。
      if (body.mode !== 'guest') {
        for (const [token, entry] of sessions) if (entry.mode === 'guest') sessions.delete(token);
      }
      return sendJson(res, 200, { ok: true, mode: next.mode });
    }

    if (path === `${ROUTE}/api/account`) {
      if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method' });
      const body = await readJsonBody(req);
      const name = typeof body.name === 'string' && body.name.trim() !== '' ? body.name.trim().slice(0, 40) : '管理员';
      const password = typeof body.password === 'string' ? body.password : '';
      if (password.length < 4) return sendJson(res, 400, { ok: false, error: '密码至少 4 位' });
      const id = randomBytes(8).toString('hex');
      await writeState({
        ...state,
        accounts: { ...state.accounts, [id]: { name, ...hashPassword(password), createdAt: Date.now() } },
      });
      return sendJson(res, 200, { ok: true, account: { id, name } });
    }

    if (path === `${ROUTE}/api/account/remove`) {
      if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method' });
      const body = await readJsonBody(req);
      const id = typeof body.id === 'string' ? body.id : '';
      if (!Object.hasOwn(state.accounts, id)) return sendJson(res, 404, { ok: false, error: '没有这个账号' });
      if (Object.keys(state.accounts).length <= 1) {
        return sendJson(res, 400, { ok: false, error: '不能删掉最后一个账号，否则就再也进不来了。' });
      }
      const accounts = { ...state.accounts };
      delete accounts[id];
      await writeState({ ...state, accounts });
      // 这个账号签出去的会话一并作废
      for (const [token, entry] of sessions) if (entry.accountId === id) sessions.delete(token);
      return sendJson(res, 200, { ok: true });
    }

    if (path === `${ROUTE}/api/password`) {
      if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method' });
      const body = await readJsonBody(req);
      const current = typeof body.current === 'string' ? body.current : '';
      const next = typeof body.next === 'string' ? body.next : '';
      const account = state.accounts[gate.accountId];
      if (account === undefined) {
        return sendJson(res, 409, { ok: false, error: '当前账号已不存在，请重新登录。' });
      }
      if (!verifyPassword(current, account)) {
        noteFailure(req);
        return sendJson(res, 401, { ok: false, error: '当前密码不对。' });
      }
      if (next.length < 4) return sendJson(res, 400, { ok: false, error: '新密码至少 4 位' });
      await writeState({
        ...state,
        accounts: { ...state.accounts, [gate.accountId]: { ...account, ...hashPassword(next) } },
      });
      // 改完密码把**别的**会话踢掉：只留当前这个。访客不动——他们本来就免密。
      const mine = readCookie(req, COOKIE);
      for (const [token, entry] of sessions) {
        if (token !== mine && entry.mode === 'admin') sessions.delete(token);
      }
      return sendJson(res, 200, { ok: true });
    }

    if (path === `${ROUTE}/api/policy/reset`) {
      if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method' });
      const fresh = emptyState();
      await writeState({ ...state, guest: fresh.guest });
      return sendJson(res, 200, { ok: true, guest: fresh.guest });
    }

    if (path === `${ROUTE}/api/policy`) {
      if (method === 'GET') return sendJson(res, 200, { ok: true, guest: state.guest });
      if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method' });
      const body = await readJsonBody(req);
      const clean = (list, fallback) => (Array.isArray(list)
        ? list.filter((x) => typeof x === 'string' && x.trim() !== '').map((x) => x.trim())
        : fallback);
      const endpoints = clean(body.endpoints, state.guest.endpoints);
      const tools = clean(body.tools, state.guest.tools);
      // 主人一保存就算自定义过：以后升级不再自动往名单里补端点。
      await writeState({ ...state, guest: { endpoints, tools, customized: true } });
      return sendJson(res, 200, { ok: true, guest: { endpoints, tools, customized: true } });
    }

    return sendJson(res, 404, { ok: false, error: 'not found' });
  };

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE,
    handler: (req, res) => {
      Promise.resolve(handleGate(req, res)).catch((error) => {
        if (res.headersSent) { res.destroy(); return; }
        sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
      });
    },
  }), 'admin-gate: 闸门路由');

  /**
   * 升级到 v3 之后的一次性归属迁移。
   *
   * 老状态里根本没有归属表，可磁盘上有一堆真对话。全丢给访客不行、全拒也不行，
   * 按实际情况划给**最早创建的那个账号** —— 那些对话本来就是它开的。
   */
  const ensureSessionOwners = async () => {
    const state = await readState(true);
    if (state.sessionsMigrated === true) return;
    const sessionQuery = ctx.get('sessionQuery');
    const first = Object.entries(state.accounts ?? {})
      .sort((a, b) => (Number(a[1]?.createdAt) || 0) - (Number(b[1]?.createdAt) || 0))[0];
    if (first === undefined) return;
    let records = [];
    if (sessionQuery !== undefined && typeof sessionQuery.listSessions === 'function') {
      try {
        records = await sessionQuery.listSessions();
      } catch {
        return; // 读不出来就下次再说，别把迁移标记写死。
      }
    }
    const sessionsOwned = { ...(state.sessions ?? {}) };
    const owner = `acct:${first[0]}`;
    let added = 0;
    for (const record of records) {
      const id = record?.header?.id;
      if (typeof id !== 'string' || id === '') continue;
      if (sessionsOwned[id] !== undefined) continue;
      sessionsOwned[id] = owner;
      added += 1;
    }
    await writeState({ ...state, sessions: sessionsOwned, sessionsMigrated: true });
    if (added > 0) {
      console.log('[admin-gate] 已把 %d 段老对话划给账号「%s」', added, first[1]?.name ?? first[0]);
    }
  };

  // 状态就位之后把老对话的归属补上（一次性）。
  Promise.resolve().then(ensureSessionOwners).catch(() => {});

  // ---- 5. 身份：闸门自己说了算 ----------------------------------------
  //
  // 这一节是整个插件的地基，先说清楚为什么要动 Harness 的 connection。
  //
  // 【问题】Harness 的 /api 和 /（主界面 HTML）在进到我们这一层之前，就已经被
  // Connection 自己的 browserAuth 拦住过一次了：没有它签发的 cookie 一律 401。
  // 也就是说，**访客根本进不来** —— 他既没有管理员密码，也没有那个 cookie。
  // v1.1 里访客能"进去"，其实只是借了同一个浏览器里管理员已经登录的 cookie，
  // 用的还是 owner 身份。所以"访客能看管理员对话"根本不是名单漏了某个端点，
  // 而是访客压根没有自己的身份。
  //
  // 【做法】把 admit / admitConnection / authorizeIndex 三个鉴权入口包一层：
  //   · 闸门没启用（没账号 / mode=open）→ 原样交给 Harness，主人不会被锁在门外；
  //   · 过了闸门                      → 发一个带身份标记的 Peer，不再问 Harness 要 cookie；
  //   · 没过闸门                      → 401 / 303 到闸门页。
  // 唯一保留的是 Harness 自己的 Host 信任检查（403）：那是防 DNS rebinding 的，
  // 跟登录状态无关，不该被我们绕过去。
  //
  // 身份用 Symbol 挂在 Peer 上（而不是塞进 principal）：principal 的形状是
  // Harness 的契约，多塞一个键迟早被它的 schema 校验打回来。

  /** 从 Peer 上读身份；读不到就是主人自己（Harness 原有行为）。 */
  const identityOfPeer = (peer) => (peer === undefined ? undefined : peerIdentity.get(peer));

  const connectionService = ctx.get('connection');
  if (connectionService !== undefined
    && typeof connectionService.admit === 'function'
    && typeof connectionService.createPeer === 'function') {
    const originalAdmit = connectionService.admit;
    const originalAdmitConnection = connectionService.admitConnection;
    const originalAuthorizeIndex = connectionService.authorizeIndex;

    /**
     * 身份 -> Peer 的缓存。
     *
     * 每个请求都新建一个 Peer 会随手挂一堆活对象在进程里，所以按身份复用：
     * 一个管理员账号一个、访客共一个。登出 / 删账号 / 改模式时把对应的收掉。
     */
    const peers = new Map(); // 身份键 -> peer

    const peerFor = (who) => {
      const key = identityKey(who);
      const cachedPeer = peers.get(key);
      if (cachedPeer !== undefined && !cachedPeer.signal?.aborted) return cachedPeer;
      const peer = connectionService.createPeer({ principal: { kind: 'owner' }, interactions: 'answer' });
      peerIdentity.set(peer, who);
      peers.set(key, peer);
      return peer;
    };

    const dropPeer = (key) => {
      const peer = peers.get(key);
      if (peer === undefined) return;
      peers.delete(key);
      Promise.resolve(peer.dispose()).catch(() => {});
    };

    const gateIsOn = () => cached !== null && cached !== undefined && cached.mode !== 'open' && hasAccounts(cached);

    /**
     * 闸门会话条目 -> 身份。
     *
     * 条目的字段是 `mode`（admin / guest），身份要的是 `kind` —— 两套词不能混用，
     * 混用的下场就是访客被当成"没有账号的管理员"，而这正是要杜绝的那种混淆。
     */
    const identityOfGate = (gate) => (gate.mode === 'guest'
      ? { kind: 'guest' }
      : { kind: 'admin', accountId: gate.accountId, accountName: gate.accountName });

    const patchedAdmit = function admit(req) {
      if (!gateIsOn()) return originalAdmit.call(this, req);
      // 先让 Harness 跑一次：我们要它的 Host 信任检查（403），只是不要它的 cookie 判断（401）。
      const admission = originalAdmit.call(this, req);
      if (admission !== undefined && admission !== null && 'rejection' in admission && admission.rejection !== 401) {
        return admission;
      }
      const gate = gateOf(req);
      if (gate === undefined) return { rejection: 401 };
      return { peer: peerFor(identityOfGate(gate)), release: () => Promise.resolve() };
    };

    const patchedAdmitConnection = function admitConnection(req, socket) {
      if (!gateIsOn()) return originalAdmitConnection.call(this, req, socket);
      const probe = originalAdmitConnection.call(this, req, socket);
      if (probe !== undefined && probe !== null && 'rejection' in probe && probe.rejection !== 401) return probe;
      // probe 可能已经占了一个 operator socket；交还回去再换自己的。
      if (probe !== undefined && probe !== null && typeof probe.release === 'function') {
        Promise.resolve(probe.release()).catch(() => {});
      }
      const gate = gateOf(req);
      if (gate === undefined) return { rejection: 401 };
      return { peer: peerFor(identityOfGate(gate)), release: () => Promise.resolve() };
    };

    /**
     * 主界面 HTML 的鉴权。
     *
     * Harness 在这里要求它自己签发的 cookie —— 访客没有，于是整页 401，连
     * "看"都做不到。闸门启用时改成认我们的 cookie：进了闸门就能看界面。
     * 这是安全的，因为页面上一切数据都要走 /api，而 /api 由下面的端点层
     * 按身份筛。
     */
    const patchedAuthorizeIndex = function authorizeIndex(req, res) {
      if (!gateIsOn()) return originalAuthorizeIndex.call(this, req, res);
      // 顺序很重要：originalAuthorizeIndex 一旦不认，它会**当场**写出 401，
      // 之后再想 303 就晚了（headers 已经发出）。所以过了闸门的先放行。
      if (gateOf(req) !== undefined) return true;
      // 没过闸门：先让 Harness 处理 launch token 换 cookie（它会 303 抹掉地址里
      // 的 token）；它不认就直接去闸门页，别再让它写那个 401。
      const url = new URL(req.url ?? '/', 'http://gate.invalid');
      if (url.searchParams.has('token')) return originalAuthorizeIndex.call(this, req, res);
      if (res.headersSent) return false;
      res.writeHead(303, { 'cache-control': 'no-store', location: ROUTE, 'referrer-policy': 'no-referrer' });
      res.end();
      return false;
    };

    ctx.effect(() => {
      connectionService.admit = patchedAdmit;
      connectionService.admitConnection = patchedAdmitConnection;
      connectionService.authorizeIndex = patchedAuthorizeIndex;
      return async () => {
        if (connectionService.admit === patchedAdmit) connectionService.admit = originalAdmit;
        if (connectionService.admitConnection === patchedAdmitConnection) connectionService.admitConnection = originalAdmitConnection;
        if (connectionService.authorizeIndex === patchedAuthorizeIndex) connectionService.authorizeIndex = originalAuthorizeIndex;
        const owned = [...peers.values()];
        peers.clear();
        await Promise.allSettled(owned.map((peer) => peer.dispose()));
      };
    }, 'admin-gate: 身份闸门');

    // 登出 / 账号被删 / 关掉访客入口时，把对应的 Peer 收掉，别让旧身份挂在内存里。
    ctx.effect(() => () => {
      for (const key of [...peers.keys()]) dropPeer(key);
    }, 'admin-gate: 身份回收');

    // ---- 5b. 访客的流按名单筛 -----------------------------------------
    //
    // 管理员和 /connect 出来的 API operator 一概照旧。`$events` 是前端刷新
    // 用的事件通道，不是业务端点，放行。
    const gateway = ctx.get('typertGateway');
    if (gateway !== undefined && typeof gateway.openWireStream === 'function') {
      const originalOpen = gateway.openWireStream;
      const patchedOpen = async function openWireStream(endpoint, payload, uplink, peer, signal, control, uplinkWindow) {
        const who = identityOfPeer(peer);
        if (who !== undefined && endpoint !== '$events') {
          if (who.kind === 'guest') {
            const state = await readState();
            if (!guestAllows(state.guest.endpoints, endpoint)) {
              throw new Error(`访客模式不允许打开 ${endpoint}`);
            }
          }
          // 归属：不是自己的对话，流也不许开。
          const denied = await ownerVerdict(who, endpoint, payload);
          if (denied !== undefined) throw denied;
        }
        return originalOpen.call(this, endpoint, payload, uplink, peer, signal, control, uplinkWindow);
      };
      ctx.effect(() => {
        gateway.openWireStream = patchedOpen;
        return () => {
          if (gateway.openWireStream === patchedOpen) gateway.openWireStream = originalOpen;
        };
      }, 'admin-gate: 访客流白名单');
    }

    /** 一次可能越界的会话调用该怎么处理；放行时返回 undefined。 */
    const ownershipGuard = (who, name, args) => {
      const request = args[0];
      const sessionId = sessionIdOf(request);
      // 拿不到 sessionId 的方法（modelCatalog / canOpenWorkspacePath 之类）不归这里管。
      if (sessionId === undefined) return undefined;
      const state = cached;
      if (state === null) return undefined;
      if (ownsSession(state, who, sessionId)) return undefined;
      if (who.kind === 'guest') return new Error('访客看不到管理员的对话。');
      return new Error(`这段对话不属于当前账号（${who.accountName ?? who.accountId ?? '未知'}）。`);
    };

    /** 流的归属判断：直接按端点 + payload 判，判不过就抛。 */
    const ownerVerdict = async (who, endpoint, payload) => {
      const args = payload?.args ?? {};
      const state = await readState();
      const sessionId = sessionIdOf(args.request) ?? sessionIdOf(args);
      if (sessionId === undefined || ownsSession(state, who, sessionId)) return undefined;
      return new Error(`这段对话不属于当前身份，${endpoint} 被拒绝。`);
    };

    /** 认领一段对话：谁开的就记谁名下。 */
    const claimSession = async (sessionId, who) => {
      if (sessionId === undefined) return;
      const state = await readState(true);
      if (state.sessions?.[sessionId] !== undefined) return;
      await writeState({ ...state, sessions: { ...(state.sessions ?? {}), [sessionId]: identityKey(who) } });
    };

    // ---- 5c. 对话归属：谁的对话，谁才看得见 ----------------------------
    //
    // 光拦 HTTP 不够。会话类方法有二十来个，漏一个就是一条越权路径，所以这里
    // 直接包 sessionController 这个服务对象：所有会话方法进同一个闸，按方法
    // 参数里带的 sessionId 判断归属。
    //
    // 为什么不去改 typert 的 resource 声明：那是生成代码里的东西，改完下次
    // Harness 升级就被盖掉了；而服务对象是我们进程里的活对象。
    const sessionController = ctx.get('sessionController');
    if (sessionController !== undefined) {
      const filtered = ['list', 'search'];
      const owned = [
        'page', 'follow', 'projections', 'liveProjections', 'prompt',
        'attachment', 'updateQueue', 'cancel', 'rename', 'fork',
        'selectModel', 'inspect',
      ];
      const originals = new Map();

      for (const name of filtered) {
        const original = sessionController[name];
        if (typeof original !== 'function') continue;
        originals.set(name, original);
        sessionController[name] = function filteredCall(...args) {
          const who = identityOfPeer(this.ctx?.invocation?.peer);
          if (who === undefined) return Reflect.apply(original, this, args);
          const keep = (result) => {
            // 这里读缓存而不是磁盘：list/search 是高频调用，每次都读盘撑不住。
            // 缓存由 writeState 同步更新，所以刚认领完的对话这里立刻就能看见。
            const state = cached;
            if (state === null || result === null || typeof result !== 'object') return result;
            const items = Array.isArray(result.items) ? result.items : [];
            const visible = items.filter((item) => {
              const id = item?.sessionId ?? item?.id;
              return typeof id === 'string' && ownsSession(state, who, id);
            });
            return { ...result, items: visible };
          };
          const result = Reflect.apply(original, this, args);
          return result !== null && typeof result?.then === 'function' ? result.then(keep) : keep(result);
        };
      }

      for (const name of owned) {
        const original = sessionController[name];
        if (typeof original !== 'function') continue;
        originals.set(name, original);
        sessionController[name] = function ownedCall(...args) {
          const who = identityOfPeer(this.ctx?.invocation?.peer);
          if (who === undefined) return Reflect.apply(original, this, args);
          const verdict = ownershipGuard(who, name, args);
          if (verdict !== undefined) return name === 'follow' ? (async function* () { throw verdict; })() : Promise.reject(verdict);
          return Reflect.apply(original, this, args);
        };
      }

      // 谁开的对话就记在谁名下：不然新对话永远是无主的，访客也能看见。
      const originalCreate = sessionController.create;
      if (typeof originalCreate === 'function') {
        originals.set('create', originalCreate);
        sessionController.create = function createOwned(...args) {
          const who = identityOfPeer(this.ctx?.invocation?.peer);
          const result = Reflect.apply(originalCreate, this, args);
          if (who === undefined) return result;
          // 认领要**等**：不等的话刚开完的对话还是"无主"的，下一页就可能被判
          // 成不属于自己 —— 自己刚开的对话自己读不到，这种 bug 最难查。
          const done = async (value) => {
            const id = value?.sessionId;
            if (typeof id === 'string') {
              try { await claimSession(id, who); } catch { /* 认领失败不该弄坏创建 */ }
            }
            return value;
          };
          return result !== null && typeof result?.then === 'function' ? result.then(done) : done(result);
        };
      }

      ctx.effect(() => () => {
        for (const [name, original] of originals) {
          if (sessionController[name] === original) continue;
          sessionController[name] = original;
        }
        originals.clear();
      }, 'admin-gate: 会话归属');
    }
  }

  // ---- 6. 页面一进来先看门开着没有 ------------------------------------
  //
  // 只做「导航」这一件事：没通过就整页换到闸门页。真正的拒绝在 /api 那边，
  // 所以就算这段脚本被绕过，也进不到数据。
  ctx.on('webserver/index-inject', (table) => {
    table.push({
      kind: 'script',
      placement: 'head',
      text: `(function(){try{fetch('${ROUTE}/api/state',{credentials:'same-origin'}).then(function(r){return r.json()}).then(function(s){if(s.gateMode==='open')return;if(!s.entered)location.replace('${ROUTE}')}).catch(function(){})}catch(e){}})();`,
    });
  });

  ctx.effect(() => () => {
    sessions.clear();
    guestAgents.clear();
    failures.clear();
  }, 'admin-gate: 会话清理');

  // 定期清掉过期会话与失败记录，避免两张表只增不减。
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [token, entry] of sessions) {
      if (now - entry.lastSeen > SESSION_TTL_MS) sessions.delete(token);
    }
    for (const [key, record] of failures) {
      const expired = now - record.firstAt > FAILURE_WINDOW_MS
        && (record.lockedUntil === undefined || record.lockedUntil < now);
      if (expired) failures.delete(key);
    }
  }, 10 * 60 * 1000);
  if (typeof timer.unref === 'function') timer.unref();
  ctx.effect(() => () => clearInterval(timer), 'admin-gate: 过期清理');
}

// 给单元测试用（生产代码不依赖这些导出）。
export { guestAllows, migrate, emptyState, hasAccounts, identityKey, ownsSession, sessionIdOf };
