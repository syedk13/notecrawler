const FORCE_MOCK_FAILURE = false;

let conversationState = [];
let activeThreadId = 'main';
let sessions = {};
let activeSessionId = '';
let activeTab = 'conversation';
let pendingAnnotationRefs = [];
const selectedAnnotationIds = new Set();
// Which annotation cards are showing their full text. In memory only, deliberately
// never written to storage: it is a view preference, not part of the annotation.
// Held here rather than read off the DOM so a re-render preserves it, and so the
// options menu can label itself Expand or Collapse from the same source.
const expandedAnnotationIds = new Set();
// The annotation whose options menu is open, or '' when none is. Only one card's
// menu is ever open.
let openAnnotationMenuId = '';
// Signature of the restricted-tab set the user last dismissed. Deliberately NOT
// persisted to chrome.storage. Keying it to the set (rather than a bare boolean)
// means a newly restricted tab re-surfaces the notice, while re-renders that do
// not change membership keep it hidden.
let dismissedRestrictedKey = '';

// --- Streaming state ---
// A streaming model response deliberately lives OUTSIDE conversationState until
// it completes. The UI is otherwise a pure function of storage, so a per-chunk
// write would rebuild the whole conversation on every chunk. This object is the
// only record of the in-flight response while it streams.
//
// Shape: { messageId, threadId, text, wrapper, bubble, lastRenderAt,
// renderTimer }. `wrapper` and `bubble` stay null until the first chunk arrives,
// which is exactly what keeps the loading indicator on screen until there is
// something to show.
let activeStream = null;

// Whether the conversation should follow the bottom as chunks arrive. Released
// when the user scrolls up mid-stream so streaming never fights a manual scroll.
let streamPinnedToBottom = true;

// How close to the bottom still counts as pinned, in px.
const STREAM_PIN_SLACK_PX = 24;

// How often the live bubble re-parses its accumulated Markdown, in ms. Parsing on
// every chunk would reassign innerHTML at chunk frequency, which churns the DOM and
// makes half-arrived syntax jump. Measured against the bundled marked: a lone
// "| a | b |" renders as a paragraph and then becomes an entire <table> once the
// delimiter row lands, "**bo" shows raw asterisks until its closing pair arrives,
// and "#head" is a paragraph until the space makes it an <h1>. (An unclosed code
// fence is NOT one of these -- marked auto-closes it, so it renders the same either
// way.) Parsing only at the end would instead show raw ** and ## for the whole
// response.
const STREAM_RENDER_INTERVAL_MS = 100;

// --- Storage helpers ---

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

async function readSessions() {
    const result = await chrome.storage.local.get(['sessions', 'activeSessionId']);
    return {
        sessions: result.sessions || {},
        activeSessionId: result.activeSessionId || ''
    };
}

async function ensureActiveSession() {
    const { sessions: s, activeSessionId: sid } = await readSessions();
    if (sid && s[sid]) return { sessions: s, activeSessionId: sid };
    const session = createFreshSession();
    const newSessions = { ...s, [session.id]: session };
    await chrome.storage.local.set({ sessions: newSessions, activeSessionId: session.id });
    return { sessions: newSessions, activeSessionId: session.id };
}

async function modifySession(updater) {
    const { sessions: s, activeSessionId: sid } = await readSessions();
    if (!s[sid]) return;
    await chrome.storage.local.set({ sessions: { ...s, [sid]: updater(s[sid]) } });
}

// Preserved signature — used by generateResponse and retry handler.
async function modifyState(updater) {
    await modifySession(session => ({
        ...session,
        conversationState: updater(session.conversationState || [])
    }));
}

async function setActiveThread(threadId) {
    await modifySession(session => ({ ...session, activeThreadId: threadId }));
}

async function setActiveSession(sessionId) {
    await chrome.storage.local.set({ activeSessionId: sessionId });
}

async function startNewSession() {
    const { sessions: s } = await readSessions();
    const session = createFreshSession();
    await chrome.storage.local.set({
        sessions: { ...s, [session.id]: session },
        activeSessionId: session.id
    });
}

// Ask the background service worker for the active tab id.
// chrome.tabs.getCurrent() returns undefined in side-panel contexts.
async function getCurrentTabId() {
    return new Promise(resolve => {
        chrome.runtime.sendMessage({ type: 'GET_CURRENT_TAB' }, response => {
            if (chrome.runtime.lastError) { resolve(null); return; }
            resolve(response?.tabId ?? null);
        });
    });
}

// Add tabId to a specific session's tabIds (no-op if already present or tabId is null).
async function addTabToSession(sessionId, tabId) {
    if (tabId == null) return;
    const { sessions: s } = await readSessions();
    const session = s[sessionId];
    if (!session) return;
    const tabIds = session.tabIds || [];
    if (tabIds.includes(tabId)) return;
    await chrome.storage.local.set({
        sessions: { ...s, [sessionId]: { ...session, tabIds: [...tabIds, tabId] } }
    });
}

// --- Restricted tab detection ---

// Pages that extensions categorically cannot script. Matched on the tab URL
// alone -- no injection probe, so this costs nothing and never spends a request.
const RESTRICTED_SCHEMES = [
    'chrome://',
    'chrome-extension://',
    'edge://',
    'about:',
    'view-source:',
    'file://',
];

// http:// cannot live in the list above because it needs an exception: the only
// plain-http hosts the extension may script are the local dev server's.
const LOCAL_HTTP_HOSTNAMES = ['localhost', '127.0.0.1'];

function isRestrictedUrl(url) {
    if (typeof url !== 'string' || !url) return false; // unknown -> do not warn
    const lower = url.toLowerCase();
    if (RESTRICTED_SCHEMES.some(scheme => lower.startsWith(scheme))) return true;
    // The Chrome Web Store blocks extension scripting, on its current host and
    // the legacy one.
    if (lower.startsWith('https://chromewebstore.google.com/')) return true;
    if (lower.startsWith('https://chrome.google.com/webstore')) return true;
    // host_permissions grants https://*/* but only http://localhost:3000/*, so a
    // non-local http:// page fails injection exactly like a chrome:// page does.
    // ('https://' does not match this prefix, so secure pages are unaffected.)
    if (lower.startsWith('http://')) {
        let hostname;
        try {
            hostname = new URL(url).hostname.toLowerCase();
        } catch {
            return false; // unparseable -> same fallback as a missing URL
        }
        // Compared as a whole hostname, not a substring, so a lookalike host such
        // as http://localhost.example.com stays restricted.
        return !LOCAL_HTTP_HOSTNAMES.includes(hostname);
    }
    return false;
}

// Resolves every in-scope tab once. chrome.tabs.get is the only source for both
// the title the indicator shows and the URL the warning needs, so they are read
// together rather than twice.
async function readScopedTabs(tabIds) {
    const scoped = [];
    for (const tabId of tabIds) {
        let title = '';
        let url = '';
        try {
            // title and url both require the "tabs" permission, already granted.
            const tab = await chrome.tabs.get(tabId);
            title = tab.title || '';
            url = tab.url || '';
        } catch {
            // Tab closed but not yet pruned by background.js -- neutral fallback.
        }
        scoped.push({ tabId, title, url, restricted: isRestrictedUrl(url) });
    }
    return scoped;
}

// Identifies a restricted set so dismissal can be scoped to exactly that set.
function restrictedKeyFor(scopedTabs) {
    return scopedTabs
        .filter(tab => tab.restricted)
        .map(tab => tab.tabId)
        .sort((a, b) => a - b)
        .join(',');
}

