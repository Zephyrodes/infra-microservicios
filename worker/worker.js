'use strict';

const http = require('http');
const client = require('prom-client');

// ─── Registro de Prometheus ───────────────────────────────────────────────
const register = new client.Registry();
client.collectDefaultMetrics({ register });

const tasksProcessed = new client.Counter({
  name: 'worker_tasks_processed_total',
  help: 'Total tasks processed by the worker',
  labelNames: ['status'],
  registers: [register],
});

const taskDuration = new client.Histogram({
  name: 'worker_task_duration_seconds',
  help: 'Time taken to process a task',
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
  registers: [register],
});

const workerCyclesTotal = new client.Counter({
  name: 'worker_cycles_total',
  help: 'Total processing cycles executed',
  registers: [register],
});

const queueDepth = new client.Gauge({
  name: 'worker_queue_depth',
  help: 'Simulated number of pending items in queue',
  registers: [register],
});

const workerErrors = new client.Counter({
  name: 'worker_errors_total',
  help: 'Total errors during task processing',
  labelNames: ['error_type'],
  registers: [register],
});

// ─── Procesador de tareas simulado ────────────────────────────────────────
const INTERVAL_MS = parseInt(process.env.WORKER_INTERVAL_MS || '3000', 10);
const ERROR_RATE  = parseFloat(process.env.WORKER_ERROR_RATE || '0.05'); // 5% errores sintéticos

let cycleCount = 0;
let depth = Math.floor(Math.random() * 20) + 5;

async function processTask() {
  cycleCount++;
  workerCyclesTotal.inc();

  // Simular fluctuaciones de la cola
  depth = Math.max(0, depth + Math.floor(Math.random() * 5) - 2);
  queueDepth.set(depth);

  const end = taskDuration.startTimer();
  const workMs = Math.random() * 800 + 100; // trabajo sintético de 100-900 ms
  await new Promise(r => setTimeout(r, workMs));

  const failed = Math.random() < ERROR_RATE;

  if (failed) {
    workerErrors.inc({ error_type: 'processing_failure' });
    tasksProcessed.inc({ status: 'failed' });
    console.error(`[ciclo ${cycleCount}] Tarea FALLÓ (sintético) después de ${workMs.toFixed(0)}ms`);
  } else {
    tasksProcessed.inc({ status: 'success' });
    console.log(`[ciclo ${cycleCount}] Tarea OK – profundidad de cola: ${depth}, duración: ${workMs.toFixed(0)}ms`);
  }

  end();
}

// ─── Bucle principal ──────────────────────────────────────────────────────
(async function loop() {
  console.log(`worker iniciado – intervalo=${INTERVAL_MS}ms tasa_error=${ERROR_RATE}`);
  while (true) {
    try {
      await processTask();
    } catch (err) {
      workerErrors.inc({ error_type: 'unexpected' });
      console.error('[worker] error inesperado:', err.message);
    }
    await new Promise(r => setTimeout(r, INTERVAL_MS));
  }
})();

// ─── Servidor HTTP de métricas ────────────────────────────────────────────
const PORT = parseInt(process.env.METRICS_PORT || '9091', 10);
const server = http.createServer(async (req, res) => {
  if (req.url === '/metrics') {
    res.writeHead(200, { 'Content-Type': register.contentType });
    res.end(await register.metrics());
  } else if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', cycles: cycleCount }));
  } else {
    res.writeHead(404);
    res.end('no encontrado');
  }
});

server.listen(PORT, () => console.log(`servidor de métricas escuchando en :${PORT}`));

process.on('SIGTERM', () => {
  console.log('SIGTERM – apagado controlado');
  server.close(() => process.exit(0));
});
