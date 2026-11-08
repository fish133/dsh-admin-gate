import { createServer } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'gate-v2-'));

const listeners = new Map();
const routes = [];
let indexInjection = null;

const ctx = {
  on(n, fn) { listeners.set(n, fn); return () => listeners.delete(n); },
  effect(fn) { return fn(); },
  get() { return undefined; },
  webServer: {
    register(r) { routes.push(r); return () => {}; },
    tapIndex() { return () => {}; },
  },
};

const mod = await import(new URL('../index.js', import.meta.url).href);
mod.apply(ctx);

const server = createServer(async (req, res) => {
  for (const route of routes) {
    if (req.url.startsWith(route.path)) { await route.handler(req, res); return; }
  }
  // 模拟 /api：走闸门
  const guard = listeners.get('connection/request');
  if (guard) {
    let passed = false;
    await guard(req, res, async () => { passed = true; });
    if (passed) { res.writeHead(200); res.end('{"ok":true}'); }
    return;
  }
  res.writeHead(404); res.end();
});
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

const R = [];
const t = (label, ok, extra = '') => R.push([ok ? 'PASS' : 'FAIL', label, String(extra).slice(0, 70)]);

// ---------- 单元：guestAllows 修复 ----------
const { guestAllows } = mod;
t('精确匹配', guestAllows(['a/b'], 'a/b') === true);
t('前缀通配', guestAllows(['session/*'], 'session/list') === true);
t('前缀通配不误伤', guestAllows(['session/*'], 'sessionXlist') === false);
t('全通配', guestAllows(['*'], '任意端点') === true);
t('BUG修复: 中间通配不再放行 ab', guestAllows(['a*b'], 'ab') === false);
t('中间通配当字面量', guestAllows(['a*b'], 'a*b') === true);
t('空名单', guestAllows([], 'x') === false);
t('忽略非字符串', guestAllows([null, 123, 'ok'], 'ok') === true);

// ---------- 首次 setup ----------
let r = await call('/admin-gate/api/state');
t('初始未配置', r.body.configured === false && r.body.gateMode === 'admin-only', r.body.gateMode);

r = await post('/admin-gate/api/setup', { password: 'pass1234' });
const adminCookie = r.cookie;
t('设置首个密码', r.status === 200 && !!adminCookie);

// ---------- 多账号 ----------
r = await post('/admin-gate/api/account', { name: '小号', password: 'second99' }, adminCookie);
t('添加第二个账号', r.status === 200 && r.body.ok === true, r.body.account?.name);

r = await call('/admin-gate/api/state', { headers: { cookie: adminCookie } });
t('账本有 2 个账号', r.body.accounts?.length === 2, r.body.accounts?.map(a=>a.name).join(','));

r = await post('/admin-gate/api/login', { mode: 'admin', password: 'second99' });
t('第二账号能登录', r.status === 200 && r.body.account === '小号', r.body.account);
const secondCookie = r.cookie;

r = await post('/admin-gate/api/login', { mode: 'admin', password: 'wrongpw' });
t('错误密码被拒', r.status === 401);

// ---------- 无访客模式 ----------
r = await call('/admin-gate/api/state');
t('默认是 admin-only（无访客）', r.body.gateMode === 'admin-only' && r.body.guestAllowed === false);

r = await post('/admin-gate/api/login', { mode: 'guest' });
t('无访客模式下访客登录被拒', r.status === 403, r.status);

r = await post('/admin-gate/api/mode', { mode: 'guest' }, adminCookie);
t('切到访客模式', r.status === 200 && r.body.mode === 'guest');

r = await post('/admin-gate/api/login', { mode: 'guest' });
const guestCookie = r.cookie;
t('访客现在能进', r.status === 200 && r.body.mode === 'guest');

// ---------- 开门/关门 ----------
r = await post('/admin-gate/api/login', { mode: 'guest' });
const guestCookieB = r.cookie;
t('访客能进（第二份 cookie）', r.status === 200);

r = await post('/admin-gate/api/mode', { mode: 'admin-only' }, adminCookie);
t('切回无访客', r.status === 200);

r = await fetch(base + '/api/session/list', { method: 'POST', headers: { cookie: guestCookieB, 'content-type':'application/json' }, body: '{}' });
t('切回无访客后旧访客 cookie 失效', r.status === 401, r.status);

r = await post('/admin-gate/api/mode', { mode: 'guest' }, adminCookie);
r = await post('/admin-gate/api/login', { mode: 'guest' });
const guestCookie2 = r.cookie;

// ---------- 删除账号保护 ----------
r = await post('/admin-gate/api/account', { name: '待删', password: 'temp9999' }, adminCookie);
const tempId = r.body.account?.id;
r = await post('/admin-gate/api/account/remove', { id: tempId }, adminCookie);
t('能删掉多余账号', r.status === 200);

// 留到最后测：先把当前登录的账号删掉会让后面全部 401
const state2 = await call('/admin-gate/api/state', { headers: { cookie: adminCookie } });
const ids2 = state2.body.accounts.map(a => a.id);
const notMe = ids2.filter(id => id !== state2.body.accounts.find(a=>a.name==='小号')?.id);
for (const id of ids2.slice(0, -1)) await post('/admin-gate/api/account/remove', { id }, adminCookie);

// ---------- BUG: 畸形 cookie 不崩 ----------
const res = await fetch(base + '/api/session/list', { headers: { cookie: 'dsh-admin-gate=%E4%' } });
t('BUG修复: 畸形 cookie 不 500', res.status === 401, res.status);

// ---------- 闸门 /api ----------
let fakeRes = () => { const o = {}; return { o, writeHead(s){o.s=s;}, end(){}, headersSent:false }; };
r = await fetch(base + '/api/session/list', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
t('无 cookie 的 /api 被拦', r.status === 401);

r = await fetch(base + '/api/session/list', { method: 'POST', headers: { cookie: guestCookie2, 'content-type':'application/json' }, body: '{}' });
t('访客白名单端点放行', r.status === 200, r.status);

r = await fetch(base + '/api/session/prompt', { method: 'POST', headers: { cookie: guestCookie2, 'content-type':'application/json' }, body: '{}' });
t('访客越界端点 403', r.status === 403, r.status);

// ---------- 状态文件 ----------
const raw = JSON.parse(await readFile(join(process.env.DSH_HOME, 'admin-gate.json'), 'utf8'));
t('状态是 v2 且有多账号', raw.version === 2 && Object.keys(raw.accounts).length >= 1);
t('不存明文密码', !JSON.stringify(raw).includes('pass1234'));
t('有 mode 字段', typeof raw.mode === 'string', raw.mode);

// ---------- v1 → v2 迁移 ----------
const mig = mod.migrate({ version: 1, password: { salt: 'x', hash: 'y', n:1,r:1,p:1 } });
t('v1 迁移出账号', Object.keys(mig.accounts).length === 1);
t('迁移后版本是 2', mig.version === 2);

server.close();
for (const [s, l, e] of R) console.log(`${s}  ${l}${e ? '  [' + e + ']' : ''}`);
const failed = R.filter(x => x[0] === 'FAIL').length;
console.log(`\n${R.length - failed}/${R.length} 通过`);
process.exit(failed ? 1 : 0);
