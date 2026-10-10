# Importing a material from a SEED project

A SEED project (`seed.project.json`, schema `seed.project/0.1`, SEED contracts, section 5, in the SEED repository) lists **materials** by id and revision. Each has **property sets** named by their consumer (`openmc.composition`, `thermal.conductivity`, ...), and a set is opaque to everyone but its owner. FEED's editor can read one material from a project into the fuel or the cladding of a case. Code: `src/core/projectImport.ts`; routes `POST /api/import/project` (list) and `POST /api/import/material`; the material panel's "Import from a SEED project". Tests: `tests/projectImport.test.ts`.

**FEED only reads.** It never writes into a project: SEED owns the manifest (its writer lock, its expected-revision check). A material that FEED changes is saved in FEED's own library as a new revision ([user-library.md](user-library.md)); getting that revision back into the project is SEED's side and is not built.

## What FEED reads

| In the project | What FEED does |
|---|---|
| `thermal.conductivity` with `schema: "feed.thermal-property/0.1"` | read: FEED's conductivity model fields ([conductivity-models.md](conductivity-models.md)), with `source` as SEED's `{kind, text}` |
| `thermal.volumetric_heat_capacity` with the same schema | read as FEED's `thermal.volumetricHeatCapacity` (SEED's set names are lower case, FEED's own has a capital) |
| a `thermal.*` set of any **other** schema | the material is **refused** (`E_IMPORT_FOREIGN_SET`): another app's set is not guessed at, evaluated or overwritten |
| any other set (`openmc.composition`, unknown ones) | **kept exactly**, deep copy, never read, saved as it was |

`source`: SEED's `{kind: synthetic|sourced|assumed, text}` becomes FEED's source text, with the project's record kept beside it as `sourceRecord` (and restored on export). A kind other than `sourced` is noted. FEED never says "sourced" on its own account about an imported or saved material: a saved material is `custom`.

## What it asks, what it refuses

- **By id.** Matching is by id only; a name is not an id. If a revision is given it must be the project's (`E_IMPORT_REVISION`): a revision is immutable and FEED reads the one the project holds. No such id: `E_IMPORT_NOT_FOUND`.
- An id FEED cannot carry unchanged (3 to 64 characters: lower case letters, digits, hyphens, not starting or ending with a hyphen) is refused, `E_IMPORT_ID`; FEED does not rewrite ids.
- A set that is not an object, a set name that is not `consumer.property`, a thermal set with no usable source: `E_IMPORT_SET`.
- The project itself: only a file named `seed.project.json` (or the folder holding it), at most 8 MB, valid JSON, schema `seed.project/0.1` exactly: `E_IMPORT_PROJECT`.

## A material with no thermal set

It is imported (the rest of it is the project's), and the answer names what is missing and what each is for: `thermal.conductivity` (every run), `thermal.volumetric_heat_capacity` (a transient). The case then refuses to run with its usual `E_PROP_MISSING` naming the same set. Nothing is invented. Adding a thermal set in the editor and saving makes **a new revision**.

## Revisions and the origin

An imported material carries `origin`: the project id, the material's id and revision there, its name, and the SHA-256 of its sets as imported. Saving it to the library:

- a **new id**, sets as imported: the project's revision; sets **changed** (a thermal set added or edited): the project's revision **plus one**; the other app's sets stay as they were, byte for byte;
- an id the library already has: the latest plus one, and never below what the rule above gives;
- a malformed `origin` is refused (`E_SCHEMA_INVALID /material/origin`); a material with no origin keeps the old rule (revision 1 for a new id).

The saved copy keeps its `origin`, so choosing it from the library again carries the provenance.

## The form a project holds (for the writers of projects)

`toProjectMaterial` gives a FEED material in the form a project holds, and the import of it gives the same sets back. A thermal set is FEED's property set plus `"schema": "feed.thermal-property/0.1"`, with `source` as `{kind, text}`:

```json
"thermal.conductivity": {
  "schema": "feed.thermal-property/0.1",
  "model": "constant",
  "value": { "value": 3.2, "unit": "W/m/K" },
  "referenceTemperature": { "value": 300, "unit": "K" },
  "source": { "kind": "sourced", "text": "datasheet, 2026" }
}
```

OpenMC Studio does not write project materials yet, and SEED has no writer for them: today a project with these sets is made by hand or by a script, and the `openmc.composition/0.1` set is whatever its owner puts in it. FEED does not look inside it.

## Not done

- Writing a changed material back into a project (SEED's `saveProject` with its expected-revision check is the way; a change of SEED's code and a decision about who merges revisions).
- Importing by revision when the project holds only a later one (a project holds one revision per id).
- Any reading of `openmc.composition` (density, nuclides): FEED needs none of it for a thermal run.
