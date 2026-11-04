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

// Phrases that indicate the request exceeded the model's input token/size limit.
// Matched case-insensitively against the error message and any SDK detail text.
const TOKEN_LIMIT_PATTERNS = [
    'token count',
    'tokens allowed',
    'maximum number of tokens',
    'too many tokens',
    'token limit',
    'input is too long',
    'context length',
    'context window',
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
            push(err.message);
            push(err.statusText);
            if (err.errorDetails != null) {
                // errorDetails may contain circular refs or unserializable values.
                try { push(JSON.stringify(err.errorDetails)); } catch { /* skip */ }
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

app.post('/generate', async (req, res) => {
    console.log('Received request at /generate');
    try {
        const { sources = [], prompt = '', history = [] } = req.body;
        const contents = buildContents(sources, prompt, history);
        const result = await model.generateContent({ contents });
        const reply = result.response.text();
        res.json({ reply });
    } catch (err) {
        console.error('Gemini generation failed:', err);
        const type = classifyError(err);
        res.status(500).json({ error: err?.message ?? String(err), type });
    }
});

app.listen(PORT, () => {
    console.log(`NoteCrawler server listening on http://localhost:${PORT}`);
});
