# E-GAOP Quickstart

> Zero to running AI agent platform in 5 minutes.

## Prerequisites

- [Node.js 22+](https://nodejs.org/)
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (with Compose v2)
- [Git](https://git-scm.com/)
- An [OpenAI API key](https://platform.openai.com/api-keys) (or compatible provider)

## Quick Setup

```bash
# Clone and setup
git clone https://github.com/Ismail-2001/The-Kubernetes-of-AI-Agents.git
cd The-Kubernetes-of-AI-Agents
chmod +x scripts/setup.sh
./scripts/setup.sh
```

The setup script will:
1. Check prerequisites
2. Generate secure secrets
3. Install dependencies
4. Build the shared package
5. Start all 22 services via Docker Compose

## Verify It Works

```bash
# Check health
curl http://localhost:15051/healthz

# Run the smoke test
./scripts/smoke-test.sh localhost
```

## Create Your First Agent

```bash
# 1. Register a user
curl -X POST http://localhost:3001/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"name":"Demo User","email":"demo@egaop.io","password":"DemoPassword123!"}'

# 2. Login (save the token)
TOKEN=$(curl -s -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"demo@egaop.io","password":"DemoPassword123!"}' | jq -r '.data.token')

# 3. Create an agent
curl -X POST http://localhost:3001/api/agents \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Hello World Agent",
    "description": "A simple greeting agent",
    "namespace": "default",
    "model": "gpt-4o-mini",
    "systemPrompt": "You are a friendly assistant. Greet the user warmly.",
    "tools": []
  }'

# 4. Run the agent
curl -X POST http://localhost:3001/api/agents/<agent-id>/run \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"input": "Hello!"}'
```

## Dashboards

| Service | URL | Credentials |
|---------|-----|-------------|
| API | http://localhost:3001 | — |
| Swagger | http://localhost:3001/api/docs | — |
| Health | http://localhost:15051/healthz | — |
| Grafana | http://localhost:3003 | admin / (from .env) |
| Prometheus | http://localhost:9091 | — |

## Common Commands

```bash
make status          # Check all services
make docker-logs     # View logs
make test            # Run tests
make db-shell        # PostgreSQL shell
make health          # Health check
make help            # All commands
```

## Troubleshooting

**Services won't start:**
```bash
docker compose logs api-server | tail -20
```

**Port conflict:**
```bash
docker compose down -v
docker compose up -d
```

**Reset everything:**
```bash
docker compose down -v
rm .env
./scripts/setup.sh
```

## Next Steps

- Read [CONTRIBUTING.md](CONTRIBUTING.md) for development setup
- Read [docs/quickstart.md](docs/quickstart.md) for detailed walkthrough
- Read [docs/OPERATIONAL-RUNBOOK.md](docs/OPERATIONAL-RUNBOOK.md) for operations
- Read [docs/SLO-BASELINE.md](docs/SLO-BASELINE.md) for SLOs and monitoring
