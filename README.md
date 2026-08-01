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

```yaml
# codegen.ts
import type { CodegenConfig } from '@graphql-codegen/cli';

const config: CodegenConfig = {
  schema: './schema.graphql',
  documents: './src/**/*.graphql',
  generates: {
    './src/__generated__/types.ts': {
      plugins: ['typescript', 'typescript-operations'],
    },
    './src/__generated__/mocks.ts': {
      plugins: ['graphql-codegen-mock-responses'],
      config: {
        typesFile: './types',
      },
    },
  },
};

export default config;
```

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

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `typesFile` | `string` | **(required)** | Import path for the generated operation types |
| `listElementCount` | `number` | `1` | Number of elements generated for list fields |
| `prefix` | `string` | auto (`a`/`an`) | Prefix for factory names (e.g. `mock` → `mockGetUserQueryResponse`) |
| `scalars` | `Record<string, string>` | built-in defaults | Custom faker expressions per scalar type |

### Custom scalars

Override the generated expression for any scalar type:

```yaml
config:
  typesFile: ./types
  scalars:
    DateTime: "faker.date.past().toISOString()"
    URL: "faker.internet.url()"
    Email: "faker.internet.email()"
```

### Built-in scalar defaults

| Scalar | Expression |
|--------|-----------|
| `String` | `faker.lorem.word()` |
| `Int` | `faker.number.int({ min: 1, max: 9999 })` |
| `Float` | `faker.number.float({ min: 0, max: 100, fractionDigits: 2 })` |
| `Boolean` | `faker.datatype.boolean()` |
| `ID` | `faker.string.uuid()` |

## How it works

The plugin walks each named operation's selection set against your schema, generating a factory function typed as `(overrides?: DeepPartial<OperationType>) => OperationType`. Nested objects are recursively constructed. The `DeepPartial` type allows overriding at any depth while keeping the return type fully concrete.

Fragment spreads, inline fragments, aliases, and `__typename` are all handled. Union/interface fields with multiple inline fragment branches generate per-branch closure functions and a dispatcher.

## License

MIT
