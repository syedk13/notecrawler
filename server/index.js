import 'dotenv/config';
import express from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';

if (!process.env.GEMINI_API_KEY) {
    console.error('Error: GEMINI_API_KEY is not set. Add it to server/.env and restart.');
    process.exit(1);
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-3.5-flash' });

const app = express();
const PORT = 3000;

// Permissive CORS for local development — tighten to the extension origin for production.
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }
    next();
});

app.use(express.json());

function buildSourceBlock(source, index, total) {
    const lines = [];
    const label = total > 1 ? `Source ${index + 1}` : 'Source';
    if (source.pageTitle && source.sourceUrl) {
        lines.push(`${label}: ${source.pageTitle} (${source.sourceUrl})`);
    } else if (source.pageTitle) {
        lines.push(`${label}: ${source.pageTitle}`);
    } else if (source.sourceUrl) {
        lines.push(`${label}: ${source.sourceUrl}`);
    } else {
        lines.push(`${label}:`);
    }
    lines.push('---');
    lines.push(source.content || '');
    return lines.join('\n');
}

function buildContents(sources, prompt, history) {
    const allSourceBlocks = sources
        .map((s, i) => buildSourceBlock(s, i, sources.length))
        .join('\n\n');

    // --- Summarize path: the "Ask NoteCrawler" highlight flow ---
    if (prompt === 'summarize') {
        const text = [
            'You are a research assistant for graduate students.',
            'Summarize the following passage clearly and concisely,',
            'highlighting the key claims and any important context.',
            '',
            allSourceBlocks,
        ].join('\n');
        return [{ role: 'user', parts: [{ text }] }];
    }

    // --- Answer path: the user asked a real question ---
    const preamble = [
        'You are a research assistant for graduate students.',
        'Use the following source material to answer the user\'s question.',
        'If the sources present differing or contradictory information, address that directly.',
        'Ground your answer in the sources; do not simply summarize them.',
        '',
        allSourceBlocks,
        '',
    ].join('\n');

    // No prior conversation: single user turn with sources + question.
    if (history.length === 0) {
        const text = preamble + '\nQuestion: ' + prompt;
        return [{ role: 'user', parts: [{ text }] }];
    }

    // Follow-up: prepend the source preamble to the first user turn,
    // replay history, then append the new question.
    let preambleAdded = false;
    const contents = history.map(turn => {
        const role = turn.role === 'model' ? 'model' : 'user';
        let text = turn.content;
        if (role === 'user' && !preambleAdded) {
            text = preamble + turn.content;
            preambleAdded = true;
        }
        return { role, parts: [{ text }] };
    });
    contents.push({ role: 'user', parts: [{ text: prompt }] });
    return contents;
}

// Phrases that indicate the request was rejected for its input size.
// Matched case-insensitively against the error message, SDK detail text, and
// the cause chain. Grouped by the failure mode each group actually comes from.
const TOKEN_LIMIT_PATTERNS = [
    // Context-window overflow (HTTP 400). Gemini phrases this as
    // "The input token count (N) exceeds the maximum number of tokens allowed (M)."
    'token count',
    'tokens allowed',
    'maximum number of tokens',
    'too many tokens',
    'token limit',
    'input is too long',
    'context length',
    'context window',

    // Input-token quota rejection (HTTP 429). This is what an oversized request
    // actually hits first: the per-minute input-token quota is far below the
    // model's context window, so the quota trips before the window ever does.
    // These spellings are NOT covered by the spaced phrases above -- the quota
    // metric name is underscored ("..._input_token_count") and the human-readable
    // description reads "input tokens per minute limit exceeded".
    'input_token_count',
    'input tokens per minute',
    'input token limit',

    // Request-body size rejection (HTTP 400/413).
    'payload size exceeds',
    'request entity too large',
    'request too large',
];

// Classify a caught /generate failure so the client can branch on the error type
// rather than the HTTP status. Fully defensive: it inspects whatever shape the
// error happens to have and never throws — anything unrecognized or unreadable
// falls through to 'server_error'.
function classifyError(err) {
    try {
        const parts = [];
        const push = value => { if (typeof value === 'string' && value) parts.push(value); };

        if (err !== null && typeof err === 'object') {
            // Walk the cause chain too: when the SDK wraps a transport failure the
            // only useful text can sit on err.cause rather than err.message.
            const seen = new Set();
            let node = err;
            for (let depth = 0; node !== null && typeof node === 'object' && depth < 5; depth++) {
                if (seen.has(node)) break;
                seen.add(node);
                push(node.message);
                push(node.statusText);
                if (node.errorDetails != null) {
                    // errorDetails may hold circular refs or unserializable values.
                    try { push(JSON.stringify(node.errorDetails)); } catch { /* skip */ }
                }
                node = node.cause;
            }
        } else {
            push(String(err));
        }

        const haystack = parts.join(' ').toLowerCase();
        if (TOKEN_LIMIT_PATTERNS.some(pattern => haystack.includes(pattern))) {
            return 'token_limit';
        }

        // 413 is unambiguously an input-size rejection. A bare 400 is not —
        // malformed requests and safety blocks also return 400, so status alone
        // is only trusted for 413; everything else must match on message text.
        const statuses = [err?.status, err?.statusCode, err?.code, err?.response?.status];
        if (statuses.some(status => Number(status) === 413)) {
            return 'token_limit';
        }

        return 'server_error';
    } catch {
        // Classification itself must never surface an error to the caller.
        return 'server_error';
    }
}

