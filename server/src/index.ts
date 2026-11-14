import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { Pool } from 'pg';
import { createNexusBrain } from './brain.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 4000);
const ADMIN_TOKEN = (process.env.NEXUS_ADMIN_TOKEN || '').trim();

function hasValidAdminToken(value: unknown) {
  if (!ADMIN_TOKEN || typeof value !== 'string') return false;
  const supplied = Buffer.from(value);
  const expected = Buffer.from(ADMIN_TOKEN);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
const WEBSITE_URL = process.env.WEBSITE_URL || 'https://tinetech-nexus-tower.onrender.com';

const allowedOrigins = (
  process.env.CORS_ORIGINS ||
  'http://localhost:5173,http://127.0.0.1:5173'
).split(',').map(s => s.trim());

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: allowedOrigins, methods: ['GET', 'POST'] }
});

io.use((socket, next) => {
  if (hasValidAdminToken(socket.handshake.auth?.token)) return next();
  next(new Error('Nexus authentication required.'));
});

app.use(cors({
  origin(origin, cb) {
    if (!origin || allowedOrigins.includes(origin) || process.env.NODE_ENV !== 'production') {
      return cb(null, true);
    }
    return cb(new Error('Origin not allowed'));
  }
}));

app.use(express.json({ limit: '256kb' }));

app.use('/api', (req, res, next) => {
  if (req.path === '/health' || req.path === '/website/health') return next();
  if (!ADMIN_TOKEN) {
    return res.status(503).json({ error: 'Nexus API is locked. Configure NEXUS_ADMIN_TOKEN on the server.' });
  }
  const authorization = req.header('authorization') || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!hasValidAdminToken(token)) {
    return res.status(401).json({ error: 'Nexus authentication required.' });
  }
  next();
});

const startedAt = Date.now();

let lastHealth: any = {
  status: 'unknown',
  code: null,
  latency: null,
  checkedAt: null,
  error: null,
  url: WEBSITE_URL
};

const audit: any[] = [];
const workOrders = new Map<string, any>();
const aiCommandWindows = new Map<string, { startedAt: number; count: number }>();

function limitAiCommands(req: any, res: any, next: any) {
  const key = String(req.ip || req.socket?.remoteAddress || 'unknown');
  const now = Date.now();
  const windowMs = 60 * 60 * 1000;
  const maxRequests = 10;

  let window = aiCommandWindows.get(key);

  if (!window || now - window.startedAt >= windowMs) {
    window = { startedAt: now, count: 0 };
  }

  if (window.count >= maxRequests) {
    return res.status(429).json({
      error: 'AI task limit reached for this IP. Try again later.'
    });
  }

  window.count++;
  aiCommandWindows.set(key, window);

  if (aiCommandWindows.size > 2000) {
    for (const [ip, entry] of aiCommandWindows) {
      if (now - entry.startedAt >= windowMs) aiCommandWindows.delete(ip);
    }
  }

  next();
}

const pg = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false },
      max: 5
    })
  : null;

let dbReady = false;

function logAudit(action: string, actor: string, details: unknown, result = 'recorded') {
  const entry = {
    id: randomUUID(),
    action,
    actor,
    details,
    result,
    at: new Date().toISOString()
  };

  audit.unshift(entry);
  if (audit.length > 500) audit.length = 500;

  if (pg && dbReady) {
    pg.query(
      'INSERT INTO audit_log(id, action, actor, details, result, created_at) VALUES($1,$2,$3,$4,$5,$6)',
      [entry.id, action, actor, JSON.stringify(details), result, entry.at]
    ).catch(err => console.error('audit persistence failed:', err.message));
  }

  io.emit('audit:event', entry);
  return entry;
}

