#!/usr/bin/env bash
#
# setup-vps.sh — Idempotent VPS provisioning for claudebridge
#
# Usage:
#   scp infra/setup-vps.sh user@vps:/tmp/ && ssh user@vps 'sudo bash /tmp/setup-vps.sh'
#
# Tested on: Ubuntu 22.04 / 24.04 LTS
# This script is idempotent — safe to run multiple times.
#
set -euo pipefail

CLAUDE_USER="claude"
PROJECT_DIR="/home/${CLAUDE_USER}/claudebridge"
NODE_MAJOR=22

log() { echo "=== [$1] $2 ==="; }

# --- [1/9] System update ---
log "1/9" "System update"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get upgrade -y -qq

# --- [2/9] Install essentials ---
log "2/9" "Install essentials"
apt-get install -y -qq \
  curl wget git tmux jq ufw fail2ban \
  python3 python3-pip python3-venv \
  unattended-upgrades apt-listchanges

# --- [3/9] Create claude user ---
log "3/9" "Create '${CLAUDE_USER}' user"
if ! id "${CLAUDE_USER}" &>/dev/null; then
  adduser --disabled-password --gecos "" "${CLAUDE_USER}"
  usermod -aG sudo "${CLAUDE_USER}"
  echo "${CLAUDE_USER} ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/${CLAUDE_USER}"
  chmod 440 "/etc/sudoers.d/${CLAUDE_USER}"
fi

# Copy SSH authorized_keys from whoever is running this script
SSH_DIR="/home/${CLAUDE_USER}/.ssh"
mkdir -p "${SSH_DIR}"
if [ -f /root/.ssh/authorized_keys ]; then
  cp /root/.ssh/authorized_keys "${SSH_DIR}/authorized_keys"
elif [ -f "${HOME}/.ssh/authorized_keys" ]; then
  cp "${HOME}/.ssh/authorized_keys" "${SSH_DIR}/authorized_keys"
fi
chown -R "${CLAUDE_USER}:${CLAUDE_USER}" "${SSH_DIR}"
chmod 700 "${SSH_DIR}"
chmod 600 "${SSH_DIR}/authorized_keys" 2>/dev/null || true

# --- [4/9] Harden SSH ---
log "4/9" "Harden SSH"
SSHD_CONFIG="/etc/ssh/sshd_config"
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' "${SSHD_CONFIG}"
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' "${SSHD_CONFIG}"
sed -i 's/^#\?PubkeyAuthentication.*/PubkeyAuthentication yes/' "${SSHD_CONFIG}"
systemctl restart sshd

# --- [5/9] Configure UFW firewall ---
log "5/9" "Configure UFW firewall"
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment "SSH"
ufw allow 443/tcp comment "HTTPS (Claude auth callbacks)"
ufw --force enable

# --- [6/9] Configure Fail2Ban ---
log "6/9" "Configure Fail2Ban"
cat > /etc/fail2ban/jail.local <<'JAILEOF'
[sshd]
enabled  = true
port     = ssh
filter   = sshd
logpath  = /var/log/auth.log
maxretry = 3
bantime  = 3600
findtime = 600
JAILEOF
systemctl enable fail2ban
systemctl restart fail2ban

# --- [7/9] Install Node.js ---
log "7/9" "Install Node.js ${NODE_MAJOR}.x"
if ! command -v node &>/dev/null || ! node --version | grep -q "^v${NODE_MAJOR}"; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y -qq nodejs
fi
echo "  Node.js $(node --version) / npm $(npm --version)"

# --- [8/9] Install Claude Code CLI ---
log "8/9" "Install Claude Code CLI"
if ! command -v claude &>/dev/null; then
  npm install -g @anthropic-ai/claude-code
fi
echo "  Claude Code $(claude --version 2>/dev/null || echo '(installed)')"

# --- [9/9] Setup project directory and tmux ---
log "9/9" "Setup project directory and tmux config"
su - "${CLAUDE_USER}" -c "mkdir -p ${PROJECT_DIR}"

# Tmux config (idempotent — overwrites if present)
cat > "/home/${CLAUDE_USER}/.tmux.conf" <<'TMUXEOF'
set -g mouse on
set -g history-limit 50000
set -g default-terminal "screen-256color"
set -g status-bg colour235
set -g status-fg white
set -g status-left "[#S] "
set -g status-right "%H:%M %d-%b"
set-option -g set-titles on
set-option -g set-titles-string "#S / #W"
TMUXEOF
chown "${CLAUDE_USER}:${CLAUDE_USER}" "/home/${CLAUDE_USER}/.tmux.conf"

echo ""
echo "============================================"
echo "  VPS provisioning complete!"
echo "============================================"
echo ""
echo "Next steps:"
echo ""
echo "  1. SSH in as '${CLAUDE_USER}':"
echo "     ssh ${CLAUDE_USER}@$(hostname -I | awk '{print $1}')"
echo ""
echo "  2. Authenticate Claude Code (from your LOCAL machine):"
echo "     ./scripts/auth-helper.sh ${CLAUDE_USER}@YOUR_VPS_IP"
echo ""
echo "  3. Deploy the project:"
echo "     ./scripts/deploy.sh"
echo ""
echo "  4. (Optional) Start a persistent tmux session:"
echo "     tmux new -s claude"
echo ""
