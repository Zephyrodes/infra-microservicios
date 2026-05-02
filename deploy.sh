#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
#  deploy.sh — Helper de despliegue para demo SRE en EKS
#  Uso: ./deploy.sh [comando]
#  Comandos: build | push | apply | status | portforward | drill-crash | drill-oom | loadtest | rollback
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

# ── Cargar .env si existe ─────────────────────────────────────────────────
if [ -f ~/.env ]; then
  set -a
  source ~/.env
  set +a
fi

# ── Variables con fallbacks ───────────────────────────────────────────────
AWS_ACCOUNT_ID="${AWS_ACCOUNT_ID:-$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo 'UNSET')}"
AWS_REGION="${AWS_REGION:-us-east-1}"
ECR_REPO_API="${ECR_REPO_API:-api-service}"
ECR_REPO_WORKER="${ECR_REPO_WORKER:-worker}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
ECR="$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com"
NAMESPACE="${NAMESPACE:-default}"
CMD="${1:-help}"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[ADVERTENCIA]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

ecr_login() {
  info "Iniciando sesión en ECR..."
  aws ecr get-login-password --region "$AWS_REGION" \
    | docker login --username AWS --password-stdin "$ECR"
}

cmd_build() {
  info "Construyendo $ECR_REPO_API..."
  docker build --no-cache -t "$ECR/$ECR_REPO_API:$IMAGE_TAG" ./api-service

  info "Construyendo $ECR_REPO_WORKER..."
  docker build --no-cache -t "$ECR/$ECR_REPO_WORKER:$IMAGE_TAG" ./worker
  info "Build completado — tag: $IMAGE_TAG"
}

cmd_push() {
  ecr_login
  info "Subiendo $ECR_REPO_API:$IMAGE_TAG..."
  docker push "$ECR/$ECR_REPO_API:$IMAGE_TAG"

  info "Subiendo $ECR_REPO_WORKER:$IMAGE_TAG..."
  docker push "$ECR/$ECR_REPO_WORKER:$IMAGE_TAG"
  info "Push completado."
}

cmd_apply() {
  info "Sustituyendo placeholders en manifiestos..."

  # Copiar manifiestos a /tmp para no modificar los originales del repo
  cp k8s/deployment.yaml        /tmp/deployment.yaml
  cp k8s/worker-deployment.yaml /tmp/worker-deployment.yaml

  for f in /tmp/deployment.yaml /tmp/worker-deployment.yaml; do
    sed -i "s|<AWS_ACCOUNT_ID>|$AWS_ACCOUNT_ID|g" "$f"
    sed -i "s|<AWS_REGION>|$AWS_REGION|g"         "$f"
    sed -i "s|<IMAGE_TAG>|$IMAGE_TAG|g"            "$f"
  done

  info "Aplicando manifiestos..."
  kubectl apply -f /tmp/deployment.yaml           -n "$NAMESPACE"
  kubectl apply -f k8s/service.yaml               -n "$NAMESPACE"
  kubectl apply -f /tmp/worker-deployment.yaml    -n "$NAMESPACE"
  kubectl apply -f k8s/servicemonitor.yaml        -n "$NAMESPACE"
  kubectl apply -f k8s/hpa/hpa.yaml               -n "$NAMESPACE"
  kubectl apply -f k8s/alerts/prometheusrule.yaml -n "$NAMESPACE"

  info "Esperando rollout de api-service..."
  kubectl rollout status deployment/api-service -n "$NAMESPACE" --timeout=120s
  info "Esperando rollout de worker..."
  kubectl rollout status deployment/worker      -n "$NAMESPACE" --timeout=120s
  info "¡Despliegue completado!"
}

