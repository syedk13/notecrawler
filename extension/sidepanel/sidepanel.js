const FORCE_MOCK_FAILURE = false;

let conversationState = [];
let activeThreadId = 'main';
let sessions = {};
let activeSessionId = '';
let activeTab = 'conversation';
let pendingAnnotationRefs = [];
const selectedAnnotationIds = new Set();

// --- Storage helpers ---

function createFreshSession() {
    return {
        id: crypto.randomUUID(),
        title: null,
        conversationState: [],
        annotations: [],
        activeThreadId: 'main',
        tabIds: [],
        createdAt: Date.now()
    };
}

async function readSessions() {
    const result = await chrome.storage.local.get(['sessions', 'activeSessionId']);
    return {
        sessions: result.sessions || {},
        activeSessionId: result.activeSessionId || ''
    };
}

async function ensureActiveSession() {
    const { sessions: s, activeSessionId: sid } = await readSessions();
    if (sid && s[sid]) return { sessions: s, activeSessionId: sid };
    const session = createFreshSession();
    const newSessions = { ...s, [session.id]: session };
    await chrome.storage.local.set({ sessions: newSessions, activeSessionId: session.id });
    return { sessions: newSessions, activeSessionId: session.id };
}

async function modifySession(updater) {
    const { sessions: s, activeSessionId: sid } = await readSessions();
    if (!s[sid]) return;
    await chrome.storage.local.set({ sessions: { ...s, [sid]: updater(s[sid]) } });
}

// Preserved signature — used by generateResponse and retry handler.
async function modifyState(updater) {
    await modifySession(session => ({
        ...session,
        conversationState: updater(session.conversationState || [])
    }));
}

async function setActiveThread(threadId) {
    await modifySession(session => ({ ...session, activeThreadId: threadId }));
}

async function setActiveSession(sessionId) {
    await chrome.storage.local.set({ activeSessionId: sessionId });
}

async function startNewSession() {
    const { sessions: s } = await readSessions();
    const session = createFreshSession();
    await chrome.storage.local.set({
        sessions: { ...s, [session.id]: session },
        activeSessionId: session.id
    });
}

// Ask the background service worker for the active tab id.
// chrome.tabs.getCurrent() returns undefined in side-panel contexts.
async function getCurrentTabId() {
    return new Promise(resolve => {
        chrome.runtime.sendMessage({ type: 'GET_CURRENT_TAB' }, response => {
            if (chrome.runtime.lastError) { resolve(null); return; }
            resolve(response?.tabId ?? null);
        });
    });
}

// Add tabId to a specific session's tabIds (no-op if already present or tabId is null).
async function addTabToSession(sessionId, tabId) {
    if (tabId == null) return;
    const { sessions: s } = await readSessions();
    const session = s[sessionId];
    if (!session) return;
    const tabIds = session.tabIds || [];
    if (tabIds.includes(tabId)) return;
    await chrome.storage.local.set({
        sessions: { ...s, [sessionId]: { ...session, tabIds: [...tabIds, tabId] } }
    });
}

// --- View filter ---

function getThreadMessages() {
    if (activeThreadId === 'main') {
        return conversationState.filter(m => m.threadId === 'main');
    }
    // Fork view: pull in the anchor highlight AND its summary as the header.
    // Both live in 'main' (stored once) but are displayed at the top of the fork.
    const anchor = conversationState.find(m => m.id === activeThreadId && m.threadId === 'main');
    const summary = conversationState.find(
        m => m.role === 'model' && m.type === 'summary' && m.contextRef === activeThreadId
    );
    const threadMessages = conversationState.filter(m => m.threadId === activeThreadId);

    const header = [];
    if (anchor) header.push(anchor);
    if (summary) header.push(summary);
    return [...header, ...threadMessages];
}

// --- Thread menu helpers ---

function getThreadLabel(threadId) {
    if (threadId === 'main') return 'Main Conversation';
    const anchor = conversationState.find(m => m.id === threadId && m.threadId === 'main');
    if (!anchor) return threadId.slice(0, 8) + '…';
    const raw = anchor.content.trim();
    return raw.length > 40 ? raw.slice(0, 40) + '…' : raw;
}

