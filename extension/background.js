function openSidePanel(tabId) {
    chrome.sidePanel.open({tabId}).catch(err => {
        if (err?.message?.includes('Side panel is already open')) return;
        console.debug('Failed to open side panel:', err);
    });
}

chrome.runtime.onInstalled.addListener(() => {
    chrome.storage.local.remove(['highlightedHistory', 'lastHighlight', 'threads']);
    chrome.storage.local.set({
        conversationState: [],
        activeThreadId: 'main'
    });
    chrome.contextMenus.create({
        id: 'ContextMenu',
        title: 'Ask NoteCrawler',
        contexts: ['selection']
    });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === 'ContextMenu' && info.selectionText?.trim()) {
        openSidePanel(tab.id);
        ;(async () => {
            try {
                const result = await chrome.storage.local.get('conversationState');
                const state = result.conversationState || [];
                state.push({
                    id: crypto.randomUUID(),
                    role: 'user',
                    type: 'highlight',
                    content: info.selectionText.trim(),
                    contextRef: null,
                    threadId: 'main',
                    status: 'pending',
                    timestamp: Date.now()
                });
                await chrome.storage.local.set({ conversationState: state });
            } catch (err) {
                console.error('Failed to save highlight to storage:', err);
            }
        })();
    }
});

chrome.action.onClicked.addListener((tab) => {
    openSidePanel(tab.id);
});