async function initDatabase() {
  if (!pg) return;

  try {
    await pg.query(`
      CREATE TABLE IF NOT EXISTS work_orders (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        department TEXT NOT NULL,
        priority TEXT NOT NULL DEFAULT 'normal',
        status TEXT NOT NULL DEFAULT 'queued',
        progress INTEGER NOT NULL DEFAULT 0,
        owner TEXT NOT NULL DEFAULT 'Chief of Staff relay',
        source TEXT NOT NULL DEFAULT 'president',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        result TEXT,
        error TEXT,
        plan JSONB,
        deliverables JSONB
      );
    `);

    await pg.query('ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS result TEXT');
    await pg.query('ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS error TEXT');
    await pg.query('ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS plan JSONB');
    await pg.query('ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS deliverables JSONB');

    await pg.query(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        actor TEXT NOT NULL,
        details JSONB NOT NULL DEFAULT '{}',
        result TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    dbReady = true;

    const { rows } = await pg.query(
      'SELECT * FROM work_orders ORDER BY created_at DESC LIMIT 500'
    );

    for (const row of rows) {
      workOrders.set(row.id, {
        id: row.id,
        title: row.title,
        department: row.department,
        priority: row.priority,
        status: row.status,
        progress: row.progress,
        owner: row.owner,
        source: row.source,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        result: row.result,
        error: row.error,
        plan: row.plan,
        deliverables: row.deliverables
      });
    }

    console.log('PostgreSQL connected; tables ready.');
  } catch (e: any) {
    console.error('PostgreSQL unavailable; using in-memory queue:', e.message);
  }
}

async function persistOrder(o: any) {
  if (process.env.NODE_ENV === 'production' && (!pg || !dbReady)) {
    throw new Error('Durable PostgreSQL storage is required before production tasks can be accepted. Configure DATABASE_URL and verify the database connection.');
  }
  if (pg && dbReady) {
    await pg.query(`
      INSERT INTO work_orders (
        id, title, department, priority, status, progress, owner, source,
        created_at, updated_at, result, error, plan, deliverables
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),$10,$11,$12,$13)
      ON CONFLICT(id) DO UPDATE SET
        title=EXCLUDED.title,
        department=EXCLUDED.department,
        priority=EXCLUDED.priority,
        status=EXCLUDED.status,
        progress=EXCLUDED.progress,
        owner=EXCLUDED.owner,
        source=EXCLUDED.source,
        updated_at=NOW(),
        result=EXCLUDED.result,
        error=EXCLUDED.error,
        plan=EXCLUDED.plan,
        deliverables=EXCLUDED.deliverables
    `, [
      o.id, o.title, o.department, o.priority, o.status, o.progress,
      o.owner, o.source, o.createdAt, o.result || null, o.error || null,
      JSON.stringify(o.plan || null), JSON.stringify(o.deliverables || null)
    ]);
  }
}

async function checkWebsite() {
  const started = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    let response: Response;

    try {
      response = await fetch(WEBSITE_URL, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: { 'user-agent': 'TineTech-Nexus-HealthMonitor/1.0' }
      });
    } catch {
      response = await fetch(WEBSITE_URL, {
        method: 'HEAD',
        redirect: 'follow',
        signal: controller.signal,
        headers: { 'user-agent': 'TineTech-Nexus-HealthMonitor/1.0' }
      });
    }

    const latency = Math.round(performance.now() - started);

    lastHealth = {
      status: response.ok ? (latency > 2500 ? 'degraded' : 'healthy') :
        (response.status >= 500 ? 'down' : 'degraded'),
      code: response.status,
      latency,
      checkedAt: new Date().toISOString(),
      error: response.ok ? null : `HTTP ${response.status}`,
      url: WEBSITE_URL,
      finalUrl: response.url
    };
  } catch (e: any) {
    lastHealth = {
      status: 'down',
      code: null,
      latency: Math.round(performance.now() - started),
      checkedAt: new Date().toISOString(),
      error: e.name === 'AbortError'
        ? 'Health check timed out after 12 seconds'
        : String(e.message || e),
      url: WEBSITE_URL
    };
  } finally {
    clearTimeout(timeout);
  }

  io.emit('website:health', lastHealth);

  if (lastHealth.status === 'down') {
    io.emit('tower:alert', {
      level: 'critical',
      title: 'Production website unreachable',
      detail: lastHealth.error || 'Website health check failed.'
    });

    logAudit(
      'website.health.down',
      'health-monitor',
      {
        status: lastHealth.status,
        code: lastHealth.code,
        latency: lastHealth.latency
      },
      'observed'
    );
  }

  return lastHealth;
}

const brain = createNexusBrain({
  io,
  audit: (action, actor, details, result) => {
    logAudit(action, actor, details, result);
  },
  persist: persistOrder,
  load: async () => [...workOrders.values()]
});

app.get('/api/brain/status', (_req, res) => res.json(brain.status()));
app.get('/api/brain/tasks', (_req, res) => res.json(brain.listOrders().slice(0, 100)));

app.post('/api/agent/command', limitAiCommands, async (req, res) => {
  const {
    title,
    objective,
    department = 'engineering',
    priority = 'normal',
    source = 'president'
  } = req.body || {};

  try {
    const order = await brain.enqueue({
      title: typeof title === 'string' ? title : objective,
      department,
      priority: ['normal', 'high', 'critical'].includes(priority) ? priority : 'normal',
      source: ['president', 'simulation', 'website'].includes(source) ? source : 'president'
    });

    res.status(202).json({
      ...order,
      execution: 'queued',
      brain: brain.status(),
      notice: 'The central Gemini brain accepted the task. AI-generated deliverables require human review.'
    });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : 'Could not queue the task.'
    });
  }
});

app.get('/api/health', (_req, res) => res.json({
  status: 'ok',
  service: 'tinetech-nexus-tower-api',
  uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
  database: dbReady ? 'connected' : pg ? 'unavailable' : 'not_configured',
  time: new Date().toISOString()
}));

app.get('/api/website/health', async (_req, res) => {
  if (!lastHealth.checkedAt) await checkWebsite();
  res.json(lastHealth);
});

app.post('/api/website/check', async (_req, res) => {
  res.json(await checkWebsite());
});

