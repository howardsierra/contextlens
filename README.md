# Context Lens

A context-window dashboard for SillyTavern (Chat Completion APIs only).

See exactly what's in your prompt right now:

- **Fill donut** — % of the *prompt budget* used (context size minus the reply
  reserve), with a change-since-last-send chip; the ring turns amber/red near the limit
- **Stacked token gauge** — color-coded breakdown: main prompt, character card, persona,
  world info, chat history, author's note/extensions. The reply reserve is drawn at the
  right end and turns red when the prompt runs into it
- **Per-category bars** with animated token counts and percentages; hover a category to
  highlight it in the gauge
- **Active world info** — every lorebook entry that fired this turn, with its trigger
  keywords, book, and token cost; entries that activated but never made it into the
  prompt are struck through
- **Truncation line** — the oldest chat message still in context, and how many older ones fell out
- **History strip** — recent messages by token size, with a ✂ marker at the cut-off.
  Dropped messages are hollow, `/hide`-den ones are hatched. Click a bar to jump to that message
- **Fill trend** — sparkline of budget use over your recent sends in this chat

## Install

Extensions ▸ Install extension ▸ paste this repo's URL.

Or manually: copy this folder into `data/<your-user>/extensions/` and reload.

## Use

Open the wand (Extensions) menu and click **Context Lens**. The panel updates
automatically whenever a prompt is assembled — including dry-run token previews.
You can also toggle it with `/contextlens` (alias `/ctxlens`).

- Drag it by the header and resize it from the corner; position and size are remembered
- Collapse it to a slim header bar that still shows the fill % and a progress line
- Every section folds away, and the folded state is remembered

## Notes

- Chat Completion APIs only (OpenAI-compatible, Claude, etc.). Text Completion is not supported.
- Token attribution is heuristic: merged system messages are split by matching
  known sources (card fields, fired lorebook entries, persona, extension prompts),
  so heavily macro-modified prompts may attribute a few tokens to "Other / overhead."
