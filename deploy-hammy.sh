#!/usr/bin/env bash
set -euo pipefail

SITE_ID="b9c4de86-97dc-4814-9a7f-537ce31d823f"
ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "========================================="
echo "  Hammy HYTOPIA - Deploy All"
echo "========================================="
echo ""

# --- Check npm auth ---
if ! npm whoami &>/dev/null; then
  echo "Not logged in to npm."
  echo ""
  echo "Set your token first:"
  echo "  npm config set //registry.npmjs.org/:_authToken <your-token>"
  echo ""
  echo "Or log in interactively:"
  echo "  npm login"
  echo ""
  exit 1
fi
NPM_USER=$(npm whoami)
echo "Logged in to npm as: $NPM_USER"

# --- Check Netlify auth ---
if ! npx netlify-cli api listAccountsForUser &>/dev/null; then
  echo "Not logged in to Netlify."
  echo ""
  echo "Log in first:"
  echo "  npx netlify-cli login"
  echo ""
  exit 1
fi
echo "Netlify authenticated."
echo ""

# --- Determine version bump type ---
BUMP="${1:-patch}"
if [[ "$BUMP" != "patch" && "$BUMP" != "minor" && "$BUMP" != "major" ]]; then
  echo "Usage: ./deploy-hammy.sh [patch|minor|major]"
  echo "  Default: patch"
  exit 1
fi

# --- Step 1: Build client ---
echo "=> [1/5] Building client..."
cd "$ROOT_DIR/client"
npm run build
echo "   Client built."

# --- Step 2: Deploy client to Netlify ---
echo "=> [2/5] Deploying client to Netlify (hammyhytopia.com)..."
npx netlify-cli deploy --prod --dir=dist --site="$SITE_ID" --message="deploy $(date +%Y-%m-%d_%H:%M)"
echo "   Client deployed."

# --- Step 3: Build server ---
echo "=> [3/5] Building server engine..."
cd "$ROOT_DIR/server"
npm run build:server
echo "   Server built -> sdk/server.mjs"

# --- Step 4: Bump version ---
echo "=> [4/5] Bumping npm version ($BUMP)..."
cd "$ROOT_DIR/sdk"
NEW_VERSION=$(npm version "$BUMP" --no-git-tag-version | tr -d 'v')
echo "   New version: $NEW_VERSION"

# --- Step 5: Publish to npm ---
echo "=> [5/5] Publishing hammy-hytopia@$NEW_VERSION to npm..."
cd "$ROOT_DIR/sdk"
npm publish --access public
echo "   Published!"

echo ""
echo "========================================="
echo "  All done!"
echo "  Client:  https://hammyhytopia.com"
echo "  npm:     hammy-hytopia@$NEW_VERSION"
echo "========================================="
echo ""
echo "Developers can update with:"
echo "  npm install hytopia@npm:hammy-hytopia@latest"
