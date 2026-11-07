/**
 * 管理员密码（admin-gate）—— 浏览器半边
 *
 * 只做一件事：在「设置」里挂一页「管理员密码」，让主人随时改密码、调访客名单。
 * 闸门本身的判定全在 host 那边（index.js），这里只是它的控制面板 ——
 * 页面藏起来挡不住谁，反过来面板没了也照样拦人。
 *
 * 手写 React.createElement，不跑构建；配色只用 --dsw-alias-* 语义变量，
 * 浅色/深色跟着宿主走。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-admin-gate',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'admin-gate';
    const API = '/admin-gate/api';

    const zh = {
      nav: '管理员密码',
      blurb: '进入 Harness 前先过这道门：管理员输密码，访客按名单放行。',
      set: '已设置密码',
      unset: '还没设置密码',
      asAdmin: '当前身份：管理员',
      asGuest: '当前身份：访客 —— 这一页改不了任何东西',
      asNone: '当前还没过闸门',
      stateFile: '状态文件',
      passwordTitle: '改密码',
      current: '当前密码',
      next: '新密码（至少 4 位）',
      savePassword: '改密码',
      logout: '退出闸门（下次要重新输密码）',
      saved: '密码已更新。',
      guestTitle: '访客能拿到什么',
      guestHint: '一行一个。接口是 /api 端点名，工具是 agent 能调的工具名。',
      endpoints: '放行的接口',
      tools: '放行的工具',
      savePolicy: '保存名单',
      resetPolicy: '恢复默认名单',
      policyReset: '已恢复默认名单。',
      customized: '当前是自定义名单：插件升级不会再自动补端点。',
      notCustomized: '当前是默认名单：插件升级会自动补上新端点。',
      policySaved: '访客名单已保存。',
      adminOnly: '只有管理员能改。',
      unreachable: '读不到闸门状态。',
    };
    const en = {
      nav: 'Admin Password',
      blurb: 'A gate before Harness: admins enter with a password, guests get an allowlist.',
      set: 'Password is set',
      unset: 'No password yet',
      asAdmin: 'Signed in as admin',
      asGuest: 'Signed in as guest — this page cannot change anything',
      asNone: 'Not through the gate yet',
      stateFile: 'State file',
      passwordTitle: 'Change password',
      current: 'Current password',
      next: 'New password (4+ characters)',
      savePassword: 'Change password',
      logout: 'Leave the gate (password required again)',
      saved: 'Password updated.',
      guestTitle: 'What guests get',
      guestHint: 'One per line. Endpoints are /api names; tools are agent tool names.',
      endpoints: 'Allowed endpoints',
      tools: 'Allowed tools',
      savePolicy: 'Save allowlist',
      resetPolicy: 'Restore defaults',
      policyReset: 'Default allowlist restored.',
      customized: 'Custom allowlist: upgrades will not add endpoints.',
      notCustomized: 'Default allowlist: upgrades add new endpoints automatically.',
      policySaved: 'Guest allowlist saved.',
      adminOnly: 'Admins only.',
      unreachable: 'Cannot read the gate state.',
    };

    const S = {
      root: { display: 'flex', flexDirection: 'column', gap: 14, padding: '4px 0 24px' },
      blurb: { margin: 0, color: 'var(--dsw-alias-label-secondary)', fontSize: 13, lineHeight: 1.6 },
      card: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 12,
        background: 'var(--dsw-alias-bg-layer-1)',
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      },
      heading: { margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      label: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', display: 'block', marginBottom: 6 },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '9px 12px',
        borderRadius: 9,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        fontSize: 13,
      },
      textarea: {
        width: '100%',
        boxSizing: 'border-box',
        minHeight: 96,
        padding: '9px 12px',
        borderRadius: 9,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 12,
        resize: 'vertical',
      },
      button: {
        padding: '8px 14px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        fontSize: 13,
        cursor: 'pointer',
      },
      primary: {
        padding: '9px 16px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-brand-primary)',
        background: 'var(--dsw-alias-brand-primary)',
        color: '#fff',
        font: 'inherit',
        fontSize: 13,
        fontWeight: 600,
        cursor: 'pointer',
      },
      disabled: { opacity: 0.5, cursor: 'default' },
      row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      badge: (ok) => ({
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 999,
        fontSize: 12,
        color: ok ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-warn-primary)',
        border: `1px solid ${ok ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-warn-primary)'}`,
      }),
      note: (tone) => ({
        margin: 0,
        fontSize: 12,
        minHeight: 18,
        color: tone === 'error'
          ? 'var(--dsw-alias-state-error-primary)'
          : 'var(--dsw-alias-state-success-primary)',
      }),
      muted: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', margin: 0 },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 },
    };

    function request(path, init) {
      return fetch(`${API}/${path}`, {
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        ...init,
      }).then(async (response) => {
        let body = {};
        try {
          body = await response.json();
        } catch {
          body = { ok: false, error: `HTTP ${response.status}` };
        }
        return { ok: response.ok && body.ok !== false, body };
      });
    }

    function createSection(t) {
      return function AdminGateSection() {
        const [state, setState] = React.useState(null);
        const [current, setCurrent] = React.useState('');
        const [next, setNext] = React.useState('');
        const [endpoints, setEndpoints] = React.useState('');
        const [tools, setTools] = React.useState('');
        const [message, setMessage] = React.useState(null);

        const reload = React.useCallback(() => {
          request('state')
            .then(({ body }) => {
              setState(body);
              if (Array.isArray(body.guest?.endpoints)) setEndpoints(body.guest.endpoints.join('\n'));
              if (Array.isArray(body.guest?.tools)) setTools(body.guest.tools.join('\n'));
            })
            .catch(() => setState({ entered: false, failed: true }));
        }, []);

        React.useEffect(() => { reload(); }, [reload]);

        const isAdmin = state?.isAdmin === true;
        const configured = state?.configured === true;
        const identity = state === null
          ? ''
          : state.mode === 'admin' ? t('asAdmin')
            : state.mode === 'guest' ? t('asGuest')
              : t('asNone');

        const savePassword = () => {
          setMessage(null);
          request('password', { method: 'POST', body: JSON.stringify({ current, next }) })
            .then(({ ok, body }) => {
              if (!ok) {
                setMessage({ tone: 'error', text: body.error || t('adminOnly') });
                return;
              }
              setCurrent('');
              setNext('');
              setMessage({ tone: 'ok', text: t('saved') });
              reload();
            })
            .catch((error) => setMessage({ tone: 'error', text: String(error) }));
        };

        const savePolicy = () => {
          setMessage(null);
          const split = (value) => value.split('\n').map((line) => line.trim()).filter(Boolean);
          request('policy', {
            method: 'POST',
            body: JSON.stringify({ endpoints: split(endpoints), tools: split(tools) }),
          })
            .then(({ ok, body }) => {
              if (!ok) {
                setMessage({ tone: 'error', text: body.error || t('adminOnly') });
                return;
              }
              setMessage({ tone: 'ok', text: t('policySaved') });
              reload();
            })
            .catch((error) => setMessage({ tone: 'error', text: String(error) }));
        };

        const resetPolicy = () => {
          setMessage(null);
          request('policy/reset', { method: 'POST', body: '{}' })
            .then(({ ok, body }) => {
              if (!ok) {
                setMessage({ tone: 'error', text: body.error || t('adminOnly') });
                return;
              }
              setMessage({ tone: 'ok', text: t('policyReset') });
              reload();
            })
            .catch((error) => setMessage({ tone: 'error', text: String(error) }));
        };

        const logout = () => {
          request('logout', { method: 'POST', body: '{}' }).then(() => reload());
        };

        const disabled = !isAdmin;
        const button = (label, onClick, primary) => h('button', {
          type: 'button',
          onClick,
          style: { ...(primary ? S.primary : S.button), ...(disabled ? S.disabled : {}) },
          disabled,
        }, label);

        return h('div', { style: S.root },
          h('p', { style: S.blurb }, t('blurb')),
          h('div', { style: S.card },
            h('div', { style: S.row },
              h('span', { style: S.badge(configured) }, configured ? t('set') : t('unset')),
              identity === '' ? null : h('span', { style: S.muted }, identity),
            ),
            state?.statePath
              ? h('p', { style: S.muted }, `${t('stateFile')}: `, h('code', { style: S.mono }, state.statePath))
              : null,
            state === null || !configured ? null : h('p', { style: S.muted },
              state.guestCustomized ? t('customized') : t('notCustomized')),
            state?.failed ? h('p', { style: S.note('error') }, t('unreachable')) : null,
          ),
          h('div', { style: S.card },
            h('h3', { style: S.heading }, t('passwordTitle')),
            h('div', null,
              h('label', { style: S.label, htmlFor: 'ag-current' }, t('current')),
              h('input', {
                id: 'ag-current', type: 'password', autoComplete: 'current-password',
                style: S.input, value: current, disabled,
                onChange: (event) => setCurrent(event.target.value),
              }),
            ),
            h('div', null,
              h('label', { style: S.label, htmlFor: 'ag-next' }, t('next')),
              h('input', {
                id: 'ag-next', type: 'password', autoComplete: 'new-password',
                style: S.input, value: next, disabled,
                onChange: (event) => setNext(event.target.value),
              }),
            ),
            h('div', { style: S.row },
              button(t('savePassword'), savePassword, true),
              h('button', { type: 'button', style: S.button, onClick: logout }, t('logout')),
            ),
          ),
          h('div', { style: S.card },
            h('h3', { style: S.heading }, t('guestTitle')),
            h('p', { style: S.muted }, t('guestHint')),
            h('div', null,
              h('label', { style: S.label, htmlFor: 'ag-eps' }, t('endpoints')),
              h('textarea', {
                id: 'ag-eps', style: S.textarea, spellCheck: false, value: endpoints, disabled,
                onChange: (event) => setEndpoints(event.target.value),
              }),
            ),
            h('div', null,
              h('label', { style: S.label, htmlFor: 'ag-tools' }, t('tools')),
              h('textarea', {
                id: 'ag-tools', style: S.textarea, spellCheck: false, value: tools, disabled,
                onChange: (event) => setTools(event.target.value),
              }),
            ),
            h('div', { style: S.row },
              button(t('savePolicy'), savePolicy, true),
              button(t('resetPolicy'), resetPolicy, false),
            ),
          ),
          message === null ? null : h('p', { style: S.note(message.tone) }, message.text),
        );
      };
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'admin-gate: 文案');
        const t = ctx.locale.bind(NS);
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'admin-gate',
          order: 34,
          label: () => ctx.locale.bind(NS)('nav'),
          locale: NS,
        }, createSection(t)));
      },
    };
  },
});
