# NoteCrawler

A Chrome extension (Manifest V3) for capturing text from any web page and querying it with an LLM. Highlights, annotations and conversations are grouped into **sessions**, so research on one topic stays together and can be asked about as a whole.

Built with vanilla JavaScript and Tailwind CSS — no framework, no bundler, no build step for the application code.

---

## Overview & Purpose

Reading across a dozen tabs produces notes that are hard to reconcile. NoteCrawler sits in Chrome's side panel and keeps the capture-and-question loop in one place:

- **Capture** — right-click any selection to save it as an annotation, or send it straight to the model for a summary.
- **Scope** — a session can be bound to specific open tabs, whose page text is pulled in as live context at request time rather than being copied and frozen.
- **Query** — stage any combination of saved annotations and ask a question across them. Answers stream in token by token.
- **Branch** — fork a side thread off any summary to dig into one source without losing the main conversation.

Everything lives in `chrome.storage.local`. Responses come from a small local Express server that proxies Google's Gemini API, so the API key stays off the client.

---

## Key Features

### Session-based annotation management
Each session owns its own conversation, annotations and tab scope. Switching sessions switches all three. Annotations are listed in a dedicated tab, newest first, and are never shared between sessions.

### Per-card options menu
Every annotation card carries a vertical-dots menu in its top-right corner with two actions:

- **Expand / Collapse** — toggles a five-line text clamp. The label reflects the card's current state, so reopening the menu after expanding reads "Collapse". The action only appears when the text *actually* overflows five lines, measured from the DOM, so short annotations offer no pointless control.
- **Delete** — removes the annotation from the session, and simultaneously drops it from the in-memory selection and from any staged query, so a pending "Ask" can never reference something that no longer exists.

Expansion state is deliberately in-memory only. It is a view preference, not part of the annotation, and never touches storage.

### Multi-target card interaction
Two independent click targets coexist on every card: the **card body** toggles selection for query staging, and the **options menu** does not. Both are handled by a single delegated listener on the list container, which dispatches on `data-*` hooks and stops menu clicks before they reach the selection branch — including clicks that land on the menu's own padding between items.

### Context-aware synthesis with dangling-reference handling
Staged annotations are written to `pendingAnnotationRefs` and resolved by id when the request is built. References are resolved late and tolerantly at every layer: the staging card shows `(annotation removed)` for an id that no longer resolves, and source assembly skips missing annotations rather than failing the request. Deleting an annotation that an older answer referenced degrades that answer's provenance display without corrupting it.

