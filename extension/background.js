function openSidePanel(tabId) {
    chrome.sidePanel.open({tabId}).catch(err => {
        if (err?.message?.includes('Side panel is already open')) return;
        console.debug('Failed to open side panel:', err);
    });
}

function createFreshSession() {
    return {
        id: crypto.randomUUID(),
        title: null,
        conversationState: [],
        annotations: [],
        activeThreadId: 'main',
        tabIds: [],
        createdAt: Date.now()
    };
}

async function readActiveSession() {
    const result = await chrome.storage.local.get(['sessions', 'activeSessionId']);
    const sessions = result.sessions || {};
    const activeSessionId = result.activeSessionId || '';
    return { sessions, activeSessionId, session: sessions[activeSessionId] };
}

async function modifyActiveSession(updater) {
    const { sessions, activeSessionId, session } = await readActiveSession();
    if (!session) return;
    await chrome.storage.local.set({ sessions: { ...sessions, [activeSessionId]: updater(session) } });
}

chrome.runtime.onInstalled.addListener(() => {
    chrome.storage.local.remove(['highlightedHistory', 'lastHighlight', 'threads', 'conversationState', 'activeThreadId', 'annotations']);
    const session = createFreshSession();
    chrome.storage.local.set({
        sessions: { [session.id]: session },
        activeSessionId: session.id
    });
    chrome.contextMenus.create({
        id: 'ContextMenu',
        title: 'Ask NoteCrawler',
        contexts: ['selection']
    });
    chrome.contextMenus.create({
        id: 'AddAnnotation',
        title: 'Add annotation',
        contexts: ['selection']
    });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === 'AddAnnotation' && info.selectionText?.trim()) {
        ;(async () => {
            try {
                await modifyActiveSession(session => ({
                    ...session,
                    annotations: [...(session.annotations || []), {
                        id: crypto.randomUUID(),
                        content: info.selectionText.trim(),
                        sourceUrl: tab.url,
                        pageTitle: tab.title,
                        timestamp: Date.now()
                    }]
                }));
            } catch (err) { console.error('Failed to save annotation to storage:', err); }
        })();
    }

    if (info.menuItemId === 'ContextMenu' && info.selectionText?.trim()) {
        openSidePanel(tab.id);
        ;(async () => {
            try {
                const text = info.selectionText.trim();
                await modifyActiveSession(session => {
                    const messages = [...(session.conversationState || []), {
                        id: crypto.randomUUID(),
                        role: 'user',
                        type: 'highlight',
                        content: text,
                        contextRef: null,
                        threadId: 'main',
                        status: 'pending',
                        timestamp: Date.now()
                    }];
                    const title = session.title === null
                        ? (text.length > 40 ? text.slice(0, 40) + '…' : text)
                        : session.title;
                    return { ...session, conversationState: messages, title };
                });
            } catch (err) { console.error('Failed to save highlight to storage:', err); }
        })();
    }
});

chrome.action.onClicked.addListener((tab) => {
    openSidePanel(tab.id);
});

// Remove a closed tab from every session's tabIds list.
chrome.tabs.onRemoved.addListener(async (tabId) => {
    const result = await chrome.storage.local.get('sessions');
    const allSessions = result.sessions || {};
    let modified = false;
    const updated = {};
    for (const [id, session] of Object.entries(allSessions)) {
        const ids = session.tabIds || [];
        if (ids.includes(tabId)) {
            updated[id] = { ...session, tabIds: ids.filter(t => t !== tabId) };
            modified = true;
        } else {
            updated[id] = session;
        }
    }
    if (modified) {
        await chrome.storage.local.set({ sessions: updated });
    }
});

// Let the side panel resolve the active tab id via the background, because
// chrome.tabs.getCurrent() returns undefined in side-panel contexts.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'GET_CURRENT_TAB') {
        chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
            sendResponse({ tabId: tabs[0]?.id ?? null });
        });
        return true; // keep channel open for async sendResponse
    }
});
