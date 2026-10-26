# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-10-26

First public release.

### Added

- Rooms with 6-digit codes, a public session list, and automatic cleanup when empty
- NTP-style clock synchronisation with min-RTT offset selection
- Coordinated playback: every device decodes the track before one shared start time is scheduled
- Speaker-accurate scheduling via `AudioContext.getOutputTimestamp()`, plus a per-device timing nudge
- Late joiners drop in at the room's current position
- Shared queue: uploads (MP3, WAV, OGG, M4A, FLAC, AAC, Opus, WebM up to 60 MB), reorder, delete, seek, skip, auto-advance
- Synthesized demo tracks, including a click track for checking sync by ear
- Spatial audio radar with orbit and manual modes
- Room-wide volume and low-pass filter
- Crew chat with notification feed
- Admin roles with *Everyone* / *Admins only* playback permissions
- GTA V–inspired interface with original artwork and open-licensed fonts, responsive down to phones
- Integration test suite, CI, Docker image and Codespaces configuration

[Unreleased]: https://github.com/ww2d2vjh8c-lab/tunegathering/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ww2d2vjh8c-lab/tunegathering/releases/tag/v0.1.0