// One muted, dismissible notice for the whole restricted set -- never one per
// tab. Informational only: it does not block submission and does not change what
// generateResponse sends.
function appendRestrictedWarning(card, scopedTabs) {
    const count = scopedTabs.filter(tab => tab.restricted).length;
    if (count === 0) return;

    const key = restrictedKeyFor(scopedTabs);
    if (key === dismissedRestrictedKey) return;

    const notice = document.createElement('div');
    notice.dataset.restrictedWarning = key;
    notice.classList.add('flex', 'items-center', 'justify-between', 'mt-2');
    // Hairline divider, matching the in-bubble notices. Inline because the nc-*
    // palette classes live in sidepanel.html, which this change does not touch.
    notice.style.cssText = 'padding-top:0.375rem;border-top:1px solid rgba(255,255,255,0.08);';

    const label = document.createElement('span');
    // Muted rather than alarming: the glyph carries the signal, not the colour.
    label.classList.add('text-xs', 'nc-text2', 'truncate');
    label.textContent = `\u26A0 ${count} tab${count !== 1 ? 's' : ''} could not be read`;

    const dismissBtn = document.createElement('button');
    // The key rides on the button so the handler needs no extra module state.
    dismissBtn.dataset.dismissRestricted = key;
    dismissBtn.textContent = '\u00D7';
    dismissBtn.title = 'Dismiss';
    dismissBtn.classList.add('nc-text2', 'text-base', 'leading-none', 'px-1', 'shrink-0');

    notice.appendChild(label);
    notice.appendChild(dismissBtn);
    card.appendChild(notice);
}

// --- Annotation options menu ---

// One action inside a card's options menu. Mirrors createSessionMenuItem's shape so
// this menu and the session menu look and behave identically.
function createAnnotationMenuItem(action, annotationId, label) {
    const btn = document.createElement('button');
    btn.classList.add('w-full', 'text-left', 'px-3', 'py-1.5', 'text-xs', 'nc-menu-btn');
    btn.textContent = label;
    if (action === 'delete') {
        btn.dataset.annotationDelete = annotationId;
        // Inline so it also beats .nc-menu-btn:hover -- a destructive action should
        // stay red while hovered, with only the hover background changing.
        btn.style.color = 'var(--nc-red)';
    } else {
        btn.dataset.annotationExpand = annotationId;
    }
    return btn;
}

// Close every card's options menu. Only one is open at a time, but this also runs
// from the document-level handler, which does not know which one that is.
function closeAnnotationMenus() {
    const list = document.getElementById('annotations-list');
    if (list) {
        for (const menu of list.querySelectorAll('[data-annotation-menu-for]')) {
            menu.classList.add('hidden');
        }
    }
    openAnnotationMenuId = '';
}

// Remove an annotation from the active session, and from everything still pointing
// at it. Synthesis already tolerates dangling refs -- expansion shows "(annotation
// removed)" and source assembly skips the gap -- but a staged Ask should not carry
// an id the user just deleted, so pendingAnnotationRefs is pruned too.
async function deleteAnnotation(annotationId) {
    selectedAnnotationIds.delete(annotationId);
    expandedAnnotationIds.delete(annotationId);
    updateAskButton();

    await modifySession(session => ({
        ...session,
        annotations: (session.annotations || []).filter(a => a.id !== annotationId),
    }));

    // Read-modify-write, and only write when the id is actually staged, so an
    // unrelated storage event is not fired on every delete.
    const stored = await chrome.storage.local.get('pendingAnnotationRefs');
    const staged = stored.pendingAnnotationRefs || [];
    if (staged.includes(annotationId)) {
        await chrome.storage.local.set({
            pendingAnnotationRefs: staged.filter(ref => ref !== annotationId),
        });
    }
}

// --- View filter ---

function getThreadMessages() {
    if (activeThreadId === 'main') {
        return conversationState.filter(m => m.threadId === 'main');
    }
    // Fork view: pull in the anchor highlight AND its summary as the header.
    // Both live in 'main' (stored once) but are displayed at the top of the fork.
    const anchor = conversationState.find(m => m.id === activeThreadId && m.threadId === 'main');
    const summary = conversationState.find(
        m => m.role === 'model' && m.type === 'summary' && m.contextRef === activeThreadId
    );
    const threadMessages = conversationState.filter(m => m.threadId === activeThreadId);

    const header = [];
    if (anchor) header.push(anchor);
    if (summary) header.push(summary);
    return [...header, ...threadMessages];
}

// --- Thread menu helpers ---

function getThreadLabel(threadId) {
    if (threadId === 'main') return 'Main Conversation';
    const anchor = conversationState.find(m => m.id === threadId && m.threadId === 'main');
    if (!anchor) return threadId.slice(0, 8) + '…';
    const raw = anchor.content.trim();
    return raw.length > 40 ? raw.slice(0, 40) + '…' : raw;
}

function getDerivedThreadIds() {
    const ids = new Set(['main']);
    for (const m of conversationState) ids.add(m.threadId);
    if (activeThreadId !== 'main') ids.add(activeThreadId);
    return ids;
}

// --- Response reconciliation ---
// A pending message needs a response if no model message already references it.
// This is idempotent: safe to call from both the initial read and onChanged,
// and it never double-triggers because it checks for an existing response.

const inFlight = new Set();

function pendingNeedsResponse(state, msg) {
    if (msg.role !== 'user' || msg.status !== 'pending') return false;
    if (inFlight.has(msg.id)) return false;
    const hasResponse = state.some(m => m.role === 'model' && m.replyTo === msg.id);
    return !hasResponse;
}

function reconcilePending(state) {
    for (const msg of state) {
        if (pendingNeedsResponse(state, msg)) {
            inFlight.add(msg.id);
            generateResponse(msg.id);
        }
    }
}

// --- Failure presentation ---

// Copy shown inside the bubble for each failure type. The keys are also the set
// of types generateResponse will accept from the server.
const FAILURE_COPY = {
    network:      "Couldn't reach the server.",
    server_error: 'Something went wrong.',
    token_limit:  'This request was too large to process. Try removing a source or shortening your selection.',
};

// token_limit is deliberately absent: the identical request would fail the same
// way, so the retry control is omitted rather than rendered disabled.
const RETRYABLE_FAILURES = new Set(['network', 'server_error']);

// Normalize a server-supplied failure type. `errorType` is the canonical spelling
// on the client and on NDJSON error lines; the pre-stream 500 body still spells it
// `type`, so both are accepted here. Anything unrecognized -- or 'network', which
// only the client may assign -- collapses to the generic server error.
function normalizeErrorType(value) {
    return FAILURE_COPY[value] && value !== 'network' ? value : 'server_error';
}

// Builds the in-bubble failure notice for a user message whose request failed.
// It is appended inside the bubble so it reads as part of the message, matching
// where the "more" and "Fork thread" controls now sit.
//
// Styling is inline rather than class-based because the nc-* palette classes live
// in sidepanel.html, which this task does not touch; the CSS variables it
// references are declared on :root there and so are available here.
function createFailureNotice(message) {
    // Messages that failed before failureType existed fall back to the generic
    // retry-able case rather than rendering an empty notice.
    const type = FAILURE_COPY[message.failureType] ? message.failureType : 'server_error';

    const notice = document.createElement('div');
    notice.dataset.failureNotice = message.id;
    // Hairline divider, as .nc-fork-btn uses. Neutral white alpha so it reads on
    // the blue-tinted user bubble and the grey highlight bubble alike.
    notice.style.cssText =
        'margin-top:0.5rem;padding-top:0.375rem;border-top:1px solid rgba(255,255,255,0.1);';

    const text = document.createElement('p');
    text.classList.add('text-xs', 'nc-red-text');
    // Reset the italics inherited from .nc-bubble-highlight and the pre-wrap
    // inherited from the user bubble, so the notice wraps as ordinary prose.
    text.style.cssText = 'font-style:normal;white-space:normal;line-height:1.45;';
    text.textContent = FAILURE_COPY[type];
    notice.appendChild(text);

    if (RETRYABLE_FAILURES.has(type)) {
        const retryBtn = document.createElement('button');
        retryBtn.textContent = 'Retry';
        // Unchanged hook: the delegated handler keys off data-retryId.
        retryBtn.dataset.retryId = message.id;
        retryBtn.classList.add('text-xs', 'nc-accent-text', 'hover:underline', 'block');
        retryBtn.style.cssText = 'font-style:normal;margin-top:0.25rem;font-weight:500;';
        notice.appendChild(retryBtn);
    }

    return notice;
}

