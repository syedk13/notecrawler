let isPanelOpen = false;
let isOpening = false;

chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'panel') return;
    isOpening = false;
    isPanelOpen = true;
    console.log('Panel opened, flag is now true');
    port.onDisconnect.addListener(() => {
        isPanelOpen = false;
        console.log('Panel closed, flag is now false');
    });
});

chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
        id: 'ContextMenu',
        title: 'Ask NoteCrawler',
        contexts: ['selection']
    });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === 'ContextMenu' && info.selectionText?.trim()) {
        if (!isPanelOpen && !isOpening) {
            isOpening = true;
            chrome.sidePanel.open({tabId: tab.id}).catch(err => console.error('Failed to open side panel:', err));
        }
        ;(async () => {
            try {
                const result = await chrome.storage.local.get('highlightedHistory');
                const history = result.highlightedHistory || [];
                history.push({
                    text: info.selectionText,
                    timestamp: Date.now()
                });
                await chrome.storage.local.set({highlightedHistory: history});
            } catch (err) {
                console.error('Failed to save highlight to storage:', err);
            }
        })();
    }
});

chrome.action.onClicked.addListener((tab) => {
    console.log("Current panel state:", isPanelOpen);
    if (!isPanelOpen && !isOpening) {
        isOpening = true;
        chrome.sidePanel.open({tabId: tab.id}).catch(err => console.error('Failed to open side panel:', err));
    }
});
