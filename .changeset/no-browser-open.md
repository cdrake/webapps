---
---

Deface, BrowserQC, dicompare and NiiMath no longer open a browser tab when their dev server or `vite preview` starts. `vite preview` inherited `server.open`, so every smoke and e2e run opened a tab in the developer's default browser. `test/vite-open.test.mjs` keeps the setting out of every app. Tooling only; no app release.