// Why an incomplete response stopped, keyed by the cause recorded on the message.
// These reuse the existing error taxonomy -- no new failure types.
const INCOMPLETE_CAUSE = {
    network:      'The connection dropped before the response finished.',
    server_error: 'The server stopped sending before the response finished.',
    token_limit:  'The response was cut off after the request hit a size limit.',
};

// Notice shown inside an incomplete model bubble. The text above it stops
// mid-answer, so the label has to be unmissable: a truncated answer quoted as if it
// were finished is a correctness problem, not a cosmetic one. Hence the red rule,
// the bold lead line and the explicit word "Incomplete".
//
// Retry reuses the delegated data-retryId handler, but points at the USER message,
// because generateResponse re-runs the original request -- it cannot continue a
// fragment. Styling is inline for the same reason createFailureNotice uses inline
// styles: the nc-* palette classes live in sidepanel.html, which stays untouched.
function createIncompleteNotice(message) {
    const notice = document.createElement('div');
    notice.dataset.incompleteNotice = message.id;
    notice.style.cssText =
        'margin-top:0.625rem;padding-top:0.5rem;border-top:1px solid var(--nc-red);';

    const label = document.createElement('p');
    label.classList.add('text-xs', 'nc-red-text');
    label.style.cssText =
        'font-style:normal;white-space:normal;line-height:1.45;font-weight:600;';
    label.textContent = 'Incomplete response \u2014 cut off before it finished.';
    notice.appendChild(label);

    const cause = INCOMPLETE_CAUSE[message.errorType];
    if (cause) {
        const detail = document.createElement('p');
        detail.classList.add('text-xs', 'nc-text2');
        detail.style.cssText =
            'font-style:normal;white-space:normal;line-height:1.45;margin-top:0.125rem;';
        detail.textContent = cause;
        notice.appendChild(detail);
    }

    // Without a parent question there is nothing to re-request, so the control is
    // omitted rather than rendered as a dead button.
    if (message.replyTo) {
        const retryBtn = document.createElement('button');
        retryBtn.textContent = 'Retry';
        // Unchanged hook: the delegated handler keys off data-retryId.
        retryBtn.dataset.retryId = message.replyTo;
        retryBtn.classList.add('text-xs', 'nc-accent-text', 'hover:underline', 'block');
        retryBtn.style.cssText = 'font-style:normal;margin-top:0.375rem;font-weight:500;';
        notice.appendChild(retryBtn);
    }

    return notice;
}

// --- DOM builders ---

function createHighlightCard(message) {
    const wrapper = document.createElement('div');
    wrapper.dataset.id = message.id;
    wrapper.classList.add('flex', 'flex-col', 'items-start', 'gap-0.5');

    const bubble = document.createElement('div');
    bubble.classList.add('nc-bubble-highlight', 'max-w-[85%]', 'px-3', 'py-2', 'text-sm');

    const text = document.createElement('p');
    text.classList.add('line-clamp-5');
    text.dataset.expandContent = message.id;
    text.textContent = message.content;
    bubble.appendChild(text);

    const moreBtn = document.createElement('button');
    moreBtn.textContent = 'more';
    moreBtn.dataset.expandToggle = message.id;
    moreBtn.style.display = 'none';
    moreBtn.classList.add('nc-more-btn');
    bubble.appendChild(moreBtn);

    if (message.status === 'failed') {
        bubble.appendChild(createFailureNotice(message));
    }

    wrapper.appendChild(bubble);

    return wrapper;
}

function createLoadingIndicator() {
    const wrapper = document.createElement('div');
    wrapper.classList.add('flex', 'justify-start');

    const bubble = document.createElement('div');
    bubble.classList.add('max-w-[85%]', 'px-3', 'py-2', 'text-sm', 'nc-bubble-model', 'nc-loading');
    bubble.textContent = 'Generating response…';

    wrapper.appendChild(bubble);
    return wrapper;
}

function createChatBubble(message) {
    const isUser = message.role === 'user';
    const isFailed = isUser && message.status === 'failed';
    const hasRefs = isUser && message.annotationRefs && message.annotationRefs.length > 0;

    const wrapper = document.createElement('div');
    if (!isUser) {
        wrapper.classList.add('flex', 'flex-col', 'items-start', 'gap-0.5');
    } else if (hasRefs) {
        // Only the refs toggle still renders outside the bubble.
        wrapper.classList.add('flex', 'flex-col', 'items-end', 'gap-1');
    } else {
        wrapper.classList.add('flex', 'justify-end');
    }
    wrapper.dataset.id = message.id;

    const bubble = document.createElement('div');
    bubble.classList.add(
        'max-w-[85%]', 'px-3', 'py-2', 'text-sm',
        ...(isUser ? ['nc-bubble-user', 'whitespace-pre-wrap'] : ['nc-bubble-model', 'md-content'])
    );
    if (isUser) {
        bubble.textContent = message.content;
    } else {
        bubble.innerHTML = DOMPurify.sanitize(marked.parse(message.content));
    }

    // An incomplete response gets its notice directly under the text that was cut
    // off, before any footer action, so the two read as one unit.
    if (message.role === 'model' && message.incomplete) {
        bubble.appendChild(createIncompleteNotice(message));
    }

    // Fork button rendered inside the model bubble as a footer action, below content.
    // Only on a summary viewed from main — in a fork the summary is a read-only header.
    if (message.role === 'model' && message.type === 'summary' && activeThreadId === 'main') {
        const forkBtn = document.createElement('button');
        forkBtn.textContent = 'Fork thread';
        forkBtn.dataset.forkAnchor = message.contextRef;
        forkBtn.classList.add('nc-fork-btn');
        bubble.appendChild(forkBtn);
    }

    if (isFailed) {
        bubble.appendChild(createFailureNotice(message));
    }

    wrapper.appendChild(bubble);

    // Collapsed reference toggle for synthesis messages.
    if (hasRefs) {
        const count = message.annotationRefs.length;
        const refToggle = document.createElement('button');
        refToggle.textContent = `Using ${count} annotation${count !== 1 ? 's' : ''} ▸`;
        refToggle.dataset.toggleRefs = message.id;
        refToggle.classList.add('text-xs', 'nc-accent-text', 'hover:underline');
        wrapper.appendChild(refToggle);

        // Hidden container for the expanded ref list, rendered on first open.
        const refsExpanded = document.createElement('div');
        refsExpanded.id = `refs-${message.id}`;
        refsExpanded.style.display = 'none';
        refsExpanded.classList.add('flex', 'flex-col', 'items-end', 'gap-1');
        wrapper.appendChild(refsExpanded);
    }

    return wrapper;
}

// --- Streaming view ---

// The live bubble for an in-flight response. Carries exactly the classes the model
// branch of createChatBubble uses, so the committed bubble that replaces it on
// completion is visually identical and the swap is imperceptible. The streamed
// content is now parsed Markdown, so there is no whitespace-pre-wrap here -- it
// would add spurious blank lines between the block elements marked produces.
function createStreamBubble(messageId) {
    const wrapper = document.createElement('div');
    wrapper.classList.add('flex', 'flex-col', 'items-start', 'gap-0.5');
    wrapper.dataset.streamingId = messageId;

    const bubble = document.createElement('div');
    bubble.classList.add(
        'max-w-[85%]', 'px-3', 'py-2', 'text-sm',
        'nc-bubble-model', 'md-content'
    );

    wrapper.appendChild(bubble);
    return { wrapper, bubble };
}

