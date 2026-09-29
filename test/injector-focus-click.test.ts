// Focus-steal was a wrong hypothesis (2026-09-29). Synthetic clicks did not
// register even with the pool window focused; the actual gate is
// event.isTrusted, which no synthetic dispatch can satisfy. The fix uses
// chrome.debugger + CDP Input.dispatchMouseEvent instead.
//
// This file is kept as an empty placeholder so the build does not leave a
// stale compiled artifact in dist/test/. See HANDOFF.md §8.
export {};
