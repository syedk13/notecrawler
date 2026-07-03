function appendHighlightCard(item, container) {
    const highlightItem = document.createElement('div');
    highlightItem.textContent = item.text;
    highlightItem.classList.add('highlight-item');
    container.appendChild(highlightItem);
}

function renderAllHighlights(history, container) {
    container.innerHTML = '';
    if (!history?.length) {
        const emptyState = document.createElement('p');
        emptyState.textContent = 'No highlights yet. Select text on a page and choose "Ask NoteCrawler".';
        emptyState.classList.add('empty-state');
        container.appendChild(emptyState);
        return;
    }
    history.forEach(item => appendHighlightCard(item, container));
}

document.addEventListener('DOMContentLoaded', async () => {
    chrome.runtime.sendMessage({ type: "PANEL_OPENED" });

    const container = document.getElementById('side-panel-content');
    if (!container) {
        console.error('Side Panel container not found.');
        return;
    }

    const result = await chrome.storage.local.get('highlightedHistory');
    renderAllHighlights(result.highlightedHistory, container);

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes.highlightedHistory) return;
        const newHistory = changes.highlightedHistory.newValue;
        const latestItem = newHistory[newHistory.length - 1];
        // Remove empty state if present, then append only the new card
        const emptyState = container.querySelector('.empty-state');
        if (emptyState) emptyState.remove();
        appendHighlightCard(latestItem, container);
    });
});

window.addEventListener('unload', () => {
    chrome.runtime.sendMessage({ type: "PANEL_CLOSED" });
});