// Put the live bubble back into the container. renderConversation clears the
// container wholesale, which DETACHES the streaming bubble without destroying it,
// so re-appending the same node restores it with its accumulated text intact.
// This is the stream-aware render guard: it runs at the end of every render, so an
// unrelated storage write (a tab closing, a session rename) can no longer erase an
// in-progress response.
function mountStreamBubble(container) {
    if (!activeStream || !activeStream.wrapper) return;
    // The stream belongs to a thread the user is not currently viewing.
    if (activeStream.threadId !== activeThreadId) return;
    if (activeStream.wrapper.parentNode === container) return;
    container.appendChild(activeStream.wrapper);
}

// Follow the bottom, but only while the pin is still armed.
function keepStreamPinned(container) {
    if (streamPinnedToBottom) container.scrollTop = container.scrollHeight;
}

// Parse the whole accumulated string and swap it into the live bubble. Runs on a
// throttle during the stream and once more when the stream completes.
//
// DOMPurify runs on EVERY pass, never only the last one: each pass builds HTML
// from model output and assigns it to innerHTML, so skipping sanitization
// mid-stream would leave a window where unsanitized markup reaches the DOM.
//
// Re-pins after the swap, since re-parsing changes the bubble's height.
function renderStreamMarkdown(container) {
    if (!activeStream || !activeStream.bubble) return;
    activeStream.lastRenderAt = Date.now();
    try {
        activeStream.bubble.innerHTML = DOMPurify.sanitize(marked.parse(activeStream.text));
    } catch (err) {
        // Half-arrived Markdown is a stranger input than the complete documents the
        // committed path parses. Falling back to raw text keeps the response legible
        // and, more importantly, stops a parser error from escaping consumeStream
        // and being misreported as a network failure.
        console.error('NoteCrawler: Markdown parse failed mid-stream', err);
        activeStream.bubble.textContent = activeStream.text;
    }
    if (container) keepStreamPinned(container);
}

// Throttle the re-parse. The leading edge fires at once when the bubble has sat
// idle longer than the interval; otherwise a single trailing timer coalesces every
// chunk arriving inside the window into one parse.
function scheduleStreamRender(container) {
    if (!activeStream) return;
    // A pass is already pending, and it will pick up everything buffered since.
    if (activeStream.renderTimer !== null) return;

    const elapsed = Date.now() - activeStream.lastRenderAt;
    if (elapsed >= STREAM_RENDER_INTERVAL_MS) {
        renderStreamMarkdown(container);
        return;
    }

    // Tie the timer to this stream: one that ends and is replaced before the timer
    // fires must not have its pass applied to its successor.
    const owner = activeStream.messageId;
    activeStream.renderTimer = setTimeout(() => {
        if (!activeStream || activeStream.messageId !== owner) return;
        activeStream.renderTimer = null;
        renderStreamMarkdown(container);
    }, STREAM_RENDER_INTERVAL_MS - elapsed);
}

// Cancel any pending pass and parse immediately. Used when the stream completes:
// the throttle may have left the last chunks unparsed, and the finished string is
// the only one guaranteed to be syntactically whole.
function flushStreamRender(container) {
    if (!activeStream) return;
    if (activeStream.renderTimer !== null) {
        clearTimeout(activeStream.renderTimer);
        activeStream.renderTimer = null;
    }
    renderStreamMarkdown(container);
}

// Drop the in-memory stream record. Must run BEFORE the terminal modifyState
// write: that write triggers onChanged -> renderConversation, and a still-live
// activeStream would re-mount the streaming bubble next to the newly committed
// model message, showing the same response twice.
function endStream(messageId) {
    if (!activeStream || activeStream.messageId !== messageId) return;
    // Cancel a pending throttled pass: it would otherwise fire against a stream
    // record that no longer exists.
    if (activeStream.renderTimer !== null) clearTimeout(activeStream.renderTimer);
    activeStream = null;
}

// --- Render ---

function renderConversation(container) {
    container.innerHTML = '';

    const messages = getThreadMessages();

    if (!messages.length) {
        const emptyState = document.createElement('div');
        emptyState.classList.add('nc-empty-state');
        const heading = document.createElement('p');
        heading.classList.add('nc-empty-heading');
        heading.textContent = 'Ready to explore';
        const sub = document.createElement('p');
        sub.classList.add('nc-empty-sub');
        sub.textContent = 'Highlight text on any page and choose "Ask NoteCrawler," or type a question below.';
        emptyState.appendChild(heading);
        emptyState.appendChild(sub);
        container.appendChild(emptyState);
        container.scrollTop = container.scrollHeight;
        return;
    }

    for (const message of messages) {
        const el = (message.role === 'user' && message.type === 'highlight')
            ? createHighlightCard(message)
            : createChatBubble(message);
        container.appendChild(el);

        // Reveal "more" toggle for clamped highlight cards that actually overflow.
        const clampedText = el.querySelector('[data-expand-content]');
        const moreBtn = el.querySelector('[data-expand-toggle]');
        if (clampedText && moreBtn && clampedText.scrollHeight > clampedText.clientHeight) {
            moreBtn.style.display = '';
        }

        // Show the loading indicator for a pending message that has no response yet.
        // A streaming response is not in conversationState until it completes, so
        // this condition stays true for the whole stream; the final clause is the
        // explicit override that retires the indicator once real text is on screen.
        const streamingThisMessage = !!activeStream
            && activeStream.messageId === message.id
            && !!activeStream.bubble;
        const awaitingResponse = message.role === 'user'
            && message.status === 'pending'
            && !conversationState.some(m => m.role === 'model' && m.replyTo === message.id)
            && !streamingThisMessage;
        if (awaitingResponse) {
            container.appendChild(createLoadingIndicator());
        }
    }

    // Stream-aware guard: restore the in-progress bubble this rebuild detached.
    mountStreamBubble(container);

    // Outside a stream this is unchanged. Mid-stream it defers to the pin, so a
    // storage write cannot yank the view back down after the user scrolled up.
    if (!activeStream || streamPinnedToBottom) {
        container.scrollTop = container.scrollHeight;
    }
}

async function renderContextCard() {
    const card = document.getElementById('context-card');
    if (!card) return;

    // Resolve tabs first, then build. Awaiting before clearing keeps every DOM
    // mutation below synchronous, so two overlapping renders cannot interleave
    // one's clear with the other's appends.
    const activeSession = sessions[activeSessionId] || {};
    const scopedTabs = await readScopedTabs(activeSession.tabIds || []);

    card.style.display = '';
    card.innerHTML = '';

    // Priority 1: annotations staged card.
    if (pendingAnnotationRefs.length > 0) {
        const session = sessions[activeSessionId] || {};
        const annotations = session.annotations || [];

        const header = document.createElement('div');
        header.classList.add('flex', 'items-center', 'justify-between');

        const label = document.createElement('span');
        label.classList.add('text-xs', 'font-medium', 'nc-text2');
        const n = pendingAnnotationRefs.length;
        label.textContent = `${n} annotation${n !== 1 ? 's' : ''} staged`;

        const dismissBtn = document.createElement('button');
        dismissBtn.id = 'dismiss-context-card';
        dismissBtn.textContent = '×';
        dismissBtn.classList.add('nc-text2', 'text-base', 'leading-none', 'px-1');

        header.appendChild(label);
        header.appendChild(dismissBtn);
        card.appendChild(header);

        for (const id of pendingAnnotationRefs) {
            const ann = annotations.find(a => a.id === id);
            const row = document.createElement('p');
            row.classList.add('text-xs', 'nc-text2', 'truncate', 'mt-1');
            if (ann) {
                const excerpt = ann.content.length > 40 ? ann.content.slice(0, 40) + '…' : ann.content;
                row.textContent = ann.pageTitle ? `${ann.pageTitle} — ${excerpt}` : excerpt;
            } else {
                row.textContent = '(annotation removed)';
                row.classList.add('italic');
            }
            card.appendChild(row);
        }
        // Tab content is merged into synthesis requests too, so a restricted
        // source is silently lost in this path as well -- warn here also.
        appendRestrictedWarning(card, scopedTabs);
        return;
    }

    // Priority 2: tab-tracking indicator (display-only).
    const header = document.createElement('div');
    header.classList.add('flex', 'items-center', 'justify-between');

    const label = document.createElement('span');
    label.classList.add('text-xs', 'font-medium', 'nc-text2');
    const n = scopedTabs.length;
    label.textContent = `${n} tab${n !== 1 ? 's' : ''} in scope`;

    header.appendChild(label);
    card.appendChild(header);

    for (const { tabId, title } of scopedTabs) {
        const row = document.createElement('p');
        row.classList.add('text-xs', 'nc-text3', 'truncate', 'mt-1');
        row.textContent = title || `Tab ${tabId}`;
        card.appendChild(row);
    }

    appendRestrictedWarning(card, scopedTabs);
}

