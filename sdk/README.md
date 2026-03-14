# Hammy HYTOPIA

> **This is a community fork of the official [HYTOPIA SDK](https://github.com/hytopiagg/sdk).** It includes a custom self-hosted client at [hammyhytopia.com](https://hammyhytopia.com). All credit for the original SDK goes to [HYTOPIA, Inc.](https://hytopia.com)

## Play your games

Custom client: **https://hammyhytopia.com**

## Install (new project)

```bash
npx hammy-hytopia init
cd my-project
hytopia start
```

Open https://hammyhytopia.com/?join=local.hytopiahosting.com:8080 to play.

## Migrate an existing HYTOPIA project

```bash
npx hammy-hytopia migrate
```

All your `import { ... } from 'hytopia'` statements keep working. No code changes needed.

## Switch back to official HYTOPIA

```bash
npm install hytopia@latest
```

---

## What is HYTOPIA?

HYTOPIA is a modern games platform inspired by Minecraft, Roblox, and Rec Room. Create your own massively multiplayer games in a voxel-like style by writing TypeScript or JavaScript, playable in a web browser on any device.

## What does this fork change?

- Custom self-hosted client at [hammyhytopia.com](https://hammyhytopia.com)
- `npx hammy-hytopia migrate` command for easy switching
- Server startup message points to the custom client

The server engine, API, and all game functionality remain identical to the official SDK.

## Resources

- [Official HYTOPIA Developer Docs](https://dev.hytopia.com/)
- [Official SDK Repository](https://github.com/hytopiagg/sdk)
- [Game Examples](https://github.com/hytopiagg/sdk-examples)
- [HYTOPIA Developer Discord](https://discord.gg/hytopia-developers)
- [Report Bugs](https://github.com/hytopiagg/sdk/issues)
