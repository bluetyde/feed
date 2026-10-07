# Accessibility of the editor

Plan 03 and plan 07 ask for keyboard operation, visible focus, no information by colour alone, 200 % zoom and a text alternative for every plot. This note records what was checked and how, and what only a person with a screen reader can finish.

## What was done (2026-10-07), checked in a browser with the accessibility tree, not with a screen reader

| Area | State |
|---|---|
| Landmarks | `header`, `nav` "Commands", `aside` "Explorer", `main` "Editor" (the old `section`), `aside` "Properties"; a skip link "Skip to the editor" (visible on focus) |
| Headings | the title is level 1, the panel titles level 2, the group titles of the explorer and the section titles of the properties level 3 (there were none before) |
| Names | every button, input, select and tab has a name (the audit found none missing, in the case view, the results and compare views, and each properties panel of the example case); the ribbon icons are hidden from assistive technology (the buttons carry their text) |
| Tabs | the four document tabs and the output tabs are paired with `tabpanel`s (`aria-controls`, `aria-labelledby`); the Run result and Compare tabs now report `aria-selected` correctly (they were `true` while hidden, and never set when shown); arrow keys, Home and End move between tabs and in menus (already there) |
| Plots | each canvas is `role="img"` with a name, and described by a hidden values table written beside it: up to 24 evenly spaced points of each series with their count, the range, and a pointer to the exports for every point. Covers the case profile, the transient time series, the results and compare plots and the B − A difference. The pin cross-section's name carries its radii. |
| Announcements | a polite status region announces the validation outcome when it changes ("Valid, no problems", "1 error: ...", "Valid, with 2 warnings"); the run chip was already a status region |
| Regression guard | `tests/pageStructure.test.ts` (5 tests; 10 mutants of the page, all killed) |

## Not done, and why

- **A real screen reader.** Names, roles and tables were read from the browser's accessibility tree; how NVDA, JAWS or Narrator speak them was not heard. The checklist below is for that.
- **Roving tab index.** Each tab is a tab stop (the arrow keys also work). The ARIA pattern would make only the selected tab a stop. Left alone: it is operable as it is.
- **Hover-only readouts.** The "r = ... T = ..." readout still follows the mouse; the hidden table is the keyboard and screen-reader route to the same numbers.
- **Touch and mobile layouts, and the decision about physically absurd temperatures** (TODO, F2): not designed.

## Checklist for a screen-reader pass (about 15 minutes with NVDA or Narrator)

1. Open the editor and press Tab once: "Skip to the editor" is announced; Enter lands in the editor.
2. List headings (NVDA: Insert+F7; Narrator: Caps+Ctrl+H or the headings navigation): the title, Case, the group titles, Properties and its sections appear in order.
3. Load the example, move through the Explorer, and open a property group: each field is spoken with its label, unit and error text when it is wrong.
4. Type `-5` in the linear heat rate: "1 error: linear heat rate must be positive" is spoken without moving focus.
5. On the Pin and profile tab, find the profile in browse mode: a description with the point counts and range is read, then a table (Series, r, T) can be walked row by row.
6. Run (or Quick look), open the Results and Compare modes: the run list is operable by Enter and Space; the plots read as in 5.
7. Open Pins, Materials and an import panel: the menu items are announced as a menu, arrow keys move, Escape closes and focus returns.
8. Anything spoken twice, not at all, or in a confusing order goes to the TODO.
