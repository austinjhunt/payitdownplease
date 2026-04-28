require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');

// Load fallback memos from flat file (300 entries)
const FALLBACKS = require('fs')
  .readFileSync(require('path').join(__dirname, 'fallbacks.txt'), 'utf8')
  .split('\n')
  .map(l => l.trim())
  .filter(Boolean);

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'donations.db');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Ensure data dir exists
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

let db;

async function initDb() {
  const SQL = await initSqlJs();

  // Load existing DB from disk if it exists
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS donations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      amount REAL NOT NULL,
      memo TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS leaderboard (
      name TEXT PRIMARY KEY,
      total REAL NOT NULL DEFAULT 0,
      count INTEGER NOT NULL DEFAULT 0
    )
  `);

  saveDb();
}

function saveDb() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

// ---- API Routes ----

// GET /api/feed - recent donations
app.get('/api/feed', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const offset = parseInt(req.query.offset) || 0;
  const stmt = db.prepare(
    'SELECT * FROM donations ORDER BY created_at DESC LIMIT ? OFFSET ?'
  );
  const rows = [];
  stmt.bind([limit, offset]);
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  res.json({ donations: rows });
});

// GET /api/leaderboard
app.get('/api/leaderboard', (req, res) => {
  const stmt = db.prepare(
    'SELECT name, total, count FROM leaderboard ORDER BY total DESC LIMIT 10'
  );
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  res.json({ leaderboard: rows });
});

// GET /api/stats
app.get('/api/stats', (req, res) => {
  const totalStmt = db.prepare('SELECT COALESCE(SUM(amount),0) as total, COUNT(*) as count FROM donations');
  totalStmt.step();
  const stats = totalStmt.getAsObject();
  totalStmt.free();
  res.json(stats);
});

// POST /api/donate
app.post('/api/donate', async (req, res) => {
  const { name, amount, memo } = req.body;
  if (!name || !amount || amount <= 0) {
    return res.status(400).json({ error: 'Invalid donation data' });
  }

  let finalMemo = memo;

  // Generate AI memo if none provided
  if (!finalMemo || finalMemo.trim() === '') {
    finalMemo = await generateMemo(amount);
  }

  db.run(
    'INSERT INTO donations (name, amount, memo, created_at) VALUES (?, ?, ?, ?)',
    [name, amount, finalMemo, Date.now()]
  );

  db.run(
    `INSERT INTO leaderboard (name, total, count) VALUES (?, ?, 1)
     ON CONFLICT(name) DO UPDATE SET total = total + ?, count = count + 1`,
    [name, amount, amount]
  );

  saveDb();

  res.json({ success: true, donation: { name, amount, memo: finalMemo, created_at: Date.now() } });
});

// POST /api/generate-memo - standalone memo generation
app.post('/api/generate-memo', async (req, res) => {
  const { amount } = req.body;
  if (!amount) return res.status(400).json({ error: 'Amount required' });
  const memo = await generateMemo(amount);
  res.json({ memo });
});

async function generateMemo(amount) {
  const randFallback = () => FALLBACKS[Math.floor(Math.random() * FALLBACKS.length)];

  if (!process.env.ANTHROPIC_API_KEY) {
    return randFallback();
  }

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 60,
        messages: [{
          role: 'user',
          content: `Generate a single chaotic, funny, absurdist Venmo-style memo. Someone just "donated" $${Number(amount).toLocaleString()} to the U.S. national debt (yes, the Treasury really accepts this). 5-15 words. Weird, satirical, no hashtags, no quotes, just the text.`
        }]
      })
    });
    const data = await resp.json();
    return data.content?.[0]?.text?.trim() || randFallback();
  } catch (e) {
    return randFallback();
  }
}

// Serve frontend for all other routes
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`💸 Pay It Down Please running on http://localhost:${PORT}`);
  });
});
