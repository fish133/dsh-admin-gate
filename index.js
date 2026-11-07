// 管理员密码（admin-gate）—— host 半边
//
// 目标：进 Harness 之前先过一道门。
//   · 管理员：输密码进去，能力全开。
//   · 访客：不输密码，按名单放行接口与工具。
//
// 为什么不是「客户端弹个遮罩」：
//   遮罩只能挡住眼睛，挡不住手 —— 页面里的 /api 照样能调。所以真正的闸门放在
//   host 这边：没通过闸门的浏览器请求一律拿不到 /api；访客的 /api 端点还要再过
//   一遍白名单。页面跳一下只是外表，服务端这份拒绝才是本体。
//
// 闸门页自己必须「不用登录也能打开」，所以它不挂在 /api 下，而是 /admin-gate/*
// 这组自有路由（HTML + JSON），也不依赖 Harness 的 cookie。
//
// 密码不写在 profile patch 里（改了要重启、还会被别的层覆盖），而是落在
// $DSH_HOME/admin-gate.json 里，存 scrypt 加盐哈希。改密码走闸门页的「管理员设置」
// 或 Web 设置页里的「管理员密码」分区。

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { AsyncLocalStorage } from 'node:async_hooks';

export const name = 'admin-gate';
// 路由要挂在 webServer 上；connection / tools 都是可选的，不写进 inject，
// 免得在没装它们的组合里整个插件不激活。
export const inject = ['webServer'];

const COOKIE = 'dsh-admin-gate';
const ROUTE = '/admin-gate';
const STATE_VERSION = 1;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SCRYPT = { n: 16384, r: 8, p: 1, len: 64 };

/**
 * 访客默认能调的 /api 端点：能看见工作区、会话和模型目录，改不了一样。
 *
 * 刻意**不含** session/prompt —— 一放行，访客就能让 agent 干活，而 agent 是
 * 以主人的身份在这台机器上跑的。想让访客能聊天，就自己把 session/prompt
 * 加进名单，这是明确的取舍，不该由默认值替主人决定。
 *
 * 这份名单要**够页面正常启动**：前端一加载就会问会话、模型目录、插件清单、
 * 传输恢复参数，少一个就是一屏红字（"Failed to load plugins" 就是这么来的）。
 * 所以这里收的是「页面开得起来所需要的最小集合」，工具权限另算。
 */
const DEFAULT_GUEST_ENDPOINTS = [
  // 会话与工作区（看得到，改不了）
  'session/list', 'session/page', 'session/follow', 'session/projections',
  'session/modelCatalog', 'session/search', 'session/attachment',
  'session/listMetadata', 'session/canOpenWorkspacePath',
  'workspace/follow', 'workspaceFiles/read', 'workspaceFiles/readBytes',
  'workspaceFiles/list', 'workspaceFiles/stat', 'workspaceFiles/changes',
  // 页面开起来要用的目录类查询
  'job/list', 'job/follow', 'schedule/list', 'skills/list',
  'agentPresets/list', 'agentPresets/read', 'settings/describe',
  'llm/listProviders', 'llm/listConfigurableProviders', 'fileReferences/list',
  'messageFeedback/list', 'remoteAccess/follow', 'account/getState',
  'pluginManager/listBundles', 'pluginManager/listPlugins',
  'pluginManager/registries', 'pluginInventory/list',
  // 思维链翻译小部件：前端启动时一定会问它，拦掉就是「插件加载失败」
  'cotTranslation/limits', 'cotTranslation/translate',
];

/**
 * 访客默认能用的工具：只留联网查资料。
 *
 * 不默认给 read / glob / grep / read_image / bash / write：它们是**主人身份**在
 * 这台机器上跑的工具，read 能读 ~/.dsh 里的凭据，bash 能跑任何命令。访客要
 * 这些得主人自己往名单里加，默认值不替他把门打开。
 */
const DEFAULT_GUEST_TOOLS = ['web_search', 'web_fetch'];