function getDerivedThreadIds() {
    const ids = new Set(['main']);
    for (const m of conversationState) ids.add(m.threadId);
    if (activeThreadId !== 'main') ids.add(activeThreadId);
    return ids;
}

// --- Response reconciliation ---
// A pending message needs a response if no model message already references it.
// This is idempotent: safe to call from both the initial read and onChanged,
// and it never double-triggers because it checks for an existing response.

const inFlight = new Set();

function pendingNeedsResponse(state, msg) {
    if (msg.role !== 'user' || msg.status !== 'pending') return false;
    if (inFlight.has(msg.id)) return false;
    const hasResponse = state.some(m => m.role === 'model' && m.replyTo === msg.id);
    return !hasResponse;
}

function reconcilePending(state) {
    for (const msg of state) {
        if (pendingNeedsResponse(state, msg)) {
            inFlight.add(msg.id);
            generateResponse(msg.id);
        }
    }
}

// --- DOM builders ---

function createHighlightCard(message) {
    const wrapper = document.createElement('div');
    wrapper.dataset.id = message.id;

    const card = document.createElement('div');
    card.classList.add('highlight-item', 'line-clamp-5');
    card.dataset.expandContent = message.id;
    card.textContent = message.content;
    wrapper.appendChild(card);

    const moreBtn = document.createElement('button');
    moreBtn.textContent = 'more';
    moreBtn.dataset.expandToggle = message.id;
    moreBtn.style.display = 'none';
    moreBtn.classList.add('text-xs', 'text-blue-400', 'hover:underline', 'block', 'mt-1');
    wrapper.appendChild(moreBtn);

    if (message.status === 'failed') {
        const retryBtn = document.createElement('button');
        retryBtn.textContent = 'Retry';
        retryBtn.dataset.retryId = message.id;
        retryBtn.classList.add('text-xs', 'text-red-500', 'hover:underline', 'mt-1', 'block');
        wrapper.appendChild(retryBtn);
    }

    return wrapper;
}

function createLoadingIndicator() {
    const wrapper = document.createElement('div');
    wrapper.classList.add('flex', 'justify-start');

    const bubble = document.createElement('div');
    bubble.classList.add(
        'max-w-[85%]', 'rounded-lg', 'px-3', 'py-2', 'text-sm',
        'bg-gray-100', 'text-gray-500', 'italic'
    );
    bubble.textContent = 'Generating response…';

    wrapper.appendChild(bubble);
    return wrapper;
}

function createChatBubble(message) {
    const isUser = message.role === 'user';
    const isFailed = isUser && message.status === 'failed';
    const hasRefs = isUser && message.annotationRefs && message.annotationRefs.length > 0;

    const wrapper = document.createElement('div');
    if (!isUser) {
        wrapper.classList.add('flex', 'flex-col', 'items-start', 'gap-0.5');
    } else if (isFailed || hasRefs) {
        wrapper.classList.add('flex', 'flex-col', 'items-end', 'gap-1');
    } else {
        wrapper.classList.add('flex', 'justify-end');
    }
    wrapper.dataset.id = message.id;

    const bubble = document.createElement('div');
    bubble.classList.add(
        'max-w-[85%]', 'rounded-lg', 'px-3', 'py-2', 'text-sm', 'whitespace-pre-wrap',
        ...(isUser ? ['bg-blue-600', 'text-white'] : ['bg-gray-100', 'text-gray-800'])
    );
    bubble.textContent = message.content;
    wrapper.appendChild(bubble);

    if (isFailed) {
        const retryBtn = document.createElement('button');
        retryBtn.textContent = 'Retry';
        retryBtn.dataset.retryId = message.id;
        retryBtn.classList.add('text-xs', 'text-red-500', 'hover:underline');
        wrapper.appendChild(retryBtn);
    }

    // Fork button appears only on a summary, and only while viewing main.
    // In a fork the summary is shown as a header, so it must not offer forking.
    if (message.role === 'model' && message.type === 'summary' && activeThreadId === 'main') {
        const forkBtn = document.createElement('button');
        forkBtn.textContent = 'Fork thread';
        forkBtn.dataset.forkAnchor = message.contextRef;
        forkBtn.classList.add('text-xs', 'text-blue-400', 'hover:underline');
        wrapper.appendChild(forkBtn);
    }

    // Collapsed reference toggle for synthesis messages.
    if (hasRefs) {
        const count = message.annotationRefs.length;
        const refToggle = document.createElement('button');
        refToggle.textContent = `Using ${count} annotation${count !== 1 ? 's' : ''} ▸`;
        refToggle.dataset.toggleRefs = message.id;
        refToggle.classList.add('text-xs', 'text-blue-400', 'hover:underline');
        wrapper.appendChild(refToggle);

        // Hidden container for the expanded ref list, rendered on first open.
        const refsExpanded = document.createElement('div');
        refsExpanded.id = `refs-${message.id}`;
        refsExpanded.style.display = 'none';
        refsExpanded.classList.add('flex', 'flex-col', 'items-end', 'gap-1');
        wrapper.appendChild(refsExpanded);
    }

    return wrapper;
}