function createSessionMenuItem(sessionId, label) {
    const btn = document.createElement('button');
    btn.classList.add('w-full', 'text-left', 'px-3', 'py-1.5', 'text-xs', 'nc-menu-btn', 'truncate');
    if (sessionId === activeSessionId) btn.classList.add('nc-active');
    btn.textContent = label;
    btn.dataset.sessionId = sessionId;
    return btn;
}

function createThreadMenuItem(threadId, label, isChild) {
    const btn = document.createElement('button');
    btn.classList.add('w-full', 'text-left', 'px-3', 'py-1.5', 'text-xs', 'nc-menu-btn', 'truncate');
    if (isChild) btn.classList.add('pl-6');
    if (threadId === activeThreadId) btn.classList.add('nc-active');
    // 'main' never gets ↳ even when indented under a session entry
    btn.textContent = (isChild && threadId !== 'main' ? '↳ ' : '') + label;
    btn.dataset.threadId = threadId;
    return btn;
}

function renderThreadMenu() {
    const menu = document.getElementById('thread-menu');
    const titleEl = document.getElementById('thread-title');
    if (!menu) return;

    menu.innerHTML = '';

    // Sessions at top level (only titled sessions appear)
    const sortedSessions = Object.values(sessions)
        .filter(s => s.title !== null)
        .sort((a, b) => a.createdAt - b.createdAt);

    for (const session of sortedSessions) {
        menu.appendChild(createSessionMenuItem(session.id, session.title));

        // Indented threads appear only under the active session
        if (session.id === activeSessionId) {
            menu.appendChild(createThreadMenuItem('main', 'Main Conversation', true));
            const threadIds = getDerivedThreadIds();
            for (const id of threadIds) {
                if (id === 'main') continue;
                menu.appendChild(createThreadMenuItem(id, getThreadLabel(id), true));
            }
        }
    }

    if (titleEl) {
        const activeSession = sessions[activeSessionId];
        titleEl.textContent = activeSession?.title || getThreadLabel(activeThreadId);
    }
}

// --- Response pipeline ---
// FORCE_MOCK_FAILURE bypasses the fetch and forces the failed state so the
// retry UI can be tested without stopping the server.

// Append streamed text to the live bubble, creating it on the first chunk. This
// is the moment the loading indicator gives way to streamed output.
function appendStreamText(container, text) {
    if (!activeStream) return;
    activeStream.text += text;

    if (!activeStream.bubble) {
        const { wrapper, bubble } = createStreamBubble(activeStream.messageId);
        activeStream.wrapper = wrapper;
        activeStream.bubble = bubble;
        // Re-render once so the loading indicator disappears in the same frame the
        // bubble appears; mountStreamBubble inside the render attaches it.
        if (container) renderConversation(container);
        // Parse the first chunk at once rather than leaving an empty bubble on
        // screen for up to one throttle window.
        renderStreamMarkdown(container);
        return;
    }

    scheduleStreamRender(container);
}

// Read the NDJSON response, appending each text chunk to the live bubble as it
// arrives. The accumulated text is left on activeStream for the caller to commit in
// a single write.
//
// Returns { errorType, interrupted }, which distinguishes WHY a stream ended early
// rather than merely that it did:
//   { errorType: null,  interrupted: false }  completed cleanly on a `done` line
//   { errorType: T,     interrupted: false }  stopped before any text arrived --
//                                             an ordinary failure, nothing to keep
//   { errorType: T,     interrupted: true  }  stopped after text was already on
//                                             screen -- a partial answer worth
//                                             keeping, labelled rather than dropped
async function consumeStream(body, messageId, threadId) {
    const container = document.getElementById('side-panel-content');
    const reader = body.getReader();
    const decoder = new TextDecoder();

    activeStream = {
        messageId, threadId, text: '',
        wrapper: null, bubble: null,
        // 0 so the first chunk parses on the leading edge instead of waiting out
        // a throttle window it never needed.
        lastRenderAt: 0, renderTimer: null,
    };
    streamPinnedToBottom = true;

    let buffer = '';
    let finished = false;
    let failure = null;
    let readBroke = false;

    // Handle one complete NDJSON line. Returns false once the stream is over.
    const handleLine = line => {
        let payload;
        try {
            payload = JSON.parse(line);
        } catch {
            // One malformed line is not worth discarding the whole response over.
            console.error('NoteCrawler: skipping unparseable stream line');
            return true;
        }

        if (payload?.type === 'chunk' && typeof payload.text === 'string') {
            if (payload.text) appendStreamText(container, payload.text);
            return true;
        }
        if (payload?.type === 'error') {
            failure = normalizeErrorType(payload.errorType);
            return false;
        }
        if (payload?.type === 'done') {
            finished = true;
            return false;
        }
        // Unknown line type: ignore it so the protocol can be extended without
        // breaking older clients.
        return true;
    };

    try {
        let open = true;
        while (open) {
            const { value, done } = await reader.read();
            if (done) break;
            // stream: true so a multi-byte character split across two network
            // chunks is held back rather than decoded into a replacement char.
            buffer += decoder.decode(value, { stream: true });

            let newline;
            while (open && (newline = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, newline).trim();
                buffer = buffer.slice(newline + 1);
                if (line) open = handleLine(line);
            }
        }

        // Flush anything the decoder held back, then any final unterminated line.
        if (open && !finished && failure === null) {
            buffer += decoder.decode();
            const tail = buffer.trim();
            if (tail) handleLine(tail);
        }
    } catch (err) {
        // The socket broke partway through. Whatever already arrived stays on screen
        // and in the buffer; the tail below decides whether that is a keepable
        // fragment. Catching here is what stops a mid-stream drop from escaping to
        // generateResponse, where it would be misread as a pre-stream network
        // failure and the partial text thrown away.
        console.error('NoteCrawler /generate stream broke mid-flight:', err);
        readBroke = true;
    } finally {
        // Stop pulling as soon as we have what we need, or on an early exit.
        reader.cancel().catch(() => {});
    }

    // Three distinct ways a stream stops early, each with its own cause:
    //   an NDJSON error line     -> the server's own classification
    //   reader.read() threw      -> the socket broke, so a network failure
    //   EOF with no `done` line  -> the server stopped sending, so a server failure
    //
    // None of these is the panel-close case: closing the panel destroys this whole
    // JS context, so nothing here runs and reconcilePending re-fires on reopen.
    if (failure !== null || readBroke || !finished) {
        const errorType = failure !== null
            ? failure
            : (readBroke ? 'network' : 'server_error');
        console.error(`NoteCrawler /generate stream ended early (${errorType})`);

        // Text had already arrived, so this is an interruption rather than a plain
        // failure. Parse what landed before the break so the bubble on screen
        // matches the fragment about to be committed.
        if (activeStream && activeStream.text) {
            flushStreamRender(container);
            return { errorType, interrupted: true };
        }
        return { errorType, interrupted: false };
    }

    // One final pass over the completed string: the throttle may have dropped the
    // last chunks, and only the finished text is certain to be whole Markdown.
    flushStreamRender(container);

    return { errorType: null, interrupted: false };
}

