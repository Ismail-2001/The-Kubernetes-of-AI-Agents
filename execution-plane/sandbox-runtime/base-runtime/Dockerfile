# egaop-base-runtime — Minimal sandbox image for agent execution
# Contains: Node.js 22, Python 3, curl, jq, basic security tools
# Used by sandbox-runtime as the default container image for agent workloads

FROM node:22-slim

# Install Python 3, curl, jq, git, and basic utilities
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    curl \
    wget \
    jq \
    git \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user for agent execution
RUN groupadd --gid 1001 agent \
    && useradd --uid 1001 --gid agent --shell /bin/bash --create-home agent

# Create workspace directory
RUN mkdir -p /workspace && chown agent:agent /workspace

# Create /tmp for scratch space
RUN chmod 1777 /tmp

USER agent
WORKDIR /workspace

# Healthcheck — verify Node.js and Python are available
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "console.log('ok')" && python3 -c "print('ok')"

LABEL org.opencontainers.image.title="egaop-base-runtime"
LABEL org.opencontainers.image.description="Minimal sandbox runtime for E-GAOP agent execution"
LABEL org.opencontainers.image.vendor="E-GAOP"
