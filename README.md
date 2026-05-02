# EKS SRE — Plataforma de Microservicios

Plataforma de microservicios estilo producción desplegada sobre Amazon EKS, con enfoque SRE. Incluye una API REST y un worker en segundo plano, observabilidad completa con Prometheus y Grafana, pipeline CI/CD con Jenkins, autoscaling horizontal y simulación de fallos.

---

## Arquitectura

```
┌─────────────────────────────────────────────────────────────┐
│  Jenkins (EC2)                                              │
│  git push → build → ECR push → kubectl set image            │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│  Amazon EKS Cluster — namespace: default                    │
│                                                             │
│  ┌──────────────────┐     ┌──────────────────────────────┐  │
│  │  api-service     │     │  worker                      │  │
│  │  2–8 réplicas    │     │  1–4 réplicas                │  │
│  │  Puerto 3000     │     │  Métricas en puerto 9091     │  │
│  │  /api/tasks      │     │  Procesador en segundo plano │  │
│  └────────┬─────────┘     └──────────────┬───────────────┘  │
│           │ ClusterIP                    │ ClusterIP        │
│           └──────────────┬───────────────┘                  │
│                          │                                  │
│  ┌───────────────────────▼─────────────────────────────┐    │
│  │  Prometheus Operator                                │    │
│  │  ServiceMonitor → scrapea /metrics cada 15s         │    │
│  │  PrometheusRule → 8 reglas de alertas               │    │
│  └───────────────────────┬─────────────────────────────┘    │
│                          │                                  │
│  ┌───────────────────────▼─────────────────────────────┐    │
│  │  Grafana + Alertmanager                             │    │
│  │  11 paneles: requests, latencia, errores, infra     │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│  HPA: api-service (2–8) · worker (1–4)                      │
└─────────────────────────────────────────────────────────────┘
```

---

## Estructura del Repositorio

```
.
├── api-service/
│   ├── app.js              # API REST con métricas Prometheus y endpoints de caos
│   ├── Dockerfile
│   └── package.json
├── worker/
│   ├── worker.js           # Worker con métricas Prometheus
│   ├── Dockerfile
│   └── package.json
├── k8s/
│   ├── deployment.yaml         # Deployment del api-service
│   ├── service.yaml            # Service ClusterIP del api-service
│   ├── worker-deployment.yaml  # Deployment y Service del worker
│   ├── servicemonitor.yaml     # ServiceMonitors para Prometheus
│   ├── ingress.yaml            # Ingress ALB (entorno con privilegios completos)
│   ├── iam_policy.json         # Política IAM para el AWS Load Balancer Controller
│   ├── hpa/
│   │   └── hpa.yaml            # HorizontalPodAutoscaler para api-service y worker
│   └── alerts/
│       └── prometheusrule.yaml # Reglas de alertas SRE
├── jenkins/
│   └── Jenkinsfile             # Pipeline CI/CD declarativo
├── grafana-dashboards/
│   └── eks-sre-dashboard.json  # Dashboard importable de Grafana
├── deploy.sh                   # Script helper de operaciones
├── .env                        # Variables secretas — NO subir a git
├── .gitignore
└── docs/
    └── RUNBOOK.md              # Runbook de respuesta a incidentes
```

---

## Prerequisitos

- Cluster EKS corriendo (v1.27+)
- `kubectl` configurado con acceso al cluster
- `docker` instalado
- `aws-cli` configurado
- Prometheus Operator desplegado (`kube-prometheus-stack`)
- `metrics-server` corriendo (requerido para HPA)
- Repositorios ECR creados:
  ```bash
  aws ecr create-repository --repository-name api-service --region <REGION>
  aws ecr create-repository --repository-name worker      --region <REGION>
  ```

---

## Configuración Inicial

### 1. Clonar el repositorio y configurar variables

```bash
git clone https://github.com/<usuario>/eks-sre-platform.git
cd eks-sre-platform
```

Crear el archivo `.env` con los valores reales:

```bash
# ── AWS ──────────────────────────────────────────────
AWS_ACCOUNT_ID=
AWS_REGION=
EKS_CLUSTER=

# ── ECR ──────────────────────────────────────────────
ECR_REPO_API=api-service
ECR_REPO_WORKER=worker
IMAGE_TAG=v1
```

### 2. Construir y subir imágenes a ECR

```bash
./deploy.sh build
./deploy.sh push
```

### 3. Desplegar en el cluster

```bash
./deploy.sh apply
```

Este comando sustituye los placeholders del `.env`, aplica todos los manifiestos y espera a que los deployments estén listos.

### 4. Verificar el estado

```bash
./deploy.sh status
```

---

## Acceso a los Servicios

Este entorno no cuenta con un Load Balancer externo, por lo que el acceso se realiza mediante `port-forward`:

```bash
./deploy.sh portforward
```

| Servicio | URL local |
|---|---|
| API REST | http://localhost:8080 |
| Grafana | http://localhost:3000 |
| Prometheus | http://localhost:9090 |
| Alertmanager | http://localhost:9093 |

