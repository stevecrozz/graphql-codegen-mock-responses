# Issue list

Working backlog. Sourced from external review of 0.3.0 (items marked *[review]*) plus
findings from verifying that review (*[own]*). Every claim below was reproduced against
`src/` before being written down.

Ordering principle: unblock verification first, then fix silently-wrong output, then
ergonomics, then the type-layer rewrite that subsumes several workarounds.

| # | Title | Priority | Size | Status |
|---|-------|----------|------|--------|
| 1 | Compile-and-run test harness for generated output | P0 | M | **done** |
| 2 | README documents a config that throws | P0 | S | open |
| 3 | Export `DeepPartial` + per-operation `FooOverrides` alias | P0 | S | **done** |
| 4 | Nullable lists lose both override callbacks | P0 | S | **done** |
| 5 | Name the field when an array override isn't an array | P1 | S | open |
| 6 | `@skip` / `@include` are ignored | P0 | M | open |
| 7 | Warn on unreachable union branches | P1 | S | open |
| 8 | `seed` config for deterministic factories | P1 | M | open |
| 9 | Per-operation override types instead of generic `DeepPartial` | P2 | L | open |
| 10 | Upstream: `typescript` + `typescript-operations` in one file duplicates enums | P1 | S | open |

Issues 6, 8 and 9 change generated output or add config; batch them into one release
rather than shipping a version per issue.

Unreleased on `main`: 3 and 4. Both touch the type layer of the generated output — 4 is a
strict widening (code that compiled still compiles), 3 is additive — so they can ship
together with 2's README fix whenever the next release goes out.

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

## 2. README documents a config that throws — P0, S

*[own]* `operationTypesFile` is required (`src/index.ts:22`) but appears in neither the
Setup example nor the config table. Copying the README verbatim throws at codegen time.

**What:** fix the Setup snippet and the config table; state what each of the two paths
points at (`typesFile` → enums from `typescript`, `operationTypesFile` → operation types
from `typescript-operations`). Sweep the rest of the README for the same drift while in
there.

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

## 6. `@skip` / `@include` are ignored — P0, M

*[review]* No directive handling anywhere in the walk. A field gated on
`@include(if: $flag)` is emitted unconditionally with faker data, so the semantics flip
from "server omitted this" to "present with a random value".

Worse than reported: `typescript-operations` types conditional fields as optional but
*not* nullable —

```ts
export type QQuery = { user: { id: string, name?: string, nickname?: string | null } | null }
```

— so for a conditional selection of a non-null schema field there is currently **no**
escape hatch: `null` is a type error and `mergeOverrides` skips `undefined`
(`src/runtime.ts:50`). The reviewer's `null` workaround only worked because their fields
happened to be nullable.

**What:** omit conditionally-selected fields from the defaults by default (type-checks,
because the operation type marks them optional), with `conditionalFields: 'omit' |
'include'` to opt back in. Changes generated output — release alongside 8 and 9.

**Watch:**
- A field is conditional only if *every* merged occurrence carries the directive.
  `mergeFieldNodes` (`src/operationFactories.ts:339`) keeps the first node's attributes
  and drops the second's directives, so the flag has to be tracked in `collectFields`
  rather than read off the merged node.
- `@skip`/`@include` on fragment spreads and inline fragments must propagate to the
  fields collected beneath them.
- If we omit a field the operation type marks required, the emitted
  `const defaults: T = {...}` fails to compile. Loud rather than silent, but the harness
  from issue 1 should assert it doesn't happen for the mixed conditional/unconditional
  case.

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

## 8. `seed` config for deterministic factories — P1, M

*[review]* Nothing calls `faker.seed`, so any field a test transitively depends on has to
be pinned or the spec flakes. Cited as the single most expensive thing about migrating
off `graphql-codegen-typescript-mock-data`, with three real spec failures traced to it.

**What:** `seed?: number`. Re-seed at the top of *each factory body* with
`seed ^ hash(operationName)`:
- per-call re-seeding makes a given factory reproducible regardless of call order (a
  single module-level seed does not — values would still depend on call sequence);
- mixing in the operation name keeps different operations from producing identical
  values;
- the sequence still advances within a call, so list elements stay distinct.

Use a module-private `new Faker({ locale: [en, base] })` instance rather than the shared
export, so seeding doesn't hijack the user's own `faker` calls. User-supplied `scalars`
expressions reference `faker.…` and resolve to the module-private const unchanged. Keep
the plain `import { faker }` path when `seed` is unset — no behavior change for existing
users.

**Acceptance:** harness test asserting two calls to the same factory deep-equal, two
different factories don't collide on `id`, and `listElementCount: 3` yields three
distinct elements.

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

Not our bug, but our documented setup trips over it, so:
- **What:** reproduce minimally and file upstream. Meanwhile add a README note with the
  two workarounds — split schema types and operation types into separate files and set
  `importSchemaTypesFrom` (what the harness does), or pin the plugins to v4.
- Fold the README note into issue 2 rather than shipping it separately.

---

## Not doing

- **Auto-injecting `__typename`** to make union dispatch work — see issue 7.
- **Schema-level factories.** Out of scope by design; see README "Why?".

## Credit from the review, worth keeping

The 0.3.0 output caught four places where hand-written `as SomeQuery` casts were hiding
fields the operation doesn't select, or fields outright wrong for the payload. Whatever
issue 9 does to the type layer must not weaken that — the harness needs negative type
tests (issue 1) pinning it down before the rewrite starts.
