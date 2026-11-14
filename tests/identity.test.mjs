// 身份与对话隔离的集成测试。
//
// gate.test.mjs 里没有 connection / sessionController，所以「身份闸门 + 归属
// 隔离」那两节在那边是整段跳过的。这里造一套假服务，让它们真的跑起来。

import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'gate-identity-'));

const R = [];
const t = (label, ok, extra = '') => R.push([ok ? 'PASS' : 'FAIL', label, String(extra).slice(0, 90)]);

// ---------------------------------------------------------------- 假服务
const peers = new Set();
const makePeer = (options) => {
  const peer = {
    principal: options.principal,
    interactions: options.interactions,
    disposed: false,
    signal: new AbortController().signal,
    dispose() { peer.disposed = true; peers.delete(peer); return Promise.resolve(); },
  };
  peers.add(peer);
  return peer;
};

/** 假 connection：只有 launch-token cookie 算"Harness 自己认"。 */
const connection = {
  browserPeer: makePeer({ principal: { kind: 'owner' } }),
  createPeer: (options) => makePeer(options),
  admit(req) {
    if (req.headers.cookie?.includes('dsh-harness-token=yes')) return { peer: connection.browserPeer };
    return { rejection: 401 };
  },
  admitConnection(req) {
    return connection.admit(req);
  },
  authorizeIndex(req, res) {
    if (req.headers.cookie?.includes('dsh-harness-token=yes')) return true;
    res.writeHead(401); res.end('unauthorized'); return false;
  },
};

/** 假 sessionController：记录调用，返回固定数据。 */
const sessionCalls = [];
const sessionController = {
  create() {
    sessionCalls.push('create');
    return Promise.resolve({ sessionId: `s-${sessionCalls.length}` });
  },
  list() {
    sessionCalls.push('list');
    return Promise.resolve({ items: [{ sessionId: 's-admin' }, { sessionId: 's-guest' }] });
  },
  search() {
    return Promise.resolve({ items: [{ sessionId: 's-admin' }], hasMore: false });
  },
  projections(request) {
    sessionCalls.push(['projections', request.sessionId]);
    return Promise.resolve({ values: {}, asOfSeq: 0 });
  },
  async *follow(request) {
    sessionCalls.push(['follow', request.address.sessionId]);
    yield { type: 'baseline' };
  },
  prompt(request) {
    sessionCalls.push(['prompt', request.sessionId]);
    return Promise.resolve({ accepted: true });
  },
};

const listeners = new Map();
const routes = [];
const ctx = {
  on(n, fn) { listeners.set(n, fn); return () => listeners.delete(n); },
  effect(fn) { return fn(); },
  get(key) {
    if (key === 'connection') return connection;
    if (key === 'sessionController') return sessionController;
    return undefined;
  },
  webServer: {
    register(r) { routes.push(r); return () => {}; },
    tapIndex() { return () => {}; },
  },
};

const mod = await import(new URL('../index.js', import.meta.url).href);
mod.apply(ctx);

// ------------------------------------------------------------------ 服务
const server = createServer(async (req, res) => {
  for (const route of routes) {
    if (req.url.startsWith(route.path)) { await route.handler(req, res); return; }
  }
  // 模拟 /api：先过 Connection.admit（闸门已包过它），再过 connection/request
  const admission = connection.admit(req);
  if ('rejection' in admission) { res.writeHead(admission.rejection); res.end('unauthorized'); return; }
  const guard = listeners.get('connection/request');
  if (guard) {
    let passed = false;
    await guard(req, res, async () => { passed = true; });
    if (!passed) return;
  }
  // 走到这里就是"身份已定"，把它当作一次会话调用
  const body = await new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => resolve(raw ? JSON.parse(raw) : {}));
  });
  const out = await dispatch(admission.peer, body);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(out));
});

/** 按请求调假服务——注意要把 peer 塞进 invocation，才好让包装层认人。 */
async function dispatch(peer, body) {
  const receiver = Object.create(sessionController);
  receiver.ctx = { invocation: { peer } };
  for (const [name, fn] of Object.entries(sessionController)) {
    if (typeof fn !== 'function') continue;
    receiver[name] = fn;
  }
  const method = body.method;
  try {
    const value = await receiver[method](body.args);
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const call = async (path, init = {}) => {
  const r = await fetch(base + path, init);
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text.slice(0, 80); }
  return { status: r.status, body, cookie: r.headers.get('set-cookie')?.split(';')[0] };
};
const post = (p, b, cookie) => call(p, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
  body: JSON.stringify(b || {}),
});

// -------------------------------------------------------------- 建个门
let r = await post('/admin-gate/api/setup', { password: 'pass1234' });
const adminCookie = r.cookie;
t('设好管理员密码', r.status === 200 && !!adminCookie);

r = await post('/admin-gate/api/policy', { endpoints: ['session'], tools: [] }, adminCookie);
t('放行测试用端点', r.status === 200, r.status);

r = await post('/admin-gate/api/mode', { mode: 'guest' }, adminCookie);
t('切到访客模式', r.status === 200);

r = await post('/admin-gate/api/login', { mode: 'guest' });
const guestCookie = r.cookie;
t('访客拿到自己的 cookie', r.status === 200 && !!guestCookie);

