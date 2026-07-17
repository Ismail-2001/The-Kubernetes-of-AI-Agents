import http from 'node:http';

const GRAFANA_URL = process.env.GRAFANA_URL || 'http://localhost:3003';
const GRAFANA_USER = process.env.GRAFANA_USER || 'admin';
const GRAFANA_PASSWORD = process.env.GRAFANA_PASSWORD;
const SLACK_WEBHOOK = process.env.SLACK_ALERT_WEBHOOK || '';

if (!GRAFANA_PASSWORD) {
  console.error('ERROR: Set GRAFANA_PASSWORD');
  process.exit(1);
}

const base = new URL(GRAFANA_URL);
const auth = Buffer.from(`${GRAFANA_USER}:${GRAFANA_PASSWORD}`).toString('base64');
const headers = {
  'Content-Type': 'application/json',
  Authorization: `Basic ${auth}`,
};

function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: base.hostname,
      port: base.port || 3003,
      path,
      method,
      headers,
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        if (!ok) {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        } else {
          try { resolve(JSON.parse(data)); } catch { resolve(data); }
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function waitForGrafana() {
  for (let i = 0; i < 30; i++) {
    try {
      await api('GET', '/api/health');
      console.log('Grafana is ready');
      return;
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.error('Grafana did not become ready');
  process.exit(1);
}

let FOLDER_UID;

async function ensureFolder() {
  console.log('Ensuring alert folder...');
  const name = 'E-GAOP Alerts';

  // check if exists
  const folders = await api('GET', '/api/folders');
  const existing = folders.find((f) => f.title === name);

  if (existing) {
    FOLDER_UID = existing.uid;
    console.log(`  ✓ existing folder: ${name} (uid=${FOLDER_UID})`);
  } else {
    try {
      const f = await api('POST', '/api/folders', { title: name });
      FOLDER_UID = f.uid;
      console.log(`  ✓ created folder: ${name} (uid=${FOLDER_UID})`);
    } catch (e) {
      console.error(`  ✗ failed: ${e.message}`);
      process.exit(1);
    }
  }
}

async function ensureContactPoint() {
  const name = SLACK_WEBHOOK ? 'E-GAOP Slack' : 'E-GAOP Log';

  let exists = false;
  try {
    await api('GET', `/api/v1/provisioning/contact-points/${encodeURIComponent(name)}`);
    exists = true;
  } catch {}

  let body;
  if (SLACK_WEBHOOK) {
    body = {
      name,
      type: 'slack',
      settings: {
        url: SLACK_WEBHOOK,
        text: '{{ range .Alerts }}\n*{{ .Labels.severity }}:* {{ .Annotations.summary }}\n{{ .Annotations.description }}\n{{ end }}',
      },
      disableResolveMessage: false,
    };
    console.log('Contact point: E-GAOP Slack');
  } else {
    body = {
      name,
      type: 'webhook',
      settings: { url: 'http://localhost:3000/api/health', sendReminder: false, autoResolve: true },
      disableResolveMessage: true,
    };
    console.log('Contact point: E-GAOP Log (no-op sink)');
  }

  try {
    if (exists) {
      await api('PUT', `/api/v1/provisioning/contact-points/${encodeURIComponent(name)}`, body);
      console.log('  ✓ updated');
    } else {
      await api('POST', '/api/v1/provisioning/contact-points', body);
      console.log('  ✓ created');
    }
  } catch (e) {
    console.error(`  ✗ failed: ${e.message}`);
  }
}

async function ensureNotificationPolicy() {
  const receiver = SLACK_WEBHOOK ? 'E-GAOP Slack' : 'E-GAOP Log';
  console.log(`Notification policy → receiver: ${receiver}`);
  try {
    await api('PUT', '/api/v1/provisioning/policies', {
      receiver,
      group_by: ['severity', 'alertname'],
      group_wait: '30s',
      group_interval: '5m',
      repeat_interval: '4h',
      routes: [],
    });
    console.log('  ✓ set');
  } catch (e) {
    console.error(`  ✗ failed: ${e.message}`);
  }
}

const RULES = [
  {
    uid: 'egaop_service_down',
    title: 'E-GAOP Service Down',
    severity: 'critical',
    summary: 'One or more E-GAOP services are unreachable',
    description: 'Service down',
    expr: 'min(up{job="egaop-services"}) == 0',
    for: '30s',
  },
  {
    uid: 'egaop_high_error_rate',
    title: 'E-GAOP High Error Rate (>5% 5xx)',
    severity: 'critical',
    summary: 'Error rate exceeds 5% over 5 minutes',
    description: 'High 5xx rate',
    expr: '(sum(rate(http_server_duration_count{status_code=~"5..",job="egaop-services"}[5m])) or vector(0)) / (sum(rate(http_server_duration_count{job="egaop-services"}[5m])) or vector(1)) > 0.05',
    for: '5m',
  },
  {
    uid: 'egaop_high_latency_p95',
    title: 'E-GAOP High Latency P95 (>3s)',
    severity: 'warning',
    summary: 'P95 latency exceeds 3s over 5 minutes',
    description: 'High P95 latency',
    expr: 'histogram_quantile(0.95, sum(rate(http_server_duration_bucket{job="egaop-services"}[5m])) by (le)) > 3000',
    for: '5m',
  },
  {
    uid: 'egaop_high_latency_p99',
    title: 'E-GAOP Critical Latency P99 (>10s)',
    severity: 'critical',
    summary: 'P99 latency exceeds 10s over 5 minutes',
    description: 'Critical P99 latency',
    expr: 'histogram_quantile(0.99, sum(rate(http_server_duration_bucket{job="egaop-services"}[5m])) by (le)) > 10000',
    for: '5m',
  },
  {
    uid: 'egaop_collector_dropping',
    title: 'E-GAOP Metrics Pipeline Dropping',
    severity: 'warning',
    summary: 'OTel collector is dropping metric points',
    description: 'Collector dropping metrics',
    expr: 'rate(otelcol_exporter_send_failed_metric_points{exporter="prometheus"}[5m]) > 100',
    for: '5m',
  },
];

async function ensureRules() {
  console.log('Ensuring alert rules...');

  for (const rule of RULES) {
    process.stdout.write(`  ${rule.title}... `);

    const body = {
      uid: rule.uid,
      title: rule.title,
      ruleGroup: 'egaop-critical',
      folderUID: FOLDER_UID,
      noDataState: 'Alerting',
      execErrState: 'Alerting',
      for: rule.for,
      annotations: { summary: rule.summary, description: rule.description },
      labels: { severity: rule.severity, team: 'egaop', rule_type: 'grafana_alert' },
      data: [
        {
          refId: 'A',
          queryType: '',
          relativeTimeRange: { from: 600, to: 0 },
          datasourceUid: 'prometheus',
          model: {
            expr: rule.expr,
            intervalMs: 10000,
            maxDataPoints: 100,
            refId: 'A',
          },
        },
      ],
      condition: 'A',
    };

    try {
      // try create, fall back to update on 409
      try {
        await api('POST', '/api/v1/provisioning/alert-rules', body);
        console.log('created');
      } catch (e) {
        if (e.message.includes('409')) {
          await api('PUT', `/api/v1/provisioning/alert-rules/${rule.uid}`, body);
          console.log('updated');
        } else {
          throw e;
        }
      }
    } catch (e) {
      console.log(`FAILED: ${e.message}`);
    }
  }
}

async function main() {
  await waitForGrafana();
  await ensureFolder();
  await ensureContactPoint();
  await ensureNotificationPolicy();
  await ensureRules();
  console.log('\nGrafana alerting init complete');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