// --- Render ---

function renderConversation(container) {
    container.innerHTML = '';

    const messages = getThreadMessages();

    if (!messages.length) {
        const emptyState = document.createElement('p');
        emptyState.textContent = 'Select text on any page and choose "Ask NoteCrawler" to start a conversation.';
        emptyState.classList.add('empty-state');
        container.appendChild(emptyState);
        container.scrollTop = container.scrollHeight;
        return;
    }

    for (const message of messages) {
        const el = (message.role === 'user' && message.type === 'highlight')
            ? createHighlightCard(message)
            : createChatBubble(message);
        container.appendChild(el);

        // Reveal "more" toggle for clamped highlight cards that actually overflow.
        const clampedText = el.querySelector('[data-expand-content]');
        const moreBtn = el.querySelector('[data-expand-toggle]');
        if (clampedText && moreBtn && clampedText.scrollHeight > clampedText.clientHeight) {
            moreBtn.style.display = '';
        }

        // Show the loading indicator for a pending message that has no response yet.
        const awaitingResponse = message.role === 'user'
            && message.status === 'pending'
            && !conversationState.some(m => m.role === 'model' && m.replyTo === message.id);
        if (awaitingResponse) {
            container.appendChild(createLoadingIndicator());
        }
    }

    container.scrollTop = container.scrollHeight;
}

async function renderContextCard() {
    const card = document.getElementById('context-card');
    if (!card) return;

    card.style.display = '';
    card.innerHTML = '';

    // Priority 1: annotations staged card.
    if (pendingAnnotationRefs.length > 0) {
        const session = sessions[activeSessionId] || {};
        const annotations = session.annotations || [];

        const header = document.createElement('div');
        header.classList.add('flex', 'items-center', 'justify-between');

        const label = document.createElement('span');
        label.classList.add('text-xs', 'font-medium', 'text-gray-600');
        const n = pendingAnnotationRefs.length;
        label.textContent = `${n} annotation${n !== 1 ? 's' : ''} staged`;

        const dismissBtn = document.createElement('button');
        dismissBtn.id = 'dismiss-context-card';
        dismissBtn.textContent = '×';
        dismissBtn.classList.add('text-gray-400', 'hover:text-gray-700', 'text-base', 'leading-none', 'px-1');

        header.appendChild(label);
        header.appendChild(dismissBtn);
        card.appendChild(header);

        for (const id of pendingAnnotationRefs) {
            const ann = annotations.find(a => a.id === id);
            const row = document.createElement('p');
            row.classList.add('text-xs', 'text-gray-500', 'truncate', 'mt-1');
            if (ann) {
                const excerpt = ann.content.length > 40 ? ann.content.slice(0, 40) + '…' : ann.content;
                row.textContent = ann.pageTitle ? `${ann.pageTitle} — ${excerpt}` : excerpt;
            } else {
                row.textContent = '(annotation removed)';
                row.classList.add('italic');
            }
            card.appendChild(row);
        }
        return;
    }

    // Priority 2: tab-tracking indicator (display-only).
    const session = sessions[activeSessionId] || {};
    const tabIds = session.tabIds || [];

    const header = document.createElement('div');
    header.classList.add('flex', 'items-center', 'justify-between');

    const label = document.createElement('span');
    label.classList.add('text-xs', 'font-medium', 'text-gray-600');
    const n = tabIds.length;
    label.textContent = `${n} tab${n !== 1 ? 's' : ''} in scope`;

    header.appendChild(label);
    card.appendChild(header);

    for (const tabId of tabIds) {
        // tab.title requires the "tabs" manifest permission; falls back to id-based label.
        let title = '';
        try {
            const tab = await chrome.tabs.get(tabId);
            title = tab.title || '';
        } catch {
            // Tab closed but not yet pruned — show neutral fallback.
        }
        const row = document.createElement('p');
        row.classList.add('text-xs', 'text-gray-500', 'truncate', 'mt-1');
        row.textContent = title || `Tab ${tabId}`;
        card.appendChild(row);
    }
}

