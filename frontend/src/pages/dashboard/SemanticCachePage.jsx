import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { apiCall, API_BASE } from '../../utils/auth';


export default function SemanticCachePage() {
  const [cacheEntries, setCacheEntries] = React.useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [deletingId, setDeletingId] = useState(null);
  const [deletingSelected, setDeletingSelected] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  React.useEffect(() => {
    apiCall(`${API_BASE}/api/v1/cache`)
      .then(async res => {
        if (!res.ok) throw new Error(`Could not load semantic cache (${res.status}).`);
        return res.json();
      })
      .then(data => setCacheEntries(Array.isArray(data) ? data : []))
      .catch(err => { console.error(err); setLoadError('Could not load semantic cache.'); })
      .finally(() => setLoading(false));
  }, []);
  const [selected, setSelected] = useState([]);
  const searchTerms = searchQuery.trim().normalize('NFKC').toLowerCase().split(/\s+/).filter(Boolean);
  const visibleCacheEntries = searchTerms.length
    ? cacheEntries.filter(entry => {
        const searchable = [entry.query, entry.response_preview, entry.cache_id]
          .map(value => String(value ?? '')).join(' ').normalize('NFKC').toLowerCase();
        return searchTerms.every(term => searchable.includes(term));
      })
    : cacheEntries;
  const allVisibleSelected = visibleCacheEntries.length > 0 && visibleCacheEntries.every(entry => selected.includes(entry.cache_id));

  const toggleSelect = (id) => {
    setSelected(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const toggleAll = () => {
    const visibleIds = visibleCacheEntries.map(entry => entry.cache_id);
    setSelected(previous => allVisibleSelected
      ? previous.filter(id => !visibleIds.includes(id))
      : [...new Set([...previous, ...visibleIds])]);
  };

  const deleteEntry = async (cacheId) => {
    setDeletingId(cacheId);
    setDeleteError('');
    try {
      const response = await apiCall(`${API_BASE}/api/v1/cache/${encodeURIComponent(cacheId)}`, { method: 'DELETE' });
      if (!response.ok) {
        const details = await response.json().catch(() => ({}));
        throw new Error(details.detail || `Could not delete this cache entry (${response.status}).`);
      }
      const { deleted_ids: deletedIds = [], deleted_conversation_ids: conversationIds = [] } = await response.json();
      const deleted = new Set(deletedIds);
      const deletedConversations = new Set(conversationIds);
      setCacheEntries(previous => previous.filter(entry => !deleted.has(entry.cache_id) && !deletedConversations.has(entry.conversation_id)));
      setSelected(previous => previous.filter(id => !deleted.has(id)));
    } catch (error) {
      setDeleteError(error.message || 'Could not delete this cache entry.');
    } finally {
      setDeletingId(null);
    }
  };

  const deleteSelected = async () => {
    if (!selected.length) return;
    setDeletingSelected(true);
    setDeleteError('');
    try {
      const response = await apiCall(`${API_BASE}/api/v1/cache/delete-selected`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cache_ids: selected }),
      });
      if (!response.ok) {
        const details = await response.json().catch(() => ({}));
        throw new Error(details.detail || `Could not delete the selected cache entries (${response.status}).`);
      }
      const { deleted_ids: deletedIds = [], deleted_conversation_ids: conversationIds = [] } = await response.json();
      const deleted = new Set(deletedIds);
      const deletedConversations = new Set(conversationIds);
      setCacheEntries(previous => previous.filter(entry => !deleted.has(entry.cache_id) && !deletedConversations.has(entry.conversation_id)));
      setSelected(previous => previous.filter(id => !deleted.has(id)));
    } catch (error) {
      setDeleteError(error.message || 'Could not delete the selected cache entries.');
    } finally {
      setDeletingSelected(false);
    }
  };

  return (
    <div className="flex flex-col items-center pt-4 pb-10 w-full max-w-[1280px] mx-auto gap-[20px]">
      
      {/* Header Row */}
      <div className="w-full flex flex-col lg:flex-row items-start lg:items-end justify-between px-2 gap-4 lg:gap-0">
        <div>
          <h1 className="font-radio-canada text-[22px] md:text-[26px] font-bold text-black">Semantic Cache</h1>
          <p className="font-radio-canada text-[13px] md:text-[14px] text-gray-500 mt-1">Repeated prompts reuse one entry; close paraphrases can reuse its cached response. Deleting an entry also deletes its linked chat and cached answers.</p>
        </div>
        <div className="flex w-full flex-col gap-3 sm:flex-row sm:items-center lg:w-auto">
          {/* Search cached queries and response previews */}
          <div className="flex w-full min-w-0 flex-1 items-center gap-2 bg-white/20 backdrop-blur-sm border border-white/30 rounded-[10px] px-4 py-2 sm:w-auto lg:w-[260px] focus-within:ring-2 focus-within:ring-[#788FA8]/50">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-gray-500 flex-shrink-0"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
            <label htmlFor="cache-search" className="sr-only">Search in cache</label>
            <input id="cache-search" type="search" value={searchQuery} onChange={event => setSearchQuery(event.target.value)} placeholder="Search in cache" className="w-full min-w-0 bg-transparent text-[14px] text-gray-800 placeholder:text-gray-500 font-radio-canada outline-none" />
            {searchQuery && <button type="button" aria-label="Clear cache search" onClick={() => setSearchQuery('')} className="text-gray-600 hover:text-gray-900">×</button>}
          </div>
          <button type="button" onClick={deleteSelected} disabled={!selected.length || deletingSelected || deletingId !== null} className="w-full shrink-0 rounded-[10px] border border-red-700/30 bg-white/60 px-4 py-2 text-[13px] font-bold text-red-800 transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto">
            {deletingSelected ? 'Deleting...' : `Delete selected${selected.length ? ` (${selected.length})` : ''}`}
          </button>
        </div>
      </div>

      {deleteError && <p role="alert" className="w-full px-2 text-sm text-red-700">{deleteError}</p>}

      {/* Table with dark slate background */}
      <div className="w-full bg-[#788FA8] rounded-[20px] shadow-lg overflow-hidden">
        <div className="p-4 lg:hidden">
          <label className="flex items-center gap-3 border-b border-white/20 pb-4 text-sm font-semibold text-white">
            <input type="checkbox" checked={allVisibleSelected} onChange={toggleAll} aria-label="Select all visible cache entries" className="h-4 w-4 shrink-0 accent-blue-500" />
            Select all visible
          </label>
          <div className="divide-y divide-white/15">
            {visibleCacheEntries.map((entry) => (
              <article key={entry.cache_id} className="min-w-0 py-5 text-white">
                <div className="flex min-w-0 items-start gap-3">
                  <input type="checkbox" checked={selected.includes(entry.cache_id)} onChange={() => toggleSelect(entry.cache_id)} aria-label={`Select cache entry: ${entry.query}`} className="mt-1 h-4 w-4 shrink-0 accent-blue-500" />
                  <div className="min-w-0 flex-1">
                    <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-white/65">Query</p>
                    {entry.conversation_id ? (
                      <Link to={`/prompt?conversation=${encodeURIComponent(entry.conversation_id)}&turn=${encodeURIComponent(entry.chat_id)}`} className="block break-words text-sm font-semibold underline-offset-2 hover:underline">{entry.query}</Link>
                    ) : <p className="break-words text-sm font-semibold">{entry.query}</p>}
                  </div>
                </div>
                <div className="mt-4 min-w-0 pl-7">
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-white/65">Cached response</p>
                  <p className="break-words text-sm text-white/85">{entry.response_preview}</p>
                  <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-white/70">
                    <span>Hits: {entry.hit_count ?? 0}</span>
                    <span>{entry.time}</span>
                    <button type="button" disabled={deletingSelected || deletingId === entry.cache_id} onClick={() => deleteEntry(entry.cache_id)} className="rounded-lg border border-white/40 px-3 py-2 font-semibold text-white disabled:opacity-50">{deletingId === entry.cache_id ? 'Deleting...' : 'Delete'}</button>
                  </div>
                </div>
              </article>
            ))}
            {!loading && !loadError && visibleCacheEntries.length === 0 && <p className="py-8 text-center text-sm text-white/80">{searchTerms.length ? 'No matching cache entries.' : 'No cached prompts yet.'}</p>}
            {(loading || loadError) && <p className="py-8 text-center text-sm text-white/80">{loading ? 'Loading cache entries...' : loadError}</p>}
          </div>
        </div>
        <div className="hidden w-full overflow-x-auto lg:block">
          <table className="w-full text-left min-w-[760px]">
            <thead>
              <tr className="border-b border-white/10">
                <th className="py-4 px-5 w-[4%]">
                  <input 
                    type="checkbox" 
                    checked={allVisibleSelected}
                    onChange={toggleAll}
                    className="w-4 h-4 rounded border-white/30 cursor-pointer accent-blue-500" 
                  />
                </th>
                <th className="py-4 px-4 font-bold text-[13px] text-white font-geist-mono w-[30%]">Query</th>
                <th className="py-4 px-4 font-bold text-[13px] text-white font-geist-mono w-[34%]">Cached Response</th>
                <th className="py-4 px-4 font-bold text-[13px] text-white font-geist-mono w-[10%] text-center">Hit<br/>Count</th>
                <th className="py-4 px-4 font-bold text-[13px] text-white font-geist-mono w-[12%]">Created<br/>At</th>
                <th className="py-4 px-4 font-bold text-[13px] text-white font-geist-mono w-[10%] text-center">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleCacheEntries.map((entry) => {
                const isSelected = selected.includes(entry.cache_id);
                return (
                  <tr 
                    key={entry.cache_id} 
                    className={`border-b border-white/5 transition-colors ${
                      isSelected ? 'bg-[#6B8099]' : 'hover:bg-[#6B8099]/50'
                    }`}
                  >
                    {/* Checkbox */}
                    <td className="py-5 px-5">
                      <input 
                        type="checkbox" 
                        checked={isSelected}
                        onChange={() => toggleSelect(entry.cache_id)}
                        className="w-4 h-4 rounded border-white/30 cursor-pointer accent-blue-500" 
                      />
                    </td>

                    {/* Query */}
                    <td className="py-5 px-4">
                      {entry.conversation_id ? (
                        <Link
                          to={`/prompt?conversation=${encodeURIComponent(entry.conversation_id)}&turn=${encodeURIComponent(entry.chat_id)}`}
                          className="block text-[13px] text-white font-bold font-geist-mono mb-1.5 hover:underline focus-visible:underline focus-visible:outline-none"
                          title="Open this query in its chat"
                        >
                          {entry.query}
                        </Link>
                      ) : (
                        <p className="text-[13px] text-white font-bold font-geist-mono mb-1.5" title="Original chat unavailable">{entry.query}</p>
                      )}
                    </td>

                    {/* Cached Response */}
                    <td className="py-5 px-4">
                      <p className="text-[13px] text-white/70 font-geist-mono leading-relaxed">{entry.response_preview}</p>
                    </td>

                    {/* Hit Count */}
                    <td className="py-5 px-4 text-center">
                      <span className={`inline-flex items-center gap-1 px-3 py-1 rounded-full text-[13px] font-bold font-geist-mono ${
                        entry.hit_count >= 40 ? 'bg-green-500/20 text-green-300' :
                        entry.hit_count >= 20 ? 'bg-purple-500/20 text-purple-300' :
                        'bg-blue-500/20 text-blue-300'
                      }`}>
                        {entry.hit_count ?? 0}
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="12 2 22 12 2 12"></polygon></svg>
                      </span>
                    </td>

                    {/* Created At */}
                    <td className="py-5 px-4">
                      <span className="text-[12px] text-white/60 font-geist-mono whitespace-pre-line leading-tight">{entry.time}</span>
                    </td>

                    {/* Delete cache entry */}
                    <td className="py-5 px-4">
                      <div className="flex items-center justify-center">
                        <button type="button" disabled={deletingSelected || deletingId === entry.cache_id} onClick={() => deleteEntry(entry.cache_id)} className="flex items-center gap-1.5 px-3 py-1.5 border border-white/30 text-white/90 rounded-[6px] text-[11px] font-bold font-geist-mono hover:bg-white/10 transition-colors disabled:opacity-50">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white/70"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                          {deletingId === entry.cache_id ? 'Deleting...' : 'Delete'}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!loading && !loadError && visibleCacheEntries.length === 0 && (
                <tr><td colSpan={6} className="py-12 px-5 text-center text-white/80 font-radio-canada text-[14px]">{searchTerms.length ? 'No matching cache entries.' : 'No cached prompts yet.'}</td></tr>
              )}
              {(loading || loadError) && (
                <tr><td colSpan={6} className="py-12 px-5 text-center text-white/80 font-radio-canada text-[14px]">{loading ? 'Loading cache entries...' : loadError}</td></tr>
              )}
            </tbody>
          </table>
        </div>
        
        {/* Footer / Pagination */}
        <div className="flex flex-col md:flex-row items-center justify-between px-4 md:px-6 py-4 border-t border-white/10 gap-4 md:gap-0">
          <span className="text-[13px] text-white/70 font-geist-mono bg-[#5F7A94] px-3 py-1 rounded-[6px] font-bold">{selected.length} selected</span>
          <div className="flex items-center gap-3">
            <span className="text-[13px] text-white/60 font-radio-canada">
              {cacheEntries.length === 0 ? 'No cached prompts yet' : `Showing ${visibleCacheEntries.length} of ${cacheEntries.length}`}
            </span>
            <button className="w-7 h-7 rounded-[6px] border border-white/20 flex items-center justify-center text-white/40 hover:bg-white/10 transition-colors">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"></polyline></svg>
            </button>
            <button className="w-7 h-7 rounded-[6px] border border-white/20 flex items-center justify-center text-white/40 hover:bg-white/10 transition-colors">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 18 15 12 9 6"></polyline></svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}


