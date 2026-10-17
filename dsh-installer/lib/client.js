window.__ModuleLoader__.load({
  id: 'dsh-installer',
  factory: require => {
    const React = require('react');
    const h = React.createElement;
    const NS = 'settings.betterdshInstaller';
    const dicts = { zh: { title: 'betterDSH 安装向导' }, en: { title: 'betterDSH installer' } };
    const labels = { install: '安装并启用', enable: '启用已安装插件', skip: '已启用，跳过', applied: '已应用', 'restart-required': '已保存，需重启', failed: '失败', skipped: '已启用，跳过', completed: '安装完成', running: '安装中', stopped: '已停止' };
    const C = { text: 'var(--dsw-alias-label-primary, inherit)', border: 'var(--dsw-alias-border-l1, rgba(128,128,128,.25))', layer: 'var(--dsw-alias-bg-layer-1, rgba(128,128,128,.06))', primaryLayer: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,.14))', error: 'var(--dsw-alias-state-error-primary, #b74141)' };
    async function api(route, body) {
      const response = await fetch('api/betterdsh.' + route, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.code || 'request-failed');
      return data;
    }
    const ERROR_HELP = {
      'absolute-repository-path-required': ['需要绝对路径', '请填写克隆后 betterDSH 的完整目录，而不是某个插件子目录。'],
      'source-unavailable': ['找不到插件源码', '检查仓库路径及插件目录是否存在，然后重新检查安装状态。'],
      'source-outside-repository': ['源码目录越过仓库边界', '请使用仓库内的真实插件目录，不要链接到仓库外。'],
      'invalid-bundle': ['插件声明不完整', '请重新下载可信仓库副本，然后检查安装状态。'],
      'bundle-problem': ['已有插件配置异常', '请先在原生插件管理器中处理加载或兼容性问题，再返回向导。'],
      'plan-expired': ['安装计划已过期', '请返回选择，重新预览安装计划后再确认。'],
      'source-changed-replan': ['源码在预览后发生变化', '重新检查状态并预览新计划；旧计划不会继续安装。'],
      'installation-busy': ['另一批安装仍在运行', '等待当前批次完成。关闭页面不会取消安装。'],
      'incompatible-version': ['插件与当前 DSH 不兼容', '请在原生插件管理器查看版本要求；向导不会自动忽略兼容性检查。'],
      'build-approval-required': ['依赖需要构建批准', '请在原生插件管理器核对待构建依赖后处理，向导不会自动批准。'],
      'plugin-manager-unavailable': ['官方插件管理器不可用', '先启用 DSH 插件管理服务或重启 DSH，然后重试。'],
      'overridden': ['配置被更高优先级覆盖', '请在原生插件管理器检查 profile 或 launcher 覆盖项。'],
      'installation-failed': ['安装未完成', '检查原生插件管理器的诊断信息，再重新检查状态并预览。已成功的插件保留。'],
    };
    function errorInfo(code) { const copy = ERROR_HELP[code]; return copy ? { title: copy[0], recovery: copy[1] } : { title: '操作未完成', recovery: '检查网络与官方插件管理器后重试；不会将原始诊断或凭据显示在页面中。' }; }
    function canInstall(data, selected) { return data?.capable === true && selected.length > 0 && !selected.some(name => !data.plugins.some(p => p.name === name && !p.problem && (p.installed || p.available))) && data.job?.state !== 'running'; }
    function Panel() {
      const [data, setData] = React.useState(null);
      const [root, setRoot] = React.useState('');
      const [selected, setSelected] = React.useState([]);
      const [plan, setPlan] = React.useState(null);
      const [job, setJob] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');
      const alive = React.useRef(true);
      const action = React.useRef(null);
      React.useEffect(() => { alive.current = true; return () => { alive.current = false; action.current = null; }; }, []);
      // A ref lock closes the gap before disabled controls rerender, while a
      // per-operation token rejects responses from a cleaned-up effect lifetime.
      function begin(kind) {
        if (action.current) return null;
        const token = {}; action.current = token; setBusy(kind); setError('');
        return token;
      }
      const current = token => alive.current && action.current === token;
      function end(token) { if (current(token)) { action.current = null; setBusy(false); } }
      async function refresh() {
        const token = begin('checking'); if (!token) return;
        setPlan(null);
        try {
          const next = await api('status' + (root ? '?root=' + encodeURIComponent(root) : ''));
          if (!current(token)) return;
          setData(next); setRoot(next.root); setJob(next.job);
          setSelected(previous => previous.filter(name => next.plugins.some(p => p.name === name && !p.problem && (p.available || p.installed))));
        } catch (e) { if (current(token)) setError(e.message); }
        finally { end(token); }
      }
      React.useEffect(() => { refresh(); }, []);
      React.useEffect(() => {
        if (job?.state !== 'running') return;
        let stopped = false;
        let timer;
        async function poll() {
          try {
            const next = await api('job');
            if (stopped) return;
            if (next.job?.state !== 'running') {
              // Read final status before publishing terminal job state: otherwise
              // that state change cleans up this effect and discards the status.
              try {
                const status = await api('status?root=' + encodeURIComponent(root));
                if (!stopped) { setData(status); setJob(next.job); }
              } catch (e) { if (!stopped) { setJob(next.job); setData(previous => previous ? { ...previous, job: next.job } : previous); setError(e.message); } }
              return;
            }
            setJob(next.job);
          } catch (e) { if (!stopped) setError(e.message); }
          if (!stopped) timer = setTimeout(poll, 1200);
        }
        timer = setTimeout(poll, 600);
        return () => { stopped = true; clearTimeout(timer); };
      }, [job?.id, job?.state, root]);
      async function preview() {
        const token = begin('planning'); if (!token) return;
        try { const next = await api('plan', { root, names: selected }); if (current(token)) setPlan(next); }
        catch (e) { if (current(token)) setError(e.message); }
        finally { end(token); }
      }
      async function confirm() {
        if (!plan) return;
        const token = begin('installing'); if (!token) return;
        try { const next = await api('install', { planId: plan.id, confirm: true }); if (current(token)) { setJob(next.job); setPlan(null); } }
        catch (e) { if (current(token)) { setError(e.message); if (e.message === 'plan-expired' || e.message === 'source-changed-replan') setPlan(null); } }
        finally { end(token); }
      }
      const running = job?.state === 'running';
      const button = (text, onClick, disabled, key) => h('button', { key, type: 'button', onClick, disabled: !!disabled, style: { minHeight: 36, padding: '8px 12px', fontFamily: 'inherit', fontWeight: key === 'preview' || key === 'confirm' ? 600 : 400, borderRadius: 8, border: '1px solid ' + C.border, color: C.text, background: key === 'preview' || key === 'confirm' ? C.primaryLayer : C.layer, opacity: disabled ? .55 : 1, cursor: disabled ? 'default' : 'pointer' } }, text);
      return h('div', { 'aria-busy': !!busy || running, style: { display: 'flex', flexDirection: 'column', gap: 16, color: C.text, padding: 8 } },
        h('header', null, h('h2', null, 'betterDSH 安装向导'), h('p', null, '检查仓库 → 选择插件 → 确认安装 → 完成配置')),
        h('p', { style: { fontSize: 13, opacity: .8 } }, '从本地 betterDSH 仓库安装，使用 DSH 官方插件管理器。不自动下载仓库，不读取凭据，不自动重启。已有插件只启用或跳过，不覆盖更新。'),
        h('label', null, '① 本地 betterDSH 仓库路径', h('input', { 'aria-label': 'betterDSH 仓库路径', value: root, disabled: busy || running, onChange: e => { setRoot(e.target.value); setData(null); setPlan(null); setSelected([]); }, placeholder: '输入克隆后的仓库绝对路径', style: { display: 'block', boxSizing: 'border-box', width: '100%', marginTop: 8, padding: 10, border: '1px solid ' + C.border, borderRadius: 8, background: C.layer, color: C.text } })),
        button(busy === 'checking' ? '正在检查…' : '检查安装状态', refresh, !!busy || running, 'refresh'),
        busy ? h('p', { role: 'status' }, ({ checking: '正在检查源码与当前 profile…', planning: '正在生成只读安装计划…', installing: '正在提交确认，尚未启动的插件不会重复安装…' })[busy]) : null,
        error ? h('div', { role: 'alert', style: { color: C.error } }, h('strong', null, errorInfo(error).title), h('p', null, errorInfo(error).recovery)) : null,
        data && !data.capable ? h('div', { role: 'alert' }, '官方 pluginManager 服务不可用；无法安装，请先启用 DSH 插件管理服务。') : null,
        data ? h('section', null, h('h3', null, '② 选择插件'), button('选择全部可安装插件', () => { setSelected(data.plugins.filter(p => !p.enabled && !p.problem && (p.available || p.installed)).map(p => p.name)); setPlan(null); }, busy || running, 'all'),
          ...data.plugins.map(p => h('label', { key: p.name, style: { display: 'block', padding: 14, border: '1px solid ' + C.border, borderRadius: 10, marginTop: 10 } },
            h('input', { type: 'checkbox', checked: selected.includes(p.name), disabled: !!busy || running || !!p.problem || (!p.available && !p.installed), onChange: e => { setSelected(previous => e.target.checked ? [...previous, p.name] : previous.filter(n => n !== p.name)); setPlan(null); } }),
            h('strong', { style: { marginLeft: 8 } }, p.title),
            h('span', { style: { marginLeft: 10, opacity: .75 } }, p.problem ? errorInfo(p.problem).title : p.installed ? p.enabled ? '已启用' : '已安装，未启用' : p.available ? '可安装' : '缺少源码'),
            h('p', null, p.description), h('small', null, p.name + ' · 仓库 ' + (p.sourceVersion || '—') + ' · 已安装 ' + (p.installedVersion || '—')), h('p', { style: { fontSize: 12, opacity: .8 } }, p.setup)))) : null,
        data ? h('p', { role: 'status', style: { fontSize: 13 } }, selected.length ? '已选择 ' + selected.length + ' 个插件。预览不会修改配置。' : '尚未选择插件。勾选需要的插件后预览；异常项请先在原生插件页处理。') : null,
        button(busy === 'planning' ? '正在生成计划…' : '③ 预览安装计划', preview, !!busy || running || !canInstall(data, selected), 'preview'),
        plan ? h('section', { style: { border: '1px solid ' + C.border, padding: 16, borderRadius: 10 } }, h('h3', null, '确认将修改当前 DSH profile'),
          h('p', null, '通过官方管理器顺序安装；可能下载依赖。失败后停止，已成功的插件保留，不会回滚整批安装。'),
          ...plan.items.map(item => h('p', { key: item.name }, item.name + '：' + labels[item.action] + ' · ' + (item.version || '—'))),
          h('p', { style: { fontSize: 12 } }, '计划有效期为 5 分钟；超时或源码变更后需要重新预览。'),
          button(busy === 'installing' ? '正在提交确认…' : '确认安装所选插件', confirm, !!busy || running, 'confirm'), ' ', button('返回选择', () => setPlan(null), !!busy || running, 'back')) : null,
        job ? h('section', { 'aria-live': 'polite' }, h('h3', null, '④ ' + (labels[job.state] || job.state)), job.active ? h('p', null, '当前：' + job.active) : null,
          h('p', null, '已处理 ' + job.results.length + ' / ' + (job.total ?? job.results.length) + ' 项'),
          ...job.results.map(item => h('div', { key: item.name }, h('p', null, item.name + '：' + (labels[item.state] || item.state) + (item.warnings ? ' · 有 ' + item.warnings + ' 项管理器警告，请查看官方插件页' : '')), item.code ? h('p', { role: 'alert' }, errorInfo(item.code).title + '。' + errorInfo(item.code).recovery) : null)),
          job.state === 'failed' || job.state === 'stopped' ? h('p', null, '后续未开始的插件没有安装；重新检查状态并生成新计划可继续。') : null,
          job.state !== 'running' ? h('p', null, job.restartRequired ? '安装配置已保存。请手动重启 DSH，再刷新 GUI。' : '请刷新 GUI 查看新设置页；如宿主功能未出现，请重启 DSH。') : h('p', null, '关闭向导不会取消当前安装；重新打开可继续查看。'),
          job.state !== 'running' ? h('p', null, '账号池需添加账号；GitHub 需配置令牌。向导不会替你填写账号或凭据。') : null) : null);
    }
    function apply(ctx) {
      const slots = ctx.get('slots');
      const locale = ctx.get('locale');
      if (!slots || !locale) return;
      ctx.effect(() => locale.register(NS, dicts), 'betterdsh: dictionaries');
      // Attach to this bundle's native plugin detail; do not add a Settings entry.
      slots.inject('plugins.bundle.config', () => slots.register({ name: 'plugins.bundle.config', key: 'dsh-installer', locale: NS }, props => props.view === 'summary' ? h('span', null, '检查本地仓库，选择并安装 betterDSH 插件。') : h(Panel)));
    }
    return { name: 'dsh-installer', inject: ['slots', 'locale'], apply, Panel, canInstall, errorInfo };
  }
});