**Credenciales de Grafana**: `admin` / `prom-operator`

> En un entorno con privilegios completos (OIDC + IRSA + AWS Load Balancer Controller), aplicar `k8s/ingress.yaml` provisiona un ALB automáticamente. Ver detalles en el propio archivo y en `docs/RUNBOOK.md`.

---

## API REST

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/healthz` | Liveness probe |
| GET | `/readyz` | Readiness probe |
| GET | `/metrics` | Métricas de Prometheus |
| GET | `/api/tasks` | Listar tareas |
| POST | `/api/tasks` | Crear tarea `{"title", "priority"}` |
| GET | `/api/tasks/:id` | Obtener tarea por ID |
| PATCH | `/api/tasks/:id` | Actualizar tarea |
| DELETE | `/api/tasks/:id` | Eliminar tarea |
| POST | `/debug/crash` | ⚠️ Forzar crash del pod |
| POST | `/debug/oom` | ⚠️ Simular agotamiento de memoria |
| POST | `/debug/slow` | ⚠️ Inyectar latencia `{"ms": 3000}` |

---

## Observabilidad

### Métricas disponibles

**api-service** (puerto 3000):
- `http_requests_total` — total de requests por método, ruta y código de estado
- `http_request_duration_seconds` — histograma de latencia
- `http_requests_in_flight` — requests en curso
- `task_queue_size` — tamaño de la cola de tareas
- `api_errors_total` — errores por ruta y tipo

**worker** (puerto 9091):
- `worker_tasks_processed_total` — tareas procesadas por estado (success/failed)
- `worker_task_duration_seconds` — duración de procesamiento
- `worker_queue_depth` — profundidad simulada de la cola
- `worker_errors_total` — errores por tipo
- `worker_cycles_total` — ciclos de procesamiento ejecutados

### Alertas configuradas

| Alerta | Severidad | Condición |
|--------|-----------|-----------|
| `HighErrorRate` | critical | Tasa de errores 5xx > 5% por 2 minutos |
| `HighLatencyP99` | warning | Latencia p99 > 1s por 3 minutos |
| `PodCrashLooping` | critical | Pod reiniciado más de una vez en 15 minutos |
| `APIServiceDown` | critical | Sin pods disponibles en Prometheus |
| `WorkerHighErrorRate` | warning | Errores del worker > 0.1/s por 3 minutos |
| `WorkerQueueDepthHigh` | warning | Cola > 50 elementos por 5 minutos |
| `NodeHighCPU` | warning | CPU del nodo > 80% por 5 minutos |
| `PodOOMKilled` | critical | Container terminado por OOMKilled |

### Importar dashboard en Grafana

```
Grafana → Dashboards → Import → Subir grafana-dashboards/eks-sre-dashboard.json
Seleccionar datasource "Prometheus" → Import
```

---

## CI/CD con Jenkins

El pipeline en `jenkins/Jenkinsfile` ejecuta las siguientes etapas:

1. **Checkout** — clona el repositorio y extrae el hash del commit
2. **Test** — lint de ambos servicios en paralelo
3. **ECR Login** — autenticación con las credenciales de AWS
4. **Build & Push** — construcción y push en paralelo de ambas imágenes con tag `<BUILD_NUMBER>-<git-sha>`
5. **Deploy** — `kubectl set image` con rolling update
6. **Smoke Test** — verifica `/healthz` via port-forward
7. **Apply Manifests** — aplica HPA, ServiceMonitors y PrometheusRules

En caso de fallo, el pipeline ejecuta automáticamente un rollback de ambos deployments.

**Credenciales requeridas en Jenkins UI:**
- `AWS_CREDENTIALS` — tipo AWS (Access Key + Secret)
- `KUBECONFIG_FILE` — tipo Secret file con el kubeconfig del cluster

---

## Drills de SRE

Ejecutar en staging o durante ventanas de mantenimiento.

```bash
# Crash de un pod — valida liveness probe y reinicio automático
./deploy.sh drill-crash

# Simulación de OOM — valida límites de memoria y alerta PodOOMKilled
./deploy.sh drill-oom

# Prueba de carga — valida el HPA
./deploy.sh loadtest

# Rollback manual
./deploy.sh rollback
```

---

## Limitaciones del Entorno Actual

| Limitación | Solución en Producción |
|---|---|
| Sin ALB/NLB — acceso via `port-forward` | Instalar AWS Load Balancer Controller con IRSA |
| Sin OIDC / IRSA | Asociar proveedor OIDC al cluster con `eksctl` |
| Sin DNS externo | External-DNS Controller + Route53 |
| Sin TLS | cert-manager + ACM |
| Sin Cluster Autoscaler | Karpenter o Cluster Autoscaler |
| Sin gestión de secretos | AWS Secrets Manager + External Secrets Operator |

---

## Documentación Adicional

- [`docs/RUNBOOK.md`](docs/RUNBOOK.md) — Runbook completo de respuesta a incidentes, playbooks por escenario y referencia de consultas Prometheus