function createSessionMenuItem(sessionId, label) {
    const btn = document.createElement('button');
    btn.classList.add(
        'w-full', 'text-left', 'px-3', 'py-1.5', 'text-xs',
        'hover:bg-gray-50', 'text-gray-700', 'truncate'
    );
    if (sessionId === activeSessionId) btn.classList.add('font-semibold', 'text-blue-600');
    btn.textContent = label;
    btn.dataset.sessionId = sessionId;
    return btn;
}

function createThreadMenuItem(threadId, label, isChild) {
    const btn = document.createElement('button');
    btn.classList.add(
        'w-full', 'text-left', 'px-3', 'py-1.5', 'text-xs',
        'hover:bg-gray-50', 'text-gray-700', 'truncate'
    );
    if (isChild) btn.classList.add('pl-6');
    if (threadId === activeThreadId) btn.classList.add('font-semibold', 'text-blue-600');
    // 'main' never gets ↳ even when indented under a session entry
    btn.textContent = (isChild && threadId !== 'main' ? '↳ ' : '') + label;
    btn.dataset.threadId = threadId;
    return btn;
}

function renderThreadMenu() {
    const menu = document.getElementById('thread-menu');
    const titleEl = document.getElementById('thread-title');
    if (!menu) return;

    menu.innerHTML = '';

    // Sessions at top level (only titled sessions appear)
    const sortedSessions = Object.values(sessions)
        .filter(s => s.title !== null)
        .sort((a, b) => a.createdAt - b.createdAt);

    for (const session of sortedSessions) {
        menu.appendChild(createSessionMenuItem(session.id, session.title));

        // Indented threads appear only under the active session
        if (session.id === activeSessionId) {
            menu.appendChild(createThreadMenuItem('main', 'Main Conversation', true));
            const threadIds = getDerivedThreadIds();
            for (const id of threadIds) {
                if (id === 'main') continue;
                menu.appendChild(createThreadMenuItem(id, getThreadLabel(id), true));
            }
        }
    }

    if (titleEl) {
        const activeSession = sessions[activeSessionId];
        titleEl.textContent = activeSession?.title || getThreadLabel(activeThreadId);
    }
}

// --- Response pipeline ---
// FORCE_MOCK_FAILURE bypasses the fetch and forces the failed state so the
// retry UI can be tested without stopping the server.