/**
 * 一条端点是否放行给访客。
 *
 * 名单里的字面量优先；另外认 `*`（整个命名空间）与结尾的 `*` 通配，
 * 这样主人不用一条条列。写成函数是因为这套判断现在有两个调用点
 * （HTTP 一份、WS 一份），规则只能有一处。
 * @param {string[]} endpoints - 主人配置的名单。
 * @param {string} endpoint - 例如 `session/list`。
 */
function guestAllows(endpoints, endpoint) {
  for (const pattern of endpoints) {
    if (pattern === endpoint) return true;
    if (!pattern.includes('*')) continue;
    const prefix = pattern.slice(0, pattern.indexOf('*'));
    if (pattern.endsWith('*') && endpoint.startsWith(prefix)) return true;
    if (pattern.indexOf('*') === pattern.length - 2 && endpoint === prefix + pattern.at(-1)) return true;
  }
  return false;
}

// ------------------------------------------------------------------ 存储

function statePath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'admin-gate.json');
}

function emptyState() {
  return {
    version: STATE_VERSION,
    password: null,
    // `customized` = 主人动过这份名单。没动过就跟着 DEFAULT 走，
    // 这样插件升级补了新端点（前端要用的那些）能自动补上，不至于
    // 主人什么都没改、却因为旧名单缺一条而白屏。
    guest: {
      endpoints: [...DEFAULT_GUEST_ENDPOINTS],
      tools: [...DEFAULT_GUEST_TOOLS],
      customized: false,
    },
  };
}

async function loadState() {
  try {
    const raw = await readFile(statePath(), 'utf8');
    const parsed = JSON.parse(raw);
    const base = emptyState();
    const customized = parsed.guest?.customized === true;
    return {
      version: STATE_VERSION,
      password: parsed.password ?? null,
      guest: {
        // 没自定义过就跟默认值（升级自动补齐）；自定义过就完全照主人的来。
        endpoints: customized
          ? (Array.isArray(parsed.guest.endpoints) ? parsed.guest.endpoints : base.guest.endpoints)
          : base.guest.endpoints,
        tools: customized
          ? (Array.isArray(parsed.guest.tools) ? parsed.guest.tools : base.guest.tools)
          : base.guest.tools,
        customized,
      },
    };
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.warn('[admin-gate] 状态文件读不动，按未设置处理：%s', error?.message ?? error);
    }
    return emptyState();
  }
}

async function saveState(state) {
  const path = statePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
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

// --------------------------------------------------------------- HTTP 小工具

function readCookie(req, key) {
  const header = req.headers.cookie;
  if (typeof header !== 'string') return undefined;
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at === -1) continue;
    if (part.slice(0, at).trim() !== key) continue;
    return decodeURIComponent(part.slice(at + 1).trim());
  }
  return undefined;
}

function sendJson(res, status, value, extraHeaders = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(JSON.stringify(value));
}

function sendHtml(res, status, html) {
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
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('请求体不是 JSON');
  }
}

