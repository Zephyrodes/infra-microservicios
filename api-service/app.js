'use strict';

const express = require('express');
const client = require('prom-client');

const app = express();
app.use(express.json());

// ─── Registro de Prometheus ─────────────────────────────────────────────────
const register = new client.Registry();
client.collectDefaultMetrics({ register });

const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
});

const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
});

const httpRequestsInFlight = new client.Gauge({
  name: 'http_requests_in_flight',
  help: 'Number of HTTP requests currently being processed',
  registers: [register],
});

const taskQueueSize = new client.Gauge({
  name: 'task_queue_size',
  help: 'Simulated task queue depth',
  registers: [register],
});

const errorsTotal = new client.Counter({
  name: 'api_errors_total',
  help: 'Total number of API errors',
  labelNames: ['route', 'error_type'],
  registers: [register],
});

// ─── Almacenamiento de tareas en memoria (demo) ─────────────────────────────
const tasks = [];
let idSeq = 1;

// ─── Middleware: instrumentación ────────────────────────────────────────────
app.use((req, res, next) => {
  const end = httpRequestDuration.startTimer();
  httpRequestsInFlight.inc();

  res.on('finish', () => {
    const labels = {
      method: req.method,
      route: req.route ? req.route.path : req.path,
      status_code: res.statusCode,
    };
    httpRequestsTotal.inc(labels);
    end(labels);
    httpRequestsInFlight.dec();
  });

  next();
});

// ─── Probes de salud ────────────────────────────────────────────────────────
app.get('/healthz', (_req, res) => res.json({ status: 'ok', ts: Date.now() }));
app.get('/readyz', (_req, res) => {
  // Simula disponibilidad: falla si la cola está sobrecargada (demo)
  if (tasks.length > 500) {
    return res.status(503).json({ status: 'overloaded', queue: tasks.length });
  }
  res.json({ status: 'ready', queue: tasks.length });
});

// ─── Endpoint de métricas ───────────────────────────────────────────────────
app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// ─── API REST ───────────────────────────────────────────────────────────────
app.get('/api/tasks', (_req, res) => {
  taskQueueSize.set(tasks.length);
  res.json({ count: tasks.length, tasks });
});

app.post('/api/tasks', (req, res) => {
  const { title, priority = 'normal' } = req.body || {};
  if (!title) {
    errorsTotal.inc({ route: '/api/tasks', error_type: 'validation' });
    return res.status(400).json({ error: 'title is required' });
  }
  const task = { id: idSeq++, title, priority, status: 'pending', createdAt: new Date().toISOString() };
  tasks.push(task);
  taskQueueSize.set(tasks.length);
  res.status(201).json(task);
});

app.get('/api/tasks/:id', (req, res) => {
  const task = tasks.find(t => t.id === Number(req.params.id));
  if (!task) {
    errorsTotal.inc({ route: '/api/tasks/:id', error_type: 'not_found' });
    return res.status(404).json({ error: 'task not found' });
  }
  res.json(task);
});

app.patch('/api/tasks/:id', (req, res) => {
  const task = tasks.find(t => t.id === Number(req.params.id));
  if (!task) return res.status(404).json({ error: 'task not found' });
  Object.assign(task, req.body, { updatedAt: new Date().toISOString() });
  res.json(task);
});

app.delete('/api/tasks/:id', (req, res) => {
  const idx = tasks.findIndex(t => t.id === Number(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'task not found' });
  tasks.splice(idx, 1);
  taskQueueSize.set(tasks.length);
  res.status(204).send();
});

// ─── Endpoints de caos / demo SRE ───────────────────────────────────────────
app.post('/debug/crash', () => {
  console.error('[CHAOS] Forced crash triggered');
  process.exit(1);
});

app.post('/debug/oom', (_req, res) => {
  console.warn('[CHAOS] OOM simulation: allocating large buffer');
  const arr = [];
  try {
    for (let i = 0; i < 1e8; i++) arr.push(Math.random());
  } catch (e) {
    errorsTotal.inc({ route: '/debug/oom', error_type: 'oom' });
    return res.status(500).json({ error: 'OOM triggered', msg: e.message });
  }
  res.json({ allocated: arr.length });
});

app.post('/debug/slow', async (req, res) => {
  const ms = Math.min(Number(req.body?.ms) || 2000, 30000);
  await new Promise(r => setTimeout(r, ms));
  res.json({ slept_ms: ms });
});

// ─── Inicio ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`api-service listening on :${PORT}`));

process.on('SIGTERM', () => {
  console.log('SIGTERM received – apagado controlado');
  process.exit(0);
});
