---
"dicompare": minor
"@neurodesk/dicompare": minor
---

Add the `dicompare` portable command line. It runs the web app's Pyodide build
and pinned dicompare wheel in Node, offline, with the worker's own Python calls:
`analyze`, `compare` (the compliance report) and `build-schema`, plus the app's
schema library. Its reports match the web app's downloads.
