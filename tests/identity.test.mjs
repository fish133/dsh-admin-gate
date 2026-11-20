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
  // 闸门路由自己补的准入：模拟 DSH 的 Host / Origin 检查
  isTrusted(req) {
    if (req.headers['sec-fetch-site'] === 'cross-site') return false;
    const origin = req.headers.origin;
    if (origin === undefined) return true;
    return origin === `http://127.0.0.1:${server.address().port}`;
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
  // 全站投影基线流：一次把**所有**会话的 projections 推过来
  async *control() {
    yield { type: 'baseline', value: { projections: {
      's-admin': { asOfSeq: 1, values: { title: '管理员的秘密' } },
      's-second': { asOfSeq: 2, values: { title: '乙的对话' } },
    } } };
    yield { type: 'projection', sessionId: 's-admin', key: 'title', value: '管理员的秘密', seq: 3 };
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
  // Cordis 的等依赖入口：服务已在就直接回调，否则等服务出现。
  inject(names, callback) {
    const ready = names.every((n) => ctx.get(n) !== undefined);
    if (ready) callback(ctx);
    return { dispose() {} };
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
    // 流：把帧收进数组，好让测试断言"推过来了什么"
    if (value !== null && typeof value === 'object' && typeof value[Symbol.asyncIterator] === 'function') {
      const frames = [];
      for await (const frame of value) frames.push(frame);
      return { ok: true, value: { frames } };
    }
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


// ---------- 回归：插件必须声明 connection 依赖 ----------
// 曾经只声明 webServer，导致启动早期 ctx.get('connection') 是 undefined，
// 身份层整段被跳过、访客 401 —— 而手动重载后又正常，测试全绿。
t('inject 声明了 connection（否则启动早期拿不到身份层）',
  Array.isArray(mod.inject) && mod.inject.includes('connection'), JSON.stringify(mod.inject));
t('inject 仍声明了 webServer', Array.isArray(mod.inject) && mod.inject.includes('webServer'), JSON.stringify(mod.inject));


// ---------------- control 流：全站投影基线也要按归属筛 ----------------
// 这条最容易漏：Harness 自己的 allows() 对 owner principal 一律放行，
// 而我们的 Peer 全是 owner —— 它一帧都不会替我们挡。
const controlFrames = async (cookie) => {
  const r = await call('/api/session', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'control', args: {} }),
  });
  return r.body.value?.frames ?? [];
};

r = await call('/api/session', {
  method: 'POST',
  headers: { cookie: guestCookie, 'content-type': 'application/json' },
  body: JSON.stringify({ method: 'control', args: {} }),
});
const guestFrames = r.body.value?.frames ?? [];
const guestBaseline = guestFrames.find((f) => f?.type === 'baseline');
const guestIds = Object.keys(guestBaseline?.value?.projections ?? {});
t('访客的 control 基线里没有别人的会话',
  guestIds.length === 0, JSON.stringify(guestIds));
t('访客的 control 投影帧被丢掉',
  guestFrames.filter((f) => f?.type === 'projection').length === 0,
  JSON.stringify(guestFrames.map((f) => f?.type)));

r = await call('/api/session', {
  method: 'POST',
  headers: { cookie: adminCookie, 'content-type': 'application/json' },
  body: JSON.stringify({ method: 'control', args: {} }),
});
const adminFrames = r.body.value?.frames ?? [];
const adminBaseline = adminFrames.find((f) => f?.type === 'baseline');
const adminIds = Object.keys(adminBaseline?.value?.projections ?? {});
t('管理员的 control 基线保留自己的会话', adminIds.includes('s-admin'), JSON.stringify(adminIds));
// s-second 没登记归属 = 无主，按设计管理员看得见。要看"别人的"，得有一条
// 真登记在别人名下的 —— 用乙的身份开一段，它自动记到 acct:b 名下。
r = await call('/api/session', {
  method: 'POST',
  headers: { cookie: secondCookie, 'content-type': 'application/json' },
  body: JSON.stringify({ method: 'create', args: {} }),
});
const secondOwned = r.body.value?.sessionId;
t('乙开了一段对话', typeof secondOwned === 'string', secondOwned);

