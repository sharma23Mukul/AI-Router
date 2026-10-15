import React, { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { signOut } from 'firebase/auth';
import { auth } from '../utils/firebase';
import { getAuthHeaders, API_BASE } from '../utils/auth';
import MarkdownRenderer from '../components/ui/MarkdownRenderer';

const orderConversationTurns = (turns) => {
  const chronological = turns
    .map((turn, index) => ({ turn, index }))
    .sort((a, b) => (a.turn.turn_index ?? a.index) - (b.turn.turn_index ?? b.index))
    .map(({ turn }) => turn);
  const byId = new Map(chronological.map((turn) => [turn.chat_id, turn]));
  const parents = new Map();
  const followUps = new Map();
  const retries = new Map();
  let previousId = null;

  for (const turn of chronological) {
    const route = turn.response?.optiroute || {};
    const isRetry = Boolean(route.retry_from_chat_id);
    const parentId = Object.prototype.hasOwnProperty.call(route, 'parent_chat_id')
      ? route.parent_chat_id
      : isRetry ? parents.get(route.retry_from_chat_id) : previousId;
    parents.set(turn.chat_id, parentId || null);
    const group = isRetry ? retries : followUps;
    const groupKey = isRetry ? route.retry_from_chat_id : (parentId || null);
    if (!group.has(groupKey)) group.set(groupKey, []);
    group.get(groupKey).push(turn);
    previousId = turn.chat_id;
  }

  const branchContext = (parentId) => {
    if (retries.has(parentId)) return 'earlier';
    if (byId.get(parentId)?.response?.optiroute?.retry_from_chat_id) return 'heavier';
    return null;
  };

  const result = [];
  const visited = new Set();
  const append = (turn) => {
    if (visited.has(turn.chat_id)) return;
    visited.add(turn.chat_id);
    result.push({
      ...turn,
      branchContext: branchContext(parents.get(turn.chat_id)),
      superseded: retries.has(turn.chat_id),
    });
    for (const retry of retries.get(turn.chat_id) || []) append(retry);
    for (const followUp of followUps.get(turn.chat_id) || []) append(followUp);
  };
  for (const root of followUps.get(null) || []) append(root);
  for (const turn of chronological) append(turn);
  return result;
};

const PromptPage = () => {
  const [turns, setTurns] = useState([]);
  const [loading, setLoading] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [progressMessage, setProgressMessage] = useState('Loading response...');
  const [progressErrors, setProgressErrors] = useState([]);
  const [error, setError] = useState(null);
  const [answerFeedback, setAnswerFeedback] = useState({});
  const [retryError, setRetryError] = useState(null);
  const [retryingChatId, setRetryingChatId] = useState(null);
  const [cachedAnswerIds, setCachedAnswerIds] = useState([]);
  const [cacheChoiceLoading, setCacheChoiceLoading] = useState(null);
  const [cacheChoiceError, setCacheChoiceError] = useState(null);
  const [prompt, setPrompt] = useState('');
  const promptInputRef = useRef(null);
  const chatScrollRef = useRef(null);
  const pendingAnswerScrollRef = useRef(null);
  const activeRequestRef = useRef(null);
  const [isPolicyOpen, setIsPolicyOpen] = useState(true);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isDesktopSidebarOpen, setIsDesktopSidebarOpen] = useState(true);

  // Chat history state
  const [recentChats, setRecentChats] = useState([]);
  const [loadingChats, setLoadingChats] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [chatListError, setChatListError] = useState('');
  const [deleteChatError, setDeleteChatError] = useState('');
  const [deletingChatId, setDeletingChatId] = useState(null);
  const chatRequestRef = useRef(0);
  const [activeConversationId, setActiveConversationId] = useState(null);
  const [activeParentId, setActiveParentId] = useState(null);
  const [focusedTurnId, setFocusedTurnId] = useState(null);

  const navigate = useNavigate();
  const location = useLocation();

  useLayoutEffect(() => {
    const input = promptInputRef.current;
    if (!input) return;
    const maxHeight = Math.max(80, Math.min(320, window.innerHeight * 0.4));
    input.style.height = 'auto';
    input.style.height = `${Math.min(Math.max(input.scrollHeight, 40), maxHeight)}px`;
    input.style.overflowY = input.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, [prompt, turns.length]);

  useLayoutEffect(() => {
    const requestId = pendingAnswerScrollRef.current;
    const scroller = chatScrollRef.current;
    if (!requestId || !scroller) return;
    const answer = document.getElementById(`chat-answer-${requestId}`);
    if (!answer) return;
    const answerTop = answer.getBoundingClientRect().top;
    const scrollerTop = scroller.getBoundingClientRect().top;
    scroller.scrollTop += answerTop - scrollerTop - 16;
    pendingAnswerScrollRef.current = null;
  }, [turns]);

  // Refresh the sidebar when the search changes.
  useEffect(() => {
    const timer = window.setTimeout(() => fetchRecentChats(searchQuery), searchQuery ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [searchQuery]);

  const fetchRecentChats = async (query = searchQuery) => {
    const requestId = ++chatRequestRef.current;
    setLoadingChats(true);
    setChatListError('');
    try {
      const headers = await getAuthHeaders();
      const url = new URL(`${API_BASE}/api/v1/chats`);
      if (query.trim()) url.searchParams.set('q', query.trim());
      const res = await fetch(url, {
        headers: { ...headers }
      });
      if (!res.ok) throw new Error(`Could not load chats (${res.status}).`);
      const data = await res.json();
      if (requestId === chatRequestRef.current) setRecentChats(data);
    } catch (err) {
      console.error("Failed to load chat history:", err);
      if (requestId === chatRequestRef.current) setChatListError('Could not load chats. Try again.');
    } finally {
      if (requestId === chatRequestRef.current) setLoadingChats(false);
    }
  };

  const loadChat = async (chatId, turnId = null) => {
    pendingAnswerScrollRef.current = null;
    if (activeRequestRef.current) {
      activeRequestRef.current.discardResult = true;
      cancelActivePrompt();
    }
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`${API_BASE}/api/v1/chats/${chatId}`, {
        headers: { ...headers }
      });
      if (res.ok) {
        const data = await res.json();
        setCachedAnswerIds(data.cached_answer_ids || []);
        setCacheChoiceError(null);
        setActiveConversationId(data.chat_id);
        setActiveParentId(data.turns.find((turn) => turn.chat_id === turnId)?.chat_id || data.turns.at(-1)?.chat_id || null);
        setFocusedTurnId(turnId);
        setTurns(orderConversationTurns(data.turns.map((turn) => {
          try {
            return { ...turn, response: JSON.parse(turn.response) };
          } catch {
            return { ...turn, response: null };
          }
        })));
        setPrompt('');
        setError(null);
        setAnswerFeedback({});
        setRetryError(null);
        // Close sidebar on mobile after selecting
        setIsSidebarOpen(false);
      }
    } catch (err) {
      console.error("Failed to load chat:", err);
    }
  };

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const conversationId = params.get('conversation');
    if (conversationId) loadChat(conversationId, params.get('turn'));
  }, [location.search]);

  useEffect(() => {
    if (!focusedTurnId || !turns.length) return;
    const frame = requestAnimationFrame(() => {
      document.getElementById(`chat-turn-${focusedTurnId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusedTurnId, turns]);

  const handleNewChat = () => {
    if (activeRequestRef.current) {
      activeRequestRef.current.discardResult = true;
      cancelActivePrompt();
    }
    navigate('/prompt', { replace: true });
    setActiveConversationId(null);
    setActiveParentId(null);
    setFocusedTurnId(null);
    setPrompt('');
    setTurns([]);
    setCachedAnswerIds([]);
    setCacheChoiceError(null);
    setAnswerFeedback({});
    setRetryError(null);
    pendingAnswerScrollRef.current = null;
    setError(null);
    setIsSidebarOpen(false);
  };

  const handleDeleteChat = async (chat) => {
    if (deletingChatId || (loading && activeConversationId === chat.chat_id)) return;
    setDeletingChatId(chat.chat_id);
    setDeleteChatError('');
    try {
      const headers = await getAuthHeaders();
      const response = await fetch(`${API_BASE}/api/v1/chats/${encodeURIComponent(chat.chat_id)}`, {
        method: 'DELETE', headers,
      });
      if (!response.ok) {
        const details = await response.json().catch(() => ({}));
        throw new Error(details.detail || `Could not delete this chat (${response.status}).`);
      }
      chatRequestRef.current += 1;
      setRecentChats(previous => previous.filter(item => item.chat_id !== chat.chat_id));
      if (activeConversationId === chat.chat_id) handleNewChat();
      fetchRecentChats(searchQuery);
    } catch (error) {
      setDeleteChatError(error.message || 'Could not delete this chat.');
    } finally {
      setDeletingChatId(null);
    }
  };

  const cancelActivePrompt = async () => {
    const active = activeRequestRef.current;
    if (!active || active.cancelRequested) return;
    active.cancelRequested = true;
    active.cancelled = true;
    active.discardResult = true;
    setStopping(true);
    setRetryingChatId(null);
    pendingAnswerScrollRef.current = null;
    if (!active.isRetry) setPrompt('');
    setTurns((current) => current.filter((turn) => turn.requestId !== active.requestId));
    active.controller.abort();
    if (active.started && active.headers) {
      try {
        const res = await fetch(`${API_BASE}/v1/chat/completions/${active.requestId}/cancel`, {
          method: 'POST',
          headers: active.headers,
        });
        if (!res.ok) throw new Error('Cancellation request failed.');
      } catch {
        if (activeRequestRef.current === active) setError('Could not confirm cancellation with the backend.');
      }
    }
    if (activeRequestRef.current === active) {
      activeRequestRef.current = null;
      setLoading(false);
      setStopping(false);
    }
  };

  const refreshCachedAnswers = async (conversationId) => {
    if (!conversationId) return;
    const headers = await getAuthHeaders();
    const res = await fetch(`${API_BASE}/api/v1/chats/${conversationId}`, { headers });
    if (!res.ok) throw new Error('Could not refresh the cache selection.');
    const data = await res.json();
    setCachedAnswerIds(data.cached_answer_ids || []);
  };

  const handleSelectCacheAnswer = async (turn) => {
    if (!turn.chat_id || !activeConversationId || cacheChoiceLoading || loading) return;
    setCacheChoiceLoading(turn.chat_id);
    setCacheChoiceError(null);
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`${API_BASE}/api/v1/chats/${activeConversationId}/cache-answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ chat_id: turn.chat_id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Could not save this answer to cache.');
      await refreshCachedAnswers(activeConversationId);
    } catch (err) {
      setCacheChoiceError({ chatId: turn.chat_id, message: err.message });
    } finally {
      setCacheChoiceLoading(null);
    }
  };

  const handleSubmit = async (retryTurn = null) => {
    const submittedPrompt = retryTurn ? retryTurn.prompt : prompt.trim();
    let retryChatId = retryTurn?.chat_id || retryTurn?.response?.optiroute?.chat_id;
    const conversationId = retryTurn
      ? retryTurn.response?.optiroute?.conversation_id || activeConversationId
      : activeConversationId;
    if (!submittedPrompt || activeRequestRef.current) return;
    const active = { requestId: crypto.randomUUID(), controller: new AbortController(), cancelled: false, cancelRequested: false, discardResult: false, started: false, headers: null, isRetry: Boolean(retryTurn) };
    activeRequestRef.current = active;
    setLoading(true);
    setRetryingChatId(retryChatId || null);
    setProgressMessage('Preparing your prompt...');
    setProgressErrors([]);
    setError(null);
    setRetryError(null);
    setFocusedTurnId(null);
    try {
      const headers = await getAuthHeaders();
      if (active.cancelled || active.cancelRequested || active.discardResult) return;
      active.headers = headers;
      if (retryTurn && !retryChatId) {
        if (!conversationId) throw new Error('Could not find the conversation for this answer.');
        const saved = await fetch(`${API_BASE}/api/v1/chats/${conversationId}`, {
          headers,
          signal: active.controller.signal,
        });
        if (!saved.ok) throw new Error('Could not load the saved answer for a heavier retry.');
        const chat = await saved.json();
        if (active.cancelled || active.cancelRequested || active.discardResult) return;
        const savedTurn = chat.turns?.find((turn) =>
          turn.turn_index === retryTurn.turn_index && turn.prompt === submittedPrompt
        );
        if (!savedTurn) {
          throw new Error('Could not find this answer in the saved chat. Reload the chat and try again.');
        }
        retryChatId = savedTurn.chat_id;
        setRetryingChatId(retryChatId);
        setTurns((current) => current.map((turn) =>
          turn === retryTurn ? { ...turn, chat_id: retryChatId } : turn
        ));
      }
      if (retryTurn && (!retryChatId || !conversationId)) {
        throw new Error('Could not identify the saved answer for a heavier retry.');
      }
      active.started = true;
      const res = await fetch(`${API_BASE}/v1/chat/completions${retryTurn ? '/retry/jobs' : '/jobs'}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        signal: active.controller.signal,
        body: JSON.stringify({
           model: "auto",
           request_id: active.requestId,
           messages: [{ role: "user", content: submittedPrompt }],
           ...(conversationId ? { conversation_id: conversationId } : {}),
           ...(!retryTurn && activeParentId ? { parent_chat_id: activeParentId } : {}),
           ...(retryChatId ? { retry_from_chat_id: retryChatId } : {})
        })
      });
      if (active.cancelled || active.cancelRequested || active.discardResult) return;
      if (res.status === 401) {
        await signOut(auth);
        navigate('/login');
        return;
      }
      let data = await res.json();
      if (active.cancelled || active.cancelRequested || active.discardResult) return;
      if (res.ok) {
        let pollFailures = 0;
        while (!active.cancelled && !active.discardResult) {
          await new Promise((resolve, reject) => {
            const onAbort = () => {
              window.clearTimeout(timer);
              reject(new DOMException('Request cancelled', 'AbortError'));
            };
            const timer = window.setTimeout(() => {
              active.controller.signal.removeEventListener('abort', onAbort);
              resolve();
            }, 1000);
            active.controller.signal.addEventListener('abort', onAbort, { once: true });
          });
          let statusResponse;
          try {
            statusResponse = await fetch(`${API_BASE}/v1/chat/completions/${active.requestId}/status`, {
              headers,
              signal: active.controller.signal,
            });
            if (!statusResponse.ok) throw new Error(`Status returned ${statusResponse.status}`);
            data = await statusResponse.json();
            pollFailures = 0;
          } catch (pollError) {
            if (pollError?.name === 'AbortError') throw pollError;
            if (++pollFailures < 10) continue;
            throw new Error('Lost contact with the backend while the answer was generating. Reload the chat to check its result.');
          }
          if (data.status === 'running') {
            if (data.message) setProgressMessage(data.message);
            if (Array.isArray(data.errors)) setProgressErrors(data.errors);
            continue;
          }
          if (data.status === 'completed') {
            data = data.result;
            break;
          }
          if (data.status === 'failed') throw new Error(data.error || 'All connected models failed to complete the answer.');
          if (data.status === 'cancelled') return;
          throw new Error('The answer job was interrupted. Reload the chat to check its result.');
        }
      }
      if (active.cancelled || active.cancelRequested || active.discardResult) return;
      if (!res.ok) {
        const message = retryTurn && res.status === 404
          ? 'The backend does not support heavier retries yet. Restart the backend and try again.'
          : data.detail || `Server returned error (${res.status})`;
        if (retryTurn) setRetryError({ chatId: retryChatId, message });
        else setError(message);
      } else if (retryTurn && (
        data.optiroute?.manual_escalation !== true ||
        data.optiroute?.retry_from_chat_id !== retryChatId ||
        data.optiroute?.cache_hit !== false ||
        ['light', 'mid', 'heavy'].indexOf(data.optiroute?.tier) <=
          ['light', 'mid', 'heavy'].indexOf(retryTurn.response?.optiroute?.tier)
      )) {
        setRetryError({
          chatId: retryChatId,
          message: 'The server returned a cached or non-heavier answer. Please restart the backend and try again.'
        });
      } else {
        pendingAnswerScrollRef.current = active.requestId;
        setTurns((current) => orderConversationTurns([...current, {
          chat_id: data.optiroute?.chat_id,
          turn_index: data.optiroute?.turn_index ?? current.length,
          prompt: submittedPrompt,
          response: data,
          requestId: active.requestId,
        }]));
        setActiveConversationId(data.optiroute?.conversation_id || activeConversationId);
        setActiveParentId(data.optiroute?.chat_id || null);
        refreshCachedAnswers(data.optiroute?.conversation_id || activeConversationId).catch(() => {});
        if (!retryTurn) setPrompt('');
        // Refresh the recent chats list so the new chat appears
        fetchRecentChats();
      }
    } catch (err) {
      if (!active.cancelled && !active.discardResult && err?.name !== 'AbortError') {
        console.error(err);
        const message = err?.message || "Failed to connect to the backend server. Please ensure the backend is running.";
        if (retryTurn) setRetryError({ chatId: retryChatId, message });
        else setError(message);
      }
    } finally {
      if (activeRequestRef.current === active && !active.cancelled) {
        activeRequestRef.current = null;
        setLoading(false);
        setRetryingChatId(null);
      }
    }
  };

  // Format date for sidebar display
  const formatDate = (dateStr) => {
    if (!dateStr) return '';
    const d = new Date(dateStr + 'Z'); // treat SQLite datetime as UTC
    const now = new Date();
    const diffMs = now - d;
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHrs = Math.floor(diffMins / 60);
    if (diffHrs < 24) return `${diffHrs}h ago`;
    const diffDays = Math.floor(diffHrs / 24);
    if (diffDays < 7) return `${diffDays}d ago`;
    return d.toLocaleDateString();
  };

  const renderComposer = (isFollowUp) => (
    <div className={isFollowUp ? 'w-full shrink-0 border-t border-white/40 bg-white/20 px-4 pt-3 pb-[calc(env(safe-area-inset-bottom)+12px)] backdrop-blur-md md:px-8' : 'w-full max-w-[820px] mb-7'}>
      {isFollowUp && turns.some((turn) => turn.response?.optiroute?.manual_escalation) && activeParentId && (
        <p className="mx-auto mb-2 w-full max-w-[820px] truncate font-radio-canada text-xs text-[#40546b]">
          Continuing from {turns.find((turn) => turn.chat_id === activeParentId)?.response?.optiroute?.model?.replace(/^models\//i, '') || 'the selected'} answer
        </p>
      )}
      {loading && <div role="status" aria-live="polite" className="mx-auto mb-2 w-full max-w-[820px] text-sm font-radio-canada text-[#40546b]">{stopping ? 'Stopping request...' : progressMessage}</div>}
      {loading && progressErrors.length > 0 && (
        <div role="log" aria-label="Provider issues" className="mx-auto mb-2 max-h-24 w-full max-w-[820px] space-y-1 overflow-y-auto font-radio-canada text-xs text-[#7d3c32]">
          {progressErrors.map((message, index) => <p key={`${index}-${message}`}>{message}</p>)}
        </div>
      )}
      <form
        className="mx-auto flex w-full max-w-[820px] items-end gap-3 rounded-[20px] border border-white/70 bg-white px-4 py-2 shadow-lg focus-within:ring-2 focus-within:ring-[#788FA8]/40"
        onSubmit={(event) => { event.preventDefault(); handleSubmit(); }}
      >
        <label htmlFor="prompt-composer" className="sr-only">Your prompt</label>
        <textarea
          id="prompt-composer"
          ref={promptInputRef}
          rows={1}
          value={prompt}
          disabled={loading}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              handleSubmit();
            }
          }}
          placeholder={activeConversationId ? 'Ask a follow-up question...' : 'Ask anything...'}
          className="block min-h-[40px] min-w-0 flex-1 resize-none border-none bg-transparent py-2 text-[15px] leading-6 text-gray-800 outline-none placeholder:text-gray-400 disabled:opacity-60 md:text-[16px] font-radio-canada"
        />
        {loading ? (
          <button type="button" onClick={cancelActivePrompt} disabled={stopping} aria-label="Stop generating" title="Stop generating" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#788FA8] text-black transition-colors hover:bg-[#546781] disabled:cursor-not-allowed disabled:opacity-40">
            <svg width="15" height="15" viewBox="0 0 15 15" fill="currentColor" aria-hidden="true"><rect x="2" y="2" width="11" height="11" rx="2" /></svg>
          </button>
        ) : (
          <button type="submit" disabled={!prompt.trim()} aria-label="Send prompt" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#788FA8] text-black transition-colors hover:bg-[#546781] disabled:cursor-not-allowed disabled:opacity-40">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5"></path><path d="m5 12 7-7 7 7"></path></svg>
          </button>
        )}
      </form>
    </div>
  );

  return (
    <div className="w-full h-dvh min-h-0 overflow-hidden relative flex" style={{ background: 'linear-gradient(180deg, #A8D3FF 0%, #FFF4DF 100%)' }}>
      
      {/* Top Navigation - Mobile Hamburger */}
      <button 
        className="md:hidden absolute top-4 left-4 z-30 p-2 text-black bg-[#788FA8]/40 rounded-lg backdrop-blur-sm border border-white/20"
        onClick={() => setIsSidebarOpen(!isSidebarOpen)}
        aria-label={isSidebarOpen ? 'Close sidebar' : 'Open sidebar'}
        aria-expanded={isSidebarOpen}
        aria-controls="prompt-sidebar"
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="3" y1="12" x2="21" y2="12"></line>
          <line x1="3" y1="6" x2="21" y2="6"></line>
          <line x1="3" y1="18" x2="21" y2="18"></line>
        </svg>
      </button>

      {/* Mobile Sidebar Overlay */}
      {isSidebarOpen && (
        <div 
          className="md:hidden fixed inset-0 bg-black/20 z-20"
          onClick={() => setIsSidebarOpen(false)}
        />
      )}

      {/* Left Sidebar */}
      <div id="prompt-sidebar" className={`fixed md:relative top-0 left-0 h-full shrink-0 bg-[#788FA8] md:bg-transparent z-30 transform ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full'} md:translate-x-0 transition-[transform,width,padding,opacity] duration-300 w-[min(280px,85vw)] flex flex-col pt-8 pl-6 pr-4 ${isDesktopSidebarOpen ? 'md:w-[min(320px,32vw)] md:pl-8 md:pr-4' : 'md:w-0 md:pl-0 md:pr-0 md:opacity-0 md:pointer-events-none md:overflow-hidden'}`}>
        {/* Logo and toggle */}
        <div className="flex items-center justify-between mb-10">
          <h1 className="font-radio-canada text-[24px] font-bold text-black">OptiRoute</h1>
          <button onClick={() => setIsSidebarOpen(false)} className="md:hidden text-black/70 hover:text-black">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </button>
          <button type="button" onClick={() => setIsDesktopSidebarOpen(false)} className="hidden md:flex items-center justify-center text-black/70 hover:text-black" aria-label="Close sidebar" aria-controls="prompt-sidebar" aria-expanded={isDesktopSidebarOpen}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
              <line x1="9" y1="3" x2="9" y2="21"></line>
              <polyline points="13 8 9 12 13 16"></polyline>
            </svg>
          </button>
        </div>

        {/* New Chat */}
        <div className="flex items-center gap-6 mb-8">
          <button 
            className="flex items-center gap-2 text-black font-radio-canada text-[14px] font-bold hover:opacity-80 transition-opacity"
            onClick={handleNewChat}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
            New Chat
          </button>
        </div>

        {/* Search */}
        <div className="flex items-center gap-2 mb-8 text-black bg-white/15 rounded-lg px-3 py-2 focus-within:ring-2 focus-within:ring-white/50">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 text-black/70"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
          <label htmlFor="chat-search" className="sr-only">Search chats</label>
          <input id="chat-search" type="search" value={searchQuery} onChange={event => { chatRequestRef.current += 1; setLoadingChats(true); setSearchQuery(event.target.value); }} placeholder="Search chats" autoComplete="off" className="w-full min-w-0 bg-transparent outline-none font-radio-canada text-[13px] text-black placeholder:text-black/70" />
          {searchQuery && <button type="button" aria-label="Clear chat search" onClick={() => { chatRequestRef.current += 1; setSearchQuery(''); }} className="shrink-0 text-black/70 hover:text-black">×</button>}
        </div>

        {/* Recent */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1">
          <h3 className="font-radio-canada text-[11px] font-bold text-black tracking-widest uppercase mb-4">{searchQuery.trim() ? 'Search results' : 'Recents'}</h3>
          {deleteChatError && <p role="alert" className="mb-3 text-[12px] font-radio-canada text-red-800">{deleteChatError}</p>}
          {chatListError ? (
            <p role="alert" className="text-black/80 font-radio-canada text-[13px]">{chatListError}</p>
          ) : loadingChats ? (
            <p className="text-black/50 font-radio-canada text-[13px]">Loading...</p>
          ) : recentChats.length === 0 ? (
            <p className="text-black/70 font-radio-canada text-[13px]">{searchQuery.trim() ? 'No matching chats.' : 'No chats yet. Start a conversation!'}</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {recentChats.map((chat) => (
                <li key={chat.chat_id} className={`group flex min-w-0 items-center gap-1 rounded-lg px-2 py-1.5 ${activeConversationId === chat.chat_id ? 'bg-white/15' : 'hover:bg-white/10'}`}>
                  <button
                  type="button"
                  className={`block min-w-0 flex-1 text-left font-radio-canada text-[13px] font-bold hover:text-black transition-colors ${
                    activeConversationId === chat.chat_id ? 'text-black' : 'text-black/90'
                  }`}
                  onClick={() => {
                    navigate('/prompt', { replace: true });
                    loadChat(chat.chat_id, chat.matching_turn_id);
                  }}
                  title={chat.title}
                >
                  <span className="block truncate">{chat.title || 'Untitled'}</span>
                  {searchQuery.trim() && chat.matching_prompt && <span className="block truncate text-[11px] font-normal text-black/65 mt-0.5">{chat.matching_prompt}</span>}
                  <span className="block text-[10px] font-normal text-black/40 mt-0.5">{formatDate(chat.created_at)}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeleteChat(chat)}
                    disabled={Boolean(deletingChatId) || (loading && activeConversationId === chat.chat_id)}
                    className="shrink-0 rounded-md p-1.5 text-black/55 hover:bg-red-100 hover:text-red-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-red-700 disabled:opacity-40"
                    aria-label={`Delete chat ${chat.title || 'Untitled'}`}
                    title="Delete chat and cached answers"
                  >
                    {deletingChatId === chat.chat_id ? <span className="text-[10px]">...</span> : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2m3 0-1 14H6L5 6m5 4v6m4-6v6" /></svg>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="relative min-w-0 min-h-0 flex-1 flex flex-col">
        <header className="pointer-events-none absolute inset-x-0 top-0 z-10 flex h-16 md:h-20 items-center justify-end px-4 md:px-8">
          {!isDesktopSidebarOpen && (
            <button type="button" onClick={() => setIsDesktopSidebarOpen(true)} className="pointer-events-auto hidden md:flex mr-auto items-center justify-center rounded-lg p-2 text-black/70 hover:bg-[#788FA8]/20 hover:text-black" aria-label="Open sidebar" aria-controls="prompt-sidebar" aria-expanded={isDesktopSidebarOpen}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                <line x1="9" y1="3" x2="9" y2="21"></line>
                <polyline points="11 8 15 12 11 16"></polyline>
              </svg>
            </button>
          )}
          <Link
            to="/dashboard/overview"
            className="pointer-events-auto flex items-center justify-center whitespace-nowrap bg-[#788FA8]/40 border border-white/20 rounded-[20px] px-3 py-1.5 text-black font-geist-mono font-medium text-[12px] md:text-[13px] hover:bg-[#788FA8]/60 transition-colors"
          >
            My dashboard
          </Link>
        </header>

      {/* Main Content Area */}
      <main ref={chatScrollRef} className={`min-w-0 min-h-0 flex-1 flex flex-col items-center overflow-y-auto overscroll-contain scroll-pt-20 pt-16 md:pt-20 px-3 sm:px-4 pb-6 ${turns.length === 0 ? 'justify-center' : ''}`}>
        {/* Title */}
        <div className="relative mb-6 md:mb-8">
          <h1 className="text-black font-radio-canada font-medium text-[clamp(1.55rem,7vw,2.75rem)] leading-tight text-center">
            {activeConversationId ? 'Continue the Conversation' : 'Sandbox your Idea'}
          </h1>
          <div className="absolute -bottom-1 md:-bottom-2 left-1/4 w-1/2 h-[3px] bg-[#3B82F6]"></div>
        </div>

        {turns.length === 0 && renderComposer(false)}

        {turns.length > 0 && (
          <div className="w-full max-w-[820px] flex flex-col gap-5 mb-7" aria-live="polite">
            {turns.map((turn, index) => (
              <div
                key={turn.chat_id || index}
                id={turn.chat_id ? `chat-turn-${turn.chat_id}` : undefined}
                className={`flex flex-col gap-3 rounded-[16px] ${focusedTurnId === turn.chat_id ? 'ring-2 ring-blue-500 ring-offset-4' : ''}`}
              >
                {!turn.response?.optiroute?.manual_escalation && turn.branchContext && (
                  <p className="self-start rounded-full bg-white/60 px-3 py-1 font-radio-canada text-xs text-[#40546b]">
                    {turn.branchContext === 'heavier'
                      ? 'Continued from the heavier answer above'
                      : 'Continued from the earlier answer above'}
                  </p>
                )}
                {!turn.response?.optiroute?.manual_escalation && (
                  <div className="self-end max-w-[95%] sm:max-w-[88%] bg-[#788FA8] text-black rounded-[16px] px-4 sm:px-5 py-3 font-radio-canada whitespace-pre-wrap break-words">
                    {turn.prompt}
                  </div>
                )}
                <div
                  id={turn.requestId ? `chat-answer-${turn.requestId}` : undefined}
                  className={`self-start w-full min-w-0 rounded-[16px] bg-white p-4 sm:p-6 shadow-sm ${turn.response?.optiroute?.manual_escalation ? 'shadow-[0_10px_30px_rgba(59,130,246,0.16)]' : ''}`}
                >
                  {turn.response?.optiroute?.manual_escalation ? (
                    <div className="-mx-4 -mt-4 mb-4 flex flex-wrap items-center justify-between gap-3 rounded-t-[16px] bg-[#24559a] px-4 py-4 font-radio-canada text-white sm:-mx-6 sm:-mt-6 sm:mb-6 sm:px-6">
                      <div className="flex items-center gap-3">
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/20 text-xl" aria-hidden="true">↑</span>
                        <div>
                          <p className="text-lg font-bold leading-tight">Heavier model answer</p>
                          <p className="text-sm text-white/85">New answer to the same prompt</p>
                        </div>
                      </div>
                      {turn.response.optiroute.tier && (
                        <span className="rounded-full bg-white/20 px-3 py-1 text-sm font-semibold capitalize">
                          {turn.response.optiroute.tier} tier
                        </span>
                      )}
                    </div>
                  ) : turn.superseded ? (
                    <div className="-mx-4 -mt-4 mb-4 rounded-t-[16px] bg-[#edf2f7] px-4 py-3 font-radio-canada sm:-mx-6 sm:-mt-6 sm:mb-6 sm:px-6">
                      <p className="font-bold text-[#40546b]">Earlier answer</p>
                      <p className="text-sm text-[#52677d]">A heavier model answer to this prompt appears below.</p>
                    </div>
                  ) : null}
                  {turn.response?.choices?.[0]?.message?.content ? (
                    <MarkdownRenderer>{turn.response.choices[0].message.content}</MarkdownRenderer>
                  ) : (
                    <p className="text-slate-500">
                      {turn.response?.choices?.[0]?.finish_reason === 'length'
                        ? 'This earlier response reached the model’s token limit before an answer appeared. Start a new chat and send the prompt again.'
                        : 'Response unavailable. Please send the prompt again.'}
                    </p>
                  )}
                  {turn.response?.optiroute && (
                    <div className="mt-4 min-w-0 break-words p-3 sm:p-4 bg-gray-50 rounded-lg text-xs sm:text-sm font-mono text-gray-600 space-y-1">
                      {turn.response.optiroute.quality_warning && (
                        <p role="status" className="mb-2 rounded-md bg-amber-100 px-3 py-2 font-sans text-amber-900">
                          {turn.response.optiroute.quality_warning}
                        </p>
                      )}
                      {turn.response.optiroute.cache_hit && (
                        <p className="mb-2 rounded-md bg-green-100 px-3 py-2 font-bold text-green-800">
                          Served from cache — no model call for this prompt
                        </p>
                      )}
                      <p><strong>Workload:</strong> {turn.response.optiroute.tier} tier</p>
                      <p><strong>{turn.response.optiroute.cache_hit ? 'Cached answer from:' : 'Model used:'}</strong> {turn.response.optiroute.model?.replace(/^models\//i, '')}</p>
                      <p><strong>Latency:</strong> {turn.response.optiroute.latency_ms}ms</p>
                      <p><strong>Cache Hit:</strong> {turn.response.optiroute.cache_hit ? 'Yes' : 'No'}</p>
                      {turn.response.optiroute.complexity_score > 0 && <p><strong>Complexity:</strong> {turn.response.optiroute.complexity_score}</p>}
                    </div>
                  )}
                  {(turn.superseded || turn.response?.optiroute?.manual_escalation) && turn.chat_id && (
                    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-[#edf2f7] px-4 py-3 font-radio-canada text-sm text-[#40546b]">
                      <span>{cachedAnswerIds.includes(turn.chat_id)
                        ? 'This answer is currently used for cached replies.'
                        : 'You can use this answer for future cached replies.'}</span>
                      {!cachedAnswerIds.includes(turn.chat_id) && (
                        <button
                          type="button"
                          disabled={loading || Boolean(cacheChoiceLoading)}
                          onClick={() => handleSelectCacheAnswer(turn)}
                          className="rounded-full bg-[#24559a] px-4 py-2 font-semibold text-white hover:bg-[#1b4278] disabled:opacity-50"
                        >
                          {cacheChoiceLoading === turn.chat_id ? 'Saving...' : 'Use this answer for cache'}
                        </button>
                      )}
                      {cacheChoiceError?.chatId === turn.chat_id && (
                        <p role="alert" className="w-full text-red-700">{cacheChoiceError.message}</p>
                      )}
                    </div>
                  )}
                  {turn.response?.optiroute?.tier && !turn.superseded && answerFeedback[turn.chat_id || turn.requestId] !== 'satisfied' && (
                    <div className="mt-4 border-t border-slate-200 pt-4 font-radio-canada text-sm text-slate-700">
                      {answerFeedback[turn.chat_id || turn.requestId] === 'heaviest' ? (
                        <p role="status">This response is already from the heaviest tier available.</p>
                      ) : (
                        <>
                          <p className="mb-3 font-semibold">Are you satisfied with this answer?</p>
                          <div className="flex flex-wrap gap-2">
                            <button type="button" disabled={loading} onClick={() => setAnswerFeedback((current) => ({ ...current, [turn.chat_id || turn.requestId]: 'satisfied' }))} className="rounded-full border border-slate-300 px-4 py-2 hover:bg-slate-50 disabled:opacity-50">Yes, satisfied</button>
                            <button type="button" disabled={loading} onClick={() => turn.response.optiroute.tier === 'heavy' ? setAnswerFeedback((current) => ({ ...current, [turn.chat_id || turn.requestId]: 'heaviest' })) : handleSubmit(turn)} className="rounded-full bg-[#788FA8] px-4 py-2 font-semibold text-black hover:bg-[#6b829c] disabled:opacity-50">Try a heavier model</button>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                  {retryError && retryError.chatId === (turn.chat_id || turn.response?.optiroute?.chat_id) && (
                    <p role="alert" className="mt-3 font-radio-canada text-sm text-red-700">{retryError.message}</p>
                  )}
                  {loading && retryingChatId === turn.chat_id && (
                    <p role="status" className="mt-3 rounded-lg bg-[#788FA8]/15 px-4 py-3 font-radio-canada text-sm text-[#40546b]">
                      {progressMessage}
                    </p>
                  )}
                  {turn.chat_id && (
                    <div className="mt-3 font-radio-canada text-xs text-[#40546b]">
                      {activeParentId === turn.chat_id ? (
                        <span aria-current="true">Your next question will continue from this answer.</span>
                      ) : (
                        <button
                          type="button"
                          disabled={loading}
                          onClick={() => setActiveParentId(turn.chat_id)}
                          className="font-semibold underline underline-offset-2 hover:text-black disabled:opacity-50"
                        >
                          Continue from this answer
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {error && (
          <div className="w-full max-w-[820px] bg-red-50 border border-red-300 text-red-800 rounded-[16px] shadow-sm p-5 mb-6 text-sm font-radio-canada">
            <p className="font-bold mb-1">Request Error:</p>
            <p className="whitespace-pre-wrap">{error}</p>
            {error.includes('Add a model and API key') && <Link to="/dashboard/routing-policies" className="inline-block mt-3 font-bold underline">Set up your model workflows</Link>}
          </div>
        )}

        {/* Routing guide stays visible until the first response arrives. */}
        {turns.length === 0 && <div className="w-full max-w-[540px]">
          {/* Header */}
          <div 
            className={`w-full bg-[#788FA8] ${isPolicyOpen ? 'rounded-t-[12px]' : 'rounded-[12px]'} px-4 md:px-6 py-3 md:py-4 flex items-center justify-between cursor-pointer border border-white/10`}
            onClick={() => setIsPolicyOpen(!isPolicyOpen)}
          >
            <div className="flex items-center gap-3 md:gap-4">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="black" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="md:w-5 md:h-5 flex-shrink-0"><circle cx="18" cy="18" r="3"></circle><circle cx="6" cy="6" r="3"></circle><path d="M13 6h3a2 2 0 0 1 2 2v7"></path><line x1="6" y1="9" x2="6" y2="21"></line></svg>
              <div className="min-w-0">
                <p className="text-black/60 font-radio-canada font-bold text-[9px] md:text-[10px] tracking-widest uppercase mb-0.5">Automatic routing</p>
                <p className="text-black font-radio-canada font-bold text-[12px] md:text-[14px] leading-snug">
                  Each prompt gets its own workload analysis
                </p>
              </div>
            </div>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="black" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform flex-shrink-0 ${isPolicyOpen ? 'rotate-180' : ''}`}>
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
          </div>
          
          {/* Dropdown Options */}
          {isPolicyOpen && (
            <div className="w-full bg-[#788FA8] border-t border-white/10 rounded-b-[12px] p-2 flex flex-col shadow-lg border-x border-b border-white/10">
              <div className="w-full bg-white/20 rounded-[8px] px-3 md:px-4 py-2.5 md:py-3 flex items-center gap-3">
                <span className="w-1.5 h-1.5 bg-blue-500 rounded-full flex-shrink-0"></span>
                <span className="text-black font-radio-canada font-bold text-[12px] md:text-[13px] leading-snug">Light tasks → your light tier model</span>
              </div>
              <div className="w-full rounded-[8px] px-3 md:px-4 py-2.5 md:py-3 flex items-center gap-3">
                <span className="w-1.5 h-1.5 bg-green-500 rounded-full flex-shrink-0"></span>
                <span className="text-black font-radio-canada font-bold text-[12px] md:text-[13px] leading-snug">Moderate tasks → your medium tier model</span>
              </div>
              <div className="w-full rounded-[8px] px-3 md:px-4 py-2.5 md:py-3 flex items-center gap-3">
                <span className="w-1.5 h-1.5 bg-rose-500 rounded-full flex-shrink-0"></span>
                <span className="text-black font-radio-canada font-bold text-[12px] md:text-[13px] leading-snug">Complex tasks → your heavy tier model</span>
              </div>
              <div className="w-full rounded-[8px] px-3 md:px-4 py-2.5 md:py-3 flex items-center gap-3">
                <span className="w-1.5 h-1.5 bg-violet-500 rounded-full flex-shrink-0"></span>
                <span className="text-black font-radio-canada font-bold text-[12px] md:text-[13px] leading-snug">Repeated questions reuse a context-matched cache entry</span>
              </div>
            </div>
          )}
        </div>}

      </main>
      {/* Keep the composer visible while the conversation scrolls. */}
      {turns.length > 0 && renderComposer(true)}
      </div>
    </div>
  );
};

export default PromptPage;
