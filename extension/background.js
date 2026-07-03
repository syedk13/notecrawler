let isPanelOpen = false;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "PANEL_OPENED") {
        isPanelOpen = true;
    } else if (message.type === "PANEL_CLOSED") {
        isPanelOpen = false;
    }
});

chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
        id: 'ContextMenu',
        title: 'Ask NoteCrawler',
        contexts: ['selection']
    });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === 'ContextMenu' && info.selectionText) {
        chrome.sidePanel.open({tabId: tab.id});
        chrome.storage.local.set({lastHighlight: info.selectionText});
    }
});

chrome.action.onClicked.addListener((tab) => {
    console.log("Current panel state:", isPanelOpen);
    chrome.sidePanel.open({tabId: tab.id});
});