// Open the NDJSON response. Called lazily, immediately before the first line is
// written, because flushing headers is the point of no return: until it happens
// the status code is still ours to choose, so a failure before the first chunk
// can still answer with the original 500 + JSON error shape.
function beginNdjsonStream(res) {
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    // no-transform tells intermediaries not to buffer or recompress the body;
    // X-Accel-Buffering disables the response buffer if nginx is ever in front.
    // Without these a proxy can hold chunks back and defeat the streaming.
    res.setHeader('Cache-Control', 'no-cache, no-store, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    // No Content-Length is set, so Node falls back to chunked transfer encoding.
    res.flushHeaders();
}

// Write one newline-terminated JSON object. JSON.stringify escapes any newlines
// inside the text, so a chunk can never split itself across two NDJSON lines.
// Returns false when the line could not be written — i.e. the client is gone.
function writeStreamLine(res, payload) {
    if (res.writableEnded || res.destroyed) return false;
    try {
        res.write(JSON.stringify(payload) + '\n');
        // flush() only exists when a compression middleware has wrapped the
        // response. None is installed today, but guard so adding one later
        // doesn't start buffering the stream silently.
        if (typeof res.flush === 'function') res.flush();
        return true;
    } catch (err) {
        console.error('Failed to write stream line:', err);
        return false;
    }
}

app.post('/generate', async (req, res) => {
    console.log('Received request at /generate');

    // Flips the moment the first NDJSON byte leaves the server. It is the
    // boundary between the two error paths: before it, a failure is reported with
    // an HTTP status; after it, the status is already on the wire and the only
    // way to report a failure is an NDJSON error line.
    let streamStarted = false;

    // Closing the side panel aborts the request mid-stream. Stop pulling chunks
    // from Gemini rather than writing into a dead socket. 'close' also fires
    // after a normal end(), hence the writableEnded guard.
    let clientGone = false;
    res.on('close', () => {
        if (!res.writableEnded) clientGone = true;
    });

    try {
        const { sources = [], prompt = '', history = [] } = req.body;
        const contents = buildContents(sources, prompt, history);

        // Rejects for auth failures, a bad model name and oversized input. All of
        // those happen before any output, so they reach the catch below while
        // streamStarted is still false and keep the original 500 + JSON contract.
        const result = await model.generateContentStream({ contents });

        // The SDK also exposes a promise for the aggregated response. We consume
        // the stream directly and never await it, so attach a no-op handler to
        // stop a stream failure from also surfacing as an unhandled rejection.
        if (typeof result?.response?.catch === 'function') {
            result.response.catch(() => {});
        }

        for await (const chunk of result.stream) {
            if (clientGone) break;

            // A chunk can legitimately carry no text (safety ratings, usage
            // metadata) or throw while decoding. Neither ends the stream.
            let text = '';
            try {
                text = chunk.text();
            } catch (err) {
                console.error('Skipping unreadable stream chunk:', err);
                continue;
            }
            if (!text) continue;

            if (!streamStarted) {
                beginNdjsonStream(res);
                streamStarted = true;
            }
            if (!writeStreamLine(res, { type: 'chunk', text })) {
                clientGone = true;
                break;
            }
        }

        // Nothing worth saying to a client that already hung up.
        if (clientGone) return res.end();

        // A response that produced no text at all still needs a well-formed body,
        // so open the stream now and let the client see an empty-but-valid result
        // rather than a hanging request.
        if (!streamStarted) {
            beginNdjsonStream(res);
            streamStarted = true;
        }
        writeStreamLine(res, { type: 'done' });
        res.end();
    } catch (err) {
        console.error('Gemini generation failed:', err);
        const type = classifyError(err);

        // Pre-stream failure: unchanged from the blocking implementation.
        if (!streamStarted) {
            return res.status(500).json({ error: err?.message ?? String(err), type });
        }

        // In-stream failure: the 200 is already sent, so the failure has to ride
        // down the stream as its last line. `errorType` is the canonical field
        // name on the wire; the taxonomy itself still comes from classifyError.
        writeStreamLine(res, { type: 'error', errorType: type });
        res.end();
    }
});

// Error-handling middleware. Errors thrown BEFORE a route runs never reach the
// /generate catch block: express.json() rejects an oversized body with
// PayloadTooLargeError while parsing, and Express's default handler would answer
// with an HTML error page the extension cannot parse. This converts those into
// the same { error, type } JSON shape the route returns, reusing classifyError so
// there is one source of truth for classification.
//
// Must stay last, and must keep all four parameters -- Express identifies an
// error handler by its arity, so dropping `next` would silently make it a normal
// middleware that never runs.
app.use((err, req, res, next) => {
    // A response already in flight cannot be rewritten -- hand it back to Express.
    if (res.headersSent) return next(err);

    console.error('Request rejected before reaching /generate:', err);

    let status = 500;
    let message = 'Unknown error';
    try {
        // Preserve the real client-error status (413 for an oversized body, 400 for
        // malformed JSON) rather than masking it as 500; the client still branches
        // on `type`, not on the status.
        const raw = Number(err?.status ?? err?.statusCode);
        if (Number.isInteger(raw) && raw >= 400 && raw <= 599) status = raw;
        message = typeof err?.message === 'string' ? err.message : String(err);
    } catch { /* fall back to the defaults above */ }

    res.status(status).json({ error: message, type: classifyError(err) });
});

app.listen(PORT, () => {
    console.log(`NoteCrawler server listening on http://localhost:${PORT}`);
});
