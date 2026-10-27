# I14 — Text Cleaning Manager validation and save semantics

Base: VectHare I13 cumulative build. Includes all prior I01–I13 changes.

| ID | Correction |
|---|---|
| #161 | Save Changes assembles and validates a detached draft of preset, built-in toggles and custom patterns, then commits once. Invalid regexes, invalid flags and empty enabled patterns leave persisted settings unchanged. |
| #162 | JSON array and template imports validate the complete structure, built-in IDs, presets, all fields and every regex before merging or committing. Invalid imports do not partially change settings. Import previews are available to the modal without saving. |
| #163 | Add, Delete and Import act on the modal's local draft. Save Changes is the only modal operation that commits settings; Close discards pending edits. Export and Save Template use validated draft values. |
| #169 | Font and color-span built-in cleaners now preserve multiline contents while removing formatting wrappers. |

Additional adjacent hardening: escape untrusted imported pattern names and IDs in rendered HTML attributes; ignore import FileReader completions from a prior modal session.

## Tests

- New `tests/i14-text-cleaning.node.test.mjs`: 9 tests.
- Cumulative `npm run test:repair`: 153/153 passed.
- `npm run test:i14`: 9/9 passed.
- `node --check`: 97 JS/MJS files passed.
- ZIP integrity checked.

## Limitations

Only local unit/regression tests were run. The modal was exercised using a mocked jQuery environment, not a live SillyTavern browser. Custom regexes are still user-authored and may have performance costs; this repair validates syntax, not regex execution complexity.
