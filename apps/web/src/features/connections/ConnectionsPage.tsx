import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ROLES, ROLE_LABELS, type Role, type RoleRoute, type Route, type Settings } from '@smartbuilder/domain';
import type { ConnectionsResponse, ProbeResult, ProviderStatus } from '@smartbuilder/domain';
import { api, errorText } from '../../lib/api';
import { qk, useConnections, useSettings } from '../../lib/queries';
import { useDocumentTitle } from '../../lib/hooks';
import { Icon } from '../../components/Icon';
import { ConfirmDialog } from '../../components/Dialog';
import { useToast } from '../../components/Toast';
import './connections.css';

const LOGIN_CMD: Record<string, string> = { claude: 'claude auth login', codex: 'codex login' };
const DEFAULT_NLM_LOGIN = 'NLM_BROWSER_PATH=<Chromium-based browser> uvx --from notebooklm-mcp-cli nlm login --storage file';

function Copy({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" aria-label={label} onClick={() => { void navigator.clipboard?.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); }}>
      <Icon name={done ? 'check' : 'copy'} />{done ? 'Copied' : 'Copy'}
    </button>
  );
}

function providerAdvice(p: ProviderStatus): { tone: 'success' | 'warning' | 'danger'; text: string; command?: string } {
  if (!p.installed) return { tone: 'danger', text: `${p.label} is not installed on this computer. Install its command line tool, then press Check again.` };
  if (p.signedIn === false) {
    const cmd = LOGIN_CMD[p.provider];
    return cmd
      ? { tone: 'warning', text: `${p.label} is not signed in. Run the command below in a terminal on this computer, then press Check again.`, command: cmd }
      : { tone: 'warning', text: `${p.label} is not signed in. Sign in with its command line tool in a terminal on this computer, then press Check again.` };
  }
  if (p.error) return { tone: 'warning', text: `${p.label} answered with a problem: ${p.error}` };
  if (p.signedIn === null) return { tone: 'warning', text: `${p.label} is installed, but sign-in could not be checked. Try a model test below.` };
  return { tone: 'success', text: `${p.label} is ready.` };
}

export default function ConnectionsPage() {
  useDocumentTitle('Connections');
  const conn = useConnections();
  const settings = useSettings();
  const qc = useQueryClient();
  const [checking, setChecking] = useState(false);
  const [stopOpen, setStopOpen] = useState(false);
  const [stopped, setStopped] = useState(false);
  const toast = useToast();

  const check = async () => { setChecking(true); try { await conn.refetch(); } finally { setChecking(false); } };
  const stop = useMutation({
    mutationFn: () => api('POST /api/shutdown'),
    onSuccess: () => { setStopOpen(false); setStopped(true); },
    onError: (e) => toast(errorText(e), { tone: 'danger' }),
  });

  if (stopped) {
    return (
      <div className="ui-page ui-page--narrow">
        <div className="ui-banner ui-banner--info" role="status"><div className="ui-banner__body"><span className="ui-banner__title">The service is stopped</span><span>Generation is paused. Start the service again from the terminal to continue; unfinished tasks resume on their own.</span></div></div>
      </div>
    );
  }

  const c = conn.data;
  return (
    <div className="ui-page ui-page--wide cn-page">
      <div className="ui-page__head">
        <div>
          <h1 className="ui-screen-title">Connections</h1>
          <p className="ui-lede">The model tools installed on this computer and how the work is shared between them.</p>
        </div>
        <div className="ui-page__actions">
          <button type="button" className="ui-btn" onClick={() => void check()} disabled={checking}>{checking ? <><span className="ui-spinner" />Checking…</> : <><Icon name="refresh" />Check again</>}</button>
        </div>
      </div>

      {conn.isLoading && <><p className="ui-muted" role="status">Checking the tools installed on this computer. This can take a few seconds.</p><div className="ui-skeleton" style={{ height: 200 }} /></>}
      {conn.error && <div className="ui-banner ui-banner--danger" role="alert"><div className="ui-banner__body"><span className="ui-banner__title">Connections did not load</span><span>{errorText(conn.error)}</span></div></div>}

      {c && (
        <>
          <section aria-label="Providers" className="cn-cards">
            {c.providers.map((p) => <ProviderCard key={p.provider} p={p} />)}
            <NotebookCard nb={c.notebooklm} />
            <LibreCard lo={c.libreoffice} />
          </section>

          {settings.data && <Routing connections={c} settings={settings.data} onSaved={(s) => qc.setQueryData(qk.settings, s)} />}

          <section className="ui-card ui-card--pad cn-section" aria-label="This computer">
            <h2 className="ui-panel-title">This computer</h2>
            <dl className="cn-dl">
              <dt>Data folder</dt><dd className="ui-row"><code className="ui-code">{c.dataDir}</code><Copy text={c.dataDir} label="Copy data folder path" /></dd>
              <dt>Node</dt><dd><code className="ui-code">{c.node}</code></dd>
            </dl>
            <div>
              <button type="button" className="ui-btn ui-btn--danger" onClick={() => setStopOpen(true)}><Icon name="power" />Stop service</button>
              <p className="ui-muted cn-note">Closing the browser does not stop generation. Stopping the service does.</p>
            </div>
          </section>
        </>
      )}

      <ConfirmDialog
        open={stopOpen}
        title="Stop the service"
        message="Generation pauses until the next start. Tasks that are running now are put back in the queue and continue when you start the service again from the terminal. Your drafts and sources are kept."
        confirmLabel="Stop service"
        danger
        busy={stop.isPending}
        onClose={() => setStopOpen(false)}
        onConfirm={() => stop.mutate()}
      />
    </div>
  );
}

