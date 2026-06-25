chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
        id: 'ContextMenu',
        title: 'Ask NoteCrawler',
        contexts: ['selection']
    });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === 'ContextMenu' && info.selectionText) {
        chrome.storage.local.set({lastHighlight: info.selectionText});
        chrome.sidePanel.open({tabId: tab.id});
    }
});

chrome.action.onClicked.addListener((tab) => {
    chrome.sidePanel.open({tabId: tab.id});
});
