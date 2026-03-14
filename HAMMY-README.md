# Hammy HYTOPIA Fork

Custom fork of the [HYTOPIA SDK](https://github.com/hytopiagg/sdk) with a self-hosted client at **[hammyhytopia.com](https://hammyhytopia.com)**.

## For Game Developers

### New project

```bash
npx hammy-hytopia init
cd my-project
hytopia start
```

### Migrate an existing HYTOPIA project

```bash
npx hammy-hytopia migrate
```

This replaces the official SDK with the Hammy fork while keeping all your `import { ... } from 'hytopia'` statements working. Start your server as usual with `hytopia start`.

### Switch back to official HYTOPIA

```bash
npm install hytopia@latest
```

---

## For Maintainers (deploying updates)

### One-command deploy

After making changes to the client or server, deploy everything with:

```bash
./deploy-hammy.sh          # patch bump (0.15.5 -> 0.15.6)
./deploy-hammy.sh minor    # minor bump (0.15.5 -> 0.16.0)
./deploy-hammy.sh major    # major bump (0.15.5 -> 1.0.0)
```

This single command will:

1. Build the client (`client/`)
2. Deploy it to Netlify → hammyhytopia.com
3. Build the server engine (`server/` → `sdk/server.mjs`)
4. Bump the npm version
5. Publish `hammy-hytopia` to npm

### Prerequisites

- **Netlify CLI** authenticated: `npx netlify-cli login`
- **npm** authenticated: set a Granular Access Token with `npm config set //registry.npmjs.org/:_authToken <token>` before deploying, and remove it after with `npm config delete //registry.npmjs.org/:_authToken`

### Manual steps (if needed)

**Client only:**
```bash
cd client && npm run build
npx netlify-cli deploy --prod --dir=dist --site=b9c4de86-97dc-4814-9a7f-537ce31d823f
```

**Server/SDK only:**
```bash
cd server && npm run build:server
cd ../sdk && npm version patch --no-git-tag-version && npm publish --access public
```

---

## Architecture

| Component | Location | Hosted at |
|-----------|----------|-----------|
| Client | `client/` | [hammyhytopia.com](https://hammyhytopia.com) (Netlify) |
| Server engine | `server/` → `sdk/server.mjs` | npm: [hammy-hytopia](https://www.npmjs.com/package/hammy-hytopia) |
| CLI scripts | `sdk/bin/scripts.js` | Bundled in npm package |
| Game servers | Developer's machine or HYTOPIA hosting | Connects via the client |
