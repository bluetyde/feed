# The user's own materials

A material you enter or edit in the editor can be **saved to the library** and used again. It is kept apart from the sourced library: `library/materials.json` (committed, with citations) is never written by a save; yours go in `library/custom/materials.json` (git-ignored, on this computer). Code: `src/core/userLibrary.ts` (storage and revisions), `validateMaterial` in `src/core/validate.ts` (the check), the route `POST /api/library/material` and the "Save to library" section of a material's panel in the editor. Tests: `tests/userLibrary.test.ts`.

## What a save does

- **Checks the material the way a case checks it** (`validateMaterial`): an id, a revision, a thermal conductivity with its stated **source** (and, for a temperature-dependent law, its **valid range**), and a volumetric heat capacity under the same rules if the material has one. A material that would be refused in a case is refused here, with the same codes (`E_PROP_MISSING`, `E_UNITS`, `E_OUT_OF_RANGE`), so a saved material is always one a case accepts. Property sets that belong to other apps (for example an OpenMC composition) are only required to be objects and are **saved exactly as they are**.
- **Revisions are immutable.** The first save of an id is revision 1. Saving a changed material (a property, or the name or source note) under the same id is the next revision; the earlier ones stay in the file. An identical save is reported **unchanged** and writes nothing. Whatever revision the case carried, the library assigns the revision, and the editor sets the case's material to it, so the case names exactly what was saved.
- **Ids:** 3 to 64 characters, lower case letters, digits and hyphens (not at either end). An id of a **sourced** library material is refused (`E_MATERIAL_ID_TAKEN`, 409), even if its spelling is one a new id could not have; an id belongs to one region (fuel or cladding).
- **Limits:** a material up to 100 kB, a name of 1 to 120 characters, a description up to 1000 and a source note up to 2000, 1000 saved revisions, 5 MB of file. Over any of them it refuses and says which.
- **A damaged file is reported, never overwritten:** if `library/custom/materials.json` is not valid JSON, is another schema, or holds an entry that is not a valid material, the library listing shows the problem (`userLibrary.problem`), no custom material is offered, and a save is refused (`E_LIBRARY_UNREADABLE`) with the file left as it is. The file is written through a temporary file and a rename.

## In the editor

A material's panel has a **Save to library** section: a name, a source note (filled from the library entry the material came from, if it did), and the button. The result is stated in place: "Saved as ... revision 2. Earlier revisions are kept.", "Already in the library as revision 1; nothing changed.", or the reasons. The library picker lists your materials after the sourced ones, labelled `custom`, with "Yours: revision N of M saved." Picking one puts its latest revision in the case.

## Where it lives, and what it is not

- `FEED_USER_LIBRARY` names another file (the tests use it; every test runs against a user library that does not exist, so what you have saved cannot change a test).
- It is **not a way to make a number sourced**: a saved material is labelled `custom` and carries the source note you wrote; the sourced label is only for entries in the committed library with a citation.
- **Not done:** deleting or renaming a saved material (the file is plain JSON and can be edited by hand; a revision is never edited in place by the app); sharing a library between computers.

## The presets that ship

The sourced and synthetic presets in `library/materials.json` can run a pulse as they are: the TRIGA U-ZrH fuel and both stainless-steel claddings carry the SAR heat capacities (revision 2 of each; the conductivity is unchanged), the two synthetic materials of the oracle pair carry their synthetic ones. The U-ZrH law's validity range is **assumed** (the SAR states none; its source text says so). `zry-clad-like` and `synthetic-fuel-kT` carry none, and a pulse with them is refused naming the missing heat capacity.
