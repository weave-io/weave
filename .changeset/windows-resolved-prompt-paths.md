---
"@weaveio/weave-cli": patch
"@weaveio/weave-adapter-copilot": patch
"@weaveio/weave-adapter-opencode": patch
"@weaveio/weave-adapter-opencode2": patch
"@weaveio/weave-adapter-pi": patch
---

Load configs with `prompt_file` or `prompt_append_file` on Windows.

The loader resolves these paths to absolute paths and then validates the config again. That second check only recognized POSIX absolute paths, so a Windows path like `C:\Users\you\.weave\memory.md` was rejected with "must be a relative path without '..' or absolute paths". The adapter then created no agents, so Loom was missing in OpenCode. Windows drive and UNC paths now count as resolved.
