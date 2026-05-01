#!/usr/bin/env bash
set -e

BOLD='\033[1m'
GREEN='\033[0;32m'
RED='\033[0;31m'
RESET='\033[0m'

echo ""
echo -e "${BOLD}MACC — Multi-Agent Coding Client${RESET}"
echo "--------------------------------"
echo ""

# Check Node.js >= 20
if ! command -v node &>/dev/null; then
  echo -e "${RED}Error:${RESET} Node.js is not installed."
  echo "Install Node.js 20+ from https://nodejs.org and re-run this script."
  exit 1
fi

node_major=$(node -v | sed 's/v//' | cut -d'.' -f1)
if [ "$node_major" -lt 20 ]; then
  echo -e "${RED}Error:${RESET} Node.js 20+ required (you have $(node -v))."
  echo "Upgrade at https://nodejs.org"
  exit 1
fi

# Check npm
if ! command -v npm &>/dev/null; then
  echo -e "${RED}Error:${RESET} npm is not installed."
  exit 1
fi

echo "Installing MACC..."
npm install -g macc

echo ""
echo -e "${GREEN}✓ MACC installed successfully.${RESET}"
echo ""
echo "Get started:"
echo "  macc          — launch the client"
echo "  macc --help   — show all options"
echo ""
echo "Set your API key before first launch:"
echo "  export ANTHROPIC_API_KEY=sk-ant-..."
echo "  export GOOGLE_API_KEY=..."
echo ""
