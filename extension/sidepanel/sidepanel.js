let conversationState = [];

function createHighlightCard(message) {
    const card = document.createElement('div');
    card.classList.add('highlight-item');
    card.dataset.id = message.id;
    card.textContent = message.content;
    return card;
}

function createChatBubble(message) {
    const isUser = message.role === 'user';
    const wrapper = document.createElement('div');
    wrapper.classList.add('flex', isUser ? 'justify-end' : 'justify-start');
    wrapper.dataset.id = message.id;

    const bubble = document.createElement('div');
    bubble.classList.add(
        'max-w-[85%]', 'rounded-lg', 'px-3', 'py-2', 'text-sm', 'whitespace-pre-wrap',
        ...(isUser
            ? ['bg-blue-600', 'text-white']
            : ['bg-gray-100', 'text-gray-800'])
    );
    bubble.textContent = message.content;

    wrapper.appendChild(bubble);
    return wrapper;
}

function renderConversation(container) {
    container.innerHTML = '';

    if (!conversationState.length) {
        const emptyState = document.createElement('p');
        emptyState.textContent = 'No highlights yet. Select text on a page and choose "Ask NoteCrawler".';
        emptyState.classList.add('empty-state');
        container.appendChild(emptyState);
        return;
    }

    for (const message of conversationState) {
        const el = (message.role === 'user' && message.type === 'highlight')
            ? createHighlightCard(message)
            : createChatBubble(message);
        container.appendChild(el);
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    chrome.runtime.connect({ name: 'panel' });

    const container = document.getElementById('side-panel-content');
    if (!container) {
        console.error('Side Panel container not found.');
        return;
    }

    const result = await chrome.storage.local.get('conversationState');
    conversationState = result.conversationState || [];
    renderConversation(container);

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes.conversationState) return;
        conversationState = changes.conversationState.newValue || [];
        renderConversation(container);
    });
});

