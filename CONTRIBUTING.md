# Contributing to TuneGathering

Thanks for helping make TuneGathering better! This guide gets you from clone to pull request.

## Getting set up

You need **Node.js 20 or newer**. There is no build step.

```bash
git clone https://github.com/ww2d2vjh8c-lab/tunegathering.git
cd tunegathering
npm install
npm run dev     # server on http://localhost:3000, restarts on server changes
npm test        # integration tests
```

Frontend files in `public/` are served as-is. Edit them and refresh the browser.

To test sync by ear, open the room on two or more devices, load the demo tracks and play **Sync Check (click track)**. If the clicks sound like one click, it's working. `window.tg` in the devtools console exposes sync and engine state for debugging.

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains how the pieces fit together and lists every WebSocket message.

## Making a change

1. **Open an issue first** for anything bigger than a small fix, so we can agree on the approach before you invest time.
2. Create a branch from `main`: `git checkout -b fix/short-description`.
3. Keep changes focused. One pull request should do one thing.
4. Add or update tests in `test/` when you change server behaviour. Tests use real WebSocket clients, so they read like a script of what devices do.
5. Run `npm test` and check the change in a browser, ideally on a phone too.
6. Open a pull request and fill in the template.

### Code style

- Plain modern JavaScript (ES modules) on both server and client. No TypeScript, no bundler.
- Match the code around you: small focused functions, comments that explain *why* rather than *what*.
- 2-space indentation, double quotes, semicolons (see `.editorconfig`).
- Keep the dependency list short. Adding a runtime dependency needs a good reason.

### Commit messages

Write in the imperative mood ("Add QR code to invite dialog", not "Added…"). Explain *why* in the body when it isn't obvious.

## Reporting bugs

Use the [bug report template](https://github.com/ww2d2vjh8c-lab/tunegathering/issues/new/choose). Sync problems are much easier to fix with:

- browsers and devices involved (e.g. "Chrome 130 on Pixel 8, Safari 18 on MacBook")
- the **Sync diagnostics** line from the room's Settings tab on each device
- whether devices share a Wi-Fi network, and whether Bluetooth speakers are involved

## Design contributions

The UI follows GTA V conventions (pause-menu tabs, white selection, segmented stat bars, HUD feed). Keep that language consistent. **Never add game assets** (logos, screenshots, artwork, fonts) owned by Rockstar Games or Take-Two. Original artwork and openly licensed fonts only.

## Code of Conduct

By taking part you agree to follow our [Code of Conduct](CODE_OF_CONDUCT.md).
