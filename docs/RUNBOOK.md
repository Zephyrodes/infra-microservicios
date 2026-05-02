# Runbook SRE — Plataforma de Microservicios en EKS

> **Alcance**: api-service, worker · **Cluster**: EKS · **Namespace**: default  
> **Última actualización**: Mayo 2026 · **Responsable**: Equipo SRE

---

## Tabla de Contenidos

1. [Referencia Rápida](#1-referencia-rápida)
2. [Estrategias de Acceso](#2-estrategias-de-acceso)
3. [Flujo de Respuesta a Incidentes](#3-flujo-de-respuesta-a-incidentes)
4. [Escenarios de Falla y Playbooks](#4-escenarios-de-falla-y-playbooks)
   - 4.1 Pod en CrashLoopBackOff
   - 4.2 Tasa de errores alta (5xx)
   - 4.3 Latencia alta
   - 4.4 OOMKilled / Memory Leak
   - 4.5 Agotamiento de recursos / Node Pressure
   - 4.6 Deployment atascado / Rollback
5. [Referencia de Observabilidad](#5-referencia-de-observabilidad)
6. [Drills de Caos SRE](#6-drills-de-caos-sre)
7. [Limitaciones del Proveedor Cloud y Brechas de Producción](#7-limitaciones-del-proveedor-cloud-y-brechas-de-producción)
8. [Configuración de Alertmanager](#8-configuración-de-alertmanager)

---

## 1. Referencia Rápida

| Elemento | Valor |
|----------|-------|
| API ClusterIP | `10.100.34.61:80` (interno) |
| Label de los pods API | `app=api` |
| Label de los pods Worker | `app=worker` |
| Nombre del container API | `api` |
| Nombre del container Worker | `worker` |
| Grafana | `kubectl port-forward svc/monitoring-grafana 3000:80` → `localhost:3000` |
| Prometheus | `kubectl port-forward svc/prometheus-operated 9090:9090` |
| Alertmanager | `kubectl port-forward svc/monitoring-kube-prometheus-alertmanager 9093:9093` |
| Métricas API | `/metrics` en puerto 3000 |
| Métricas Worker | Puerto 9091 — Service `worker-metrics` |
| Health check | `/healthz` |

**Credenciales por defecto de Grafana** (kube-prometheus-stack):
```
usuario: admin
contraseña: prom-operator
```
*(se puede cambiar via Secret `monitoring-grafana` o valores de Helm)*

---

## 2. Estrategias de Acceso

### Entorno Restringido (configuración actual — sin ALB/NLB)

En este entorno no hay Load Balancer externo disponible. El acceso se realiza mediante `port-forward`.

#### Opción A — Port-Forward (recomendado)

```bash
# Levantar todos los port-forwards de una vez
./deploy.sh portforward

# O individualmente:
kubectl port-forward svc/api-service 8080:80 &
curl http://localhost:8080/api/tasks

kubectl port-forward svc/monitoring-grafana 3000:80 &
kubectl port-forward svc/prometheus-operated 9090:9090 &
kubectl port-forward svc/monitoring-kube-prometheus-alertmanager 9093:9093 &
```

> ⚠️ Si el port-forward se cae, matar los procesos anteriores antes de reiniciar:
> ```bash
> pkill -f "port-forward"
> ```

#### Opción B — kubectl proxy

```bash
kubectl proxy &
curl http://localhost:8001/api/v1/namespaces/default/services/api-service/proxy/api/tasks
```

#### Opción C — Pod de debug dentro del cluster

```bash
kubectl run -it --rm debug --image=curlimages/curl:latest --restart=Never -- \
  curl http://api-service/api/tasks
```

### Entorno con Privilegios Completos (producción con OIDC + IRSA)

1. Asociar el proveedor OIDC al cluster:
   ```bash
   eksctl utils associate-iam-oidc-provider \
     --cluster <NOMBRE_CLUSTER> --approve
   ```
2. Crear rol IAM y adjuntar `k8s/iam_policy.json`
3. Instalar el AWS Load Balancer Controller:
   ```bash
   helm install aws-load-balancer-controller eks/aws-load-balancer-controller \
     -n kube-system \
     --set clusterName=<NOMBRE_CLUSTER> \
     --set serviceAccount.create=true \
     --set serviceAccount.annotations."eks\.amazonaws\.com/role-arn"=arn:aws:iam::<CUENTA>:role/AWSLoadBalancerControllerRole
   ```
4. Aplicar `k8s/ingress.yaml` — el ALB se provisiona automáticamente

---

## 3. Flujo de Respuesta a Incidentes

```
Se dispara una alerta
        │
        ▼
1. EVALUAR ──► Revisar dashboard de Grafana (tasa de requests, % errores, latencia)
        │
        ▼
2. CLASIFICAR ──► kubectl get pods -A  |  kubectl describe pod <pod>
        │
        ▼
3. DIAGNOSTICAR ──► kubectl logs <pod> --previous  |  kubectl top pods
        │
        ▼
4. MITIGAR ──► Rollback / restart / escalar / parchear
        │
        ▼
5. VERIFICAR ──► Observar Grafana; confirmar que la alerta se resuelve en Alertmanager
        │
        ▼
6. POST-MORTEM ──► Documentar línea de tiempo, causa raíz y acciones correctivas
```

**Niveles de Severidad**

| Severidad | Criterio | Tiempo de Respuesta |
|-----------|----------|---------------------|
| P1 | Servicio caído, tasa de errores >50% | 15 minutos |
| P2 | Tasa de errores >5%, latencia p99 >1s | 30 minutos |
| P3 | Alertas de advertencia, degradación parcial | 2 horas |

---

## 4. Escenarios de Falla y Playbooks

### 4.1 Pod en CrashLoopBackOff

**Alerta**: `PodCrashLooping`

**Síntomas**
```
NAME                   READY   STATUS             RESTARTS
api-service-xxx        0/1     CrashLoopBackOff   5
```

**Diagnóstico**
```bash
# Ver el estado detallado del pod
kubectl describe pod <nombre-pod>

# Ver los logs del container anterior
kubectl logs <nombre-pod> --previous

# Revisar eventos recientes del cluster
kubectl get events --sort-by='.lastTimestamp' | grep -i crash

# Verificar si fue terminado por OOM
kubectl get pod <nombre-pod> \
  -o jsonpath='{.status.containerStatuses[0].lastState.terminated.reason}'

# Confirmar que los probes apuntan a /healthz
kubectl describe deployment api-service | grep -A5 "Liveness\|Readiness"
```

**Mitigación**
```bash
# Forzar restart del deployment
kubectl rollout restart deployment/api-service

# Si la imagen es mala → rollback
./deploy.sh rollback

# Último recurso: escalar a cero y volver a subir
kubectl scale deployment/api-service --replicas=0
kubectl scale deployment/api-service --replicas=2
```

---

### 4.2 Tasa de Errores Alta (5xx)

**Alerta**: `HighErrorRate` — tasa de errores 5xx >5% por 2 minutos

**Diagnóstico**
```bash
# Ver estado de los pods
kubectl get pods -l app=api

# Ver logs en tiempo real
kubectl logs -l app=api --tail=100 -f

# Verificar el readiness probe
kubectl describe pod <nombre-pod> | grep -A10 "Readiness"

# Desglose de errores por ruta en Prometheus:
# sum(rate(http_requests_total{status_code=~"5.."}[5m])) by (route)
```

**Mitigación**
```bash
# Rollback a la última versión estable
./deploy.sh rollback

# Escalar temporalmente mientras se investiga
kubectl scale deployment/api-service --replicas=4
```

---

### 4.3 Latencia Alta

**Alerta**: `HighLatencyP99` — latencia p99 >1s por 3 minutos

**Diagnóstico**
```bash
# Revisar uso de recursos
kubectl top pods -l app=api
kubectl top nodes

# Ver si el HPA ya reaccionó
kubectl get hpa api-service-hpa

# Probar latencia directamente desde dentro del cluster
kubectl run -it --rm debug --image=curlimages/curl -- \
  curl -w "\ntime_total: %{time_total}s\n" http://api-service/api/tasks

# Consultas útiles en Prometheus:
# node_load1
# histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket[5m])) by (le))
```

**Mitigación**
```bash
# Escalar manualmente
kubectl scale deployment/api-service --replicas=6

# Reducir el umbral del HPA temporalmente para que escale más rápido
kubectl patch hpa api-service-hpa --type=merge \
  -p '{"spec":{"metrics":[{"type":"Resource","resource":{"name":"cpu","target":{"type":"Utilization","averageUtilization":40}}}]}}'
```

---

### 4.4 OOMKilled / Memory Leak

**Alerta**: `PodOOMKilled`

**Síntomas**
```
Last State: Terminated
  Reason:    OOMKilled
  Exit Code: 137
```

**Diagnóstico**
```bash
# Confirmar que fue OOMKilled
kubectl get pod <nombre-pod> \
  -o json | jq '.status.containerStatuses[].lastState.terminated'

# Buscar tendencia de crecimiento de memoria en Prometheus:
# container_memory_working_set_bytes{namespace="default"}

# Revisar logs del container anterior
kubectl logs <nombre-pod> --previous | grep -i "oom\|memory\|alloc"
```

**Mitigación**
```bash
# Aumentar el límite de memoria temporalmente
kubectl set resources deployment/api-service \
  --limits=memory=512Mi --requests=memory=256Mi

# La causa raíz debe corregirse en el código.
# Para perfilar memory leaks en Node.js:
#   node --inspect app.js
#   Chrome DevTools → pestaña Memory → heap snapshots
```

---

### 4.5 Agotamiento de Recursos / Node Pressure

**Alerta**: `NodeHighCPU` o `NodeHighMemory`

**Diagnóstico**
```bash
# Vista general de los nodos
kubectl top nodes
kubectl describe node <nombre-nodo> | grep -A5 "Allocated resources"

# Pods que más consumen
kubectl top pods -A --sort-by=cpu    | head -20
kubectl top pods -A --sort-by=memory | head -20

# Pods en estado Pending (posible riesgo de evicción)
kubectl get pods -A | grep -v Running

# Revisar PodDisruptionBudgets
kubectl get pdb -A
```

**Mitigación**
```bash
# Detener el scheduling de nuevos pods en el nodo afectado
kubectl cordon <nombre-nodo>

# Drenar el nodo de forma controlada
kubectl drain <nombre-nodo> --ignore-daemonsets --delete-emptydir-data

# En AWS: escalar el grupo de Auto Scaling manualmente
# aws autoscaling set-desired-capacity \
#   --auto-scaling-group-name <nombre-asg> --desired-capacity <n>
```

---

### 4.6 Deployment Atascado / Rollback

**Síntomas**: `kubectl rollout status` se queda esperando; los pods no pasan a estado Ready

**Diagnóstico**
```bash
kubectl rollout status deployment/api-service --timeout=60s
kubectl rollout history deployment/api-service
kubectl describe pod <nombre-pod> | grep -A10 "Events"
```

**Mitigación**
```bash
# Rollback a la versión anterior
./deploy.sh rollback

# Rollback a una revisión específica
kubectl rollout undo deployment/api-service --to-revision=3

# Verificar
kubectl rollout status deployment/api-service
kubectl get pods -l app=api
```

> ⚠️ Al usar `kubectl set image` directamente, verificar primero el nombre real del container:
> ```bash
> kubectl get deployment api-service \
>   -o jsonpath='{.spec.template.spec.containers[*].name}'
> ```

---

## 5. Referencia de Observabilidad

### Consultas Clave de Prometheus

| Qué medir | PromQL |
|-----------|--------|
| Tasa de requests | `sum(rate(http_requests_total[2m])) by (route)` |
| Porcentaje de errores 5xx | `sum(rate(http_requests_total{status_code=~"5.."}[2m])) / sum(rate(http_requests_total[2m])) * 100` |
| Latencia p99 | `histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket[5m])) by (le))` |
| Reinicios de pods | `rate(kube_pod_container_status_restarts_total[15m]) * 60` |
| Tareas procesadas por el worker | `sum(rate(worker_tasks_processed_total[5m])) by (status)` |
| Profundidad de cola del worker | `worker_queue_depth` |
| CPU del nodo | `100 - (avg by(instance)(rate(node_cpu_seconds_total{mode="idle"}[5m]))*100)` |
| Memoria de containers | `container_memory_working_set_bytes{namespace="default"}` |

### Importar el Dashboard en Grafana

```
Grafana → Dashboards → Import
→ Subir grafana-dashboards/eks-sre-dashboard.json
→ Seleccionar datasource "Prometheus" → Import
```

---

## 6. Drills de Caos SRE

Ejecutar en un entorno de staging o durante ventanas de mantenimiento.

### Drill A — Crash de Pod

```bash
./deploy.sh drill-crash

# Resultado esperado: el pod entra en estado Error, el liveness probe lo detecta
# y Kubernetes lo reinicia automáticamente en segundos.
# Verificar con: kubectl get pods -l app=api -w
```

### Drill B — Simulación de OOM

```bash
./deploy.sh drill-oom

# Resultado esperado: el container es terminado con OOMKilled (exit 137)
# y Kubernetes lo reinicia. La alerta PodOOMKilled se dispara.
```

### Drill C — Inyección de Latencia

```bash
kubectl exec -it $(kubectl get pod -l app=api -o jsonpath='{.items[0].metadata.name}') \
  -- wget -qO- --post-data='{"ms":5000}' http://localhost:3000/debug/slow

# Resultado esperado: pico en la latencia p99 visible en Grafana.
# Si se sostiene más de 3 minutos, se dispara la alerta HighLatencyP99.
```

### Drill D — Validación del HPA

```bash
./deploy.sh loadtest

# En otra terminal, observar cómo reacciona el HPA:
kubectl get hpa api-service-hpa -w

# Para forzar el escalado más rápido, reducir el umbral temporalmente:
kubectl patch hpa api-service-hpa --type=merge \
  -p '{"spec":{"metrics":[{"type":"Resource","resource":{"name":"cpu","target":{"type":"Utilization","averageUtilization":1}}}]}}'

# Al terminar la carga, restaurar el umbral original:
kubectl patch hpa api-service-hpa --type=merge \
  -p '{"spec":{"metrics":[{"type":"Resource","resource":{"name":"cpu","target":{"type":"Utilization","averageUtilization":60}}}]}}'
```

### Drill E — Rolling Update sin Tiempo de Inactividad

```bash
# Mientras corre el loadtest, disparar un rolling update con un nuevo tag
IMAGE_TAG=v3 ./deploy.sh push
kubectl set image deployment/api-service api=<AWS_ACCOUNT_ID>.dkr.ecr.<AWS_REGION>.amazonaws.com/api-service:v3

# Verificar que no hay errores durante el rollout
kubectl rollout status deployment/api-service
# El panel de tasa de errores en Grafana debe mantenerse en 0%
```

---

## 7. Limitaciones del Proveedor Cloud y Brechas de Producción

| Limitación | Solución Actual | Solución en Producción |
|---|---|---|
| Sin OIDC / IRSA | Rol IAM a nivel de nodo con permisos amplios | Asociar proveedor OIDC y usar IRSA por ServiceAccount |
| Sin ALB/NLB | `kubectl port-forward`, ClusterIP | AWS Load Balancer Controller + `k8s/ingress.yaml` |
| Sin DNS externo | Acceso manual via port-forward | External-DNS Controller + Route53 |
| Sin TLS | Solo HTTP | cert-manager + ACM |
| Sin Cluster Autoscaler | Escalado manual de nodos | Karpenter o Cluster Autoscaler |
| Sin gestión de secretos | Variables en el entorno local | AWS Secrets Manager + External Secrets Operator |
| Sin políticas de red | Red plana entre pods | Calico o VPC CNI network policies |
| Sin almacenamiento persistente | Aplicaciones sin estado (stateless) | EBS CSI Driver + StorageClass |

### Habilitar IRSA en Producción

```bash
# 1. Obtener la URL del proveedor OIDC del cluster
aws eks describe-cluster --name <NOMBRE_CLUSTER> \
  --query "cluster.identity.oidc.issuer" --output text

# 2. Asociar el proveedor OIDC
eksctl utils associate-iam-oidc-provider \
  --cluster <NOMBRE_CLUSTER> --approve

# 3. Crear el rol IAM con la política de confianza correspondiente al ServiceAccount

# 4. Anotar el ServiceAccount con el ARN del rol
kubectl annotate serviceaccount <nombre-sa> \
  eks.amazonaws.com/role-arn=arn:aws:iam::<CUENTA>:role/<NOMBRE_ROL>
```

---

## 8. Configuración de Alertmanager

Para recibir notificaciones, actualizar la configuración de Alertmanager:

```bash
# Ver configuración actual
kubectl get secret alertmanager-monitoring-kube-prometheus-alertmanager -o json \
  | jq -r '.data["alertmanager.yaml"]' | base64 -d
```

Ejemplo de enrutamiento a Slack:

```yaml
global:
  slack_api_url: 'https://hooks.slack.com/services/T.../B.../xxx'

route:
  receiver: slack-sre
  group_by: ['alertname', 'severity']
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h

receivers:
  - name: slack-sre
    slack_configs:
      - channel: '#alertas-sre'
        title: '{{ .GroupLabels.alertname }}'
        text: '{{ range .Alerts }}{{ .Annotations.description }}{{ end }}'
```

Aplicar la nueva configuración:

```bash
kubectl create secret generic alertmanager-monitoring-kube-prometheus-alertmanager \
  --from-file=alertmanager.yaml=./alertmanager-config.yaml \
  --dry-run=client -o yaml | kubectl apply -f -
```

---

*Despues de un incidente P1/P2 con su post-mortem correspondiente, actualizariamos el Runbook.*