function cookieHeader(token, maxAgeSeconds) {
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

// ------------------------------------------------------------------ 闸门页

const GATE_CSS = `
  :root { color-scheme: light dark; --fg:#1b1f24; --dim:#6b7480; --bg:#f6f7f9; --card:#fff; --line:#dfe3e8; --brand:#247bbf; --err:#c0392b; }
  @media (prefers-color-scheme: dark) { :root { --fg:#e8eaed; --dim:#9aa3ad; --bg:#16181c; --card:#1e2126; --line:#31363d; --brand:#5aa9e6; --err:#ff7b6b; } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; padding:24px 16px; background:var(--bg); color:var(--fg);
         font:15px/1.6 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
  .card { width:min(440px, 100%); background:var(--card); border:1px solid var(--line);
          border-radius:14px; padding:26px 24px 20px; box-shadow:0 10px 40px rgb(0 0 0 / .08); }
  h1 { margin:0 0 4px; font-size:19px; letter-spacing:.2px; }
  .sub { margin:0 0 18px; color:var(--dim); font-size:13px; }
  .tabs { display:flex; gap:8px; margin-bottom:16px; }
  .tabs button { flex:1; padding:9px 0; border-radius:9px; border:1px solid var(--line); background:transparent;
                 color:var(--fg); font:inherit; font-size:13px; cursor:pointer; }
  .tabs button[aria-selected="true"] { border-color:var(--brand); color:var(--brand); font-weight:600; }
  label { display:block; font-size:13px; color:var(--dim); margin:0 0 6px; }
  input, textarea { width:100%; padding:10px 12px; border-radius:9px; border:1px solid var(--line);
          background:transparent; color:var(--fg); font:inherit; }
  textarea { min-height:88px; resize:vertical; font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12px; }
  input:focus, textarea:focus { outline:2px solid color-mix(in srgb, var(--brand) 45%, transparent); outline-offset:1px; border-color:var(--brand); }
  .row { margin-bottom:14px; }
  .go { width:100%; padding:11px 0; border-radius:9px; border:0; background:var(--brand); color:#fff;
        font:inherit; font-weight:600; cursor:pointer; }
  .go:disabled { opacity:.55; cursor:default; }
  .ghost { padding:8px 14px; border-radius:8px; border:1px solid var(--line); background:transparent;
           color:var(--fg); font:inherit; font-size:13px; cursor:pointer; }
  .hint { margin:14px 0 0; font-size:12px; color:var(--dim); line-height:1.55; }
  .err { color:var(--err); font-size:13px; min-height:20px; margin:10px 0 0; }
  .ok { color:#2e9e5b; font-size:13px; min-height:20px; margin:10px 0 0; }
  .guest-only, .admin-only, .panel { display:none; }
  [data-mode="guest"] .guest-only { display:block; }
  [data-mode="admin"] .admin-only { display:block; }
  .panel[data-open="true"] { display:block; border-top:1px solid var(--line); margin-top:18px; padding-top:16px; }
  .panel h2 { font-size:14px; margin:0 0 12px; }
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
        <label for="cur">当前密码</label>
        <input id="cur" type="password" autocomplete="current-password">
      </div>
      <div class="row">
        <label for="next">新密码（至少 4 位）</label>
        <input id="next" type="password" autocomplete="new-password">
      </div>
      <div class="row">
        <button class="ghost" type="button" id="save-pw">改密码</button>
        <button class="ghost" type="button" id="logout">退出闸门</button>
      </div>
      <p class="ok" id="panel-ok"></p>
      <div class="row">
        <label for="eps">访客可用的接口（一行一个）</label>
        <textarea id="eps" spellcheck="false"></textarea>
      </div>
      <div class="row">
        <label for="tools">访客可用的工具（一行一个）</label>
        <textarea id="tools" spellcheck="false"></textarea>
      </div>
      <div class="row">
        <button class="ghost" type="button" id="save-policy">保存访客名单</button>
        <button class="ghost" type="button" id="reset-policy">恢复默认名单</button>
      </div>
      <p class="hint" id="policy-hint"></p>
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

  function applyMode(next) {
    mode = next;
    document.body.dataset.mode = next;
    document.getElementById('tab-admin').setAttribute('aria-selected', next === 'admin' ? 'true' : 'false');
    document.getElementById('tab-guest').setAttribute('aria-selected', next === 'guest' ? 'true' : 'false');
    err.textContent = '';
  }

  function render() {
    var s = state;
    if (!s) return;
    if (!s.configured) {
      sub.textContent = '第一次进来，先给这个门设一个管理员密码。';
      go.textContent = '设置密码并进入';
      tail.innerHTML = '密码只存在本机（scrypt 加盐哈希）。忘了就删掉 <code>' + s.statePath + '</code> 再打开这里重设。';
    } else if (s.entered && s.isAdmin) {
      sub.textContent = '你已经过闸门了。可以回 Harness，或在这里改设置。';
      go.textContent = '回到 Harness';
      tail.innerHTML = '';
      panel.dataset.open = 'true';
    } else {
      sub.textContent = '请输入管理员密码进入。';
      go.textContent = '进入';
      tail.innerHTML = '忘了密码？删掉 <code>' + s.statePath + '</code> 再打开这里重设。';
      panel.dataset.open = 'false';
    }
    document.getElementById('guest-hint').textContent =
      '访客不用密码：能看不能改。当前放行接口 ' + s.guestEndpoints + ' 个、工具 ' + s.guestTools + ' 个。';
    if (s.guest) {
      document.getElementById('eps').value = s.guest.endpoints.join('\\n');
      document.getElementById('tools').value = s.guest.tools.join('\\n');
    }
    var policyHint = document.getElementById('policy-hint');
    if (policyHint) {
      policyHint.textContent = s.guestCustomized
        ? '当前是自定义名单：插件升级不会再自动补端点。'
        : '当前是默认名单：插件升级会自动补上新端点。';
    }
  }

  function post(path, body) {
    return fetch('${ROUTE}/api/' + path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(function (r) {
      return r.json().then(function (json) { return { ok: r.ok, body: json }; });
    });
  }

  function loadState() {
    return fetch('${ROUTE}/api/state', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (s) { state = s; render(); })
      .catch(function () { sub.textContent = '读不到闸门状态，请刷新重试。'; });
  }

  document.getElementById('tab-admin').onclick = function () { applyMode('admin'); pw && pw.focus(); };
  document.getElementById('tab-guest').onclick = function () { applyMode('guest'); };

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

  document.getElementById('save-pw').onclick = function () {
    ok.textContent = '';
    post('password', { current: document.getElementById('cur').value, next: document.getElementById('next').value })
      .then(function (result) {
        if (!result.ok || !result.body.ok) throw new Error(result.body.error || '改不了');
        ok.textContent = '密码已更新。';
        document.getElementById('cur').value = '';
        document.getElementById('next').value = '';
        return loadState();
      })
      .catch(function (error) { ok.textContent = error.message; });
  };

  document.getElementById('save-policy').onclick = function () {
    ok.textContent = '';
    var lines = function (id) {
      return document.getElementById(id).value.split('\\n').map(function (x) { return x.trim(); }).filter(Boolean);
    };
    post('policy', { endpoints: lines('eps'), tools: lines('tools') })
      .then(function (result) {
        if (!result.ok || !result.body.ok) throw new Error(result.body.error || '存不了');
        ok.textContent = '访客名单已保存。';
        return loadState();
      })
      .catch(function (error) { ok.textContent = error.message; });
  };

  var resetBtn = document.getElementById('reset-policy');
  if (resetBtn) resetBtn.onclick = function () {
    ok.textContent = '';
    post('policy/reset', {}).then(function (result) {
      if (!result.ok || !result.body.ok) throw new Error(result.body.error || '恢复不了');
      ok.textContent = '已恢复默认名单。';
      return loadState();
    }).catch(function (error) { ok.textContent = error.message; });
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
  /** token -> { mode, createdAt, lastSeen } */
  const sessions = new Map();
  /** 被判定为「访客在用」的 agent id —— ALS 万一断链时的兜底。 */
  const guestAgents = new Set();
  /** 把「这一串异步操作是谁发起的」带进 agent 循环；工具拦截靠它认人。 */
  const als = new AsyncLocalStorage();
  /** 闸门是否已启用（= 设过密码）。没启用时一切照旧，插件等于不存在。 */
  let gateEnabled = false;
  const refreshEnabled = () => loadState()
    .then((state) => { gateEnabled = state.password !== null; })
    .catch(() => {});
  refreshEnabled();

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
  // 先看「这门到底启用没有」：还没设密码 = 闸门没启用，一切照旧放行。
  // 这一步很重要 —— 插件刚装上、主人还没来得及设密码时，如果直接拦，
  // 他自己的页面会当场 401 掉线，等于插件把人锁在门外。
  const guardConnection = async (req, res, next) => {
    // 命中闸门后走一遍，顺手把这一串异步操作归到谁头上。
    const proceed = (gate) => (gate === undefined ? next() : als.run(gate, () => next()));
    const gate = gateOf(req);
    const path = new URL(req.url ?? '/', 'http://gate.invalid').pathname;

    if (gate === undefined) {
      const state = await loadState();
      if (state.password === null) return proceed(undefined);
      sendJson(res, 401, {
        ok: false,
        error: 'gate.locked',
        message: '还没通过管理员密码。打开 /admin-gate 过闸门再回来。',
      });
      return;
    }

    if (gate.mode === 'guest') {
      const endpoint = path.replace(/^\/api\//, '');
      const state = await loadState();
      if (!guestAllows(state.guest.endpoints, endpoint)) {
        sendJson(res, 403, {
          ok: false,
          error: 'gate.guest-forbidden',
          message: `访客模式不允许调用 ${endpoint}`,
        });
        return;
      }
    }

    // 后面可能触发 agent 回合；用 ALS 把「这次是谁发起的」带进去，
    // 供工具守卫判断该不该放行。
    return proceed(gate);
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
  let guestTools = new Set(DEFAULT_GUEST_TOOLS);
  const refreshTools = () => loadState()
    .then((state) => { guestTools = new Set(state.guest.tools); })
    .catch(() => {});
  refreshTools();

  const toolsService = ctx.get('tools');
  if (toolsService !== undefined) {
    ctx.effect(() => toolsService.guard((execution) => {
      const byRequest = als.getStore()?.mode === 'guest';
      const byAgent = execution.agent !== undefined && guestAgents.has(execution.agent.id);
      if (!byRequest && !byAgent) return undefined;
      if (guestTools.has(execution.name)) return undefined;
      return `访客模式不允许使用工具 ${execution.name}`;
    }), 'admin-gate: 访客工具白名单');
  }

  // ---- 4. 闸门页 + 它自己的 JSON 接口 ---------------------------------
  const handleGate = async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://gate.invalid').pathname;
    const method = req.method ?? 'GET';

    if (path === ROUTE || path === `${ROUTE}/`) {
      if (method !== 'GET' && method !== 'HEAD') { sendJson(res, 405, { ok: false, error: 'method' }); return; }
      sendHtml(res, 200, gatePageHtml());
      return;
    }

    const state = await loadState();
    const gate = gateOf(req);

    if (path === `${ROUTE}/api/state`) {
      sendJson(res, 200, {
        ok: true,
        configured: state.password !== null,
        entered: gate !== undefined,
        mode: gate?.mode ?? null,
        isAdmin: gate?.mode === 'admin',
        guestEndpoints: state.guest.endpoints.length,
        guestTools: state.guest.tools.length,
        guest: gate?.mode === 'admin' ? state.guest : undefined,
        guestCustomized: state.guest.customized === true,
        statePath: statePath(),
      });
      return;
    }

    if (path === `${ROUTE}/api/setup`) {
      if (method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method' }); return; }
      if (state.password !== null) { sendJson(res, 409, { ok: false, error: '已经设过密码了，用登录。' }); return; }
      const body = await readJsonBody(req);
      const password = typeof body.password === 'string' ? body.password : '';
      if (password.length < 4) { sendJson(res, 400, { ok: false, error: '密码至少 4 位' }); return; }
      await saveState({ ...state, password: hashPassword(password) });
      gateEnabled = true;
      const token = randomBytes(32).toString('base64url');
      sessions.set(token, { mode: 'admin', createdAt: Date.now(), lastSeen: Date.now() });
      sendJson(res, 200, { ok: true, mode: 'admin' }, {
        'set-cookie': cookieHeader(token, Math.floor(SESSION_TTL_MS / 1000)),
      });
      return;
    }

    if (path === `${ROUTE}/api/login`) {
      if (method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method' }); return; }
      const body = await readJsonBody(req);
      const mode = body.mode === 'guest' ? 'guest' : 'admin';
      if (mode === 'admin') {
        if (state.password === null) { sendJson(res, 409, { ok: false, error: '还没设置密码，请先设置。' }); return; }
        if (!verifyPassword(typeof body.password === 'string' ? body.password : '', state.password)) {
          sendJson(res, 401, { ok: false, error: '密码不对。' });
          return;
        }
      }
      const token = randomBytes(32).toString('base64url');
      sessions.set(token, { mode, createdAt: Date.now(), lastSeen: Date.now() });
      sendJson(res, 200, { ok: true, mode }, {
        'set-cookie': cookieHeader(token, Math.floor(SESSION_TTL_MS / 1000)),
      });
      return;
    }

    if (path === `${ROUTE}/api/logout`) {
      const token = readCookie(req, COOKIE);
      if (token !== undefined) sessions.delete(token);
      sendJson(res, 200, { ok: true }, {
        'set-cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
      });
      return;
    }

    if (path === `${ROUTE}/api/password`) {
      if (method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method' }); return; }
      if (gate?.mode !== 'admin') { sendJson(res, 403, { ok: false, error: '只有管理员能改密码' }); return; }
      const body = await readJsonBody(req);
      const current = typeof body.current === 'string' ? body.current : '';
      const next = typeof body.next === 'string' ? body.next : '';
      if (state.password !== null && !verifyPassword(current, state.password)) {
        sendJson(res, 401, { ok: false, error: '当前密码不对。' });
        return;
      }
      if (next.length < 4) { sendJson(res, 400, { ok: false, error: '新密码至少 4 位' }); return; }
      await saveState({ ...state, password: hashPassword(next) });
      gateEnabled = true;
      const mine = readCookie(req, COOKIE);
      for (const [token, entry] of sessions) {
        if (token !== mine && entry.mode === 'admin') sessions.delete(token);
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (path === `${ROUTE}/api/policy/reset`) {
      if (method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method' }); return; }
      if (gate?.mode !== 'admin') { sendJson(res, 403, { ok: false, error: '只有管理员能改名单' }); return; }
      const fresh = emptyState();
      await saveState({ ...state, guest: fresh.guest });
      await refreshTools();
      sendJson(res, 200, { ok: true, guest: fresh.guest });
      return;
    }

    if (path === `${ROUTE}/api/policy`) {
      if (gate?.mode !== 'admin') { sendJson(res, 403, { ok: false, error: '只有管理员能改名单' }); return; }
      if (method === 'GET') { sendJson(res, 200, { ok: true, guest: state.guest }); return; }
      if (method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method' }); return; }
      const body = await readJsonBody(req);
      const endpoints = Array.isArray(body.endpoints)
        ? body.endpoints.filter((x) => typeof x === 'string')
        : state.guest.endpoints;
      const tools = Array.isArray(body.tools)
        ? body.tools.filter((x) => typeof x === 'string')
        : state.guest.tools;
      // 主人一保存就算自定义过：以后升级不再自动往名单里补端点。
      await saveState({ ...state, guest: { endpoints, tools, customized: true } });
      await refreshTools();
      sendJson(res, 200, { ok: true, guest: { endpoints, tools, customized: true } });
      return;
    }

    sendJson(res, 404, { ok: false, error: 'not found' });
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

  // ---- 5. WebSocket 也要过闸门 ----------------------------------------
  //
  // 实时流走 HTTP upgrade，不经过 connection/request，上面那层拦不到它。
  //
  // 第一版这里把访客的 WS 整个拒掉，结果是前端插件连不上事件通道，整页
  // 报 "Failed to load plugins"。所以现在分两步：
  //   ① 升级只要求「过了闸门」；
  //   ② 访客的 socket 挂到**它自己的 Peer** 上，这样每条逻辑流都能认出
  //      「这是访客在拉」，再按名单筛（见 5b）。
  //
  // 为什么非要另给一个 Peer：Connection 的 browserPeer 是所有浏览器共用的
  // 一个对象，管理员和访客在上面长得一模一样，流这一层分不出谁是谁。
  const connectionService = ctx.get('connection');
  if (connectionService !== undefined
    && typeof connectionService.admitConnection === 'function'
    && typeof connectionService.createPeer === 'function'
    && connectionService.browserPeer !== undefined) {
    const originalAdmit = connectionService.admitConnection;
    /** 访客专用 Peer；懒建一次，Connection 卸载时跟着走。 */
    let guestPeer;
    const peerForGuest = () => {
      guestPeer ??= connectionService.createPeer({ principal: { kind: 'owner' }, interactions: 'answer' });
      return guestPeer;
    };

    const patchedAdmit = function admitConnection(req) {
      const admission = originalAdmit.call(this, req);
      // 认不过就是认不过，原样把 401/403/409 交回去。
      if (admission?.peer === undefined || admission.peer !== connectionService.browserPeer) return admission;
      const gate = gateOf(req);
      if (gate === undefined) {
        // 还没设密码 = 闸门没启用，别把主人自己的实时流掐了。
        return gateEnabled ? { rejection: 401 } : admission;
      }
      // 管理员：照旧用共享的 browserPeer，权限和以前一模一样。
      if (gate.mode !== 'guest') return admission;
      // 访客：换到访客专用 Peer，后面的流按名单筛。
      return { peer: peerForGuest(), release: () => Promise.resolve() };
    };

    ctx.effect(() => {
      connectionService.admitConnection = patchedAdmit;
      return async () => {
        // 只在还是自己那一版时才还原，避免把别人的补丁一起抹掉。
        if (connectionService.admitConnection === patchedAdmit) {
          connectionService.admitConnection = originalAdmit;
        }
        const owned = guestPeer;
        guestPeer = undefined;
        if (owned !== undefined) {
          try { await owned.dispose(); } catch { /* 已经关了就算了 */ }
        }
      };
    }, 'admin-gate: WebSocket 升级闸门');

    // ---- 5b. 访客的流按名单筛 -----------------------------------------
    //
    // 只有访客 Peer 上的流要过名单；管理员和 /connect 出来的 API operator
    // 一概照旧。`$events` 是前端刷新用的事件通道，不是业务端点，放行。
    const gateway = ctx.get('typertGateway');
    if (gateway !== undefined && typeof gateway.openWireStream === 'function') {
      const originalOpen = gateway.openWireStream;
      const patchedOpen = async function openWireStream(endpoint, payload, uplink, peer, signal, control, uplinkWindow) {
        if (guestPeer !== undefined && peer === guestPeer && endpoint !== '$events') {
          const state = await loadState();
          if (!guestAllows(state.guest.endpoints, endpoint)) {
            throw new Error(`访客模式不允许打开 ${endpoint}`);
          }
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
  }

  // ---- 6. 页面一进来先看门开着没有 ------------------------------------
  //
  // 只做「导航」这一件事：没通过就整页换到闸门页。真正的拒绝在 /api 那边，
  // 所以就算这段脚本被绕过，也进不到数据。
  ctx.on('webserver/index-inject', (table) => {
    table.push({
      kind: 'script',
      placement: 'head',
      text: `(function(){try{fetch('${ROUTE}/api/state',{credentials:'same-origin'}).then(function(r){return r.json()}).then(function(s){if(!s.entered)location.replace('${ROUTE}')}).catch(function(){location.replace('${ROUTE}')})}catch(e){location.replace('${ROUTE}')}})();`,
    });
  });

  ctx.effect(() => () => {
    sessions.clear();
    guestAgents.clear();
  }, 'admin-gate: 会话清理');

  // 定期清掉过期会话，避免 token 表只增不减。
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [token, entry] of sessions) {
      if (now - entry.lastSeen > SESSION_TTL_MS) sessions.delete(token);
    }
  }, 60 * 60 * 1000);
  ctx.effect(() => () => clearInterval(timer), 'admin-gate: 会话过期清理');
}
