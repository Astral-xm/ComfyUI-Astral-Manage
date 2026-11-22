# CG Use Everywhere

The JavaScript and CSS under `web/ue/` are ported from:

- Project: CG Use Everywhere
- Upstream: https://github.com/chrisgoringe/cg-use-everywhere
- Version: 8.0.1
- Author: Chris Goringe and upstream contributors
- License: Apache License 2.0

Local changes include relocating the modules under
`ComfyUI-Astral-Manage/web/ue/`, adjusting ComfyUI script import paths, adding
modification notices, and using the `astral.use_everywhere` extension ID. The
local integration also removes the Combo Clone backend node and its dedicated
frontend logic while retaining the Anything Everywhere integration. The
remaining upstream node type IDs are unchanged for workflow compatibility.

The complete upstream Apache License 2.0 text is included in `LICENSE` in this
directory.