app.get('/api/website/config', (_req, res) => res.json({
  url: WEBSITE_URL,
  pollSeconds: 30,
  renderManagementConfigured: Boolean(
    process.env.RENDER_API_KEY &&
    process.env.RENDER_SERVICE_ID &&
    process.env.ENABLE_RENDER_MUTATIONS === 'true'
  ),
  mutationMode: process.env.ENABLE_RENDER_MUTATIONS === 'true'
    ? 'configured-but-approval-gated'
    : 'disabled'
}));

app.get('/api/work-orders', async (_req, res) => {
  let saved: any[] = [...workOrders.values()];

  if (pg && dbReady) {
    try {
      const { rows } = await pg.query(
        'SELECT * FROM work_orders ORDER BY created_at DESC LIMIT 500'
      );

      saved = rows.map((row: any) => ({
        id: row.id,
        title: row.title,
        department: row.department,
        priority: row.priority,
        status: row.status,
        progress: row.progress,
        owner: row.owner,
        source: row.source,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        result: row.result,
        error: row.error,
        plan: row.plan,
        deliverables: row.deliverables
      }));
    } catch (e: any) {
      return res.status(500).json({
        error: 'Database query failed',
        detail: e.message
      });
    }
  }

  const combined = new Map<string, any>();

  for (const order of saved) combined.set(order.id, order);
  for (const order of brain.listOrders()) combined.set(order.id, order);

  res.json(
    [...combined.values()]
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, 500)
  );
});

app.post('/api/work-orders', limitAiCommands, async (req, res) => {
  const {
    title,
    department,
    priority = 'normal',
    source = 'president'
  } = req.body || {};

  try {
    const order = await brain.enqueue({
      title,
      department,
      priority: ['normal', 'high', 'critical'].includes(priority) ? priority : 'normal',
      source: ['president', 'simulation', 'website'].includes(source) ? source : 'president'
    });

    res.status(202).json({
      ...order,
      execution: 'queued',
      notice: 'Accepted by the central Gemini brain. AI-generated work must be reviewed by a person.'
    });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : 'Could not queue work order.'
    });
  }
});

app.get('/api/audit', (_req, res) => res.json(audit.slice(0, 100)));

app.post('/api/agent/plan', limitAiCommands, async (req, res) => {
  const {
    objective,
    department = 'engineering',
    priority = 'normal'
  } = req.body || {};

  try {
    const order = await brain.enqueue({
      title: objective,
      department,
      priority: ['normal', 'high', 'critical'].includes(priority) ? priority : 'normal',
      source: 'president'
    });

    res.status(202).json({
      ...order,
      execution: 'queued',
      notice: 'This endpoint now submits a real Gemini-backed task to the Nexus Brain. Check /api/work-orders for progress and results.'
    });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : 'Could not queue task.'
    });
  }
});

app.post('/api/website/action', async (req, res) => {
  const { action, approvalId } = req.body || {};
  const allowed = ['deploy', 'rollback', 'restart', 'scale', 'maintenance', 'logs'];

  if (!allowed.includes(action)) {
    return res.status(400).json({ error: 'Unsupported website action.' });
  }

  if (
    process.env.ENABLE_RENDER_MUTATIONS !== 'true' ||
    !process.env.RENDER_API_KEY ||
    !process.env.RENDER_SERVICE_ID
  ) {
    logAudit(
      'website.action.blocked',
      'president',
      { action, approvalId: approvalId || null },
      'blocked-not-configured'
    );

    return res.status(503).json({
      error: 'Production control is disabled. Configure a server-side Render API adapter, authenticated approval workflow, and service-specific permissions before enabling mutations.',
      action,
      status: 'blocked'
    });
  }

  logAudit(
    'website.action.blocked',
    'president',
    { action, approvalId: approvalId || null },
    'adapter-not-implemented'
  );

  return res.status(501).json({
    error: 'Credentials are present, but the production mutation adapter is deliberately not implemented in this build. No action was taken.',
    action,
    status: 'not_implemented'
  });
});

io.on('connection', socket => {
  socket.emit('website:health', lastHealth);
  socket.emit('brain:status', brain.status());
  socket.emit('tower:hello', {
    connected: true,
    agentExecution: brain.status().configured,
    workers: 1000,
    at: new Date().toISOString()
  });
});

// Locate client/dist correctly from server/dist/index.js.
const clientDistPath = path.resolve(__dirname, '../../client/dist');

app.use(express.static(clientDistPath));

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/socket.io/')) {
    return next();
  }

  res.sendFile(path.join(clientDistPath, 'index.html'), error => {
    if (error) next(error);
  });
});

await initDatabase();
await brain.restore();

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Nexus Tower API listening on :${PORT}`);
});

checkWebsite().catch(err => console.error('initial website check failed:', err));

setInterval(() => {
  checkWebsite().catch(err => console.error('website monitor failed:', err));
}, 30000);

setInterval(() => {
  io.emit('tower:heartbeat', {
    at: new Date().toISOString(),
    simulation: true,
    workers: 1000,
    agentExecution: brain.status().configured
  });
}, 5000);