async function generateResponse(messageId) {
    try {
        if (FORCE_MOCK_FAILURE) {
            // Set FORCE_MOCK_FAILURE to a failure type ('network' | 'server_error' |
            // 'token_limit') to preview that notice, or to true for the generic one.
            const mockType = FAILURE_COPY[FORCE_MOCK_FAILURE] ? FORCE_MOCK_FAILURE : 'server_error';
            await modifyState(state =>
                state.map(msg => msg.id === messageId ? { ...msg, status: 'failed', failureType: mockType } : msg)
            );
            return;
        }

        // Fresh storage read so parent is always found even when called immediately
        // after submitMessage (before onChanged has synced module-level state).
        const { sessions: s, activeSessionId: sid } = await readSessions();
        const sessionData = s[sid] || {};
        const parent = (sessionData.conversationState || []).find(m => m.id === messageId);
        if (!parent) return;

        // A highlight's summary references the highlight's OWN id.
        // A chat reply inherits its parent's contextRef.
        const responseContextRef = parent.type === 'highlight' ? parent.id : parent.contextRef;
        const responseType = parent.type === 'highlight' ? 'summary' : 'text';

        // Build sources and prompt for three distinct cases.
        let sources;
        let prompt;
        if (parent.type === 'highlight') {
            // Case 1: automatic highlight summary — no tab content.
            sources = [{ content: parent.content, sourceUrl: '', pageTitle: '' }];
            prompt = 'summarize';
        } else if (parent.annotationRefs && parent.annotationRefs.length > 0) {
            // Case 2: cross-source synthesis — question asked over staged annotations.
            const sessionAnnotations = sessionData.annotations || [];
            sources = parent.annotationRefs
                .map(id => sessionAnnotations.find(a => a.id === id))
                .filter(Boolean)
                .map(a => ({ content: a.content, sourceUrl: a.sourceUrl || '', pageTitle: a.pageTitle || '' }));
            if (sources.length === 0) {
                // All referenced annotations were removed; send empty sources so the
                // model still attempts to answer from the question alone.
                sources = [];
            }
            prompt = parent.content;
        } else {
            // Case 3: plain typed question, optionally in a fork with an anchor highlight.
            prompt = parent.content;
            if (parent.contextRef) {
                const anchor = (sessionData.conversationState || []).find(m => m.id === parent.contextRef);
                sources = anchor
                    ? [{ content: anchor.content, sourceUrl: '', pageTitle: '' }]
                    : [];
            } else {
                sources = [];
            }
        }

        // Supplement Cases 2 & 3 with live content from the session's in-scope tabs.
        // The highlight-summarize path is excluded — it must not gather tab content.
        if (parent.type !== 'highlight') {
            const tabIds = sessionData.tabIds || [];
            if (tabIds.length > 0) {
                try {
                    const tabResults = await new Promise(resolve => {
                        chrome.runtime.sendMessage({ type: 'READ_SESSION_TABS', tabIds }, results => {
                            if (chrome.runtime.lastError) { resolve([]); return; }
                            resolve(Array.isArray(results) ? results : []);
                        });
                    });
                    // Merge, deduplicating by sourceUrl (empty URLs are not considered duplicates).
                    const seenUrls = new Set(sources.map(s => s.sourceUrl).filter(Boolean));
                    for (const { content, sourceUrl, pageTitle } of tabResults) {
                        if (!sourceUrl || !seenUrls.has(sourceUrl)) {
                            sources.push({ content, sourceUrl, pageTitle });
                            if (sourceUrl) seenUrls.add(sourceUrl);
                        }
                    }
                } catch {
                    // Tab content is additive context — a failure here never blocks the request.
                }
            }
        }

        let errorType = null;
        // Set only when the stream died after putting text on screen.
        let interrupted = false;
        try {
            const res = await fetch('http://localhost:3000/generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sources, prompt, history: [] })
            });

            if (!res.ok) {
                // Pre-stream failure. The server never began streaming, so this is
                // still a plain JSON body behind a real status code -- handled
                // exactly as before. The server classifies its own failures; trust a
                // recognized type and fall back to a generic server error when the
                // body is absent, unparseable, or carries no usable type.
                errorType = 'server_error';
                try {
                    const body = await res.json();
                    errorType = normalizeErrorType(body?.errorType ?? body?.type);
                } catch { /* non-JSON error body, e.g. a proxy error page */ }
                console.error(`NoteCrawler /generate failed: ${res.status} (${errorType})`);
            } else if (!res.body) {
                // Nothing to read. Should not happen on a 200 from our own server.
                console.error('NoteCrawler /generate returned no readable body');
                errorType = 'server_error';
            } else {
                const outcome = await consumeStream(res.body, messageId, parent.threadId);
                errorType = outcome.errorType;
                interrupted = outcome.interrupted;
            }
        } catch (err) {
            // fetch() rejects only when no response arrived at all: server down,
            // offline, DNS or CORS failure. A stream that breaks after the headers
            // land surfaces through consumeStream instead.
            console.error('NoteCrawler /generate request failed:', err);
            errorType = 'network';
        }

        // A failure with nothing on screen: no fragment to keep, so the question
        // itself carries the notice. An interruption is deliberately NOT routed here
        // -- it has partial text and falls through to the commit below.
        if (errorType && !interrupted) {
            // Drop the partial bubble before the write: the re-render it triggers
            // must show the user message's failure notice, not stale streamed text.
            endStream(messageId);
            await modifyState(state =>
                state.map(msg => msg.id === messageId ? { ...msg, status: 'failed', failureType: errorType } : msg)
            );
            return;
        }

        // Read the buffer, then clear the stream BEFORE the single commit below, so
        // the re-render that commit triggers does not draw the live bubble and the
        // committed model message side by side.
        const reply = activeStream && activeStream.messageId === messageId
            ? activeStream.text
            : '';
        endStream(messageId);

        await modifyState(state => {
            const updated = state
                // A fresh answer supersedes an earlier incomplete attempt at the same
                // question, so Retry replaces the fragment instead of stacking a
                // second bubble beneath it. Only incomplete replies are dropped;
                // a finished answer is never discarded.
                .filter(msg => !(msg.role === 'model' && msg.replyTo === messageId && msg.incomplete))
                .map(msg => msg.id === messageId ? { ...msg, status: 'answered' } : msg);

            const response = {
                id: crypto.randomUUID(),
                role: 'model',
                type: responseType,
                content: reply,
                contextRef: responseContextRef,
                threadId: parent.threadId,
                replyTo: parent.id,
                timestamp: Date.now()
            };
            if (interrupted) {
                // The flag the incomplete label renders from, plus the cause. The
                // question is marked answered either way: something was committed,
                // so reconcilePending must not re-fire behind the explicit Retry.
                response.incomplete = true;
                response.errorType = errorType;
            }
            updated.push(response);
            return updated;
        });
    } finally {
        // Safety net: an unexpected throw must not leave a dead stream record that
        // renderConversation would keep re-mounting.
        endStream(messageId);
        inFlight.delete(messageId);
    }
}

// --- Submission ---

async function submitMessage(text) {
    const messageId = crypto.randomUUID();
    const capturedThreadId = activeThreadId;
    const contextRef = capturedThreadId === 'main' ? null : capturedThreadId;
    // Snapshot staged refs so the write and the clear are based on the same list.
    const capturedRefs = [...pendingAnnotationRefs];

    inFlight.add(messageId);
    // Use modifySession directly so we can set the session title alongside the message.
    await modifySession(session => {
        const message = {
            id: messageId,
            role: 'user',
            type: 'text',
            content: text,
            contextRef,
            threadId: capturedThreadId,
            status: 'pending',
            timestamp: Date.now()
        };
        if (capturedRefs.length > 0) {
            message.annotationRefs = capturedRefs;
        }
        const messages = [...(session.conversationState || []), message];
        const trimmed = text.trim();
        const title = session.title === null
            ? (trimmed.length > 40 ? trimmed.slice(0, 40) + '…' : trimmed)
            : session.title;
        return { ...session, conversationState: messages, title };
    });

    if (capturedRefs.length > 0) {
        await chrome.storage.local.set({ pendingAnnotationRefs: [] });
    }

    generateResponse(messageId);
}

