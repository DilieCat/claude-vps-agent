#!/usr/bin/env bash
#
# deploy.sh — Deploy claudebridge to a remote VPS via rsync + SSH
#
# Usage:
#   ./scripts/deploy.sh                   # Uses VPS_HOST/VPS_USER from .env
#   ./scripts/deploy.sh myhost claude      # Override host and user
#   ./scripts/deploy.sh myhost             # Override host, user from .env
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${PROJECT_DIR}/.env"

# Load .env if it exists
if [ -f "${ENV_FILE}" ]; then
  set -a
  # shellcheck source=/dev/null
  source "${ENV_FILE}"
  set +a
fi

VPS_HOST="${1:-${VPS_HOST:-}}"
VPS_USER="${2:-${VPS_USER:-claude}}"
VPS_PORT="${VPS_PORT:-22}"
REMOTE_DIR="/home/${VPS_USER}/claudebridge"

if [ -z "${VPS_HOST}" ]; then
  echo "Error: VPS_HOST is required."
  echo ""
  echo "Usage: $0 <VPS_HOST> [VPS_USER]"
  echo "   or: set VPS_HOST in .env"
  exit 1
fi

SSH_OPTS="-o StrictHostKeyChecking=accept-new -p ${VPS_PORT}"
SSH_CMD="ssh ${SSH_OPTS} ${VPS_USER}@${VPS_HOST}"
RSYNC_SSH="ssh ${SSH_OPTS}"

echo "Deploying to ${VPS_USER}@${VPS_HOST}:${REMOTE_DIR}"
echo ""

# --- Step 1: Sync project files ---
echo "=== [1/4] Syncing project files ==="
rsync -avz --delete \
  --exclude '.env' \
  --exclude '.git/' \
  --exclude '__pycache__/' \
  --exclude '.venv/' \
  --exclude 'node_modules/' \
  --exclude '.claude/' \
  --exclude '*.pyc' \
  -e "${RSYNC_SSH}" \
  "${PROJECT_DIR}/" \
  "${VPS_USER}@${VPS_HOST}:${REMOTE_DIR}/"

# --- Step 2: Install Python dependencies ---
echo ""
echo "=== [2/4] Installing Python dependencies ==="
${SSH_CMD} bash -s <<'REMOTESH'
set -euo pipefail
cd ~/claudebridge

# Create venv if it doesn't exist
if [ ! -d .venv ]; then
  python3 -m venv .venv
fi

# Install dependencies from all requirements files found
source .venv/bin/activate
for req in requirements.txt */requirements.txt; do
  if [ -f "${req}" ]; then
    echo "  Installing from ${req}..."
    pip install -q -r "${req}"
  fi
done
REMOTESH

# --- Step 3: Install/reload systemd services ---
echo ""
echo "=== [3/4] Installing systemd services ==="
${SSH_CMD} bash -s <<'REMOTESH'
set -euo pipefail
SERVICES_SRC=~/claudebridge/infra/systemd
SERVICES_DST=/etc/systemd/system

changed=false
for svc in "${SERVICES_SRC}"/*.service; do
  [ -f "${svc}" ] || continue
  name="$(basename "${svc}")"

  if ! diff -q "${svc}" "${SERVICES_DST}/${name}" &>/dev/null; then
    sudo cp "${svc}" "${SERVICES_DST}/${name}"
    sudo systemctl enable "${name}"
    changed=true
    echo "  Updated: ${name}"
  else
    echo "  Unchanged: ${name}"
  fi
done

if [ "${changed}" = true ]; then
  sudo systemctl daemon-reload
  echo "  systemd daemon reloaded"
fi

# Restart services that are enabled (only if their unit file exists)
for svc in "${SERVICES_SRC}"/*.service; do
  [ -f "${svc}" ] || continue
  name="$(basename "${svc}")"
  if systemctl is-enabled "${name}" &>/dev/null; then
    sudo systemctl restart "${name}" 2>/dev/null || echo "  Note: ${name} not started (check .env)"
  fi
done
REMOTESH

# --- Step 4: Show service status ---
echo ""
echo "=== [4/4] Service status ==="
${SSH_CMD} bash -s <<'REMOTESH'
for svc in telegram-bot discord-bot scheduler; do
  name="${svc}.service"
  if systemctl is-enabled "${name}" 2>/dev/null | grep -q "enabled"; then
    status="$(systemctl is-active "${name}" 2>/dev/null || true)"
    echo "  ${name}: ${status}"
  else
    echo "  ${name}: not installed"
  fi
done
REMOTESH

echo ""
echo "Deploy complete!"
