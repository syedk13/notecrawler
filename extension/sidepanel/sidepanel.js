document.addEventListener('DOMContentLoaded', async () => {
    const container = document.getElementById('side-panel-content');
    if (!container) {
        console.error('Side Panel container not found.');
        return;
    }

    const result = await chrome.storage.local.get('lastHighlight');
    const text = result.lastHighlight?.trim();
    if (!text) {
        const emptyState = document.createElement('p');
        emptyState.textContent = 'No highlights yet. Select text on a page and choose "Ask NoteCrawler".';
        emptyState.classList.add('empty-state');
        container.appendChild(emptyState);
        return;
    }

    const highlightItem = document.createElement('div');
    highlightItem.textContent = text;
    highlightItem.classList.add('highlight-item');
    container.appendChild(highlightItem);
});
