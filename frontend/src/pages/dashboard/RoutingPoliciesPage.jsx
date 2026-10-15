import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { apiCall, API_BASE } from '../../utils/auth';
import ProviderWorkflowDialog from './ProviderWorkflowDialog';

const tiers = [
  { id: 'light', title: 'Workflow A', name: 'Document Processing', description: 'Quick, straightforward tasks' },
  { id: 'mid', title: 'Workflow B', name: 'General Assistant', description: 'Multi-step everyday work' },
  { id: 'heavy', title: 'Workflow C', name: 'Specialized Analysis', description: 'Complex reasoning and large tasks' },
];
const providers = ['groq', 'openai', 'anthropic', 'openrouter', 'together', 'fireworks', 'mistral', 'deepseek', 'gemini'];
const emptyForm = { name: '', provider: 'groq', model_id: '', api_key: '' };

export default function RoutingPoliciesPage() {
  const [tier, setTier] = useState('light');
  const [connections, setConnections] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [adding, setAdding] = useState(false);
  const [connectingProvider, setConnectingProvider] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    apiCall(`${API_BASE}/api/v1/model-connections`)
      .then(async res => { const data = await res.json(); if (!res.ok) throw new Error(data.detail || 'Could not load models.'); setConnections(data); })
      .catch(err => setError(err.message));
  }, []);

  useEffect(() => {
    if (!adding) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const closeOnEscape = event => { if (event.key === 'Escape') setAdding(false); };
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [adding]);

  const selected = tiers.find(item => item.id === tier);
  const shown = connections.filter(item => item.tier === tier);

  async function addModel(event) {
    event.preventDefault();
    setBusy(true); setError(''); setNotice('');
    try {
      const response = await apiCall(`${API_BASE}/api/v1/model-connections`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, tier, name: form.name.trim(), model_id: form.model_id.trim(), api_key: form.api_key.trim() }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Could not save this model.');
      setConnections(current => [...current, data]);
      setForm(emptyForm); setAdding(false); setNotice(`${data.name} was saved in ${selected.title}.`);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  async function removeModel(item) {
    if (!window.confirm(`Remove ${item.name}? You will need its API key to add it again.`)) return;
    setError(''); setNotice('');
    try {
      const response = await apiCall(`${API_BASE}/api/v1/model-connections/${item.connection_id}`, { method: 'DELETE' });
      if (!response.ok) throw new Error('Could not remove this model.');
      setConnections(current => current.filter(model => model.connection_id !== item.connection_id));
      setNotice(`${item.name} removed.`);
    } catch (err) { setError(err.message); }
  }

  const field = (label, key, type = 'text', extra = {}) => <label className="text-sm font-semibold">{label}<input required type={type} value={form[key]} onChange={event => setForm({ ...form, [key]: event.target.value })} className="mt-1 block w-full rounded-lg border border-[#cbd5e1] px-3 py-2.5 font-normal" {...extra} /></label>;

  return <div className="w-full max-w-[1100px] mx-auto px-3 md:px-6 py-6 md:py-10 text-[#1d2939]">
    <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4 mb-7">
      <div><p className="text-xs font-geist-mono uppercase tracking-[0.18em] text-[#64748b] mb-2">Routing Policies</p><h1 className="font-radio-canada text-2xl md:text-3xl font-bold">Your model workflows</h1><p className="text-sm text-[#64748b] mt-2 max-w-[650px]">Connect models using your own API keys. OptiRoute analyzes each prompt, chooses a workload tier, then ranks the connected models in that tier for the task. An empty tier uses the closest configured tier.</p></div>
      <button type="button" onClick={() => { setConnectingProvider(true); setError(''); }} className="rounded-xl bg-[#223d58] px-5 py-3 text-white text-sm font-semibold hover:bg-[#315575] whitespace-nowrap">+ Connect provider API</button>
    </div>
    {error && <div role="alert" className="mb-5 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
    {notice && <div role="status" className="mb-5 rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{notice}</div>}
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-6">{tiers.map(item => <button key={item.id} type="button" onClick={() => { setTier(item.id); setAdding(false); setError(''); }} className={`min-w-0 text-left rounded-2xl border p-5 transition-colors ${tier === item.id ? 'border-[#567998] bg-white shadow-md' : 'border-white/80 bg-white/65 hover:bg-white'}`}><span className="inline-block rounded-full bg-[#e9f3f7] px-3 py-1 text-xs font-semibold text-[#315575]">{item.id === 'mid' ? 'Medium' : item.id[0].toUpperCase() + item.id.slice(1)} tier</span><h2 className="font-radio-canada font-bold text-lg mt-3">{item.title}: {item.name}</h2><p className="text-sm text-[#64748b] mt-1">{item.description}</p><p className="text-xs font-geist-mono mt-4">{connections.filter(model => model.tier === item.id).length} connected model(s)</p></button>)}</div>
    <section className="rounded-2xl bg-white p-5 md:p-7 shadow-sm"><div className="flex flex-wrap items-center justify-between gap-3 mb-5"><div><h2 className="font-radio-canada font-bold text-xl">{selected.title}: {selected.name}</h2><p className="text-sm text-[#64748b] mt-1">Used for {selected.description.toLowerCase()}.</p></div><button type="button" onClick={() => setAdding(true)} className="text-sm font-semibold text-[#315575] hover:underline">+ Add to this workflow</button></div>
      {shown.length === 0 ? <div className="rounded-xl border border-dashed border-[#c5d0da] p-8 text-center text-sm text-[#64748b]">No models connected in this tier yet. Add one to make it available for routing.</div> : <div className="space-y-3">{shown.map((item) => <div key={item.connection_id} className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-[#e6ebf0] p-4"><div className="min-w-0"><div className="flex items-center gap-2"><strong className="truncate">{item.name}</strong></div><p className="font-geist-mono text-xs text-[#64748b] break-all mt-1">{item.provider} · {item.model_id}</p><p className="text-xs text-[#8190a0] mt-1">API key saved securely</p></div><button type="button" onClick={() => removeModel(item)} className="rounded-lg border border-[#d9e1e8] px-3 py-2 text-sm text-[#6f4040] hover:bg-red-50">Remove</button></div>)}</div>}
    </section>
    {adding && createPortal(<div className="fixed inset-0 z-[100] flex items-center justify-center bg-[#102235]/70 p-4" onMouseDown={event => { if (event.target === event.currentTarget) setAdding(false); }}><form role="dialog" aria-modal="true" aria-label={`Add a model to ${selected.title}`} onSubmit={addModel} className="w-full min-w-0 max-w-[540px] max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-2xl bg-white p-4 sm:p-6 md:p-8 shadow-xl"><div className="flex justify-between items-start gap-4 mb-5"><div><h2 className="font-radio-canada text-xl font-bold">Add a model to {selected.title}</h2><p className="text-sm text-[#64748b] mt-1">Enter a provider API key and the exact model ID available on your account.</p></div><button type="button" aria-label="Close" onClick={() => setAdding(false)} className="text-2xl text-[#64748b]">×</button></div>{error && <p role="alert" className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}<div className="grid gap-4">
      {field('Display name', 'name', 'text', { maxLength: 80, placeholder: 'e.g. My fast model' })}
      <label className="text-sm font-semibold">Provider<select value={form.provider} onChange={event => setForm({ ...form, provider: event.target.value })} className="mt-1 block w-full rounded-lg border border-[#cbd5e1] px-3 py-2.5 font-normal">{providers.map(provider => <option key={provider} value={provider}>{provider === 'anthropic' ? 'Anthropic (Claude)' : provider[0].toUpperCase() + provider.slice(1)}</option>)}</select></label>
      {field('Model ID', 'model_id', 'text', { maxLength: 150, placeholder: 'Exact ID from your provider' })}
      {field('API key', 'api_key', 'password', { autoComplete: 'off', placeholder: 'Paste your provider API key' })}
    </div><div className="flex justify-end gap-3 mt-6"><button type="button" onClick={() => setAdding(false)} className="rounded-lg px-4 py-2 text-sm font-semibold text-[#516579]">Cancel</button><button disabled={busy} type="submit" className="rounded-lg bg-[#223d58] px-5 py-2 text-sm font-semibold text-white disabled:opacity-60">{busy ? 'Saving…' : 'Save model'}</button></div></form></div>, document.body)}
    {connectingProvider && <ProviderWorkflowDialog onClose={() => setConnectingProvider(false)} onSaved={items => { setConnections(current => [...current, ...items]); setConnectingProvider(false); setNotice(`${items.length} models connected across all workflows.`); }} />}
  </div>;
}
