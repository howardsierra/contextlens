# Context Lens

A context-window dashboard for SillyTavern (Chat Completion APIs only).

See exactly what's in your prompt right now:

- **Fill donut** — % of the context window used (ring turns amber/red as you near the limit)
- **Stacked token gauge** — color-coded breakdown: main prompt, character card, world info, chat history, author's note/extensions
- **Per-category bars** with token counts and percentages
- **Active world info** — every lorebook entry that fired this turn, with its trigger keywords
- **Truncation line** — the oldest chat message still in context, and how many older ones fell out
- **History strip** — mini bar chart of recent messages by token size; dropped messages show as hollow outlines

## Install

Extensions ▸ Install extension ▸ paste this repo's URL.

Or manually: copy this folder into `data/<your-user>/extensions/` and reload.

## Use

Open the wand (Extensions) menu and click **Context Lens**. The panel updates
automatically whenever a prompt is assembled — including dry-run token previews.
Drag it anywhere by the header; position is remembered.

## Notes

- Chat Completion APIs only (OpenAI-compatible, Claude, etc.). Text Completion is not supported.
- Token attribution is heuristic: merged system messages are split by matching
  known sources (card fields, fired lorebook entries, persona, extension prompts),
  so heavily macro-modified prompts may attribute a few tokens to "Other / overhead."