// --- Annotations view ---

function updateAskButton() {
    const askBtn = document.getElementById('ask-btn');
    if (!askBtn) return;
    const hasSelection = selectedAnnotationIds.size > 0;
    askBtn.disabled = !hasSelection;
    askBtn.style.opacity = hasSelection ? '' : '0.5';
    askBtn.style.cursor = hasSelection ? '' : 'not-allowed';
}

function renderAnnotations() {
    const list = document.getElementById('annotations-list');
    if (!list) return;

    const session = sessions[activeSessionId] || {};
    const annotations = (session.annotations || []).slice().sort((a, b) => b.timestamp - a.timestamp);

    list.innerHTML = '';

    if (!annotations.length) {
        const emptyState = document.createElement('div');
        emptyState.classList.add('nc-empty-state');
        const heading = document.createElement('p');
        heading.classList.add('nc-empty-heading');
        heading.textContent = 'No annotations yet';
        const sub = document.createElement('p');
        sub.classList.add('nc-empty-sub');
        sub.textContent = 'Select text on any page and choose "Add Annotation" to save it here.';
        emptyState.appendChild(heading);
        emptyState.appendChild(sub);
        list.appendChild(emptyState);
        return;
    }

    for (const ann of annotations) {
        const isSelected = selectedAnnotationIds.has(ann.id);

        const card = document.createElement('div');
        card.dataset.annotationId = ann.id;
        // relative so the options wrapper below can anchor to this card.
        card.classList.add('nc-card', 'p-3', 'relative');
        if (isSelected) card.classList.add('nc-card-selected');
        card.style.cursor = 'pointer';

        // Options button and its menu, pinned to the card's top right. The wrapper is
        // absolutely positioned, which also makes it the containing block for the
        // menu, so the menu hangs off the dots rather than off the card's edge.
        const options = document.createElement('div');
        options.classList.add('absolute', 'top-1', 'right-1');

        const dotsBtn = document.createElement('button');
        dotsBtn.textContent = '⋮';
        dotsBtn.dataset.annotationMenu = ann.id;
        dotsBtn.title = 'Annotation options';
        // nc-menu-btn carries the palette colour and the hover treatment already used
        // by the session menu, so the two controls match without new CSS.
        dotsBtn.classList.add('nc-menu-btn', 'text-base', 'leading-none', 'px-1', 'rounded-lg');

        const menu = document.createElement('div');
        menu.dataset.annotationMenuFor = ann.id;
        menu.classList.add(
            'hidden', 'absolute', 'top-full', 'right-0', 'mt-1',
            'border', 'rounded-lg', 'z-10', 'py-1', 'min-w-[120px]'
        );
        // Palette inline: the matching #thread-menu rule is an ID selector and cannot
        // be reused here, and these variables are declared on :root in sidepanel.html.
        menu.style.cssText =
            'background: var(--nc-surf2); border-color: var(--nc-border); box-shadow: 0 6px 24px rgba(0, 0, 0, 0.55);';

        options.appendChild(dotsBtn);
        options.appendChild(menu);

        const content = document.createElement('p');
        // pr-6 keeps the first lines clear of the dots button.
        content.classList.add('text-sm', 'line-clamp-5', 'pr-6');
        content.dataset.expandContent = ann.id;
        content.textContent = ann.content;

        const meta = document.createElement('p');
        meta.classList.add('text-xs', 'nc-text3', 'mt-1');
        const truncUrl = ann.sourceUrl.length > 40 ? ann.sourceUrl.slice(0, 40) + '…' : ann.sourceUrl;
        meta.textContent = `${ann.pageTitle} · ${truncUrl}`;

        card.appendChild(options);
        card.appendChild(content);
        card.appendChild(meta);
        list.appendChild(card);

        // Overflow is only measurable while the text is clamped, so measure here --
        // after the card is in the DOM, as the old inline control did -- and apply the
        // in-memory expansion afterwards.
        const overflows = content.scrollHeight > content.clientHeight;
        const isExpanded = expandedAnnotationIds.has(ann.id);
        if (isExpanded) content.classList.remove('line-clamp-5');

        // Expand/Collapse appears only when there is text to reveal, so a short
        // annotation offers no pointless action. Delete always appears.
        if (overflows) {
            menu.appendChild(createAnnotationMenuItem('expand', ann.id, isExpanded ? 'Collapse' : 'Expand'));
        }
        menu.appendChild(createAnnotationMenuItem('delete', ann.id, 'Delete'));

        if (ann.id === openAnnotationMenuId) menu.classList.remove('hidden');
    }
}

function switchTab(tab) {
    activeTab = tab;
    const isConv = tab === 'conversation';

    const convView = document.getElementById('conversation-view');
    const annView = document.getElementById('annotations-view');
    const tabConv = document.getElementById('tab-conversation');
    const tabAnn = document.getElementById('tab-annotations');

    if (convView) convView.style.display = isConv ? '' : 'none';
    if (annView) annView.style.display = isConv ? 'none' : '';

    if (tabConv) {
        tabConv.classList.toggle('font-semibold', isConv);
        tabConv.classList.toggle('nc-tab-active', isConv);
        tabConv.classList.toggle('nc-tab-inactive', !isConv);
    }
    if (tabAnn) {
        tabAnn.classList.toggle('font-semibold', !isConv);
        tabAnn.classList.toggle('nc-tab-active', !isConv);
        tabAnn.classList.toggle('nc-tab-inactive', isConv);
    }

    if (tab === 'annotations') renderAnnotations();
}

// --- Init ---