async function generateResponse(messageId) {
    try {
        if (FORCE_MOCK_FAILURE) {
            await modifyState(state =>
                state.map(msg => msg.id === messageId ? { ...msg, status: 'failed' } : msg)
            );
            return;
        }

        // Fresh storage read so parent is always found even when called immediately
        // after submitMessage (before onChanged has synced module-level state).
        const { sessions: s, activeSessionId: sid } = await readSessions();
        const sessionData = s[sid] || {};
        const parent = (sessionData.conversationState || []).find(m => m.id === messageId);
        if (!parent) return;

        // A highlight's summary references the highlight's OWN id.
        // A chat reply inherits its parent's contextRef.
        const responseContextRef = parent.type === 'highlight' ? parent.id : parent.contextRef;
        const responseType = parent.type === 'highlight' ? 'summary' : 'text';

        // Build sources and prompt for three distinct cases.
        let sources;
        let prompt;
        if (parent.type === 'highlight') {
            // Case 1: automatic highlight summary — no tab content.
            sources = [{ content: parent.content, sourceUrl: '', pageTitle: '' }];
            prompt = 'summarize';
        } else if (parent.annotationRefs && parent.annotationRefs.length > 0) {
            // Case 2: cross-source synthesis — question asked over staged annotations.
            const sessionAnnotations = sessionData.annotations || [];
            sources = parent.annotationRefs
                .map(id => sessionAnnotations.find(a => a.id === id))
                .filter(Boolean)
                .map(a => ({ content: a.content, sourceUrl: a.sourceUrl || '', pageTitle: a.pageTitle || '' }));
            if (sources.length === 0) {
                // All referenced annotations were removed; send empty sources so the
                // model still attempts to answer from the question alone.
                sources = [];
            }
            prompt = parent.content;
        } else {
            // Case 3: plain typed question, optionally in a fork with an anchor highlight.
            prompt = parent.content;
            if (parent.contextRef) {
                const anchor = (sessionData.conversationState || []).find(m => m.id === parent.contextRef);
                sources = anchor
                    ? [{ content: anchor.content, sourceUrl: '', pageTitle: '' }]
                    : [];
            } else {
                sources = [];
            }
        }

        // Supplement Cases 2 & 3 with live content from the session's in-scope tabs.
        // The highlight-summarize path is excluded — it must not gather tab content.
        if (parent.type !== 'highlight') {
            const tabIds = sessionData.tabIds || [];
            if (tabIds.length > 0) {
                try {
                    const tabResults = await new Promise(resolve => {
                        chrome.runtime.sendMessage({ type: 'READ_SESSION_TABS', tabIds }, results => {
                            if (chrome.runtime.lastError) { resolve([]); return; }
                            resolve(Array.isArray(results) ? results : []);
                        });
                    });
                    // Merge, deduplicating by sourceUrl (empty URLs are not considered duplicates).
                    const seenUrls = new Set(sources.map(s => s.sourceUrl).filter(Boolean));
                    for (const { content, sourceUrl, pageTitle } of tabResults) {
                        if (!sourceUrl || !seenUrls.has(sourceUrl)) {
                            sources.push({ content, sourceUrl, pageTitle });
                            if (sourceUrl) seenUrls.add(sourceUrl);
                        }
                    }
                } catch {
                    // Tab content is additive context — a failure here never blocks the request.
                }
            }
        }

        let reply;
        try {
            const res = await fetch('http://localhost:3000/generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sources, prompt, history: [] })
            });
            if (!res.ok) throw new Error(`Server responded with ${res.status}`);
            const data = await res.json();
            if (typeof data.reply !== 'string') throw new Error('Malformed server response');
            reply = data.reply;
        } catch (err) {
            console.error('NoteCrawler /generate request failed:', err);
            await modifyState(state =>
                state.map(msg => msg.id === messageId ? { ...msg, status: 'failed' } : msg)
            );
            return;
        }

        await modifyState(state => {
            const updated = state.map(msg =>
                msg.id === messageId ? { ...msg, status: 'answered' } : msg
            );
            updated.push({
                id: crypto.randomUUID(),
                role: 'model',
                type: responseType,
                content: reply,
                contextRef: responseContextRef,
                threadId: parent.threadId,
                replyTo: parent.id,
                timestamp: Date.now()
            });
            return updated;
        });
    } finally {
        inFlight.delete(messageId);
    }
}

// --- Submission ---

async function submitMessage(text) {
    const messageId = crypto.randomUUID();
    const capturedThreadId = activeThreadId;
    const contextRef = capturedThreadId === 'main' ? null : capturedThreadId;
    // Snapshot staged refs so the write and the clear are based on the same list.
    const capturedRefs = [...pendingAnnotationRefs];

    inFlight.add(messageId);
    // Use modifySession directly so we can set the session title alongside the message.
    await modifySession(session => {
        const message = {
            id: messageId,
            role: 'user',
            type: 'text',
            content: text,
            contextRef,
            threadId: capturedThreadId,
            status: 'pending',
            timestamp: Date.now()
        };
        if (capturedRefs.length > 0) {
            message.annotationRefs = capturedRefs;
        }
        const messages = [...(session.conversationState || []), message];
        const trimmed = text.trim();
        const title = session.title === null
            ? (trimmed.length > 40 ? trimmed.slice(0, 40) + '…' : trimmed)
            : session.title;
        return { ...session, conversationState: messages, title };
    });

    if (capturedRefs.length > 0) {
        await chrome.storage.local.set({ pendingAnnotationRefs: [] });
    }

    generateResponse(messageId);
}

