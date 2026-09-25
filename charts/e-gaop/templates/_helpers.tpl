{{/*
Expand the name of the chart.
*/}}
{{- define "e-gaop.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "e-gaop.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "e-gaop.labels" -}}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version | replace "+" "_" }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: e-gaop
{{- end }}

{{/*
Selector labels for a service
*/}}
{{- define "e-gaop.selectorLabels" -}}
app.kubernetes.io/name: {{ .name }}
app.kubernetes.io/instance: {{ .release }}
{{- end }}

{{/*
Namespace
*/}}
{{- define "e-gaop.namespace" -}}
{{- default .Release.Namespace .Values.global.namespace }}
{{- end }}

{{/*
══════════════════════════════════════════════════════════════════
  DEPLOYMENT HELPERS — used by all 9 subchart deployment templates
  Call from subcharts: include "e-gaop.<helper>" .
  Output starts at column 0; use nindent N in templates to indent.
══════════════════════════════════════════════════════════════════
*/}}

{{/*
envFrom: shared ConfigMap
*/}}
{{- define "e-gaop.envFrom" -}}
envFrom:
  - configMapRef:
      name: {{ .Release.Name }}-e-gaop-shared
{{- end }}

{{/*
Core 7 secrets from managed-secrets. Used by all backend services.
*/}}
{{- define "e-gaop.coreSecrets" -}}
- name: EGAOP_MASTER_ENCRYPTION_KEY
  valueFrom:
    secretKeyRef:
      name: {{ .Release.Name }}-e-gaop-managed-secrets
      key: encryption-key
- name: JWT_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ .Release.Name }}-e-gaop-managed-secrets
      key: jwt-secret
- name: POSTGRES_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ .Release.Name }}-e-gaop-managed-secrets
      key: postgres-password
- name: OPENAI_API_KEY
  valueFrom:
    secretKeyRef:
      name: {{ .Release.Name }}-e-gaop-managed-secrets
      key: openai-api-key
- name: REDIS_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ .Release.Name }}-e-gaop-managed-secrets
      key: redis-password
- name: INTERNAL_SERVICE_TOKEN
  valueFrom:
    secretKeyRef:
      name: {{ .Release.Name }}-e-gaop-managed-secrets
      key: internal-service-token
- name: GRAFANA_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ .Release.Name }}-e-gaop-managed-secrets
      key: grafana-password
{{- end }}

{{/*
Container securityContext (non-root, read-only fs, PSA restricted)
*/}}
{{- define "e-gaop.containerSecurityContext" -}}
securityContext:
  runAsNonRoot: true
  runAsUser: 1001
  readOnlyRootFilesystem: true
  allowPrivilegeEscalation: false
  capabilities:
    drop:
      - ALL
  seccompProfile:
    type: RuntimeDefault
{{- end }}

{{/*
Pod-level securityContext (PSA restricted)
*/}}
{{- define "e-gaop.podSecurityContext" -}}
securityContext:
  fsGroup: 1001
  runAsNonRoot: true
  runAsUser: 1001
  seccompProfile:
    type: RuntimeDefault
{{- end }}

{{/*
serviceAccountName
*/}}
{{- define "e-gaop.serviceAccountName" -}}
serviceAccountName: {{ .Release.Name }}-e-gaop-app
{{- end }}

{{/*
Liveness and readiness probes for backend services (health port, /healthz + /readyz)
*/}}
{{- define "e-gaop.probes" -}}
livenessProbe:
  httpGet:
    path: /healthz
    port: health
  initialDelaySeconds: 10
  periodSeconds: 30
  timeoutSeconds: 3
readinessProbe:
  httpGet:
    path: /readyz
    port: health
  initialDelaySeconds: 5
  periodSeconds: 10
  timeoutSeconds: 3
{{- end }}

{{/*
Prometheus scrape annotations.

Application services do not expose an HTTP /metrics endpoint (telemetry is
exported over OTLP) and .Values.healthPort serves only health probes —
advertising it to Prometheus creates permanently-down scrape targets.
Subcharts that serve /metrics natively (loki, tempo, temporal, pushgateway)
carry their own annotations. Opt in per-service by defining .Values.metricsPort.
*/}}
{{- define "e-gaop.prometheusAnnotations" -}}
{{- if .Values.metricsPort }}
annotations:
  prometheus.io/scrape: "true"
  prometheus.io/port: "{{ .Values.metricsPort }}"
{{- end }}
{{- end }}

{{/*
TLS volumeMount (conditionally rendered)
*/}}
{{- define "e-gaop.tlsVolumeMount" -}}
{{- if .Values.tls.certManager.enabled }}
volumeMounts:
  - name: tls-certs
    mountPath: /etc/egaop/certs
    readOnly: true
{{- end }}
{{- end }}

{{/*
TLS volume (conditionally rendered). Requires .chartName to be set.
Usage: {{ include "e-gaop.tlsVolume" (dict "Values" .Values "chartName" "api-server") }}
*/}}
{{- define "e-gaop.tlsVolume" -}}
{{- if .Values.tls.certManager.enabled }}
volumes:
  - name: tls-certs
    secret:
      secretName: {{ .chartName }}-tls
      optional: true
{{- end }}
{{- end }}

{{/*
Container image block
*/}}
{{- define "e-gaop.image" -}}
image: "{{ .Values.image }}:{{ .Values.tag }}"
imagePullPolicy: IfNotPresent
{{- end }}

{{/*
Common env vars: NODE_ENV + OTEL_SERVICE_NAME. Pass .serviceName (e.g. "api-server").
*/}}
{{- define "e-gaop.commonEnv" -}}
- name: NODE_ENV
  value: production
- name: OTEL_SERVICE_NAME
  value: egaop-{{ .serviceName }}
- name: SERVICE_HEALTH_PORT
  value: "{{ .healthPort }}"
{{- end }}
