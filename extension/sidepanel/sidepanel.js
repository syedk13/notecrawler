const FORCE_MOCK_FAILURE = false;

let conversationState = [];

// --- Storage helpers ---

async function readState() {
    const result = await chrome.storage.local.get('conversationState');
    return result.conversationState || [];
}

async function modifyState(updater) {
    const state = await readState();
    await chrome.storage.local.set({ conversationState: updater(state) });
}

// --- DOM builders ---

function createHighlightCard(message) {
    const card = document.createElement('div');
    card.classList.add('highlight-item');
    card.dataset.id = message.id;
    card.textContent = message.content;
    return card;
}

function createPendingBubble(message) {
    const wrapper = document.createElement('div');
    wrapper.classList.add('flex', 'justify-end');
    wrapper.dataset.id = message.id;

    const bubble = document.createElement('div');
    bubble.classList.add(
        'max-w-[85%]', 'rounded-lg', 'px-3', 'py-2', 'text-sm',
        'whitespace-pre-wrap', 'bg-blue-400', 'text-white', 'italic', 'opacity-70'
    );
    bubble.textContent = message.text;

    wrapper.appendChild(bubble);
    return wrapper;
}

function createFailedBubble(message) {
    const wrapper = document.createElement('div');
    wrapper.classList.add('flex', 'flex-col', 'items-end', 'gap-1');
    wrapper.dataset.id = message.id;

    const bubble = document.createElement('div');
    bubble.classList.add(
        'max-w-[85%]', 'rounded-lg', 'px-3', 'py-2', 'text-sm',
        'whitespace-pre-wrap', 'bg-blue-600', 'text-white'
    );
    bubble.textContent = message.text;

    const retryBtn = document.createElement('button');
    retryBtn.textContent = 'Retry';
    retryBtn.dataset.retryId = message.id;
    retryBtn.classList.add('text-xs', 'text-red-500', 'hover:underline');

    wrapper.appendChild(bubble);
    wrapper.appendChild(retryBtn);
    return wrapper;
}

function createChatBubble(message) {
    const isUser = message.role === 'user';
    const wrapper = document.createElement('div');
    wrapper.classList.add('flex', isUser ? 'justify-end' : 'justify-start');
    wrapper.dataset.id = message.id;

    const bubble = document.createElement('div');
    bubble.classList.add(
        'max-w-[85%]', 'rounded-lg', 'px-3', 'py-2', 'text-sm', 'whitespace-pre-wrap',
        ...(isUser ? ['bg-blue-600', 'text-white'] : ['bg-gray-100', 'text-gray-800'])
    );
    bubble.textContent = message.text;

    wrapper.appendChild(bubble);
    return wrapper;
}

// --- Render ---

function renderConversation(container) {
    container.innerHTML = '';

    if (!conversationState.length) {
        const emptyState = document.createElement('p');
        emptyState.textContent = 'Select text on any page and choose "Ask NoteCrawler" to start a conversation.';
        emptyState.classList.add('empty-state');
        container.appendChild(emptyState);
        container.scrollTop = container.scrollHeight;
        return;
    }

    for (const message of conversationState) {
        let el;
        if (message.role === 'user' && message.type === 'highlight') {
            el = createHighlightCard(message);
        } else if (message.role === 'user' && message.status === 'pending') {
            el = createPendingBubble(message);
        } else if (message.role === 'user' && message.status === 'failed') {
            el = createFailedBubble(message);
        } else {
            el = createChatBubble(message);
        }
        container.appendChild(el);
    }

    container.scrollTop = container.scrollHeight;
}

// --- Mock response pipeline ---

async function mockResponse(messageId) {
    await new Promise(resolve => setTimeout(resolve, 600 + Math.random() * 400));

    if (FORCE_MOCK_FAILURE) {
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
            text: 'This is a mock response from NoteCrawler.',
            contextRef: null,
            timestamp: Date.now()
        });
        return updated;
    });
}

// --- Submission ---

async function submitMessage(text) {
    const messageId = crypto.randomUUID();
    await modifyState(state => [...state, {
        id: messageId,
        role: 'user',
        text,
        contextRef: null,
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

    const result = await chrome.storage.local.get('conversationState');
    conversationState = result.conversationState || [];
    renderConversation(container);

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes.conversationState) return;
        conversationState = changes.conversationState.newValue || [];
        renderConversation(container);
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

    container.addEventListener('click', async e => {
        const retryId = e.target.dataset.retryId;
        if (!retryId) return;
        await modifyState(state =>
            state.map(msg => msg.id === retryId ? { ...msg, status: 'pending' } : msg)
        );
        mockResponse(retryId);
    });
});
