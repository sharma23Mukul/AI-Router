import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { apiCall, API_BASE } from '../../utils/auth';

const providers = ['groq', 'openai', 'anthropic', 'openrouter', 'together', 'fireworks', 'mistral', 'deepseek', 'gemini'];
const tierLabels = [
  { id: 'light', label: 'Workflow A · Light' },
  { id: 'mid', label: 'Workflow B · Medium' },
  { id: 'heavy', label: 'Workflow C · Heavy' },
];

function suggestedModels(provider, models) {
  const ids = models.map(model => model.id);
  const find = pattern => ids.find(id => pattern.test(id));
  if (provider === 'groq') {
    return {
      light: ids.includes('openai/gpt-oss-20b') ? 'openai/gpt-oss-20b' : ids[0] || '',
      mid: find(/qwen.*27b|llama.*70b/i) || ids[1] || ids[0] || '',
      heavy: ids.includes('openai/gpt-oss-120b') ? 'openai/gpt-oss-120b' : ids[2] || ids[0] || '',
    };
  }
  if (provider === 'anthropic') {
    return { light: find(/haiku/i) || ids[0] || '', mid: find(/sonnet/i) || ids[1] || ids[0] || '', heavy: find(/opus/i) || ids[2] || ids[0] || '' };
  }
  return { light: ids[0] || '', mid: ids[1] || ids[0] || '', heavy: ids[2] || ids[0] || '' };
}

export default function ProviderWorkflowDialog({ onClose, onSaved }) {
  const [provider, setProvider] = useState('groq');
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState([]);
  const [chosen, setChosen] = useState({ light: '', mid: '', heavy: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const closeOnEscape = event => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [onClose]);

  async function discover(event) {
    event.preventDefault();
    setBusy(true); setError(''); setModels([]);
    try {
      const response = await apiCall(`${API_BASE}/api/v1/model-connections/discover`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, api_key: apiKey.trim() }),
      });
      const data = await response.json();
      if (response.status === 404 && data.detail === 'Not Found') {
        throw new Error('Model discovery is unavailable on the running backend. Restart the backend and try again.');
      }
      if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Could not list models for this API key.');
      if (!data.models.length) throw new Error('This key has no chat models available to connect.');
      setModels(data.models);
      setChosen(suggestedModels(provider, data.models));
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  async function save(event) {
    event.preventDefault();
    if (Object.values(chosen).some(value => !value)) {
      setError('Choose a model for each workflow.');
      return;
    }
    setBusy(true); setError('');
    try {
      const response = await apiCall(`${API_BASE}/api/v1/model-connections/provider-workflow`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, api_key: apiKey.trim(), models: chosen }),
      });
      const data = await response.json();
      if (response.status === 404 && data.detail === 'Not Found') {
        throw new Error('Provider workflows are unavailable on the running backend. Restart the backend and try again.');
      }
      if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Could not save this provider workflow.');
      onSaved(data);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[#102235]/70 p-4" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label="Connect a provider API" className="w-full min-w-0 max-w-[560px] max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-2xl bg-white p-4 sm:p-6 md:p-8 shadow-xl text-[#1d2939]">
        <div className="flex items-start justify-between gap-4 mb-5"><div><h2 className="font-radio-canada text-xl font-bold">Connect a provider API</h2><p className="text-sm text-[#64748b] mt-1">Use one API key to connect three models, one for each workflow.</p></div><button type="button" aria-label="Close" onClick={onClose} className="text-2xl text-[#64748b]">×</button></div>
        {error && <p role="alert" className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        <form onSubmit={discover} className="grid gap-4">
          <label className="text-sm font-semibold">Provider<select value={provider} onChange={event => { setProvider(event.target.value); setModels([]); setError(''); }} className="mt-1 block w-full rounded-lg border border-[#cbd5e1] px-3 py-2.5 font-normal">{providers.map(item => <option key={item} value={item}>{item === 'anthropic' ? 'Anthropic (Claude)' : item[0].toUpperCase() + item.slice(1)}</option>)}</select></label>
          <label className="text-sm font-semibold">API key<input required type="password" autoComplete="off" value={apiKey} onChange={event => { setApiKey(event.target.value); setModels([]); }} placeholder="Paste your provider API key" className="mt-1 block w-full rounded-lg border border-[#cbd5e1] px-3 py-2.5 font-normal" /></label>
          <button disabled={busy} type="submit" className="rounded-lg bg-[#223d58] px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-60">{busy && !models.length ? 'Finding models…' : 'Find available models'}</button>
        </form>
        {models.length > 0 && <form onSubmit={save} className="mt-6 border-t border-[#e6ebf0] pt-5"><p className="text-sm text-[#64748b] mb-4">The provider listed {models.length} models. Choose one for each workload tier; you can reuse a model across tiers. OptiRoute checks that each unique model can answer a chat request before connecting.</p><div className="grid gap-4">{tierLabels.map(tier => <label key={tier.id} className="text-sm font-semibold">{tier.label}<select required value={chosen[tier.id]} onChange={event => setChosen({ ...chosen, [tier.id]: event.target.value })} className="mt-1 block w-full rounded-lg border border-[#cbd5e1] px-3 py-2.5 font-normal"><option value="">Choose a model</option>{models.map(model => <option key={model.id} value={model.id}>{model.name} · {model.id}</option>)}</select></label>)}</div><p className="mt-4 text-xs text-[#64748b]">This check sends a tiny request to each unique selected model and may count toward your provider’s usage or rate limits.</p><div className="flex justify-end gap-3 mt-6"><button type="button" onClick={onClose} className="rounded-lg px-4 py-2 text-sm font-semibold text-[#516579]">Cancel</button><button disabled={busy} type="submit" className="rounded-lg bg-[#223d58] px-5 py-2 text-sm font-semibold text-white disabled:opacity-60">{busy ? 'Testing and connecting…' : 'Test & connect all three'}</button></div></form>}
      </div>
    </div>, document.body
  );
}