// --- Annotations view ---

function updateAskButton() {
    const askBtn = document.getElementById('ask-btn');
    if (!askBtn) return;
    const hasSelection = selectedAnnotationIds.size > 0;
    askBtn.disabled = !hasSelection;
    askBtn.style.opacity = hasSelection ? '' : '0.5';
    askBtn.style.cursor = hasSelection ? '' : 'not-allowed';
}

function renderAnnotations() {
    const list = document.getElementById('annotations-list');
    if (!list) return;

    const session = sessions[activeSessionId] || {};
    const annotations = (session.annotations || []).slice().sort((a, b) => b.timestamp - a.timestamp);

    list.innerHTML = '';

    if (!annotations.length) {
        const empty = document.createElement('p');
        empty.textContent = 'No annotations yet. Select text on a page and choose "Add annotation."';
        empty.classList.add('empty-state');
        list.appendChild(empty);
        return;
    }

    for (const ann of annotations) {
        const isSelected = selectedAnnotationIds.has(ann.id);

        const card = document.createElement('div');
        card.dataset.annotationId = ann.id;
        card.classList.add('rounded-lg', 'border', 'p-3');
        if (isSelected) {
            card.classList.add('bg-gray-100', 'border-gray-300');
        } else {
            card.classList.add('border-gray-200');
        }
        card.style.cursor = 'pointer';

        const content = document.createElement('p');
        content.classList.add('text-sm', 'text-gray-800', 'line-clamp-5');
        content.dataset.expandContent = ann.id;
        content.textContent = ann.content;

        const moreBtn = document.createElement('button');
        moreBtn.textContent = 'more';
        moreBtn.dataset.expandToggle = ann.id;
        moreBtn.style.display = 'none';
        moreBtn.classList.add('text-xs', 'text-blue-400', 'hover:underline', 'block', 'mt-1');

        const meta = document.createElement('p');
        meta.classList.add('text-xs', 'text-gray-400', 'mt-1');
        const truncUrl = ann.sourceUrl.length > 40 ? ann.sourceUrl.slice(0, 40) + '…' : ann.sourceUrl;
        meta.textContent = `${ann.pageTitle} · ${truncUrl}`;

        card.appendChild(content);
        card.appendChild(moreBtn);
        card.appendChild(meta);
        list.appendChild(card);

        // Reveal "more" toggle only if the clamped text actually overflows.
        if (content.scrollHeight > content.clientHeight) {
            moreBtn.style.display = '';
        }
    }
}

function switchTab(tab) {
    activeTab = tab;
    const isConv = tab === 'conversation';

    const convView = document.getElementById('conversation-view');
    const annView = document.getElementById('annotations-view');
    const tabConv = document.getElementById('tab-conversation');
    const tabAnn = document.getElementById('tab-annotations');

    if (convView) convView.style.display = isConv ? '' : 'none';
    if (annView) annView.style.display = isConv ? 'none' : '';

    if (tabConv) {
        tabConv.classList.toggle('font-semibold', isConv);
        tabConv.classList.toggle('text-blue-600', isConv);
        tabConv.classList.toggle('text-gray-500', !isConv);
    }
    if (tabAnn) {
        tabAnn.classList.toggle('font-semibold', !isConv);
        tabAnn.classList.toggle('text-blue-600', !isConv);
        tabAnn.classList.toggle('text-gray-500', isConv);
    }

    if (tab === 'annotations') renderAnnotations();
}

// --- Init ---

