# Design system (vendored)

Copied from the PoliTost Smartbook reader, `design-system/` at commit 012a3b9 of [politost-smartbook](https://github.com/SuperTost100/politost-smartbook). The builder uses the reader's tokens, fonts and logo so the two apps look like one product.

- `tokens.css`: the reader's file unchanged except the font paths. To follow a reader change, copy the new file over this one and fix the paths again.
- `fonts/`: Source Serif 4, Figtree, JetBrains Mono (SIL OFL 1.1, see `fonts/README.md`).
- `logo/`: the Smartbook mark (light, dark, small), with the C2PA metadata removed. The builder's app icon and favicon (`public/app-icon.svg`, `public/favicon-ink.svg`, `assets/icon.svg`) put the same mark on an ink square instead of the reader's teal, so the two apps' tabs are easy to tell apart. The favicon file name changes with the icon because browsers cache favicons regardless of cache headers.

The reader builds its controls with antd; the builder keeps its own components in `src/styles/ui.css`, styled from these tokens. The builder has its own violet accent (`--accent*` in `src/styles/tokens.css`) so it doesn't look like the reader; the reader's teal `--primary*` is used only by the preview components in `src/reader`.
