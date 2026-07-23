function openSidePanel(tabId) {
    chrome.sidePanel.open({tabId}).catch(err => {
        if (err?.message?.includes('Side panel is already open')) return;
        console.debug('Failed to open side panel:', err);
    });
}

chrome.runtime.onInstalled.addListener(() => {
    chrome.storage.local.remove(['highlightedHistory', 'lastHighlight', 'conversationState']);
    chrome.storage.local.set({
        threads: { main: { id: 'main', title: 'Main Conversation', parentResponseId: null, messages: [] } },
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
                const result = await chrome.storage.local.get(['threads', 'activeThreadId']);
                const activeId = result.activeThreadId || 'main';
                const allThreads = result.threads || {
                    main: { id: 'main', title: 'Main Conversation', parentResponseId: null, messages: [] }
                };
                const thread = allThreads[activeId] || { id: activeId, title: 'Thread', parentResponseId: null, messages: [] };
                const contextRef = activeId === 'main' ? null : (thread.parentResponseId ?? null);

                thread.messages.push({
                    id: crypto.randomUUID(),
                    role: 'user',
                    type: 'highlight',
                    content: info.selectionText.trim(),
                    contextRef,
                    status: 'pending',
                    timestamp: Date.now()
                });

                await chrome.storage.local.set({ threads: { ...allThreads, [activeId]: thread } });
            } catch (err) {
                console.error('Failed to save highlight to storage:', err);
            }
        })();
    }
});

chrome.action.onClicked.addListener((tab) => {
    openSidePanel(tab.id);
});