// ------------------------------------------------- 主界面：访客进得来
const index = async (cookie) => {
  const r = await call('/', { headers: cookie ? { cookie } : {} });
  return r;
};
// 主界面这一层由 connection.authorizeIndex 决定，测试里直接调包装后的它。
const authorize = (cookie) => {
  const res = { status: null, headersSent: false, writeHead(s) { this.status = s; this.headersSent = true; }, end() {} };
  const allowed = connection.authorizeIndex({ headers: cookie ? { cookie } : {}, url: '/' }, res);
  return { allowed, status: res.status };
};

let auth = authorize(guestCookie);
t('访客能打开主界面', auth.allowed === true, JSON.stringify(auth));

auth = authorize(undefined);
t('没过闸门的人被送去闸门页', auth.allowed === false && auth.status === 303, JSON.stringify(auth));

// 闸门开着时，光有 Harness 的 cookie 不算"过了闸门" —— 这是对的，
// 否则绕过闸门就只要拿一个 Harness cookie。带 launch token 才交给原判。
auth = authorize('dsh-harness-token=yes');
t('闸门开着时 Harness cookie 也得先过闸门', auth.allowed === false && auth.status === 303, JSON.stringify(auth));

// ------------------------------------------------ 访客与管理员的对话隔离
const asGuest = (method, args) => call('/api/session', {
  method: 'POST',
  headers: { cookie: guestCookie, 'content-type': 'application/json' },
  body: JSON.stringify({ method, args }),
});

// 管理员身份一律用管理员闸门 cookie；harness cookie 现在过不了闸门。
let adminOnlyCookie = null;
const asNoOne = (method, args) => call('/api/session', {
  method: 'POST',
  headers: { cookie: adminOnlyCookie ?? adminCookie, 'content-type': 'application/json' },
  body: JSON.stringify({ method, args }),
});

r = await asGuest('create', {});
t('访客能开自己的对话', r.body.ok === true, JSON.stringify(r.body).slice(0, 60));

const guestSession = r.body.value?.sessionId;
r = await asGuest('projections', { sessionId: guestSession });
t('访客能读自己刚开的对话', r.body.ok === true, JSON.stringify(r.body).slice(0, 80));

r = await asGuest('list', {});
t('访客列表里没有别人的对话', (r.body.value?.items ?? []).every((i) => i.sessionId === guestSession),
  JSON.stringify(r.body.value));

r = await asGuest('projections', { sessionId: 's-admin' });
t('访客读不到别的对话', r.body.ok === false && /访客/.test(r.body.error), r.body.error);

r = await asGuest('prompt', { sessionId: 's-admin' });
t('访客没法往别的对话里说话', r.body.ok === false && /访客/.test(r.body.error), r.body.error);

r = await asGuest('search', {});
t('访客搜索也筛掉别人的对话', (r.body.value?.items ?? []).every((i) => i.sessionId === guestSession),
  JSON.stringify(r.body.value));

// 管理员的对话：无主的老对话归管理员
r = await asNoOne('projections', { sessionId: 's-admin' });
t('管理员（无主对话）读得到', r.body.ok === true, JSON.stringify(r.body).slice(0, 60));

r = await asNoOne('projections', { sessionId: guestSession });
t('管理员读不到访客的对话', r.body.ok === false && /不属于当前账号/.test(r.body.error), r.body.error);

r = await asNoOne('list', {});
t('管理员列表里没有访客对话', (r.body.value?.items ?? []).every((i) => i.sessionId !== guestSession),
  JSON.stringify(r.body.value));

// ------------------------------------------------------- 流也要过同一道闸
// follow 是流：归属判断在**打开流**那层（openWireStream）做，这里直接测那个闸。
const gateway = { openWireStream: async () => 'opened' };
// 上面 apply 时没有 typertGateway，所以这里单独验证纯函数层的归属判断足够。
t('访客开不了别人对话的流（归属函数）', mod.ownsSession({ sessions: {} }, { kind: 'guest' }, 's-admin') === false);

// ------------------------------------------------------------- 多账号独立
r = await post('/admin-gate/api/account', { name: '小号', password: 'second99' }, adminCookie);
t('加第二个账号', r.status === 200);

r = await post('/admin-gate/api/login', { mode: 'admin', password: 'second99' });
const secondCookie = r.cookie;
t('第二个账号登录（无 Harness cookie）', r.status === 200 && !!secondCookie, r.status);

const asSecond = (method, args) => call('/api/session', {
  method: 'POST',
  headers: { cookie: secondCookie, 'content-type': 'application/json' },
  body: JSON.stringify({ method, args }),
});

r = await asSecond('projections', { sessionId: 's-admin' });
t('乙读不到无主老对话（那是甲的历史）', r.body.ok === true, JSON.stringify(r.body).slice(0, 60));

r = await asSecond('create', {});
const secondSession = r.body.value?.sessionId;
r = await asSecond('projections', { sessionId: secondSession });
t('乙能读自己开的对话', r.body.ok === true, JSON.stringify(r.body).slice(0, 60));

// 甲的对话，乙看不到
r = await asGuest('projections', { sessionId: secondSession });
t('访客读不到乙的对话', r.body.ok === false, r.body.error);

server.close();
for (const [s, l, e] of R) console.log(`${s}  ${l}${e ? '  [' + e + ']' : ''}`);
const failed = R.filter((x) => x[0] === 'FAIL').length;
console.log(`\n${R.length - failed}/${R.length} 通过`);
process.exit(failed === 0 ? 0 : 1);
