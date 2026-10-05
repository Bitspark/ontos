# Panel responses — drop them here

Raw proposals from the convergence panel. One file per lens, named to mirror its
brief so scoring against the sealed prediction is mechanical:

| Brief | Response file to create |
|---|---|
| `brief-logic-programming.md` | `response-logic-programming.md` |
| `brief-data-interchange.md` | `response-data-interchange.md` |
| `brief-knowledge-representation.md` | `response-knowledge-representation.md` |
| `brief-type-theory.md` | `response-type-theory.md` |

If you run extra lenses or a no-persona control, follow the same pattern:
`response-<lens>.md` (e.g. `response-control-no-persona.md`).

## Conventions

- **Paste verbatim.** Drop the model's proposal in unedited — no summarizing,
  trimming, or "fixing." The scoring depends on what each model *actually*
  produced, divergences included.
- **One model per file.** Don't merge or compare across files here; synthesis
  happens later, separately.
- **Record provenance at the top** of each file so a re-run is reproducible — a
  short front-matter block:

  ```
  ---
  lens: logic-programming
  model: <provider / model name / version>
  date: <YYYY-MM-DD>
  brief: brief-logic-programming.md
  notes: <e.g. temperature, single-shot, any deviations>
  ---
  ```

- **Keep it blind.** These are inputs to scoring; do not let a later proposer see
  an earlier response, the other briefs, or the sealed prediction.

Once all responses are in, scoring proceeds against
[`../../0001-convergence-test-sealed-prediction.md`](../../0001-convergence-test-sealed-prediction.md)
using its committed rule (strong / weak / fail-or-learn), and surprises not in the
sealed file are recorded as surprises rather than retrofitted.