document.addEventListener('DOMContentLoaded', async () => {
    const container = document.getElementById('side-panel-content');
    if (!container) {
        console.error('Side Panel container not found.');
        return;
    }

    const textarea = document.getElementById('user-input');
    const sendBtn = document.getElementById('send-btn');
    const menuBtn = document.getElementById('menu-btn');
    const threadMenu = document.getElementById('thread-menu');
    const contextCard = document.getElementById('context-card');
    const tabConversationBtn = document.getElementById('tab-conversation');
    const tabAnnotationsBtn = document.getElementById('tab-annotations');
    const annotationsListEl = document.getElementById('annotations-list');
    const askBtnEl = document.getElementById('ask-btn');
    const newChatBtn = document.getElementById('new-chat-btn');

    const init = await ensureActiveSession();
    sessions = init.sessions;
    activeSessionId = init.activeSessionId;

    // Auto-associate this tab with the active session on open.
    const openingTabId = await getCurrentTabId();
    await addTabToSession(activeSessionId, openingTabId);
    // Refresh so the initial render reflects the newly joined tab.
    const refreshed = await readSessions();
    sessions = refreshed.sessions;

    const initSession = sessions[activeSessionId] || {};
    conversationState = initSession.conversationState || [];
    activeThreadId = initSession.activeThreadId || 'main';

    // Load any refs that were staged before the panel opened.
    const refsResult = await chrome.storage.local.get('pendingAnnotationRefs');
    pendingAnnotationRefs = refsResult.pendingAnnotationRefs || [];

    renderConversation(container);
    renderThreadMenu();
    renderContextCard();

    // Trigger responses for any pending messages that arrived while the panel
    // was closed (e.g. a context-menu highlight). Idempotent.
    reconcilePending(conversationState);

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;

        if (changes.sessions) {
            sessions = changes.sessions.newValue || {};
        }
        if (changes.activeSessionId) {
            activeSessionId = changes.activeSessionId.newValue || '';
        }
        if (changes.pendingAnnotationRefs) {
            pendingAnnotationRefs = changes.pendingAnnotationRefs.newValue || [];
            renderContextCard();
        }

        if (changes.sessions || changes.activeSessionId) {
            const session = sessions[activeSessionId] || {};
            conversationState = session.conversationState || [];
            activeThreadId = session.activeThreadId || 'main';
            reconcilePending(conversationState);
            renderConversation(container);
            renderThreadMenu();
            renderContextCard();
            if (activeTab === 'annotations') renderAnnotations();
        }
    });

    function handleSubmit() {
        const text = textarea.value.trim();
        if (!text) return;
        textarea.value = '';
        submitMessage(text);
    }

    sendBtn.addEventListener('click', handleSubmit);

    textarea.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSubmit();
        }
    });

    menuBtn.addEventListener('click', e => {
        e.stopPropagation();
        threadMenu.classList.toggle('hidden');
    });

    document.addEventListener('click', () => {
        threadMenu.classList.add('hidden');
        closeAnnotationMenus();
    });

    threadMenu.addEventListener('click', async e => {
        const sessionId = e.target.dataset.sessionId;
        if (sessionId) {
            await setActiveSession(sessionId);
            // Also join this tab to the selected session so it appears in scope.
            const tabId = await getCurrentTabId();
            await addTabToSession(sessionId, tabId);
            return;
        }
        const threadId = e.target.dataset.threadId;
        if (!threadId) return;
        await setActiveThread(threadId);
    });

    contextCard.addEventListener('click', async e => {
        // Dismissal is in-memory only and scoped to this exact restricted set, so
        // the notice returns if a different restricted tab later joins.
        const dismissKey = e.target.dataset.dismissRestricted;
        if (dismissKey !== undefined) {
            dismissedRestrictedKey = dismissKey;
            renderContextCard();
            return;
        }

        if (e.target.id === 'dismiss-context-card') {
            await chrome.storage.local.set({ pendingAnnotationRefs: [] });
        }
    });

    // Release the streaming scroll pin when the user scrolls away from the bottom,
    // and re-arm it when they return. Only consulted while a stream is live, so it
    // has no effect on ordinary scrolling.
    container.addEventListener('scroll', () => {
        const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
        streamPinnedToBottom = distance <= STREAM_PIN_SLACK_PX;
    }, { passive: true });

    container.addEventListener('click', async e => {
        const retryId = e.target.dataset.retryId;
        if (retryId) {
            inFlight.add(retryId);
            await modifyState(messages =>
                messages.map(msg => {
                    if (msg.id !== retryId) return msg;
                    // Drop failureType entirely rather than nulling it, so a stale
                    // type can never leak into a later render.
                    const { failureType: _cleared, ...rest } = msg;
                    return { ...rest, status: 'pending' };
                })
            );
            generateResponse(retryId);
            return;
        }

        const forkAnchor = e.target.dataset.forkAnchor;
        if (forkAnchor) {
            await setActiveThread(forkAnchor);
            return;
        }

        const expandToggle = e.target.dataset.expandToggle;
        if (expandToggle) {
            const textEl = document.querySelector(`[data-expand-content="${expandToggle}"]`);
            if (!textEl) return;
            const isExpanded = !textEl.classList.contains('line-clamp-5');
            if (isExpanded) {
                textEl.classList.add('line-clamp-5');
                e.target.textContent = 'more';
            } else {
                textEl.classList.remove('line-clamp-5');
                e.target.textContent = 'less';
            }
            return;
        }

        const toggleRefs = e.target.dataset.toggleRefs;
        if (toggleRefs) {
            const refsEl = document.getElementById(`refs-${toggleRefs}`);
            if (!refsEl) return;

            const msg = conversationState.find(m => m.id === toggleRefs);
            const count = msg?.annotationRefs?.length || 0;
            const label = `Using ${count} annotation${count !== 1 ? 's' : ''}`;
            const isExpanded = refsEl.style.display !== 'none';

            if (isExpanded) {
                refsEl.style.display = 'none';
                e.target.textContent = `${label} ▸`;
                return;
            }

            // Render on first expand (and re-render on subsequent to pick up any removed annotations).
            refsEl.innerHTML = '';
            const session = sessions[activeSessionId] || {};
            const annotations = session.annotations || [];

            for (const id of (msg?.annotationRefs || [])) {
                const ann = annotations.find(a => a.id === id);
                const row = document.createElement('div');
                row.classList.add('nc-card', 'px-3', 'py-1.5', 'text-xs', 'nc-text2', 'max-w-[85%]');
                if (ann) {
                    const excerpt = ann.content.length > 40 ? ann.content.slice(0, 40) + '…' : ann.content;
                    row.textContent = ann.pageTitle ? `${ann.pageTitle} — ${excerpt}` : excerpt;
                } else {
                    row.textContent = '(annotation removed)';
                    row.classList.add('italic', 'nc-text3');
                }
                refsEl.appendChild(row);
            }

            refsEl.style.display = '';
            e.target.textContent = `${label} ▾`;
            return;
        }
    });

    tabConversationBtn.addEventListener('click', () => switchTab('conversation'));
    tabAnnotationsBtn.addEventListener('click', () => switchTab('annotations'));

    annotationsListEl.addEventListener('click', async e => {
        // Two click targets now share each card: the body selects, the dots menu does
        // not. Every options target bails before the selection branch below.

        const menuToggleId = e.target.dataset.annotationMenu;
        if (menuToggleId) {
            // Stop the document-level close handler from seeing this same click and
            // shutting the menu again immediately after it opens.
            e.stopPropagation();
            const shouldOpen = openAnnotationMenuId !== menuToggleId;
            closeAnnotationMenus();
            if (shouldOpen) {
                const menu = annotationsListEl.querySelector(`[data-annotation-menu-for="${menuToggleId}"]`);
                if (menu) {
                    menu.classList.remove('hidden');
                    openAnnotationMenuId = menuToggleId;
                }
            }
            return;
        }

        const expandId = e.target.dataset.annotationExpand;
        if (expandId) {
            e.stopPropagation();
            const textEl = annotationsListEl.querySelector(`[data-expand-content="${expandId}"]`);
            if (textEl) {
                if (expandedAnnotationIds.has(expandId)) {
                    expandedAnnotationIds.delete(expandId);
                    textEl.classList.add('line-clamp-5');
                } else {
                    expandedAnnotationIds.add(expandId);
                    textEl.classList.remove('line-clamp-5');
                }
                // The label is rebuilt from the Set on the next render, but update it
                // now too so a re-opened menu is correct even without one.
                e.target.textContent = expandedAnnotationIds.has(expandId) ? 'Collapse' : 'Expand';
            }
            closeAnnotationMenus();
            return;
        }

        const deleteId = e.target.dataset.annotationDelete;
        if (deleteId) {
            e.stopPropagation();
            closeAnnotationMenus();
            await deleteAnnotation(deleteId);
            return;
        }

        // A click on the menu's own padding, between items, must not fall through to
        // the card body and toggle selection.
        if (e.target.closest('[data-annotation-menu-for]')) {
            e.stopPropagation();
            return;
        }

        const card = e.target.closest('[data-annotation-id]');
        if (!card) return;
        const id = card.dataset.annotationId;
        if (selectedAnnotationIds.has(id)) {
            selectedAnnotationIds.delete(id);
            card.classList.remove('nc-card-selected');
        } else {
            selectedAnnotationIds.add(id);
            card.classList.add('nc-card-selected');
        }
        updateAskButton();
    });

    askBtnEl.addEventListener('click', async () => {
        if (selectedAnnotationIds.size === 0) return;
        await chrome.storage.local.set({ pendingAnnotationRefs: [...selectedAnnotationIds] });
        selectedAnnotationIds.clear();
        updateAskButton();
        switchTab('conversation');
    });

    newChatBtn.addEventListener('click', async () => {
        await startNewSession();
        selectedAnnotationIds.clear();
        updateAskButton();
        if (activeTab !== 'conversation') switchTab('conversation');
    });

    updateAskButton();

});
