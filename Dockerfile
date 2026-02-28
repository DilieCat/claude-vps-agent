FROM node:22-slim

RUN apt-get update && apt-get install -y \
    python3 python3-pip python3-venv git curl jq \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code
RUN npm install -g @anthropic-ai/claude-code

# Create non-root user
RUN useradd -m -s /bin/bash claude
USER claude
WORKDIR /app

# Copy project
COPY --chown=claude:claude . /app/

# Install Python dependencies
RUN python3 -m venv /app/.venv && \
    /app/.venv/bin/pip install --upgrade pip && \
    /app/.venv/bin/pip install \
    -r bots/telegram/requirements.txt \
    -r bots/discord/requirements.txt \
    -r scheduler/requirements.txt

ENV PATH="/app/.venv/bin:$PATH"
ENV PYTHONPATH="/app"
