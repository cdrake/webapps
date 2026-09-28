---
"@neurodesk/desktop": patch
---

Batch jobs now fail as soon as an application reports an error in its status line (`#statusText.error`), with the application's message, instead of waiting for the job timeout. The check also runs while outputs are still downloading and once more before the success report is written, and the job timeout now bounds the download wait. A job can set `failSelector` to another selector, or to `null` to keep waiting.
