function renderHighlight(text, container) {
    container.innerHTML = '';
    if (!text?.trim()) {
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
}

document.addEventListener('DOMContentLoaded', async () => {
    chrome.runtime.sendMessage({ type: "PANEL_OPENED" });

    const container = document.getElementById('side-panel-content');
    if (!container) {
        console.error('Side Panel container not found.');
        return;
    }

    const result = await chrome.storage.local.get('lastHighlight');
    renderHighlight(result.lastHighlight, container);

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes.lastHighlight) return;
        renderHighlight(changes.lastHighlight.newValue, container);
    });
});

window.addEventListener('unload', () => {
    chrome.runtime.sendMessage({ type: "PANEL_CLOSED" });
});
