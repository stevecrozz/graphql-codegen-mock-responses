# Issue list

Working backlog. Sourced from external review of 0.3.0 (items marked *[review]*) plus
findings from verifying that review (*[own]*). Every claim below was reproduced against
`src/` before being written down.

Ordering principle: unblock verification first, then fix silently-wrong output, then
ergonomics, then the type-layer rewrite that subsumes several workarounds.

| # | Title | Priority | Size | Status |
|---|-------|----------|------|--------|
| 1 | Compile-and-run test harness for generated output | P0 | M | **done** |
| 2 | README documents a config that throws | P0 | S | **done** |
| 3 | Export `DeepPartial` + per-operation `FooOverrides` alias | P0 | S | **done** |
| 4 | Nullable lists lose both override callbacks | P0 | S | **done** |
| 5 | Name the field when an array override isn't an array | P1 | S | open |
| 6 | `@skip` / `@include` are ignored | P0 | M | **done** |
| 7 | Warn on unreachable union branches | P1 | S | open |
| 8 | `seed` config for deterministic factories | — | — | **closed, not doing** |
| 9 | Per-operation override types instead of generic `DeepPartial` | P2 | L | open |
| 10 | Upstream: `typescript` + `typescript-operations` in one file duplicates enums | P1 | S | open |
| 11 | Type names bypass the `typescript` plugin's naming convention | P0 | M | **done** |

Issues 8 and 9 change generated output or add config; batch them into one release rather
than shipping a version per issue.

Released in 0.4.0: 1, 2, 3, 4 and 6.

11 is the next release. It only changes output for schemas that have a name `pascalCase`
does not fix-point on, and for those the current output does not compile at all — so it is
a bug fix, not a breaking change, despite touching generated identifiers.

---

## 1. Compile-and-run test harness for generated output — P0, M — DONE

*[own]* All 21 tests in `tests/plugin.spec.ts` were `assert.ok(output.includes(...))`
string matches. Nothing compiled the generated module or executed a factory, so the suite
structurally could not catch type-level regressions. Issue 4 is a documented feature that
has been broken the whole time; that was the proof.

**Landed:** `tests/helpers/compileHarness.ts` + `tests/compile.spec.ts`.

`generate(name, { schema, documents, config, check })` writes a four-file project to
`tests/.tmp/<name>/` — `schema.ts` (`@graphql-codegen/typescript`), `types.ts`
(`typescript-operations`), `mocks.ts` (this plugin), `check.ts` (the consumer source under
test) — then:

- `assertCompiles(project)` — `ts.createProgram` with `strict`, NodeNext resolution,
  asserts zero diagnostics.
- `assertTypeErrors(project, [/pattern/])` — asserts exactly one diagnostic per pattern,
  all in `check.ts`, and none in the generated files. This is what pins down the behavior
  the review credited us with: rejecting overrides of unselected fields.
- `project.load()` — imports `check.ts` through the tsx loader and returns its exports, so
  the same case asserts on runtime values.

Projects are left on disk after the run and assertion messages point at them; `name` is
the directory, so it must be unique across spec files. `tests/.tmp/` is gitignored.

Thirteen cases cover the smoke path, unselected-field and wrong-scalar rejection, list
overrides (array + callback form) across the full nullability matrix, `listElementCount`,
union branch dispatch (list, nullable list and single-field forms, plus wrong-branch
rejection), enum values, and the exported override types.

Two started as `{ todo: ... }` because they documented bugs rather than behavior — the
nullable list callback (issue 4) and the `DeepPartial` export (issue 3). node:test reports
todo failures without failing the run, which kept the suite green at exit 0 until each fix
flipped its case to passing. Both are now real tests. Worth reusing that pattern: write the
failing case when the bug is found, mark it `todo` with the issue number, delete the marker
in the fix.

**Also landed:** `@graphql-codegen/typescript` and `typescript-operations` as
devDependencies. Verified from a clean `node_modules` that nothing else is needed.