document.addEventListener('DOMContentLoaded', async () => {
    const container = document.getElementById('side-panel-content');
    if (!container) {
        console.error('Side Panel container not found.');
        return;
    }

    const textarea = document.getElementById('user-input');
    const sendBtn = document.getElementById('send-btn');
    const menuBtn = document.getElementById('menu-btn');
    const threadMenu = document.getElementById('thread-menu');
    const contextCard = document.getElementById('context-card');
    const tabConversationBtn = document.getElementById('tab-conversation');
    const tabAnnotationsBtn = document.getElementById('tab-annotations');
    const annotationsListEl = document.getElementById('annotations-list');
    const askBtnEl = document.getElementById('ask-btn');
    const newChatBtn = document.getElementById('new-chat-btn');

    const init = await ensureActiveSession();
    sessions = init.sessions;
    activeSessionId = init.activeSessionId;

    // Auto-associate this tab with the active session on open.
    const openingTabId = await getCurrentTabId();
    await addTabToSession(activeSessionId, openingTabId);
    // Refresh so the initial render reflects the newly joined tab.
    const refreshed = await readSessions();
    sessions = refreshed.sessions;

    const initSession = sessions[activeSessionId] || {};
    conversationState = initSession.conversationState || [];
    activeThreadId = initSession.activeThreadId || 'main';

    // Load any refs that were staged before the panel opened.
    const refsResult = await chrome.storage.local.get('pendingAnnotationRefs');
    pendingAnnotationRefs = refsResult.pendingAnnotationRefs || [];

    renderConversation(container);
    renderThreadMenu();
    renderContextCard();

    // Trigger responses for any pending messages that arrived while the panel
    // was closed (e.g. a context-menu highlight). Idempotent.
    reconcilePending(conversationState);

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;

        if (changes.sessions) {
            sessions = changes.sessions.newValue || {};
        }
        if (changes.activeSessionId) {
            activeSessionId = changes.activeSessionId.newValue || '';
        }
        if (changes.pendingAnnotationRefs) {
            pendingAnnotationRefs = changes.pendingAnnotationRefs.newValue || [];
            renderContextCard();
        }

        if (changes.sessions || changes.activeSessionId) {
            const session = sessions[activeSessionId] || {};
            conversationState = session.conversationState || [];
            activeThreadId = session.activeThreadId || 'main';
            reconcilePending(conversationState);
            renderConversation(container);
            renderThreadMenu();
            renderContextCard();
            if (activeTab === 'annotations') renderAnnotations();
        }
    });

    function handleSubmit() {
        const text = textarea.value.trim();
        if (!text) return;
        textarea.value = '';
        submitMessage(text);
    }

    sendBtn.addEventListener('click', handleSubmit);

    textarea.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSubmit();
        }
    });

    menuBtn.addEventListener('click', e => {
        e.stopPropagation();
        threadMenu.classList.toggle('hidden');
    });

    document.addEventListener('click', () => {
        threadMenu.classList.add('hidden');
    });

    threadMenu.addEventListener('click', async e => {
        const sessionId = e.target.dataset.sessionId;
        if (sessionId) {
            await setActiveSession(sessionId);
            // Also join this tab to the selected session so it appears in scope.
            const tabId = await getCurrentTabId();
            await addTabToSession(sessionId, tabId);
            return;
        }
        const threadId = e.target.dataset.threadId;
        if (!threadId) return;
        await setActiveThread(threadId);
    });

    contextCard.addEventListener('click', async e => {
        if (e.target.id === 'dismiss-context-card') {
            await chrome.storage.local.set({ pendingAnnotationRefs: [] });
        }
    });

    container.addEventListener('click', async e => {
        const retryId = e.target.dataset.retryId;
        if (retryId) {
            inFlight.add(retryId);
            await modifyState(messages =>
                messages.map(msg => msg.id === retryId ? { ...msg, status: 'pending' } : msg)
            );
            generateResponse(retryId);
            return;
        }

        const forkAnchor = e.target.dataset.forkAnchor;
        if (forkAnchor) {
            await setActiveThread(forkAnchor);
            return;
        }

        const expandToggle = e.target.dataset.expandToggle;
        if (expandToggle) {
            const textEl = document.querySelector(`[data-expand-content="${expandToggle}"]`);
            if (!textEl) return;
            const isExpanded = !textEl.classList.contains('line-clamp-5');
            if (isExpanded) {
                textEl.classList.add('line-clamp-5');
                e.target.textContent = 'more';
            } else {
                textEl.classList.remove('line-clamp-5');
                e.target.textContent = 'less';
            }
            return;
        }

        const toggleRefs = e.target.dataset.toggleRefs;
        if (toggleRefs) {
            const refsEl = document.getElementById(`refs-${toggleRefs}`);
            if (!refsEl) return;

            const msg = conversationState.find(m => m.id === toggleRefs);
            const count = msg?.annotationRefs?.length || 0;
            const label = `Using ${count} annotation${count !== 1 ? 's' : ''}`;
            const isExpanded = refsEl.style.display !== 'none';

            if (isExpanded) {
                refsEl.style.display = 'none';
                e.target.textContent = `${label} ▸`;
                return;
            }

            // Render on first expand (and re-render on subsequent to pick up any removed annotations).
            refsEl.innerHTML = '';
            const session = sessions[activeSessionId] || {};
            const annotations = session.annotations || [];

            for (const id of (msg?.annotationRefs || [])) {
                const ann = annotations.find(a => a.id === id);
                const row = document.createElement('div');
                row.classList.add(
                    'rounded-lg', 'border', 'border-gray-200',
                    'px-3', 'py-1.5', 'text-xs', 'text-gray-600', 'max-w-[85%]'
                );
                if (ann) {
                    const excerpt = ann.content.length > 40 ? ann.content.slice(0, 40) + '…' : ann.content;
                    row.textContent = ann.pageTitle ? `${ann.pageTitle} — ${excerpt}` : excerpt;
                } else {
                    row.textContent = '(annotation removed)';
                    row.classList.add('italic', 'text-gray-400');
                }
                refsEl.appendChild(row);
            }

            refsEl.style.display = '';
            e.target.textContent = `${label} ▾`;
            return;
        }
    });

    tabConversationBtn.addEventListener('click', () => switchTab('conversation'));
    tabAnnotationsBtn.addEventListener('click', () => switchTab('annotations'));

    annotationsListEl.addEventListener('click', e => {
        // Expand toggle must not trigger selection — handle it first and bail.
        const expandToggle = e.target.dataset.expandToggle;
        if (expandToggle) {
            const textEl = document.querySelector(`[data-expand-content="${expandToggle}"]`);
            if (!textEl) return;
            const isExpanded = !textEl.classList.contains('line-clamp-5');
            if (isExpanded) {
                textEl.classList.add('line-clamp-5');
                e.target.textContent = 'more';
            } else {
                textEl.classList.remove('line-clamp-5');
                e.target.textContent = 'less';
            }
            return;
        }

        const card = e.target.closest('[data-annotation-id]');
        if (!card) return;
        const id = card.dataset.annotationId;
        if (selectedAnnotationIds.has(id)) {
            selectedAnnotationIds.delete(id);
            card.classList.remove('bg-gray-100', 'border-gray-300');
            card.classList.add('border-gray-200');
        } else {
            selectedAnnotationIds.add(id);
            card.classList.remove('border-gray-200');
            card.classList.add('bg-gray-100', 'border-gray-300');
        }
        updateAskButton();
    });

    askBtnEl.addEventListener('click', async () => {
        if (selectedAnnotationIds.size === 0) return;
        await chrome.storage.local.set({ pendingAnnotationRefs: [...selectedAnnotationIds] });
        selectedAnnotationIds.clear();
        updateAskButton();
        switchTab('conversation');
    });

    newChatBtn.addEventListener('click', async () => {
        await startNewSession();
        selectedAnnotationIds.clear();
        updateAskButton();
        if (activeTab !== 'conversation') switchTab('conversation');
    });

    updateAskButton();

    // TEMP: remove after verifying READ_SESSION_TABS round-trip.
    const testReadBtn = document.getElementById('test-read-btn');
    if (testReadBtn) {
        testReadBtn.addEventListener('click', () => {
            const session = sessions[activeSessionId] || {};
            const tabIds = session.tabIds || [];
            chrome.runtime.sendMessage({ type: 'READ_SESSION_TABS', tabIds }, results => {
                if (chrome.runtime.lastError) {
                    console.error('READ_SESSION_TABS error:', chrome.runtime.lastError);
                    return;
                }
                console.log('READ_SESSION_TABS results:', results);
            });
        });
    }
});