function Badge({ ok, yes, no, unknown }: { ok: boolean | null; yes: string; no: string; unknown?: string }) {
  if (ok === null) return <span className="ui-badge ui-badge--warning">{unknown ?? 'unknown'}</span>;
  return <span className={`ui-badge ${ok ? 'ui-badge--success' : 'ui-badge--danger'}`}><Icon name={ok ? 'check' : 'x'} size={12} />{ok ? yes : no}</span>;
}

function ProviderCard({ p }: { p: ProviderStatus }) {
  const advice = providerAdvice(p);
  return (
    <article className="cn-card ui-card" aria-label={p.label}>
      <header className="cn-card__head">
        <h2 className="ui-panel-title">{p.label}</h2>
        {p.version && <span className="ui-badge ui-badge--mono">{p.version}</span>}
      </header>
      <div className="ui-row">
        <Badge ok={p.installed} yes="installed" no="not installed" />
        {p.installed && <Badge ok={p.signedIn} yes="signed in" no="not signed in" unknown="sign-in unknown" />}
      </div>
      <p className={`cn-advice cn-advice--${advice.tone}`}>{advice.text}</p>
      {advice.command && <div className="cn-cmd"><code className="ui-code">{advice.command}</code><Copy text={advice.command} label={`Copy ${p.label} sign-in command`} /></div>}
      {p.installed && (
        <>
          <details className="cn-details">
            <summary>{p.models.length === 0 ? 'No models reported' : `${p.models.length} ${p.models.length === 1 ? 'model' : 'models'}`}</summary>
            <ul className="cn-models">{p.models.map((m) => <li key={m.id}><span className="ui-mono">{m.id}</span>{m.efforts.length > 0 && <span className="ui-muted"> · effort {m.efforts.join(', ')}</span>}</li>)}</ul>
          </details>
          <div className="ui-row cn-caps" aria-label="Capabilities">
            <span className={`ui-badge${p.capabilities.images ? ' ui-badge--success' : ''}`}>{p.capabilities.images ? 'reads images' : 'no images'}</span>
            <span className="ui-badge">schema: {p.capabilities.schema}</span>
            <span className="ui-badge">{p.capabilities.system ? 'system prompt' : 'no system prompt'}</span>
          </div>
        </>
      )}
    </article>
  );
}

function NotebookCard({ nb }: { nb: ConnectionsResponse['notebooklm'] }) {
  const cmd = nb.loginCommand || DEFAULT_NLM_LOGIN;
  return (
    <article className="cn-card ui-card" aria-label="NotebookLM">
      <header className="cn-card__head"><h2 className="ui-panel-title">NotebookLM</h2></header>
      <div className="ui-row">
        <Badge ok={nb.installed} yes="installed" no="not installed" />
        {nb.installed && <Badge ok={nb.signedIn} yes={nb.account ? `signed in as ${nb.account}` : 'signed in'} no="signed out" />}
      </div>
      {nb.installed && nb.signedIn && (
        <>
          <p className="cn-advice cn-advice--success">NotebookLM answers questions about your sources and cites the passages.</p>
          {nb.usage.length > 0 && (
            <div><div className="ui-meta">Usage windows</div>
              <ul className="cn-models">{nb.usage.map((u, i) => <li key={i}><span>{u.window}</span><span className="ui-muted"> · {u.remaining} left</span></li>)}</ul></div>
          )}
        </>
      )}
      {nb.installed && !nb.signedIn && (
        <>
          <p className="cn-advice cn-advice--warning">NotebookLM is signed out. On a computer with a browser, run the command below, then copy <code className="ui-code">~/.notebooklm-mcp-cli/profiles</code> and <code className="ui-code">config.toml</code> to this computer and press Check again.</p>
          <div className="cn-cmd"><code className="ui-code">{cmd}</code><Copy text={cmd} label="Copy NotebookLM sign-in command" /></div>
        </>
      )}
      {!nb.installed && <p className="cn-advice cn-advice--danger">NotebookLM support is not installed on this computer. Install uv, then press Check again. Without it, the builder falls back to local evidence search.</p>}
      {nb.error && <p className="cn-advice cn-advice--warning">{nb.error}</p>}
    </article>
  );
}