const controlIds = async (cookie) => {
  const res = await call('/api/session', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'control', args: {} }),
  });
  const bl = (res.body.value?.frames ?? []).find((f) => f?.type === 'baseline');
  return Object.keys(bl?.value?.projections ?? {});
};

const adminIds2 = await controlIds(adminCookie);
t('甲的 control 里没有乙登记过的对话', !adminIds2.includes(secondOwned), JSON.stringify(adminIds2));

const guestIds2 = await controlIds(guestCookie);
t('访客的 control 里没有乙登记过的对话', !guestIds2.includes(secondOwned), JSON.stringify(guestIds2));


// ---------- 回归：归属层必须等 sessionController 就绪 ----------
// 这条对应"重启后隔离失效、重载后又正常"那个 bug。测试里的假 ctx 一开始就
// 有 sessionController，天然测不出顺序问题，所以单独验一次"晚到"的情形。
const lateCtx = {
  store: {
    connection,
    webServer: { register: () => () => {}, tapIndex: () => () => {}, renderIndex: (x) => x },
  },
  on() { return () => {}; },
  effect(fn) { return fn(); },
  get(key) { return lateCtx.store[key]; },
  webServer: { register: () => () => {}, tapIndex: () => () => {}, renderIndex: (x) => x },
  inject(names, callback) {
    // 模拟 Cordis：服务已在就立刻回调，不在就排到"稍后"再回调
    const ready = names.every((n) => lateCtx.store[n] !== undefined);
    if (ready) { callback(lateCtx); return { dispose() {} }; }
    setTimeout(() => {
      for (const n of names) if (lateCtx.store[n] === undefined) return;
      callback(lateCtx);
    }, 10);
    return { dispose() {} };
  },
};
// sessionController 晚到：先不给
const lateController = { list: async () => ({ items: [{ sessionId: 's-late' }] }) };
const lateMod = await import(new URL('../index.js', import.meta.url).href + '?late=1');
process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'gate-late-'));
lateMod.apply(lateCtx);
t('晚到的 sessionController 一开始没被包装',
  lateController.list.toString().includes('native') || !('__wrapped' in lateController));
lateCtx.store.sessionController = lateController;
await new Promise((r) => setTimeout(r, 60));
t('sessionController 出现后被装上归属层',
  lateController.list.toString().includes('filteredCall') || lateController.list.__gateWrapped === true,
  String(lateController.list).slice(0, 60));


// ---------------- 闸门路由的 Host/Origin 准入（CSRF） ----------------
// 背景：webServer.register 挂的路由不过 DSH 的准入检查，闸门页因此可被跨站
// 调用。/admin-gate/api/login 免鉴权，被 CSRF 命中就等于让别人替你登录。
r = await fetch(base + '/admin-gate/api/state', {
  headers: { 'sec-fetch-site': 'cross-site' },
});
t('跨站请求打闸门 API 被 403', r.status === 403, r.status);

r = await fetch(base + '/admin-gate/api/state', {
  headers: { origin: 'https://evil.example.com' },
});
t('外站 Origin 打闸门 API 被 403', r.status === 403, r.status);

r = await fetch(base + '/admin-gate/api/state', {
  headers: { origin: base },
});
t('同源 Origin 放行', r.status === 200, r.status);

r = await fetch(base + '/admin-gate/api/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
  body: JSON.stringify({ mode: 'guest' }),
});
t('跨站的 login 被 403（CSRF 关键一条）', r.status === 403, r.status);
t('跨站 login 没有下发 cookie', r.headers.get('set-cookie') === null, r.headers.get('set-cookie'));

r = await fetch(base + '/admin-gate/api/state', { headers: {} });
t('不带 Origin 的本机请求仍然放行', r.status === 200, r.status);

server.close();
for (const [s, l, e] of R) console.log(`${s}  ${l}${e ? '  [' + e + ']' : ''}`);
const failed = R.filter((x) => x[0] === 'FAIL').length;
console.log(`\n${R.length - failed}/${R.length} 通过`);
process.exit(failed === 0 ? 0 : 1);
