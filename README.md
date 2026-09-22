# graphql-codegen-mock-responses

A [GraphQL Code Generator](https://the-guild.dev/graphql/codegen) plugin that generates typed factory functions for your operation responses. Each factory produces data shaped exactly like what your API would return for a specific query or mutation — useful for tests, Storybook, and tools like [msw](https://mswjs.io/).

## Why?

Schema-level mock factories (like `aUser()`) produce objects matching a GraphQL type, but they have two problems:

1. **They're the wrong shape.** Your components don't consume raw schema types — they consume the response shape of a specific operation, which may select a subset of fields, use aliases, or spread fragments.

2. **They're expensive on large graphs.** Schema-level factories must populate every non-null relationship with a complete object, recursively. On a large schema this means a single `aUser()` call can construct hundreds of nested objects for edges your component never reads — consuming significant memory and slowing down test suites.

This plugin generates factories scoped to each operation's selection set. They only construct the fields actually selected by the query, fully typed against your operation types.

## Install

```sh
npm install -D graphql-codegen-mock-responses @faker-js/faker
```

`@faker-js/faker` is a runtime dependency of the generated code.

## Setup

```ts
// codegen.ts
import type { CodegenConfig } from '@graphql-codegen/cli';

const config: CodegenConfig = {
  schema: './schema.graphql',
  documents: './src/**/*.graphql',
  generates: {
    // Schema types: enums, inputs, scalars.
    './src/__generated__/schema.ts': {
      plugins: ['typescript'],
    },
    // Operation types, importing the schema types rather than re-declaring them.
    './src/__generated__/types.ts': {
      plugins: ['typescript-operations'],
      config: {
        // Relative to the project root, not to this output file.
        importSchemaTypesFrom: './src/__generated__/schema',
      },
    },
    './src/__generated__/mocks.ts': {
      plugins: ['graphql-codegen-mock-responses'],
      config: {
        typesFile: './schema',
        operationTypesFile: './types',
      },
    },
  },
};

export default config;
```

Both paths are required: `typesFile` is where the generated file imports enums from, and
`operationTypesFile` is where it imports operation types from. Both are emitted verbatim as
import specifiers, so they are relative to the generated mocks file — unlike
`importSchemaTypesFrom` above, which the operations plugin resolves from the project root and
rewrites. Easy to get backwards; if you see an import like `'../../schema'` in the generated
operation types, that's this.

**Why schema types and operation types go in separate files.** With `typescript-operations`
v6, putting both plugins in one output file declares every enum and input an operation
touches twice — once as `export enum Status`, once as `export type Status = 'ACTIVE' | …` —
and the file does not compile:

```
error TS2567: Enum declarations can only merge with namespace or other enum declarations.
```

Setting `importSchemaTypesFrom` tells the operations plugin to import those types instead of
re-emitting them, which requires them to be in a different file. Pinning both plugins to v4
also avoids it.

If your project resolves modules as ESM (`moduleResolution: node16`/`nodenext`), add
`emitLegacyCommonJSImports: false` to the operations plugin config and write the paths with
extensions — `./schema.js`, `./types.js` — so the emitted imports resolve.

## Usage

Given this operation:

```graphql
query GetUser($id: ID!) {
  user(id: $id) {
    id
    name
    email
    avatar {
      id
      url
    }
  }
}
```

The plugin generates:

```ts
import { aGetUserQueryResponse } from './__generated__/mocks';

// Use defaults — all fields populated with faker values
const data = aGetUserQueryResponse();

// Override specific fields at any depth
const data = aGetUserQueryResponse({
  user: { name: 'Alice', avatar: { url: 'https://example.com/alice.png' } },
});
```

### Override types

Each factory is accompanied by an exported type for its overrides, so helpers that wrap a
factory can be typed without reaching into its parameters:

```ts
import { aGetUserQueryResponse, GetUserQueryOverrides } from './__generated__/mocks';

const buildUser = (overrides?: GetUserQueryOverrides) =>
  aGetUserQueryResponse({ user: { name: 'Alice' }, ...overrides });
```

The alias is named after the operation type, so `prefix` does not affect it. `DeepPartial` is
exported too, if you need to build one of these yourself: `GetUserQueryOverrides` is exactly
`DeepPartial<GetUserQuery>`.

### Lists

List fields accept an array of partial overrides, or a callback for full control:

```ts
const data = aGetUsersQueryResponse({
  // Partial overrides per element
  users: [{ name: 'Alice' }, { name: 'Bob' }],
});

const data = aGetUsersQueryResponse({
  // Callback receives a factory function
  users: (make) => [make({ name: 'Alice' }), make({ name: 'Bob' }), make()],
});
```

### Unions and interfaces

When an operation selects `__typename` on a union/interface field with multiple inline fragments, the factory generates per-branch constructors exposed via a callback:

```ts
const data = aSearchQueryResponse({
  search: ({ User, Post }) => [
    User({ name: 'Alice' }),
    Post({ title: 'Hello World' }),
  ],
});
```

Without the callback, the alphabetically-first branch is used by default.

### Conditional fields (`@skip` / `@include`)

A field selected under `@skip` or `@include` is absent from the response whenever its
variable says so, so by default the factory leaves it out — the same shape the server would
send. The generated operation type marks these fields optional, so this type-checks.

```graphql
query GetUser($withEmail: Boolean!) {
  user {
    id
    email @include(if: $withEmail)
  }
}
```

```ts
aGetUserQueryResponse();
// { user: { id: '…' } }

aGetUserQueryResponse({ user: { email: 'alice@example.com' } });
// { user: { id: '…', email: 'alice@example.com' } }
```

Overriding a conditional field brings it back in full, not just the keys you supplied. A
field selected more than once counts as conditional only if *every* occurrence is gated, and
a directive that resolves statically — `@skip(if: false)`, `@include(if: true)` — is not
conditional at all. Set `conditionalFields: 'include'` to generate data for them
unconditionally instead.

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `typesFile` | `string` | **(required)** | Import path for the schema types file (the `typescript` plugin's output) — where enums are imported from |
| `operationTypesFile` | `string` | **(required)** | Import path for the operation types file (the `typescript-operations` plugin's output) |
| `listElementCount` | `number` | `1` | Number of elements generated for list fields |
| `conditionalFields` | `'omit' \| 'include'` | `'omit'` | Whether fields under `@skip`/`@include` are left out of the defaults |
| `prefix` | `string` | auto (`a`/`an`) | Prefix for factory names (e.g. `mock` → `mockGetUserQueryResponse`) |
| `scalars` | `Record<string, string>` | built-in defaults | Custom faker expressions per scalar type |

Plus the naming options below, which have to match the `typescript` plugins.

### Naming options

This plugin imports the identifiers the `typescript` and `typescript-operations` plugins
emit, and those plugins rename everything they generate according to their own config. If
you set any of these keys on them, set the same value here, or the generated module will
import names that were never exported.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `namingConvention` | `string \| fn \| { typeNames, enumValues }` | `change-case-all#pascalCase` | Must match the `typescript` plugins' `namingConvention` |
| `typesPrefix` | `string` | `''` | Prefix added to generated type names |
| `typesSuffix` | `string` | `''` | Suffix added to generated type names |
| `enumPrefix` | `boolean` | `true` | Whether `typesPrefix` applies to enum type names |
| `enumSuffix` | `boolean` | `true` | Whether `typesSuffix` applies to enum type names |
| `omitOperationSuffix` | `boolean` | `false` | Drops the `Query`/`Mutation`/`Subscription` suffix from operation type names |
| `dedupeOperationSuffix` | `boolean` | `false` | Drops that suffix only when the operation name already ends with it |
| `operationResultSuffix` | `string` | `''` | Extra suffix on the operation result type |

The defaults are the same defaults those plugins use, so the common case needs none of this.
You only need these keys if you have already set them elsewhere:

```yaml
generates:
  src/gql/schema.ts:
    plugins: [typescript]
    config:
      namingConvention: keep
  src/gql/types.ts:
    plugins: [typescript-operations]
    config:
      namingConvention: keep
      importSchemaTypesFrom: ./schema.js
  src/gql/mocks.ts:
    plugins: [graphql-codegen-mock-responses]
    config:
      typesFile: ./schema.js
      operationTypesFile: ./types.js
      namingConvention: keep # <- same value as above
```

The failure mode when they disagree is a compile error on the import rather than a wrong
value, so it is loud — but it takes out the whole generated file, not just one factory:

```
error TS2724: './schema.js' has no exported member named 'AIStatus'. Did you mean 'AiStatus'?
```

### Custom scalars

Override the generated expression for any scalar type:

```ts
config: {
  typesFile: './schema',
  operationTypesFile: './types',
  scalars: {
    DateTime: 'faker.date.past().toISOString()',
    URL: 'faker.internet.url()',
    Email: 'faker.internet.email()',
  },
}
```

The value is inlined as a raw expression, so it does not have to be a faker call — any
expression valid at that position works, including a literal.

### Built-in scalar defaults

| Scalar | Expression |
|--------|-----------|
| `String` | `faker.lorem.word()` |
| `Int` | `faker.number.int({ min: 1, max: 9999 })` |
| `Float` | `faker.number.float({ min: 0, max: 100, fractionDigits: 2 })` |
| `Boolean` | `faker.datatype.boolean()` |
| `ID` | `faker.string.uuid()` |

### Determinism

Generated values are random on purpose, and there is no `seed` option. Pin the values a test
depends on, at the call site:

```ts
const data = anAgreementQueryResponse({ agreement: { archived: false } });
```

A test that asserts on a value it never pinned is coupled to data it doesn't state, and
random defaults surface that immediately instead of at some unrelated CI run months later.
This matters most for booleans, where any fixed default is indistinguishable from a
deliberate one.

If you do want reproducible output — for snapshot tests, say — seed faker yourself. The
generated module uses the shared instance, so this is all it takes:

```ts
import { faker } from '@faker-js/faker';

beforeEach(() => faker.seed(42));
```

Seeding per test keeps determinism scoped to a boundary you control. Note that a single
`faker.seed()` in global setup does not: values depend on how many draws happened earlier in
the run, so adding or reordering a test shifts everything after it.

## How it works

The plugin walks each named operation's selection set against your schema, generating a factory function typed as `(overrides?: <Op>Overrides) => <Op>`. Nested objects are recursively constructed. The `DeepPartial` type behind `<Op>Overrides` allows overriding at any depth while keeping the return type fully concrete.

Fragment spreads, inline fragments, aliases, `__typename`, and `@skip`/`@include` are all handled. Union/interface fields with multiple inline fragment branches generate per-branch closure functions and a dispatcher.

Because the override type is derived from the operation type, overriding a field the operation does not select is a type error — which catches hand-written fixtures that drifted from their query.

## Releasing

Two commands:

```bash
npm version minor   # or patch / major
npm publish
```

Everything else is a hook or config, so there is nothing else to remember:

| Wired up by | What it does |
|---|---|
| `preversion` | Runs the test suite. A failing suite aborts the release before anything is written. |
| `npm version` | Bumps `package.json`, commits, and creates the `v`-prefixed annotated tag. Refuses to run on a dirty tree. |
| `.npmrc` `sign-git-tag=true` | Makes that tag GPG-signed. |
| `postversion` | `git push --follow-tags` — pushes the commit and the tag together. |
| `prepublishOnly` | Runs `tsc`, so the published `dist/` is always built from the tagged source. |
| `publishConfig.registry` | Pins publishing to npmjs, so a global registry override cannot redirect it. |

`npm publish` stays manual on purpose: it is the one irreversible step, and it needs an OTP.

## License

MIT
