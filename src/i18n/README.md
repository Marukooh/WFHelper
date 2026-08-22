# Translations

`en.json` is the source of truth. Missing entries fall back to English, so partial
catalogues are supported.

## Adding a language

1. Create `<code>.json` using an ISO 639-1 code such as `zh` or `fr`. Copy only
   the keys you are ready to translate from `en.json`; never change a key.
2. In `src/lib/i18n.ts`, add the code to `LocaleCode`, add an entry to
   `LOCALE_OPTIONS` with the language's own name (`Deutsch`, not `German`), and
   add one line to `LOADERS`.
3. In `ipc/overlayI18n.ts`, add the same file to `DICTIONARIES` so the in-game
   overlays follow the language too. They are plain HTML windows with no store
   access, so the main process resolves their text and pushes it to them.

The renderer loads locale catalogues on demand. Main also bundles them for the
overlay windows, and every added catalogue increases the installer size.

## Rules

- **Placeholders keep their names.** `{count}`, `{item}` and friends are filled
  in by the app; you may reorder them in the sentence, but not rename or drop
  them. A test enforces this.
- **`common.whisperBuy` / `common.whisperSell` stay English.** They are pasted
  into warframe.market trade chat and read by other players.
- **Leave a key out rather than copying the English.** Proper nouns and trade
  shorthand (`WTB R0`, relic tiers, riven grade letters) are already exempt.
- **Capitalisation belongs to CSS.** Write labels in normal sentence or title
  case; the UI uppercases what it needs to.
- **`...` not `…`:** use plain ASCII dots.

## Warframe vocabulary

Digital Extremes ships its own translations for game terms. The dependency
`warframe-public-export-plus` contains `dict.<lang>.json` for de, en, es, fr, it,
ja, ko, pl, pt, ru, tc, th, tr, uk and zh, keyed by `/Lotus/Language/...` paths.
Joining `dict.en.json` to your language on the key gives the word the game itself
uses, which is what players expect to read.

The German catalogue has an additional terminology table in
`tests/main/i18nGameTerms.test.ts`. Its `ownChoice` field records deliberate
departures from Digital Extremes and keeps that wording consistent.
