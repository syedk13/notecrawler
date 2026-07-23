const FORCE_MOCK_FAILURE = false;

let threads = {};
let activeThreadId = 'main';

// --- Storage helpers ---

async function readStorage() {
    const result = await chrome.storage.local.get(['threads', 'activeThreadId']);
    const stored = result.threads || {};
    if (!stored.main) {
        stored.main = { id: 'main', title: 'Main Conversation', parentResponseId: null, messages: [] };
    }
    return {
        threads: stored,
        activeThreadId: result.activeThreadId || 'main'
    };
}

async function modifyThreadMessages(threadId, updater) {
    const { threads: current } = await readStorage();
    const thread = current[threadId] || { id: threadId, title: 'Thread', parentResponseId: null, messages: [] };
    await chrome.storage.local.set({
        threads: { ...current, [threadId]: { ...thread, messages: updater(thread.messages) } }
    });
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

    if (!isUser) {
        const forkBtn = document.createElement('button');
        forkBtn.textContent = 'Fork thread';
        forkBtn.dataset.forkId = message.id;
        forkBtn.classList.add('text-xs', 'text-blue-400', 'hover:underline');
        wrapper.appendChild(forkBtn);
    }

    return wrapper;
}

// --- Render ---

function renderConversation(container) {
    container.innerHTML = '';

    const messages = threads[activeThreadId]?.messages || [];

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

        if (message.role === 'user' && message.status === 'pending') {
            container.appendChild(createLoadingIndicator());
        }
    }

    container.scrollTop = container.scrollHeight;
}

function createThreadMenuItem(threadId, title, isChild) {
    const btn = document.createElement('button');
    btn.classList.add(
        'w-full', 'text-left', 'px-3', 'py-1.5', 'text-xs',
        'hover:bg-gray-50', 'text-gray-700', 'truncate'
    );
    if (isChild) btn.classList.add('pl-6');
    if (threadId === activeThreadId) btn.classList.add('font-semibold', 'text-blue-600');
    btn.textContent = (isChild ? '↳ ' : '') + title;
    btn.dataset.threadId = threadId;
    return btn;
}

function renderThreadMenu() {
    const menu = document.getElementById('thread-menu');
    const titleEl = document.getElementById('thread-title');
    if (!menu) return;

    menu.innerHTML = '';

    if (threads['main']) {
        menu.appendChild(createThreadMenuItem('main', 'Main Conversation', false));
    }

    for (const thread of Object.values(threads)) {
        if (thread.id === 'main') continue;
        menu.appendChild(createThreadMenuItem(thread.id, thread.title, true));
    }

    if (titleEl) {
        const active = threads[activeThreadId];
        titleEl.textContent = active?.title ?? 'Main Conversation';
    }
}

// --- Mock response pipeline ---

async function mockResponse(messageId, threadId) {
    await new Promise(resolve => setTimeout(resolve, 600 + Math.random() * 400));

    if (FORCE_MOCK_FAILURE) {
        await modifyThreadMessages(threadId, messages =>
            messages.map(msg => msg.id === messageId ? { ...msg, status: 'failed' } : msg)
        );
        return;
    }

    await modifyThreadMessages(threadId, messages => {
        const updated = messages.map(msg =>
            msg.id === messageId ? { ...msg, status: 'answered' } : msg
        );
        updated.push({
            id: crypto.randomUUID(),
            role: 'model',
            content: 'This is a mock response from NoteCrawler.',
            contextRef: messageId,
            timestamp: Date.now()
        });
        return updated;
    });
}

// --- Submission ---

async function submitMessage(text) {
    const messageId = crypto.randomUUID();
    const capturedThreadId = activeThreadId;
    const contextRef = capturedThreadId === 'main'
        ? null
        : (threads[capturedThreadId]?.parentResponseId ?? null);

    await modifyThreadMessages(capturedThreadId, messages => [...messages, {
        id: messageId,
        role: 'user',
        content: text,
        contextRef,
        status: 'pending',
        timestamp: Date.now()
    }]);
    mockResponse(messageId, capturedThreadId);
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

    const stored = await readStorage();
    threads = stored.threads;
    activeThreadId = stored.activeThreadId;
    renderConversation(container);
    renderThreadMenu();

    // --- Storage changes ---

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;

        if (changes.activeThreadId) {
            activeThreadId = changes.activeThreadId.newValue || 'main';
        }

        if (changes.threads) {
            const oldThreads = changes.threads.oldValue || {};
            const newThreads = changes.threads.newValue || {};
            threads = newThreads;

            // Fire mockResponse for brand-new pending highlights in the active thread only
            const oldMessages = oldThreads[activeThreadId]?.messages || [];
            const newMessages = newThreads[activeThreadId]?.messages || [];
            const oldIds = new Set(oldMessages.map(m => m.id));
            for (const msg of newMessages) {
                if (!oldIds.has(msg.id) && msg.role === 'user' && msg.type === 'highlight' && msg.status === 'pending') {
                    mockResponse(msg.id, activeThreadId);
                }
            }
        }

        if (changes.threads || changes.activeThreadId) {
            renderConversation(container);
            renderThreadMenu();
        }
    });

    // --- Input ---

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

    // --- 3-dots menu ---

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
        await chrome.storage.local.set({ activeThreadId: threadId });
    });

    // --- Delegated actions (retry + fork) ---

    container.addEventListener('click', async e => {
        const retryId = e.target.dataset.retryId;
        if (retryId) {
            const capturedThreadId = activeThreadId;
            await modifyThreadMessages(capturedThreadId, messages =>
                messages.map(msg => msg.id === retryId ? { ...msg, status: 'pending' } : msg)
            );
            mockResponse(retryId, capturedThreadId);
            return;
        }

        const forkId = e.target.dataset.forkId;
        if (forkId) {
            const { threads: current } = await readStorage();
            const modelMessage = current[activeThreadId]?.messages.find(m => m.id === forkId);
            if (!modelMessage) return;

            const raw = modelMessage.content.trim();
            const title = raw.length > 47 ? raw.slice(0, 47) + '…' : raw;
            const newThreadId = crypto.randomUUID();

            await chrome.storage.local.set({
                threads: {
                    ...current,
                    [newThreadId]: {
                        id: newThreadId,
                        title,
                        parentResponseId: forkId,
                        messages: [modelMessage]
                    }
                },
                activeThreadId: newThreadId
            });
        }
    });
});
