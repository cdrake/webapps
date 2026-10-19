---
'@neurodesk/desktop': patch
---

The macOS release retries Apple notarization and stapling on a transient network error (`NSURLErrorDomain`, stapler code 68) up to four times with a 15 s, 30 s, 60 s backoff, and logs each retry. `@electron/notarize`'s own retry gave up after about seven seconds, so one dropped connection to api.apple-cloudkit.com failed the nightly desktop release. An invalid signature still fails at once.
