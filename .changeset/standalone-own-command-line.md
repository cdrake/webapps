---
"@neurodesk/webapp-components": patch
---

Each app's Standalone dialog lists only that app's own command line, never the all-apps desktop suite or its model pack. The nightly suite release now announces itself to the standalone-catalog workflow, which writes its verified entry into `registry/standalone.json` instead of leaving it on 0.10.20260918. A contract test requires every app to ship a command line or state why it cannot.
