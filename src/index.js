require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const propsRouter = require('./routes/props');
const playsRouter = require('./routes/plays');
const matchupsRouter = require('./routes/matchups');
const bankrollRouter = require('./routes/bankroll');
const healthRouter = require('./routes/health');
const linesRouter = require('./routes/lines');
const { startCron } = require('./services/lineMovementCron');
const { errorHandler } = require('./middleware/errorHandler');
const { authMiddleware } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// Rate limiting — 100 requests per 15 min per IP
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please slow down.' }
}));

// ─── Public Routes ─────────────────────────────────────────────
app.use('/health', healthRouter);

// ─── Protected Routes (require API key) ────────────────────────
app.use('/api', authMiddleware);
app.use('/api/matchups', matchupsRouter);
app.use('/api/lines', linesRouter);
app.use('/api/props', propsRouter);
app.use('/api/plays', playsRouter);
app.use('/api/bankroll', bankrollRouter);

// ─── 404 ───────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ─── Error Handler ─────────────────────────────────────────────
app.use(errorHandler);

app.listen(PORT, () => {
  startCron();
  console.log(`
╔═══════════════════════════════════════╗
║          PropIQ API v1.0              ║
║   MLB Player Props Analysis Engine    ║
╠═══════════════════════════════════════╣
║  Running on: http://localhost:${PORT}     ║
║  Env: ${process.env.NODE_ENV || 'development'}                   ║
╚═══════════════════════════════════════╝
  `);
});

module.exports = app;
