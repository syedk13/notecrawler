# Skill: NoteCrawler MV3 Streaming Response Implementation

## Objective
Transition NoteCrawler's text generation pipeline from a blocking, full-payload response model to a real-time, streaming architecture using an NDJSON transport protocol, a throttled markdown render loop, and an in-memory storage buffer to maintain single-source-of-truth consistency.

---

## Finalized Architectural Decisions (Council Verdict)
1. **Transport Protocol:** NDJSON (Newline-Delimited JSON) via standard `fetch` and `res.body.getReader()`. Each line streams independent JSON objects (`{"type":"chunk","text":"..."}`, `{"type":"error","errorType":"..."}`, `{"type":"done"}`). This avoids EventSource GET limitations and safely multiplexes text with typed errors.
2. **Markdown Parsing Strategy:** Throttled parsing. Buffer raw text in memory and re-parse via `marked` + `DOMPurify` on a strict throttle (~100ms or animation frame) alongside a final pass upon completion. (Rejects unthrottled per-chunk DOM thrashing and post-stream-only rendering).
3. **Storage Strategy Exception:** A strict parallel in-memory path during the stream. Buffer text in memory, render directly to the active chat bubble DOM, and perform **a single write to `conversationState` only when the stream completes**, preventing storage thrashing.

---

## Workflow Phases

### Phase 1: Product Behavior Implementation (Pre-Flight Rules)
Implement the core UX requirements for active streams before touching the network pipeline:
1. **Loading State:** Keep the loading indicator active until the first incoming chunk arrives.
2. **Scroll Management:** Implement auto-pinning to the bottom during streaming, with an event listener that releases the pin if the user manually scrolls up.
3. **Interruption Handling:** Design the interrupted state UI badge for partial responses if a stream terminates unexpectedly.

### Phase 2: Backend Implementation (Express Server)
1. Update `server/index.js` to swap the Gemini generation call to its streaming equivalent (`generateContentStream`).
2. Stream payloads back to the client formatted as NDJSON lines.
3. Ensure structured error types (e.g., `token_limit`, `server_error`) are safely emitted as JSON error objects down the stream before closing.

### Phase 3: Client-Side Transport & Storage Buffer (`sidepanel.js`)
1. Refactor the network request from `res.json()` to consume a stream reader (`res.body.getReader()`).
2. Implement the text-accumulation buffer in memory.
3. Wire up the single-commit write to `conversationState` exclusively upon receiving the `done` marker or stream completion.

### Phase 4: Throttled Render Loop Integration
1. Implement the throttled DOM updater using the interval/animation frame strategy.
2. Ensure mid-stream text selection and code-block stability remain intact during high-frequency data arrival.

### Phase 5: Verification & Error Integration
1. Verify progressive chunk rendering using `curl` and side-panel testing.
2. Test network disconnection and panel-close scenarios to ensure partial text handling and interruption badges trigger correctly.