### Streaming responses
Answers stream over **NDJSON** (newline-delimited JSON) rather than arriving as one blocking payload, with Markdown rendered progressively as text arrives. See [Streaming architecture](#streaming-architecture) below.

### Typed failures and interruption recovery
Failures are classified server-side into `network`, `server_error` or `token_limit`, and each renders distinct copy. A `token_limit` failure omits the Retry control entirely rather than showing a disabled one, because the identical request would fail the same way. A stream that dies mid-flight keeps the partial text, labels it **Incomplete**, and offers Retry.

### Conversation forking
Any highlight summary can be forked into its own thread. Threads are a flat array tagged with `threadId` rather than a nested tree; a fork view pulls its anchor highlight and summary in as a read-only header.

---

## Architecture & Tech Stack

| Layer | Technology |
|---|---|
| Extension | Manifest V3, vanilla JavaScript (ES2022), Chrome Side Panel API |
| Styling | Tailwind CSS v4 (CLI), CSS custom properties for the dark palette |
| Markdown | `marked` + `DOMPurify`, vendored locally as UMD bundles |
| State | `chrome.storage.local` + `chrome.storage.onChanged` |
| Backend | Node.js, Express 5 (ES modules) |
| Model | Gemini (`gemini-3.5-flash`) via `@google/generative-ai` |

### Data flow

```
┌─────────────────┐   context menu    ┌──────────────────┐
│   Web page      │ ────────────────► │  background.js   │
│  (selection)    │                   │ (service worker) │
└─────────────────┘                   └────────┬─────────┘
                                               │ read-modify-write
                                      ┌────────▼─────────┐
                                      │ chrome.storage   │  ← single source of truth
                                      │     .local       │
                                      └────────┬─────────┘
                                               │ onChanged
                                      ┌────────▼─────────┐
                                      │  sidepanel.js    │
                                      │  (full re-render)│
                                      └────────┬─────────┘
                                               │ POST /generate
                                      ┌────────▼─────────┐
                                      │ Express server   │
                                      │  (localhost)     │
                                      └────────┬─────────┘
                                               │ generateContentStream
                                      ┌────────▼─────────┐
                                      │   Gemini API     │
                                      └──────────────────┘
                                               │
                                        NDJSON lines back
                                        to the side panel
```

### Storage as the single source of truth

The UI is a pure function of storage. Every mutation is an awaited read-modify-write; `chrome.storage.onChanged` then fires and triggers a full re-render. There is no local component state to drift out of sync, no diffing, and no reconciliation logic — the cost is re-rendering the list on every change, which is negligible at this scale.

Two helpers wrap the pattern:

```js
modifySession(updater)   // replace the active session
modifyState(updater)     // replace the active session's conversationState
```

### Data model

```
sessions: {
  [sessionId]: {
    id, title, createdAt,
    activeThreadId,
    tabIds:            [tabId, ...],         // tabs scoped to this session
    annotations:       [{ id, content, sourceUrl, pageTitle, timestamp }],
    conversationState: [ message, ... ]      // flat; threads are tagged, not nested
  }
}
activeSessionId:        sessionId
pendingAnnotationRefs:  [annotationId, ...]  // transient staging for the next query
```

A message:

```js
{
  id, role,            // 'user' | 'model'
  type,                // 'highlight' | 'summary' | 'text'
  content,
  threadId,            // 'main' or the anchor highlight's id
  contextRef,          // anchor highlight, for forked threads
  replyTo,             // the user message a model reply answers
  status,              // 'pending' | 'answered' | 'failed'
  annotationRefs,      // ids this question was asked over
  failureType,         // 'network' | 'server_error' | 'token_limit'
  incomplete,          // true when a stream died mid-answer
  errorType,           // why it was cut off
  timestamp
}
```

### Streaming architecture

Streaming is the one place the storage-driven render model is bypassed, and it is bypassed deliberately.

Writing each chunk to storage would fire `onChanged` at chunk frequency, rebuilding the entire conversation on every token. So an in-flight response is held **in memory** instead, written directly to its own live DOM node, and committed to `conversationState` in **exactly one write** when the stream completes.

That creates a second problem: a streaming bubble does not exist in storage, so any unrelated storage write mid-stream — closing a tab prunes `tabIds`, for instance — would rebuild the conversation from storage and erase the in-progress response. The render is therefore **stream-aware**: because clearing the container detaches children without destroying them, the live node is re-attached after each rebuild with its accumulated text intact.

**Wire protocol** — one JSON object per line:

```
{"type":"chunk","text":"..."}        text, zero or more
{"type":"error","errorType":"..."}   typed failure, mid-stream only
{"type":"done"}                      clean completion
```

**Rendering** — the accumulated string is re-parsed through `marked` → `DOMPurify` on a ~100ms throttle, with a final pass on completion. Parsing per chunk would churn the DOM and make half-arrived Markdown jump: a lone `| a | b |` renders as a paragraph and then becomes an entire `<table>` once the delimiter row lands. Parsing only at the end would show raw `**` and `##` for the whole response. `DOMPurify` runs on *every* pass, not just the last, since each pass assigns model output to `innerHTML`.

**Error boundary** — once the first byte is flushed the HTTP status is fixed, so failures split in two: anything detected *before* streaming starts returns a normal `500` with a JSON body; anything *after* rides down the stream as an `error` line.

**Interruption** — a stream that ends without a `done` line is distinguished by *why* it stopped. A dropped connection or truncated response with text already on screen commits the partial answer flagged `incomplete` and offers Retry. Closing the side panel is a separate path: nothing was committed, so the question stays `pending` and the request re-fires when the panel reopens.

### Other design notes

- **Idempotent response dispatch.** An `inFlight` set plus `replyTo` matching means a pending question is never answered twice, whether reconciliation runs from the initial storage read or from an `onChanged` event.
- **Late-bound tab context.** Scoped tabs are read at request time via `chrome.scripting.executeScript`, extracting `main`/`article` (falling back to `body`), collapsing whitespace and capping at 20,000 characters per tab. Unreadable tabs are skipped silently, and the panel warns up front how many are unreadable.
- **Restricted-URL detection.** `chrome://`, `chrome-extension://`, `edge://`, `about:`, `view-source:` and `file://` pages are treated as unreadable, as is any `http://` origin other than `localhost`/`127.0.0.1` — the extension holds `host_permissions` for `https://*/*` only.
- **No CDN.** MV3's content security policy forbids remote scripts, so `marked` and `DOMPurify` are vendored into `extension/lib/`.
- **Key isolation.** The Gemini key lives only in `server/.env`, read through `dotenv`. The extension never sees it.

---

## Setup & Installation

### Prerequisites

- Google Chrome (or any Chromium browser with Side Panel support)
- Node.js 18 or newer
- A [Google AI Studio](https://aistudio.google.com/apikey) API key

### 1. Start the backend

```bash
cd server
npm install

# Create server/.env with your key:
echo "GEMINI_API_KEY=your_key_here" > .env

npm start
```

The server listens on `http://localhost:3000` and exits immediately with a clear message if `GEMINI_API_KEY` is missing. The port is fixed in `server/index.js`.

### 2. Build the stylesheet

```bash
cd extension
npm install
npm run build      # one-off, minified
```

For development, run the watcher instead so `output.css` regenerates whenever a Tailwind class is added:

```bash
npm run dev
```

Tailwind v4 scans source files for class names, so **any new utility class requires a rebuild** — a class that has not been compiled silently has no effect.

### 3. Load the extension

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `extension/` directory

The extension must be reloaded from that page after any change to `background.js` or `manifest.json`. Changes to side-panel files only need the panel reopened.

> The backend must be running for any request to succeed. With it stopped, requests fail as `network` and the panel offers Retry.

---

## Usage Guide

### Saving annotations

Select text on any page, right-click, and choose **Add Annotation**. It is saved to the active session and appears in the **Annotations** tab with its page title and source URL. No side panel needs to be open.

### Asking about a highlight

Select text and choose **Ask NoteCrawler**. The side panel opens, the highlight appears as a quote, and a summary streams in beneath it. The first highlight in a fresh session also becomes that session's title.

### Managing annotation cards

- **Click the card body** to stage it for a query. Selected cards are visibly highlighted, and the **Ask** button enables once at least one is selected.
- **Click the ⋮ menu** for per-card actions:
  - **Expand / Collapse** — show or re-clamp the full text. Only offered when the text exceeds five lines.
  - **Delete** — remove the annotation. It is also dropped from the current selection and from any staged query.

Only one card's menu is open at a time; clicking anywhere else closes it.

### Querying across annotations

Stage one or more annotations, then press **Ask**. The panel switches to the conversation view with a card showing what is staged. Type a question and send it. The model receives every staged annotation as a separate labelled source, plus the live text of any tabs scoped to the session, and is instructed to address contradictions between sources rather than summarise them.

Each answer carries a collapsed **"Using N annotations"** toggle listing its sources. An annotation deleted after the fact shows as `(annotation removed)` — the answer stays intact.

### Scoping tabs to a session

Use the **⋮** menu in the conversation header to add the current tab to the session. Scoped tab text is read fresh on every request, so answers reflect the page as it is now. If any scoped tab is unreadable, the panel says so before you send, once per set of tabs.

### Forking a thread

Any highlight summary carries a **Fork thread** action. Forking opens a thread anchored to that highlight, with the highlight and its summary pinned as a read-only header. Switch between the main conversation and forks from the header menu.

### Reading answers

Answers stream in and render as Markdown — headings, lists, tables, code blocks and links. If a response is cut short, the partial text is kept and labelled **Incomplete response — cut off before it finished**, with a Retry control. Retry re-requests a complete answer and replaces the fragment.

---

## Project structure

```
extension/
├── manifest.json          MV3 manifest: permissions, side panel, service worker
├── background.js          Service worker: context menus, session bootstrap,
│                          tab-text extraction, tab cleanup
├── content.js             Declared placeholder; currently empty (page text is
│                          read via chrome.scripting.executeScript instead)
├── lib/
│   ├── marked.min.js      Vendored Markdown parser (no CDN under MV3 CSP)
│   └── purify.min.js      Vendored HTML sanitiser
├── src/input.css          Tailwind entry point
└── sidepanel/
    ├── sidepanel.html     Markup, CSS custom properties, nc-* palette classes
    ├── sidepanel.js       All panel logic: render, storage, streaming, events
    └── output.css         Tailwind build output (generated — do not edit)

server/
├── index.js               Express app: /generate, NDJSON streaming,
│                          error classification, 413 handler
└── .env                   GEMINI_API_KEY (gitignored)
```

### API

**`POST /generate`**

```json
{
  "sources": [{ "content": "...", "sourceUrl": "...", "pageTitle": "..." }],
  "prompt":  "a question, or the literal \"summarize\"",
  "history": []
}
```

Responds `200` with an `application/x-ndjson` stream on success, or a JSON body on a pre-stream failure:

```json
{ "error": "human-readable message", "type": "token_limit" }
```

Errors are classified by inspecting the message text, SDK error details and the full cause chain, with `413` treated as unambiguously size-related. Oversized request bodies are rejected by `express.json()` before the route runs; a dedicated error-handling middleware converts those into the same JSON shape rather than Chrome receiving an HTML error page.

---

## Known limitations

- **Local backend only.** The server runs on `localhost:3000`; there is no hosted deployment.
- **No automated test suite.** `npm test` is an unconfigured placeholder in both packages.
- **Conversation history is not sent.** `/generate` accepts a `history` array and the server builds multi-turn contents from it, but the client currently sends `[]`, so each question is answered independently.
- **Text selection drops mid-stream.** Each throttled render pass reassigns `innerHTML`, which clears a selection inside a streaming bubble. Finished messages are unaffected.
- **Free-tier rate limits.** Gemini's free tier allows roughly 5 requests/minute and 250,000 input tokens/minute — well below the model's context window. Large multi-tab requests hit the token-per-minute quota first and surface as `token_limit`.
- **`https://` pages only** for content scripts and page reads, per `host_permissions`.
