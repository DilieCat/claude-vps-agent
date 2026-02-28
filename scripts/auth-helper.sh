#!/usr/bin/env bash
#
# auth-helper.sh — Authenticate Claude Code on a headless VPS
#
# Claude Code login requires a browser callback on localhost.
# This script sets up SSH port forwarding so the auth flow works
# through your local machine's browser.
#
# Usage:
#   ./scripts/auth-helper.sh claude@your-vps-ip
#   ./scripts/auth-helper.sh claude@your-vps-ip 2222   # custom SSH port
#
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <user@host> [ssh-port]"
  echo ""
  echo "Example:"
  echo "  $0 claude@192.168.1.100"
  echo "  $0 claude@my-vps.example.com 2222"
  exit 1
fi

SSH_TARGET="$1"
SSH_PORT="${2:-22}"
LOCAL_PORT=8080

echo "Claude Code Authentication Helper"
echo "=================================="
echo ""
echo "Target:       ${SSH_TARGET}"
echo "SSH port:     ${SSH_PORT}"
echo "Local port:   ${LOCAL_PORT} (forwarded to VPS localhost:${LOCAL_PORT})"
echo ""
echo "This will:"
echo "  1. Open an SSH connection with port forwarding"
echo "  2. Run 'claude login' on the VPS"
echo "  3. Your local browser will handle the OAuth callback"
echo ""
echo "Press Ctrl+C to cancel, or Enter to continue..."
read -r

echo "Starting SSH with port forwarding and running 'claude login'..."
echo ""

# -L forwards local port to remote localhost port so the OAuth callback works.
# -t forces pseudo-terminal allocation so 'claude login' can interact.
ssh -t \
  -L "${LOCAL_PORT}:localhost:${LOCAL_PORT}" \
  -p "${SSH_PORT}" \
  -o StrictHostKeyChecking=accept-new \
  "${SSH_TARGET}" \
  "claude login"

echo ""
echo "Authentication complete! You can now deploy and run services."
