---
"@neurodesk/desktop": patch
---

Each viewer window now has its own browser session and its own address on the local server. An app's service worker makes most of its requests, and the desktop could not tell which window they came from. Remote run inputs such as ZARRo's OME-Zarr URL failed to load over http, any window could read the https sources granted to another, and a request refused in a retained viewer failed the run in progress in another window. Requests are now checked against, and counted for, the window that made them.
