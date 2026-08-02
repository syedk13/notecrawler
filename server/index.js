const express = require('express');

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

app.post('/generate', (req, res) => {
    try {
        res.json({ reply: 'This is a hardcoded response from the NoteCrawler server.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`NoteCrawler server listening on http://localhost:${PORT}`);
});
