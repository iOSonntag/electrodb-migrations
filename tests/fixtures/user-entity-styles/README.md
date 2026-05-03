# user-entity-styles

Fixture matrix for `bumpEntityVersion` (SCF-04 / Plan 02-04). Each `.ts` file is a
syntactically-valid ElectroDB entity declaration that targets a specific AST shape
of the `model.version` initializer. Tests load each fixture into a tmp dir, run
`bumpEntityVersion`, and assert that **only the version literal changed** —
every other byte is preserved (comments, indentation, blank lines, quote style).

## Supported styles (8) — bump succeeds

| Fixture                  | AST shape of `model.version`            | Behavior                                          |
| ------------------------ | --------------------------------------- | ------------------------------------------------- |
| `single-quote.ts`        | `StringLiteral` `'1'`                   | Bumps to `'2'`. Single-quote preserved.           |
| `double-quote.ts`        | `StringLiteral` `"1"`                   | Bumps to `"2"`. Double-quote preserved.           |
| `template-literal.ts`    | `NoSubstitutionTemplateLiteral` `` `1` `` | Bumps to `` `2` ``. Backticks preserved.        |
| `numeric-version.ts`     | `NumericLiteral` `1`                    | Bumps to `2`. No quotes added (Q1 preserves form). |
| `as-const.ts`            | `AsExpression` of `StringLiteral`       | Inner literal bumped; `as const` assertion preserved. |
| `multiple-entities.ts`   | Two top-level entities; `User` and `Team` | Bumping `User` leaves `Team`'s version untouched. |
| `comments-adjacent.ts`   | Line + block comments around version property | Comments preserved byte-for-byte.            |
| `multi-line-model.ts`    | 4-space indent + blank lines inside `model:` | Whitespace preserved byte-for-byte.            |

## Refused styles (1) — bump throws

| Fixture                | AST shape                          | Behavior                                       |
| ---------------------- | ---------------------------------- | ---------------------------------------------- |
| `refused-binding.ts`   | `Identifier` (`version: VERSION`)  | Throws `EDBEntitySourceEditError`; source unchanged. |

## How tests use these

Tests in `tests/unit/scaffold/bump-entity-version.test.ts` copy each fixture into
a freshly-created `mkdtempSync` directory before running `bumpEntityVersion`. The
fixtures themselves are never mutated — they are read-only inputs for the suite.

## Adding a new edge case

When a new `model.version` form needs coverage:

1. Add a `.ts` fixture here named after the AST shape (e.g. `tagged-template.ts`).
2. Update this README's table.
3. Add a corresponding test in `tests/unit/scaffold/bump-entity-version.test.ts` —
   either a new entry in the supported-styles `it.each(...)` block, or a new
   refusal-case `it()` block — and assert the bytes-outside-literal preservation
   invariant the same way the existing tests do.
