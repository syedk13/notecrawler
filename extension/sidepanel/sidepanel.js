const FORCE_MOCK_FAILURE = false;

let conversationState = [];
let activeThreadId = 'main';

// --- Storage helpers ---

async function readState() {
    const result = await chrome.storage.local.get(['conversationState', 'activeThreadId']);
    return {
        conversationState: result.conversationState || [],
        activeThreadId: result.activeThreadId || 'main'
    };
}

async function modifyState(updater) {
    const { conversationState: current } = await readState();
    await chrome.storage.local.set({ conversationState: updater(current) });
}

async function setActiveThread(threadId) {
    await chrome.storage.local.set({ activeThreadId: threadId });
}

// --- View filter ---

function getThreadMessages() {
    if (activeThreadId === 'main') {
        return conversationState.filter(m => m.threadId === 'main');
    }
    const anchor = conversationState.find(m => m.id === activeThreadId && m.threadId === 'main');
    const threadMessages = conversationState.filter(m => m.threadId === activeThreadId);
    return anchor ? [anchor, ...threadMessages] : threadMessages;
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
            mockResponse(msg.id);
        }
    }
}

// --- DOM builders ---

function createHighlightCard(message) {
    const wrapper = document.createElement('div');
    wrapper.dataset.id = message.id;

    const card = document.createElement('div');
    card.classList.add('highlight-item');
    card.textContent = message.content;
    wrapper.appendChild(card);

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

    const wrapper = document.createElement('div');
    if (!isUser) {
        wrapper.classList.add('flex', 'flex-col', 'items-start', 'gap-0.5');
    } else if (isFailed) {
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

    if (message.role === 'model' && message.type === 'summary') {
        const forkBtn = document.createElement('button');
        forkBtn.textContent = 'Fork thread';
        forkBtn.dataset.forkAnchor = message.contextRef;
        forkBtn.classList.add('text-xs', 'text-blue-400', 'hover:underline');
        wrapper.appendChild(forkBtn);
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

function createThreadMenuItem(threadId, label, isChild) {
    const btn = document.createElement('button');
    btn.classList.add(
        'w-full', 'text-left', 'px-3', 'py-1.5', 'text-xs',
        'hover:bg-gray-50', 'text-gray-700', 'truncate'
    );
    if (isChild) btn.classList.add('pl-6');
    if (threadId === activeThreadId) btn.classList.add('font-semibold', 'text-blue-600');
    btn.textContent = (isChild ? '↳ ' : '') + label;
    btn.dataset.threadId = threadId;
    return btn;
}

function renderThreadMenu() {
    const menu = document.getElementById('thread-menu');
    const titleEl = document.getElementById('thread-title');
    if (!menu) return;

    menu.innerHTML = '';

    const threadIds = getDerivedThreadIds();
    menu.appendChild(createThreadMenuItem('main', 'Main Conversation', false));
    for (const id of threadIds) {
        if (id === 'main') continue;
        menu.appendChild(createThreadMenuItem(id, getThreadLabel(id), true));
    }

    if (titleEl) {
        titleEl.textContent = getThreadLabel(activeThreadId);
    }
}

// --- Mock response pipeline ---

async function mockResponse(messageId) {
    await new Promise(resolve => setTimeout(resolve, 600 + Math.random() * 400));

    try {
        if (FORCE_MOCK_FAILURE) {
            await modifyState(state =>
                state.map(msg => msg.id === messageId ? { ...msg, status: 'failed' } : msg)
            );
            return;
        }

        await modifyState(state => {
            const parent = state.find(m => m.id === messageId);
            if (!parent) return state;

            // A highlight's summary references the highlight's OWN id.
            // A chat reply inherits its parent's contextRef.
            const responseContextRef = parent.type === 'highlight'
                ? parent.id
                : parent.contextRef;

            const responseType = parent.type === 'highlight' ? 'summary' : 'text';

            const responseThreadId = parent.type === 'highlight' ? parent.id : parent.threadId;

            const updated = state.map(msg =>
                msg.id === messageId ? { ...msg, status: 'answered' } : msg
            );
            updated.push({
                id: crypto.randomUUID(),
                role: 'model',
                type: responseType,
                content: 'This is a mock response from NoteCrawler.',
                contextRef: responseContextRef,
                threadId: responseThreadId,
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

    inFlight.add(messageId);
    await modifyState(messages => [...messages, {
        id: messageId,
        role: 'user',
        type: 'text',
        content: text,
        contextRef,
        threadId: capturedThreadId,
        status: 'pending',
        timestamp: Date.now()
    }]);
    mockResponse(messageId);
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

    const stored = await readState();
    conversationState = stored.conversationState;
    activeThreadId = stored.activeThreadId;
    renderConversation(container);
    renderThreadMenu();

    // Trigger responses for any pending messages that arrived while the panel
    // was closed (e.g. a context-menu highlight). Idempotent.
    reconcilePending(conversationState);

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;

        if (changes.activeThreadId) {
            activeThreadId = changes.activeThreadId.newValue || 'main';
        }

        if (changes.conversationState) {
            conversationState = changes.conversationState.newValue || [];
            reconcilePending(conversationState);
        }

        if (changes.conversationState || changes.activeThreadId) {
            renderConversation(container);
            renderThreadMenu();
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
        const threadId = e.target.dataset.threadId;
        if (!threadId) return;
        await setActiveThread(threadId);
    });

    container.addEventListener('click', async e => {
        const retryId = e.target.dataset.retryId;
        if (retryId) {
            inFlight.add(retryId);
            await modifyState(messages =>
                messages.map(msg => msg.id === retryId ? { ...msg, status: 'pending' } : msg)
            );
            mockResponse(retryId);
            return;
        }

        const forkAnchor = e.target.dataset.forkAnchor;
        if (forkAnchor) {
            await setActiveThread(forkAnchor);
        }
    });
});