## 2. README documents a config that throws — P0, S — DONE

*[own]* `operationTypesFile` is required (`src/index.ts:22`) but appeared in neither the
Setup example nor the config table. Copying the README verbatim threw at codegen time.

The Setup snippet was wrong a second way: it emitted `typescript` and `typescript-operations`
into a single output file, which does not compile (issue 10).

**Landed.** Setup now shows the three-file layout with `importSchemaTypesFrom`, both required
paths, and what each points at (`typesFile` → schema types, where enums come from;
`operationTypesFile` → operation types). Config table has an `operationTypesFile` row and a
corrected `typesFile` description. Also fixed in the sweep:

- the Setup block was fenced as `yaml` while containing TypeScript;
- the custom-scalars example passed only `typesFile`, so it would have thrown too;
- `How it works` still described the factory signature as `DeepPartial<OperationType>`
  (it's `<Op>Overrides` since issue 3) and didn't mention `@skip`/`@include`;
- the exported override types from issue 3 and the `conditionalFields` option from issue 6
  were undocumented; both now have sections.

**Verified, not just proofread.** Built a throwaway project containing only the packages the
README tells you to install, put the Setup snippet in it as `codegen.ts` verbatim, ran
`npx graphql-codegen`, and type-checked the output under `--strict`: clean, including an
operation touching an enum, a `<Op>Overrides` import, and a list callback. The *old* one-file
recipe, run the same way, gives `TS2567` on a doubly-declared enum, confirming the note the
README now carries. This covers the extensionless/bundler-resolution variant;
`tests/compile.spec.ts` covers the ESM `.js` variant.

**The first version of this fix was still broken, and only the real CLI caught it.**
`importSchemaTypesFrom` is resolved relative to the *project root* and rewritten relative to
the output file, so `'./schema'` alongside an output of `./src/__generated__/types.ts` emits
`import … from '../../schema'` — `TS2307`. The correct value is
`'./src/__generated__/schema'`. Our own `typesFile`/`operationTypesFile` are the opposite:
emitted verbatim, so relative to the generated file. The README now states both.

An earlier pass at this used `@graphql-codegen/core` with flat filenames instead of the CLI,
which put every file in one directory and made the path bug invisible. Worth remembering: for
anything path-shaped, reproduce with the real output layout.

## 3. Export `DeepPartial` + per-operation `FooOverrides` alias — P0, S — DONE

*[review]* `src/runtime.ts:21` declared `type DeepPartial<T>` unexported, and the
generated file is a module, so consumers writing their own builder helpers had to go
through `NonNullable<Parameters<typeof aFooQueryResponse>[0]>` and index into it.

**Landed:** `export type DeepPartial`, plus `export type <OperationType>Overrides =
DeepPartial<<OperationType>>` emitted above each factory, which now takes the alias as its
parameter type.

The alias is keyed off the operation *type* name (`GetUserQueryOverrides`), not the factory
name, so `prefix` does not apply to it — `prefix` supplies the article in
`aGetUserQueryResponse`, and articles on a type name read wrong. Types and values live in
separate namespaces, so there is no collision with the factory either way.

Internal helpers (`_Field`, `_BranchKeys`, `Branches`, …) stay unexported. `DeepPartial` is
now public API surface, so it is a name collision if someone emits this plugin into the
same output file as another plugin that declares the same name — acceptable, and the
per-operation alias means most consumers never need to reference `DeepPartial` directly.

**Covered by:** `deep-partial-export` (both spellings type-check and run) and
`overrides-alias-rejects` (the alias still rejects unselected fields — the property the
review credited us with, now reachable through public API).

## 4. Nullable lists lose both override callbacks — P0, S — DONE

*[own]* `src/runtime.ts:24` gated the array case on `[T] extends [Array<infer U>]`, which
is false for `T = User[] | null`. GraphQL fields are nullable unless marked `!`, so this
was the common case, and it fell through to the homomorphic mapped-type branch — element
partials only, no callback:

```
error TS2322: Type '(make: any) => any[]' is not assignable to
  type '({ id?: string; name?: string; } | undefined)[]'
```

Verified through the harness across the nullability matrix. **Worse than first written
down:** it broke *both* documented callback forms, not just `(make) => U[]`. A nullable
list of a union lost branch dispatch too — `({ User, Document }) => [...]` on
`[SearchResult!]` — so both override APIs the README advertises were broken for any list
field the schema author had not marked `!`. Only *outer* nullability mattered: `[User]!`
worked, because `Array<User | null>` is still a bare array. Non-list fields were never
affected, since `_Field` already wraps its branch check in `NonNullable<T>`
(`src/runtime.ts:17`). Runtime was fine throughout — with an `as any` the callbacks
produced correct payloads. Purely a type-level gap.

**Landed:** the array branch keys off `[NonNullable<T>]`, and `Extract<T, null |
undefined>` is unioned back in so a nullable list still accepts `null` (which
`mergeOverrides` has always handled, `src/runtime.ts:34`).

**Covered by:** `list-nullable`, `list-nullability-matrix` (`[T!]!`, `[T!]`, `[T]!`, `[T]`
— callback form on each, `null` on the nullable two), `list-non-null-rejects-null` (pinning
that `null` is still a type error where the schema forbids it), and
`union-branches-nullable-list`.

## 5. Name the field when an array override isn't an array — P1, S

*[review]* `src/runtime.ts:70` does `(override as any[]).map(...)`, so a scalar passed
where the schema has a list throws `'user'.map is not a function`. Under MSW that becomes
a swallowed 500 and the failure surfaces several layers from the cause.

The generated types do reject this without an `as any`, so this is a guardrail for JS
consumers and for helpers that have cast — still worth it, given the debugging cost.

**What:** thread the field path (known at codegen time) into `applyArrayOverride` and
`applyBranchedArrayOverride`; guard with `Array.isArray` and throw naming the path, the
received type, and the accepted forms. Consider the mirror case in `mergeOverrides`
(`src/runtime.ts:39` silently takes an array override for a non-list field).

## 6. `@skip` / `@include` are ignored — P0, M — DONE

*[review]* No directive handling anywhere in the walk. A field gated on
`@include(if: $flag)` was emitted unconditionally with faker data, so the semantics flipped
from "server omitted this" to "present with a random value".

Worse than reported: `typescript-operations` types conditional fields as optional but
*not* nullable —

```ts
export type QQuery = { user: { id: string, name?: string, nickname?: string | null } | null }
```

— so for a conditional selection of a non-null schema field there was **no** escape hatch:
`null` is a type error and `mergeOverrides` skips `undefined` (`src/runtime.ts:50`). The
reviewer's `null` workaround only worked because their fields happened to be nullable.

**Landed:** conditional fields are left out of the defaults, with `conditionalFields: 'omit'
| 'include'` (default `'omit'`) to opt back into the old behavior. Changes generated output.

Rather than dropping the entry, the emitted literal guards it:

```js
...(_hasOverride(overrides?.user, 'name') ? { name: faker.lorem.word() } : {}),
```

Plain omission would have made `mergeOverrides(undefined, { name: 'x' })` hand the partial
straight back, so overriding a conditional *object* field would yield an object missing the
rest of its keys while claiming the full type — the bug class this plugin exists to catch.
The guard also skips the faker call when the field is absent. TypeScript models a
conditional spread as an optional property, which is exactly what the operation type
declares, so `const defaults: T = {…}` still checks — including when every selected field is
gated.

Resolved from the watch list:
- Conditionality is tracked in `collectFields` and merged with `&&`, so a field selected
  both gated and ungated stays unconditional. `mergeFieldNodes` drops the second node's
  directives, so reading it off the merged node would have been wrong.
- `@skip`/`@include` on fragment spreads and inline fragments propagate to the fields
  beneath. The fragment-spread cycle guard is now keyed on name *and* the flag, so the same
  fragment spread gated in one place and ungated in another still contributes its ungated
  occurrence. Terminates because the flag only goes false → true.
- Statically resolvable directives (`@skip(if: false)`, `@include(if: true)`) are treated as
  unconditional; the inverse pair is treated as conditional, which in `'omit'` mode is the
  right answer anyway.
- No case found where an omitted field is required in the operation type, so the
  fails-to-compile scenario stays hypothetical. `conditional-all` pins the all-gated case.

**Covered by:** `conditional-omit`, `conditional-override`, `conditional-merged`,
`conditional-fragment-spread`, `conditional-nested` (list elements and union branches, where
the override access is a closure parameter rather than `overrides`), `conditional-all`,
`conditional-include-mode`. README documents the behavior and the config.

**Note for issue 8:** the guard means a conditional field's faker calls only run when it is
overridden, so the random sequence for later fields shifts with the override set. Same input
still gives the same output, so the determinism promise holds, but worth stating.

## 7. Warn on unreachable union branches — P1, S

*[review]* A union field selecting inline fragments but no `__typename` anywhere silently
flattens to the alphabetically-first member (`pickBranch`,
`src/operationFactories.ts:115`); the other branches are unreachable.

Not doing what the review asked for. Generating the branch callbacks requires
`Branches<T>`, which is derived from `T extends { __typename: infer K }` — with no
`__typename` in the payload the TS union has no discriminant and branch constructors
can't be keyed by GraphQL type name. The gate at `src/operationFactories.ts:328` is
load-bearing, not an oversight. Also rejected: injecting `__typename` into the payload
(adds a field the operation doesn't select — the bug class this plugin exists to catch),
and typing the callback as `Record<string, ...>` (loses the autocomplete that makes it
useful). Issue 9 is the actual fix.

**What:** codegen-time diagnostic naming the operation, the field path, the branch that
was chosen, and the branches that are unreachable, with "add `__typename` to enable
branch selection" as the remedy. Config `onUnreachableBranch: 'warn' | 'error' |
'silent'`, default `warn`.

## 8. `seed` config for deterministic factories — CLOSED, not doing

*[review]* Nothing calls `faker.seed`, so any field a test transitively depends on has to
be pinned or the spec flakes. Cited as the single most expensive thing about migrating off
`graphql-codegen-typescript-mock-data`, with three real spec failures traced to it.

**Not building it.** Three reasons, in order of weight.

**1. Consumers already have a better version of this feature.** The generated module imports
the shared `@faker-js/faker` singleton, so `faker.seed(42)` in a test setup file already
makes every factory reproducible — verified by `consumer-seeded-faker`. And
`beforeEach(() => faker.seed(n))` scopes determinism to a *test*, which is the boundary that
actually matters and the one a codegen plugin cannot see. The `seed ^ hash(operationName)`
scheme was an attempt to reconstruct that boundary from inside the library, and it paid for
the guess with "two calls to the same factory return identical payloads."

**2. The reported failures were booleans, and no deterministic scheme protects those.**
`archived`, `hidden`, `embedEnabled` — for a `Boolean` there are two values, both meaningful,
and no third value that can signal "nobody pinned this." Any deterministic choice is
indistinguishable from a deliberate one. Randomness is the only mechanism that surfaces an
accidental dependency on an unpinned boolean, and at a 50% failure rate it surfaces on the
first or second run rather than next quarter. `seed` would have hidden three real test bugs.

**3. Faker does not promise value stability across versions.** Seeded reproducibility is a
guarantee built on a dependency that declines to make it; a faker major would break exactly
the snapshots the seed was protecting, in a diff that looks like noise.

**Obligation this creates on us:** keep generating `import { faker } from '@faker-js/faker'`.
A module-private `new Faker({...})` instance — which the original plan for this issue called
for — would silently break consumer-side seeding. `consumer-seeded-faker` is the regression
test for that.

**If a snapshot suite ever turns up**, the design is worked out and needs no `seed`.
Determinism is a per-scalar question, and the deciding test is *can a fixed value for this
scalar be mistaken for a meaningful one?*

| Scalar | Default | Why |
|---|---|---|
| `String` | a `«Type.field»` label | deterministic, and announces itself in a snapshot diff |
| `ID` | label + element index | deterministic *and* unique, so normalizing caches don't collapse rows |
| `Int`/`Float`/`DateTime`/`URL` | fixed plausible constant | must stay parseable; no label possible |
| `Boolean`, enums | **random** | no value can signal "unpinned" — keep fuzzing |

`scalars` already takes raw expressions, so most of that is a documented preset rather than
new machinery (`deterministic-scalars` pins it). The one missing piece is the element index:
there is currently no expression a user can write that varies per list element without being
random, so deterministic + unique is unreachable today. Element closures already exist and
would just need to take an `_i`. Defer until someone needs it.

**Do not** blanket-recommend literal `scalars` as a determinism recipe: `ID: "'id'"` gives
every element of a list the same id, and under Apollo/urql normalization those rows collapse
into one, silently. Worse failure than a flaky boolean.

## 9. Per-operation override types instead of generic `DeepPartial` — P2, L

*[own]* Several items above are workarounds for one root cause: overrides are derived
generically from the operation type, so the override type only knows what TypeScript can
recover from the payload shape. The plugin already knows the whole selection set.

Emitting a bespoke `<Op>Overrides` type per operation would:
- key branch constructors by GraphQL type name with no `__typename` in the payload,
  closing issue 7 properly;
- express exact omit semantics for conditional fields (issue 6);
- make issue 3's alias the real type rather than an alias of a derived one;
- remove the `[T] extends [Array<...>]` fragility behind issue 4.

Cost: the type layer in `src/runtime.ts` mostly goes away, replaced by per-operation
emission — bigger generated output, and a rewrite of the hardest code in the project.
Don't start until 1–8 have landed and the harness is trusted. Decide then whether
`DeepPartial` stays exported as a compatibility shim.

## 10. Upstream: `typescript` + `typescript-operations` in one file duplicates enums — P1, S

*[own, found while building the harness]* Our README recipe puts both plugins in one output
file. With `typescript-operations` v6, any enum or input object an operation touches is
declared twice — once by `typescript` as `export enum Status`, once by the operations
plugin as `export type Status = | 'ACTIVE'` — and the file does not compile:

```
error TS2567: Enum declarations can only merge with namespace or other enum declarations.
```

Reproduced through `@graphql-codegen/core` (i.e. the CLI's own path, not an artifact of
calling the plugins directly), with `typescript@6.1.0` + `typescript-operations@6.1.5`.
Not present on `typescript@4.1.6` + `typescript-operations@4.6.1`, so it is a v6
regression. Cause: `typescript-operations` re-emits every schema type an operation
references unless `importSchemaTypesFrom` is set
(`node_modules/@graphql-codegen/typescript-operations/cjs/index.js:92`), and it has no way
to know the `typescript` plugin already emitted them into the same file.

Not our bug, but our documented setup tripped over it.

**Done:** the README note (issue 2) documents both workarounds — split the schema types and
operation types into separate files with `importSchemaTypesFrom` (what the harness and the
Setup recipe now do), or pin both plugins to v4.

**Still open: filing it upstream.** Minimal repro, confirmed through `@graphql-codegen/core`
so it is not an artifact of calling the plugins directly — `typescript` and
`typescript-operations` on one output file, with any operation selecting an enum:

```
types.ts(27,13): error TS2567: Enum declarations can only merge with namespace or other enum declarations.
types.ts(32,13): error TS2567: ...
```

`export enum Status` from `typescript` on line 27, `export type Status = 'ACTIVE' | …` from
`typescript-operations` on line 32. Present on `typescript@6.1.0` +
`typescript-operations@6.1.5`, absent on the v4 pair.

Filing it is a human call — I'm not posting to their tracker.

**Not an upstream problem, for the record:** `@graphql-codegen/cli` appeared uninstallable at
every version, with published packages depending on unpublished ones (`cli@7.4.0` →
`plugin-helpers@^7.3.0`, `cli@7.3.1` → `typescript-operations@^6.1.6`). That is the corp
Artifactory mirror's cooldown on recently-published versions, not a publishing bug. Installing
with `--registry=https://registry.npmjs.org/` works. Worth remembering the next time a
dependency range looks impossible.

---

## 11. Type names bypass the `typescript` plugin's naming convention — P0, M — DONE

*[review, verified]* `src/leafGenerator.ts:40,53` pascal-cases the enum *value* and passes the
enum *type* through raw:

```ts
enumTypes?.add(named.name);
return `${named.name}.${pascalCase(firstValue.name)}`;
```

`named.name` is the schema name. The identifier that exists in `typesFile` is whatever
`@graphql-codegen/typescript` called it, and that plugin runs every name through
`convertName`, whose default `namingConvention` is `change-case-all#pascalCase`. For almost
every name that is identity — `SpaceLinkDeleteAccess` → `SpaceLinkDeleteAccess` — which is
why it went unnoticed. It diverges on consecutive capitals:

| schema | `typescript` emits | we emit |
|---|---|---|
| `AIDataRoomAssistantAccessStatus` | `AiDataRoomAssistantAccessStatus` | `AIDataRoomAssistantAccessStatus` |
| `NDAStatus` | `NdaStatus` | `NDAStatus` |
| `ISO8601Timestamp` | `Iso8601Timestamp` | `ISO8601Timestamp` |

Confirmed end to end: `@graphql-codegen/typescript` on `enum AIStatus { ACTIVE }` emits
`export enum AiStatus`. `enumTypes` feeds the import list (`src/index.ts:62`), so the
generated module imports a name that is not exported:

```
error TS2724: '"./types"' has no exported member named 'AIDataRoomAssistantAccessStatus'.
  Did you mean 'AiDataRoomAssistantAccessStatus'?
```

Because it is an import failure rather than a bad expression, one such enum anywhere in the
document set takes down the whole generated file, not just the factory that selects it.

**Blocking, not cosmetic.** Downstream this is the sole reason the plugin is gated to a
single package; the package it was wanted for selects one of these enums and cannot compile.

**Scope.** Both sites have to agree — one produces the import, the other the reference, so
converting only one trades TS2724 for an unresolved identifier. There is no shippable
partial, which is why this is one M ticket and not an S plus a follow-up. Four things are
in scope, all verified against `node_modules`:

1. **Enum type names** — `convertName(node, { useTypesPrefix: enumPrefix, useTypesSuffix: enumSuffix })`
   (`visitor-plugin-common/cjs/base-types-visitor.js:305`).
2. **Enum value names** — also convention-dependent, so `pascalCase(firstValue.name)` is
   wrong too. Under `namingConvention: 'keep'` the member is `ACTIVE`, not `Active`; with
   `typesSuffix: 'T'` it is `ActiveT`. Uses `useTypesPrefix: false` and
   `transformUnderscore` only when the name is not all underscores
   (`convert-schema-enum-to-declaration-block-string.js:118`).
3. **Operation type names** — `src/operationFactories.ts:64` hardcodes
   `${pascalCase(op.name)}${Query|Mutation|Subscription}`, the same failure against
   `operationTypesFile`. Wider than `namingConvention` alone; `omitOperationSuffix`,
   `dedupeOperationSuffix` and `operationResultSuffix` all move the name:

   ```
   {}                          -> GetUserQuery
   {omitOperationSuffix: true} -> GetUser
   {namingConvention: 'keep'}  -> GETUserQuery
   {typesSuffix: 'T'}          -> GetUserQueryT
   ```

   The suffix is concatenated *before* conversion (`base-documents-visitor.js:123-129`), so
   `GETUser` + `Query` converts as one string.
4. **`visitor-plugin-common` as a declared dependency.** It is *not* a transitive dep of
   `plugin-helpers` (whose deps are `@graphql-tools/utils`, `change-case-all`,
   `common-tags`, `import-from`, `lodash`, `tslib`) — it resolves today only because the
   `typescript` plugins are devDeps here. Add it as a peer dependency alongside
   `plugin-helpers`, since `typesFile` already implies the user runs those plugins.

**Not in scope:** `nextClosureName` at `src/operationFactories.ts:174`. Those `make<Hint>_<n>`
identifiers are locals inside the generated module, never imported and not public surface, so
there is no convention to agree with. `factoryName` at `:66` consumes the converted operation
type name and so changes with it — that is the exported factory name, a public-API effect but
not a compile failure.

**Default, not required.** `namingConvention` mirrors the `typescript` plugin's default
rather than being mandatory when `typesFile` is set. `convertFactory({})` *is* the same
default resolution that plugin uses, so mirroring reuses its logic instead of guessing;
requiring the key would break every existing user for no gain in the common case, and would
not even prevent mismatch (nothing stops someone setting `'keep'` here and forgetting it
there). Express the coupling in code and docs.

**Why the harness missed it:** `tests/compile.spec.ts:39` declares `enum Status`, a name
`pascalCase` fix-points on, so the enum case passes while the bug is live. Regression tests
need an enum whose name is not already pascal-case (`enum AIStatus` is the one-character
repro) plus a `namingConvention: 'keep'` case pinning that conversion follows config rather
than being hardcoded in the other direction.

**Related:** issue 10 is the other failure mode of the same coupling — this plugin has to
agree with the `typescript` plugin about what the schema types are named *and* where they
live.

**Done.** `src/naming.ts` centralizes every identifier that has to match, built on
`convertFactory` and mirroring `convertName`/`getOperationSuffix` call-for-call, with the
upstream source location cited at each mirrored site. All eight naming keys are read off
config. `visitor-plugin-common` is now a declared peer dependency (`>=5.0.0`, since the
installed tree is on 7.2.4 while `plugin-helpers` is on 5.1.1 — the majors are not in step).

Two things the report did not have:

- **An all-underscore enum value was a syntax error, not a naming mismatch.**
  `pascalCase('_')` returns the empty string, so `enum Underscored { _ }` generated
  `Underscored.` — unparseable. `typescript` emits `_`, because it only collapses underscores
  when the name is not entirely underscores. Fixed by the same guard and pinned by its own
  test.
- **Enum *values* were wrong too**, not just type names — `namingConvention: 'keep'` wants
  `ACTIVE`, and `typesSuffix: 'T'` wants `ActiveT`. `typesPrefix` notably does *not* apply to
  members, only `typesSuffix`.

`nextClosureName` was left on `pascalCase` as scoped. Six regression tests, all confirmed
failing against the old code first; the `_` case was verified red by restoring the old
`transformUnderscore: true` behaviour.

---

## Not doing

- **Auto-injecting `__typename`** to make union dispatch work — see issue 7.
- **Schema-level factories.** Out of scope by design; see README "Why?".

## Credit from the review, worth keeping

The 0.3.0 output caught four places where hand-written `as SomeQuery` casts were hiding
fields the operation doesn't select, or fields outright wrong for the payload. Whatever
issue 9 does to the type layer must not weaken that — the harness needs negative type
tests (issue 1) pinning it down before the rewrite starts.
