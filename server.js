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
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

// ---- Rate limiting (in-memory, 10 donations per IP per day) ----
const rateLimitMap = new Map(); // ip -> { count, resetAt }
const RATE_LIMIT = 10;

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now >= entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + 86400000 });
    return true;
  }
  if (entry.count >= RATE_LIMIT) return false;
  entry.count++;
  return true;
}

// ---- Input validation ----
const { RegExpMatcher, englishDataset, englishRecommendedTransformers } = require('obscenity');

const XSS_PATTERN = /<[^>]*>|javascript:|data:|on\w+\s*=/i;
const DANGEROUS_PATTERN = /(\bexec\b|\beval\b|<script|<\/script|union\s+select|drop\s+table)/i;

const profanityMatcher = new RegExpMatcher({
  ...englishDataset.build(),
  ...englishRecommendedTransformers,
});

function validateText(str) {
  if (XSS_PATTERN.test(str)) return 'Input contains disallowed HTML or script content';
  if (DANGEROUS_PATTERN.test(str)) return 'Input contains disallowed content';
  if (profanityMatcher.hasMatch(str)) return 'Message contains profanity';
  return null;
}

// ---- Admin auth middleware ----
function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) {
    return res.status(503).json({ error: 'Admin access not configured (set ADMIN_TOKEN in .env)' });
  }
  const token = req.headers['x-admin-token'] || (req.headers['authorization'] || '').replace('Bearer ', '');
  if (token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

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

  // Validate name
  if (typeof name !== 'string' || name.length > 32) {
    return res.status(400).json({ error: 'Name must be 32 characters or fewer' });
  }
  const nameErr = validateText(name);
  if (nameErr) return res.status(400).json({ error: nameErr });

  // Validate memo if provided
  if (memo && typeof memo === 'string') {
    if (memo.length > 280) {
      return res.status(400).json({ error: 'Memo must be 280 characters or fewer' });
    }
    const memoErr = validateText(memo);
    if (memoErr) return res.status(400).json({ error: memoErr });
  }

  // Rate limit by IP
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Rate limit exceeded — max 10 donations per day' });
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

// ---- Admin Routes ----

// GET /api/admin/donations - paginated list for admin panel
app.get('/api/admin/donations', requireAdmin, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const offset = parseInt(req.query.offset) || 0;
  const stmt = db.prepare(
    'SELECT * FROM donations ORDER BY created_at DESC LIMIT ? OFFSET ?'
  );
  const rows = [];
  stmt.bind([limit, offset]);
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();

  const countStmt = db.prepare('SELECT COUNT(*) as total FROM donations');
  countStmt.step();
  const { total } = countStmt.getAsObject();
  countStmt.free();

  res.json({ donations: rows, total });
});

// DELETE /api/admin/donations/:id
app.delete('/api/admin/donations/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  if (!id || isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

  // Get the donation before deleting so we can update leaderboard
  const selectStmt = db.prepare('SELECT * FROM donations WHERE id = ?');
  selectStmt.bind([id]);
  let donation = null;
  if (selectStmt.step()) donation = selectStmt.getAsObject();
  selectStmt.free();

  if (!donation) return res.status(404).json({ error: 'Donation not found' });

  db.run('DELETE FROM donations WHERE id = ?', [id]);

  // Recalculate leaderboard entry for this donor
  const recalcStmt = db.prepare(
    'SELECT COALESCE(SUM(amount),0) as total, COUNT(*) as count FROM donations WHERE name = ?'
  );
  recalcStmt.bind([donation.name]);
  recalcStmt.step();
  const { total, count } = recalcStmt.getAsObject();
  recalcStmt.free();

  if (count === 0) {
    db.run('DELETE FROM leaderboard WHERE name = ?', [donation.name]);
  } else {
    db.run('UPDATE leaderboard SET total = ?, count = ? WHERE name = ?', [total, count, donation.name]);
  }

  saveDb();
  res.json({ success: true });
});

// Serve admin page
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Serve frontend for all other routes
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`💸 Pay It Down Please running on http://localhost:${PORT}`);
  });
});
