---
"@weaveio/weave-cli": patch
---

`weave models` prints only its own output (#305).

- `weave models status`, `update`, `apply` and `pin` no longer print a raw
  JSON log line on stderr before a failed check or a skipped applied list;
  the commands already say what went wrong in words. They log errors only
  unless `LOG_LEVEL` asks for more.
- `update` and `apply` compare each agent's merged `models` list (what the
  agent runs) before and after. A list that repeats those lists, such as the
  first stable list, is reported as applied with `No agent's models changed.`
  instead of listing every agent as changed.