function LibreCard({ lo }: { lo: ConnectionsResponse['libreoffice'] }) {
  return (
    <article className="cn-card ui-card" aria-label="LibreOffice">
      <header className="cn-card__head"><h2 className="ui-panel-title">LibreOffice</h2></header>
      <div className="ui-row"><Badge ok={lo.installed} yes="installed" no="not installed" /></div>
      {lo.installed
        ? <p className="cn-advice cn-advice--success">Word and PowerPoint files are converted with LibreOffice. <code className="ui-code ui-wrap">{lo.path}</code></p>
        : <p className="cn-advice cn-advice--warning">DOCX and PPTX sources need LibreOffice to be read. Install it, then press Check again. PDF and Markdown files work without it.</p>}
    </article>
  );
}

function Routing({ connections, settings, onSaved }: { connections: ConnectionsResponse; settings: Settings; onSaved: (s: Settings) => void }) {
  const [local, setLocal] = useState<Settings>(settings);
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [err, setErr] = useState('');
  const timer = useRef<number | undefined>(undefined);
  const pending = useRef<Partial<Settings> | null>(null);
  const [probes, setProbes] = useState<Partial<Record<Role, ProbeResult | 'running' | { error: string }>>>({});

  useEffect(() => { setLocal(settings); }, [settings]);

  const save = useMutation({
    mutationFn: (body: Partial<Settings>) => api('PUT /api/settings', { body }),
    onMutate: () => setState('saving'),
    onSuccess: (s) => { setState('saved'); onSaved(s); },
    onError: (e) => { setState('error'); setErr(errorText(e)); },
  });

  const flush = useCallback(async () => {
    window.clearTimeout(timer.current);
    const body = pending.current;
    pending.current = null;
    if (body) await save.mutateAsync(body).catch(() => undefined);
  }, [save]);

  const change = (patch: Partial<Settings>) => {
    setLocal((s) => ({ ...s, ...patch }));
    pending.current = { ...pending.current, ...patch };
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), 500);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const setRoute = (role: Role, slot: 'primary' | 'fallback', route: Route | undefined) => {
    const cur: RoleRoute = local.routes[role];
    const next: RoleRoute = { ...cur, [slot]: route };
    if (slot === 'fallback' && !route) delete next.fallback;
    change({ routes: { ...local.routes, [role]: next } });
  };

  const probe = async (role: Role) => {
    setProbes((p) => ({ ...p, [role]: 'running' }));
    await flush();
    try { const r = await api('POST /api/connections/probe', { body: { role } }); setProbes((p) => ({ ...p, [role]: r })); }
    catch (e) { setProbes((p) => ({ ...p, [role]: { error: errorText(e) } })); }
  };

  const providerKeys = [...new Set([...connections.providers.map((p) => p.provider), ...Object.keys(local.concurrency)])];

  return (
    <>
      <section className="ui-card ui-card--pad cn-section" aria-label="Model routing">
        <div className="cn-section__head">
          <div><h2 className="ui-panel-title">Model routing</h2><p className="ui-muted">Which model does each job. The fallback takes over when the primary is unavailable or out of quota.</p></div>
          <span className={`cn-state${state === 'error' ? ' is-error' : ''}`} role="status" aria-live="polite">{state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved' : state === 'error' ? `Couldn't save — ${err}` : ''}</span>
        </div>
        <ul className="cn-roles">
          {ROLES.map((role) => (
            <li key={role} className="cn-role">
              <div className="cn-role__what">
                <h3 className="cn-role__name">{ROLE_LABELS[role].label}</h3>
                <p className="ui-muted cn-role__help">{ROLE_LABELS[role].help}</p>
                <div className="ui-row">
                  <button type="button" className="ui-btn ui-btn--sm" onClick={() => void probe(role)} disabled={probes[role] === 'running'}>{probes[role] === 'running' ? <><span className="ui-spinner" />Testing…</> : 'Test'}</button>
                  <ProbeText p={probes[role]} />
                </div>
              </div>
              <RouteSelect label={`${ROLE_LABELS[role].label}, primary`} title="Primary" providers={connections.providers} value={local.routes[role].primary} onChange={(r) => setRoute(role, 'primary', r)} />
              <RouteSelect label={`${ROLE_LABELS[role].label}, fallback`} title="Fallback" providers={connections.providers} value={local.routes[role].fallback} optional onChange={(r) => setRoute(role, 'fallback', r)} />
            </li>
          ))}
        </ul>
      </section>

      <section className="ui-card ui-card--pad cn-section" aria-label="Evidence mode">
        <h2 className="ui-panel-title">Evidence</h2>
        <fieldset className="cn-fieldset">
          <legend className="ui-sr">Evidence mode</legend>
          <label className="cn-radio"><input type="radio" name="evmode" checked={local.evidenceMode === 'notebooklm'} onChange={() => change({ evidenceMode: 'notebooklm' })} /><span><strong>NotebookLM</strong><br /><span className="ui-muted">Answers come with cited passages, located on the source pages. Needs a signed-in NotebookLM.</span></span></label>
          <label className="cn-radio"><input type="radio" name="evmode" checked={local.evidenceMode === 'local'} onChange={() => change({ evidenceMode: 'local' })} /><span><strong>Local</strong><br /><span className="ui-muted">Searches the pages on this computer and has the evidence reader model quote them. Nothing goes to NotebookLM.</span></span></label>
        </fieldset>
        {local.evidenceMode === 'notebooklm' && !connections.notebooklm.signedIn && <div className="ui-banner ui-banner--warning">NotebookLM is not signed in, so drafting will wait for you. Sign in above, or switch to Local.</div>}
      </section>

      <section className="ui-card ui-card--pad cn-section" aria-label="Concurrency">
        <h2 className="ui-panel-title">Concurrency</h2>
        <p className="ui-muted">How many tasks each provider may run at once. Lower it if you hit quota limits.</p>
        <div className="cn-conc">
          {providerKeys.map((k) => (
            <div key={k} className="ui-field">
              <label className="ui-field__label ui-mono" htmlFor={`cc-${k}`}>{k}</label>
              <input id={`cc-${k}`} type="number" min={1} max={8} className="ui-input ui-input--sm" value={local.concurrency[k] ?? 1} onChange={(e) => change({ concurrency: { ...local.concurrency, [k]: Math.max(1, Math.min(8, Math.round(Number(e.target.value) || 1))) } })} />
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

function ProbeText({ p }: { p: ProbeResult | 'running' | { error: string } | undefined }) {
  if (!p || p === 'running') return null;
  if ('error' in p) return <span className="cn-probe is-bad" role="status">{p.error}</span>;
  return <span className={`cn-probe ${p.ok ? 'is-ok' : 'is-bad'}`} role="status">{p.ok ? 'Works' : 'Failed'} · {(p.ms / 1000).toFixed(1)} s · {p.detail}</span>;
}

function RouteSelect({ label, title, providers, value, onChange, optional }: { label: string; title: string; providers: ProviderStatus[]; value: Route | undefined; onChange: (r: Route | undefined) => void; optional?: boolean }) {
  const provider = providers.find((p) => p.provider === value?.provider);
  const models = provider?.models ?? [];
  const model = models.find((m) => m.id === value?.model);
  const efforts = model?.efforts ?? [];
  const pick = (providerId: string) => {
    if (!providerId) return onChange(undefined);
    const p = providers.find((x) => x.provider === providerId);
    const m = p?.models[0];
    onChange({ provider: providerId, model: m?.id ?? '', effort: m?.efforts.includes('medium') ? 'medium' : undefined });
  };
  return (
    <fieldset className="cn-route">
      <legend className="ui-meta">{title}</legend>
      <label className="ui-field"><span className="ui-sr">{label} provider</span>
        <select className="ui-select ui-select--sm" value={value?.provider ?? ''} onChange={(e) => pick(e.target.value)}>
          {optional && <option value="">None</option>}
          {providers.map((p) => <option key={p.provider} value={p.provider} disabled={!p.installed && p.provider !== value?.provider}>{p.label}{p.installed ? '' : ' (not installed)'}</option>)}
          {value && !provider && <option value={value.provider}>{value.provider}</option>}
        </select></label>
      {value && (
        <>
          <label className="ui-field"><span className="ui-sr">{label} model</span>
            <select className="ui-select ui-select--sm" value={value.model} onChange={(e) => { const m = models.find((x) => x.id === e.target.value); onChange({ provider: value.provider, model: e.target.value, effort: m && value.effort && m.efforts.includes(value.effort) ? value.effort : undefined }); }}>
              {models.map((m) => <option key={m.id} value={m.id}>{m.label || m.id}</option>)}
              {!model && <option value={value.model}>{value.model || 'Choose a model'}</option>}
            </select></label>
          {efforts.length > 0 && (
            <label className="ui-field"><span className="ui-sr">{label} effort</span>
              <select className="ui-select ui-select--sm" value={value.effort ?? ''} onChange={(e) => onChange({ ...value, effort: e.target.value || undefined })}>
                <option value="">Default effort</option>{efforts.map((x) => <option key={x} value={x}>{x} effort</option>)}
              </select></label>
          )}
        </>
      )}
    </fieldset>
  );
}
