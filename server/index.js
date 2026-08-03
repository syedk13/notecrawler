import 'dotenv/config';
import express from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';

if (!process.env.GEMINI_API_KEY) {
    console.error('Error: GEMINI_API_KEY is not set. Add it to server/.env and restart.');
    process.exit(1);
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

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

function buildContents(sources, prompt, history) {
    const source = sources[0] || {};

    // Build the source reference block, omitting empty fields gracefully.
    const sourceLines = [];
    if (source.pageTitle && source.sourceUrl) {
        sourceLines.push(`Source: ${source.pageTitle} (${source.sourceUrl})`);
    } else if (source.pageTitle) {
        sourceLines.push(`Source: ${source.pageTitle}`);
    } else if (source.sourceUrl) {
        sourceLines.push(`Source: ${source.sourceUrl}`);
    }
    sourceLines.push('---');
    sourceLines.push(source.content || '');
    const sourceBlock = sourceLines.join('\n');

    if (history.length === 0) {
        const text = [
            'You are a research assistant for graduate students.',
            'Summarize the following passage clearly and concisely,',
            'highlighting the key claims and any important context.',
            '',
            sourceBlock,
        ].join('\n');
        return [{ role: 'user', parts: [{ text }] }];
    }

    // Follow-up: prepend source block to the first user turn in history,
    // replay remaining turns, then append the new prompt.
    const preamble = [
        'You are a research assistant for graduate students.',
        '',
        sourceBlock,
        '',
    ].join('\n');

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

app.post('/generate', async (req, res) => {
    try {
        const { sources = [], prompt = '', history = [] } = req.body;
        const contents = buildContents(sources, prompt, history);
        const result = await model.generateContent({ contents });
        const reply = result.response.text();
        res.json({ reply });
    } catch (err) {
        console.error('Gemini generation failed:', err);
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`NoteCrawler server listening on http://localhost:${PORT}`);
});
