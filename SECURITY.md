# Security Policy

## Supported versions

Security fixes go into the latest release on `main`.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub: **[Security → Report a vulnerability](https://github.com/ww2d2vjh8c-lab/tunegathering/security/advisories/new)**. Include:

- what the issue is and its impact
- steps or a proof of concept to reproduce it
- the version or commit you tested

You can expect an acknowledgement within a few days. We'll keep you updated while we work on a fix and credit you in the release notes if you'd like.

## Deployment notes

TuneGathering is designed for trusted, short-lived listening sessions:

- **Room codes are not passwords.** Anyone with a 6-digit code can join, and active rooms are listed on the landing page. Use *Admins only* mode to restrict controls.
- **Uploads** are limited to audio file extensions and 60 MB. They are stored under `UPLOAD_DIR` and deleted when the room closes. Put the server behind a reverse proxy with rate limits if you expose it to the internet.
- **Use HTTPS** in any public deployment. Browsers restrict audio and clipboard features on insecure origins.
