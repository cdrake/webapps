---
"white-matter-lesions": patch
---

Fix the lesion probability overlay by using NiiVue's supported display-range options. Probabilities below 0.1 stay transparent instead of tinting the entire FLAIR image orange; downloaded probabilities are unchanged. Open Advanced settings by default so skull stripping, model and processing options are immediately visible.
