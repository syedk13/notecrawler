let isPanelOpen = false;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "PANEL_OPENED") {
        isPanelOpen = true;
        console.log('Panel opened, flag is now true')
    } else if (message.type === "PANEL_CLOSED") {
        isPanelOpen = false;
        console.log('Panel closed, flag is now false')
    }
});

chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
        id: 'ContextMenu',
        title: 'Ask NoteCrawler',
        contexts: ['selection']
    });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === 'ContextMenu' && info.selectionText) {
        const result = await chrome.storage.local.get('highlightedHistory');
        const history = result.highlightedHistory || [];
        history.push({
            text: info.selectionText,
            timestamp: Date.now()
        });
        await chrome.storage.local.set({highlightedHistory: history});
        if (!isPanelOpen) {
            chrome.sidePanel.open({tabId: tab.id});
        }
    }
});

chrome.action.onClicked.addListener((tab) => {
    console.log("Current panel state:", isPanelOpen);
    if (!isPanelOpen) {
        chrome.sidePanel.open({tabId: tab.id});
    }
});
