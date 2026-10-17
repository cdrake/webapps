---
"calmar": patch
"@neurodesk/webapp-components": patch
---

CALMaR shows its result tables in a Results view in the viewer instead of the sidebar, so the Lesion % and Map % columns are no longer cut off. The Results tab opens once an analysis finishes and stays disabled until there is an atlas overlap, during lesion-mask review and after Start over. The separate Analysis log is gone: every message now appears once, in full and with its level, in the technical log. Captions above shared data tables are styled as muted, left-aligned notes.
