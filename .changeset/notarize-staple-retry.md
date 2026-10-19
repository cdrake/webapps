---
'@neurodesk/desktop': patch
---

The macOS release retries Apple stapling when `xcrun stapler` fails on a transient transport error (`NSURLErrorDomain` connection lost, timed out, offline or cannot connect, or stapler code 68), up to four attempts with a 15 s, 30 s, 60 s backoff, each retry logged. `@electron/notarize` staples once and never retries, so one dropped connection to api.apple-cloudkit.com failed the nightly desktop release. The app is notarized once; a notarization failure, a certificate-trust error or an invalid signature still fails at once.