cmd_status() {
  echo ""
  echo "═══ Pods ════════════════════════════════════"
  kubectl get pods -n "$NAMESPACE" -l 'app in (api,worker)' -o wide
  echo ""
  echo "═══ Servicios ═══════════════════════════════"
  kubectl get svc -n "$NAMESPACE"
  echo ""
  echo "═══ HPA ═════════════════════════════════════"
  kubectl get hpa -n "$NAMESPACE"
  echo ""
  echo "═══ ServiceMonitors ═════════════════════════"
  kubectl get servicemonitor -n "$NAMESPACE" 2>/dev/null || warn "CRD no encontrado"
  echo ""
  echo "═══ PrometheusRules ═════════════════════════"
  kubectl get prometheusrule -n "$NAMESPACE" 2>/dev/null || warn "CRD no encontrado"
}

cmd_portforward() {
  info "Iniciando port-forwards (Ctrl+C para detener todo)..."
  pkill -f "port-forward" 2>/dev/null || true
  sleep 1

  kubectl port-forward svc/api-service                                 8080:80   -n "$NAMESPACE" &
  kubectl port-forward svc/monitoring-grafana                          3000:80   -n "$NAMESPACE" &
  kubectl port-forward svc/prometheus-operated                         9090:9090 -n "$NAMESPACE" &
  kubectl port-forward svc/monitoring-kube-prometheus-alertmanager     9093:9093 -n "$NAMESPACE" &

  echo ""
  echo "  API        → http://localhost:8080/api/tasks"
  echo "  Grafana    → http://localhost:3000  (admin/prom-operator)"
  echo "  Prometheus → http://localhost:9090"
  echo "  Alertmgr   → http://localhost:9093"
  echo ""
  wait
}

cmd_drill_crash() {
  POD=$(kubectl get pod -l app=api -n "$NAMESPACE" -o jsonpath='{.items[0].metadata.name}')
  warn "Provocando crash en el pod $POD ..."
  kubectl exec -n "$NAMESPACE" "$POD" -- \
    wget -qO- --post-data='{}' http://localhost:3000/debug/crash || true
  info "Observa el reinicio del pod:"
  kubectl get pods -l app=api -n "$NAMESPACE" -w
}

cmd_drill_oom() {
  POD=$(kubectl get pod -l app=api -n "$NAMESPACE" -o jsonpath='{.items[0].metadata.name}')
  warn "Provocando OOM en el pod $POD ..."
  kubectl exec -n "$NAMESPACE" "$POD" -- \
    wget -qO- --post-data='{}' http://localhost:3000/debug/oom || true
}

cmd_loadtest() {
  info "Lanzando pod de prueba de carga (Ctrl+C para detener)..."
  kubectl run -it --rm loadtest --image=curlimages/curl -n "$NAMESPACE" -- sh -c '
    while true; do
      curl -s http://api-service/api/tasks > /dev/null
      curl -s -X POST http://api-service/api/tasks \
        -H "Content-Type: application/json" \
        -d "{\"title\":\"load-$(date +%s)\"}" > /dev/null
    done
  '
}

cmd_rollback() {
  warn "Revirtiendo api-service..."
  kubectl rollout undo deployment/api-service -n "$NAMESPACE"
  warn "Revirtiendo worker..."
  kubectl rollout undo deployment/worker -n "$NAMESPACE"
  kubectl rollout status deployment/api-service -n "$NAMESPACE"
}

case "$CMD" in
  build)          cmd_build ;;
  push)           cmd_push ;;
  apply)          cmd_apply ;;
  status)         cmd_status ;;
  portforward|pf) cmd_portforward ;;
  drill-crash)    cmd_drill_crash ;;
  drill-oom)      cmd_drill_oom ;;
  loadtest)       cmd_loadtest ;;
  rollback)       cmd_rollback ;;
  help|*)
    echo "Uso: $0 <comando>"
    echo ""
    echo "Comandos:"
    echo "  build        Construir imágenes Docker"
    echo "  push         Subir imágenes a ECR"
    echo "  apply        Aplicar todos los manifiestos k8s"
    echo "  status       Mostrar estado del clúster"
    echo "  portforward  Iniciar todos los port-forwards"
    echo "  drill-crash  Ejercicio SRE: crash de un pod"
    echo "  drill-oom    Ejercicio SRE: simulación OOM"
    echo "  loadtest     Ejecutar prueba de carga en clúster"
    echo "  rollback     Revertir ambos deployments"
    ;;
esac
