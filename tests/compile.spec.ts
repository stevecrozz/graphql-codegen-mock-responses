import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSchema } from 'graphql';
import { generate, assertCompiles, assertTypeErrors } from './helpers/compileHarness.js';

const schema = buildSchema(`
    type Query {
        user: User
        requiredUsers: [User!]!
        nullableUsers: [User!]
        sparseUsers: [User]!
        nullableSparseUsers: [User]
        tags: [String!]!
        search: [SearchResult!]!
        nullableSearch: [SearchResult!]
        featured: SearchResult
    }

    union SearchResult = User | Document

    type Document {
        id: ID!
        title: String!
    }

    type User {
        id: ID!
        name: String!
        age: Int
        status: Status!
        avatar: Avatar
    }

    type Avatar {
        id: ID!
        url: String!
    }

    enum Status {
        ACTIVE
        INACTIVE
    }
`);

describe('generated output compiles and runs', () => {
    it('type-checks and produces the selected fields', async () => {
        const project = await generate('smoke', {
            schema,
            documents: [`query GetUser { user { id name age status avatar { id url } } }`],
            check: `
                import { aGetUserQueryResponse } from './mocks.js';
                export const result = aGetUserQueryResponse({
                    user: { name: 'Alice', avatar: { url: 'https://example.com/a.png' } },
                });
            `,
        });
        assertCompiles(project);

        const { result } = (await project.load()) as any;
        assert.equal(result.user.name, 'Alice');
        assert.equal(result.user.avatar.url, 'https://example.com/a.png');
        assert.equal(typeof result.user.id, 'string');
        assert.equal(typeof result.user.age, 'number');
        assert.equal(result.user.status, 'ACTIVE');
        assert.deepEqual(Object.keys(result), ['user']);
        assert.deepEqual(Object.keys(result.user), ['id', 'name', 'age', 'status', 'avatar']);
    });

    it('rejects overriding a field the operation does not select', async () => {
        const project = await generate('unselected-field', {
            schema,
            documents: [`query GetUser { user { id } }`],
            check: `
                import { aGetUserQueryResponse } from './mocks.js';
                export const result = aGetUserQueryResponse({ user: { name: 'Alice' } });
            `,
        });
        assertTypeErrors(project, [/'name' does not exist in type/]);
    });

    it('rejects an override of the wrong scalar type', async () => {
        const project = await generate('wrong-scalar', {
            schema,
            documents: [`query GetUser { user { id age } }`],
            check: `
                import { aGetUserQueryResponse } from './mocks.js';
                export const result = aGetUserQueryResponse({ user: { age: 'forty' } });
            `,
        });
        assertTypeErrors(project, [/Type 'string' is not assignable to type 'number/]);
    });

    it('accepts array and callback overrides for a non-null list', async () => {
        const project = await generate('list-non-null', {
            schema,
            documents: [`query GetUsers { requiredUsers { id name } }`],
            check: `
                import { aGetUsersQueryResponse } from './mocks.js';
                export const fromArray = aGetUsersQueryResponse({
                    requiredUsers: [{ name: 'Alice' }, { name: 'Bob' }],
                });
                export const fromCallback = aGetUsersQueryResponse({
                    requiredUsers: (make) => [make({ name: 'Carol' }), make()],
                });
            `,
            config: { listElementCount: 1 },
        });
        assertCompiles(project);

        const { fromArray, fromCallback } = (await project.load()) as any;
        assert.deepEqual(fromArray.requiredUsers.map((u: any) => u.name), ['Alice', 'Bob']);
        assert.equal(fromCallback.requiredUsers.length, 2);
        assert.equal(fromCallback.requiredUsers[0].name, 'Carol');
        assert.equal(typeof fromCallback.requiredUsers[1].name, 'string');
    });

    it('accepts array, callback and null overrides for a nullable list', async () => {
        const project = await generate('list-nullable', {
            schema,
            documents: [`query GetUsers { nullableUsers { id name } }`],
            check: `
                import { aGetUsersQueryResponse } from './mocks.js';
                export const fromArray = aGetUsersQueryResponse({
                    nullableUsers: [{ name: 'Alice' }],
                });
                export const fromCallback = aGetUsersQueryResponse({
                    nullableUsers: (make) => [make({ name: 'Carol' }), make()],
                });
                export const fromNull = aGetUsersQueryResponse({ nullableUsers: null });
            `,
        });
        assertCompiles(project);

        const { fromArray, fromCallback, fromNull } = (await project.load()) as any;
        assert.deepEqual(fromArray.nullableUsers.map((u: any) => u.name), ['Alice']);
        assert.equal(fromCallback.nullableUsers.length, 2);
        assert.equal(fromCallback.nullableUsers[0].name, 'Carol');
        assert.equal(fromNull.nullableUsers, null);
    });

    // Every combination of list and element nullability: only the outer one ever reached
    // the array branch of DeepPartial before it was fixed.
    it('accepts the callback form for every list nullability shape', async () => {
        const project = await generate('list-nullability-matrix', {
            schema,
            documents: [
                `query GetUsers {
                    requiredUsers { id name }
                    nullableUsers { id name }
                    sparseUsers { id name }
                    nullableSparseUsers { id name }
                }`,
            ],
            config: { listElementCount: 1 },
            check: `
                import { aGetUsersQueryResponse } from './mocks.js';
                export const result = aGetUsersQueryResponse({
                    requiredUsers: (make) => [make({ name: 'a' })],
                    nullableUsers: (make) => [make({ name: 'b' })],
                    sparseUsers: (make) => [make({ name: 'c' })],
                    nullableSparseUsers: (make) => [make({ name: 'd' })],
                });
                export const nulled = aGetUsersQueryResponse({
                    nullableUsers: null,
                    nullableSparseUsers: null,
                });
            `,
        });
        assertCompiles(project);

        const { result, nulled } = (await project.load()) as any;
        assert.deepEqual(
            [
                result.requiredUsers[0].name,
                result.nullableUsers[0].name,
                result.sparseUsers[0].name,
                result.nullableSparseUsers[0].name,
            ],
            ['a', 'b', 'c', 'd'],
        );
        assert.equal(nulled.nullableUsers, null);
        assert.equal(nulled.nullableSparseUsers, null);
    });

    it('rejects null for a non-null list', async () => {
        const project = await generate('list-non-null-rejects-null', {
            schema,
            documents: [`query GetUsers { requiredUsers { id name } }`],
            check: `
                import { aGetUsersQueryResponse } from './mocks.js';
                export const result = aGetUsersQueryResponse({ requiredUsers: null });
            `,
        });
        assertTypeErrors(project, [/Type 'null' is not assignable/]);
    });

    it('respects listElementCount at runtime', async () => {
        const project = await generate('list-element-count', {
            schema,
            documents: [`query GetUsers { requiredUsers { id name } }`],
            config: { listElementCount: 3 },
            check: `
                import { aGetUsersQueryResponse } from './mocks.js';
                export const result = aGetUsersQueryResponse();
            `,
        });
        assertCompiles(project);

        const { result } = (await project.load()) as any;
        assert.equal(result.requiredUsers.length, 3);
        assert.equal(new Set(result.requiredUsers.map((u: any) => u.id)).size, 3);
    });

    it('dispatches union branches by GraphQL type name', async () => {
        const project = await generate('union-branches', {
            schema,
            documents: [
                `query Search {
                    search { __typename ... on User { id name } ... on Document { id title } }
                    featured { __typename ... on User { id name } ... on Document { id title } }
                }`,
            ],
            check: `
                import { aSearchQueryResponse } from './mocks.js';
                export const result = aSearchQueryResponse({
                    search: ({ User, Document }) => [User({ name: 'Alice' }), Document({ title: 'Spec' })],
                    featured: ({ Document }) => Document({ title: 'Featured' }),
                });
                export const defaulted = aSearchQueryResponse();
            `,
        });
        assertCompiles(project);

        const { result, defaulted } = (await project.load()) as any;
        assert.deepEqual(
            result.search.map((r: any) => [r.__typename, r.name ?? r.title]),
            [['User', 'Alice'], ['Document', 'Spec']],
        );
        assert.equal(result.featured.__typename, 'Document');
        assert.equal(result.featured.title, 'Featured');
        // Alphabetically first branch when no callback is given.
        assert.equal(defaulted.search[0].__typename, 'Document');
        assert.equal(defaulted.featured.__typename, 'Document');
    });

    it('dispatches union branches for a nullable list', async () => {
        const project = await generate('union-branches-nullable-list', {
            schema,
            documents: [
                `query Search {
                    nullableSearch { __typename ... on User { id name } ... on Document { id title } }
                }`,
            ],
            check: `
                import { aSearchQueryResponse } from './mocks.js';
                export const result = aSearchQueryResponse({
                    nullableSearch: ({ User, Document }) => [User({ name: 'Alice' }), Document({ title: 'Spec' })],
                });
                export const nulled = aSearchQueryResponse({ nullableSearch: null });
            `,
        });
        assertCompiles(project);

        const { result, nulled } = (await project.load()) as any;
        assert.deepEqual(
            result.nullableSearch.map((r: any) => [r.__typename, r.name ?? r.title]),
            [['User', 'Alice'], ['Document', 'Spec']],
        );
        assert.equal(nulled.nullableSearch, null);
    });

    it('rejects a field from the wrong union branch', async () => {
        const project = await generate('union-wrong-branch', {
            schema,
            documents: [
                `query Search { search { __typename ... on User { id name } ... on Document { id title } } }`,
            ],
            check: `
                import { aSearchQueryResponse } from './mocks.js';
                export const result = aSearchQueryResponse({
                    search: ({ Document }) => [Document({ name: 'Alice' })],
                });
            `,
        });
        assertTypeErrors(project, [/'name' does not exist in type/]);
    });

    it('omits fields gated on @skip / @include', async () => {
        const project = await generate('conditional-omit', {
            schema,
            documents: [
                `query GetUser($withName: Boolean!, $hideTags: Boolean!) {
                    user { id name @include(if: $withName) }
                    tags @skip(if: $hideTags)
                }`,
            ],
            check: `
                import { aGetUserQueryResponse } from './mocks.js';
                export const bare = aGetUserQueryResponse();
            `,
        });
        assertCompiles(project);

        const { bare } = (await project.load()) as any;
        assert.deepEqual(Object.keys(bare), ['user']);
        assert.deepEqual(Object.keys(bare.user), ['id']);
    });

    it('restores a gated field completely when it is overridden', async () => {
        const project = await generate('conditional-override', {
            schema,
            documents: [
                `query GetUser($flag: Boolean!) {
                    user @include(if: $flag) { id name }
                    tags @include(if: $flag)
                }`,
            ],
            check: `
                import { aGetUserQueryResponse } from './mocks.js';
                export const withUser = aGetUserQueryResponse({ user: { name: 'Alice' } });
                export const withTags = aGetUserQueryResponse({ tags: ['a'] });
            `,
        });
        assertCompiles(project);

        const { withUser, withTags } = (await project.load()) as any;
        // The whole object, not just the overridden key — the payload has to satisfy the
        // type it claims.
        assert.deepEqual(Object.keys(withUser), ['user']);
        assert.deepEqual(Object.keys(withUser.user), ['id', 'name']);
        assert.equal(withUser.user.name, 'Alice');
        assert.equal(typeof withUser.user.id, 'string');
        assert.deepEqual(Object.keys(withTags), ['tags']);
        assert.deepEqual(withTags.tags, ['a']);
    });

    it('treats a field as conditional only when every occurrence is gated', async () => {
        const project = await generate('conditional-merged', {
            schema,
            documents: [
                `query GetUser($flag: Boolean!) {
                    user {
                        id
                        name @include(if: $flag)
                        ...UserName
                        age @skip(if: $flag)
                        status @skip(if: false)
                    }
                }
                fragment UserName on User { name }`,
            ],
            check: `
                import { aGetUserQueryResponse } from './mocks.js';
                export const result = aGetUserQueryResponse();
            `,
        });
        assertCompiles(project);

        const { result } = (await project.load()) as any;
        // name: gated in one occurrence, ungated in the fragment, so always present.
        // status: @skip(if: false) resolves statically to "always sent".
        // age: gated everywhere, so omitted.
        assert.deepEqual(Object.keys(result.user), ['id', 'name', 'status']);
    });

    it('propagates @include on a fragment spread to the fields beneath it', async () => {
        const project = await generate('conditional-fragment-spread', {
            schema,
            documents: [
                `query GetUser($flag: Boolean!) {
                    user { id ...UserDetail @include(if: $flag) }
                }
                fragment UserDetail on User { name age }`,
            ],
            check: `
                import { aGetUserQueryResponse } from './mocks.js';
                export const bare = aGetUserQueryResponse();
                export const overridden = aGetUserQueryResponse({ user: { name: 'Alice' } });
            `,
        });
        assertCompiles(project);

        const { bare, overridden } = (await project.load()) as any;
        assert.deepEqual(Object.keys(bare.user), ['id']);
        assert.deepEqual(Object.keys(overridden.user), ['id', 'name']);
        assert.equal(overridden.user.name, 'Alice');
    });

    it('omits gated fields inside list elements and union branches', async () => {
        const project = await generate('conditional-nested', {
            schema,
            documents: [
                `query Search($flag: Boolean!) {
                    requiredUsers { id name @include(if: $flag) }
                    search {
                        __typename
                        ... on User { id name @include(if: $flag) }
                        ... on Document { id title }
                    }
                }`,
            ],
            config: { listElementCount: 1 },
            check: `
                import { aSearchQueryResponse } from './mocks.js';
                export const bare = aSearchQueryResponse();
                export const overridden = aSearchQueryResponse({
                    requiredUsers: [{ name: 'Alice' }],
                    search: ({ User }) => [User({ name: 'Bob' })],
                });
                export const viaCallback = aSearchQueryResponse({
                    requiredUsers: (make) => [make({ name: 'Carol' })],
                });
            `,
        });
        assertCompiles(project);

        const { bare, overridden, viaCallback } = (await project.load()) as any;
        assert.deepEqual(Object.keys(bare.requiredUsers[0]), ['id']);
        assert.deepEqual(Object.keys(bare.search[0]), ['__typename', 'id', 'title']);
        assert.deepEqual(Object.keys(overridden.requiredUsers[0]), ['id', 'name']);
        assert.deepEqual(Object.keys(overridden.search[0]), ['__typename', 'id', 'name']);
        assert.equal(overridden.search[0].name, 'Bob');
        assert.deepEqual(Object.keys(viaCallback.requiredUsers[0]), ['id', 'name']);
        assert.equal(viaCallback.requiredUsers[0].name, 'Carol');
    });

    it('compiles when every selected field is gated', async () => {
        const project = await generate('conditional-all', {
            schema,
            documents: [
                `query GetUser($flag: Boolean!) {
                    user @include(if: $flag) { id }
                    tags @include(if: $flag)
                }`,
            ],
            check: `
                import { aGetUserQueryResponse } from './mocks.js';
                export const bare = aGetUserQueryResponse();
            `,
        });
        assertCompiles(project);

        const { bare } = (await project.load()) as any;
        assert.deepEqual(Object.keys(bare), []);
    });

    it('generates gated fields unconditionally under conditionalFields: include', async () => {
        const project = await generate('conditional-include-mode', {
            schema,
            documents: [
                `query GetUser($flag: Boolean!) {
                    user { id name @include(if: $flag) }
                }`,
            ],
            config: { conditionalFields: 'include' },
            check: `
                import { aGetUserQueryResponse } from './mocks.js';
                export const result = aGetUserQueryResponse();
            `,
        });
        assertCompiles(project);

        const { result } = (await project.load()) as any;
        assert.deepEqual(Object.keys(result.user), ['id', 'name']);
        assert.equal(typeof result.user.name, 'string');
    });

    // The generated module imports the shared faker singleton, so consumers get
    // determinism by seeding it in their own test setup. That is the only seeding story
    // this plugin ships, so it must not regress into a module-private Faker instance.
    it('honors a seed set by the consumer on the shared faker instance', async () => {
        const project = await generate('consumer-seeded-faker', {
            schema,
            documents: [`query GetUser { user { id name age } }`],
            check: `
                import { faker } from '@faker-js/faker';
                import { aGetUserQueryResponse } from './mocks.js';
                export const seeded = () => {
                    faker.seed(42);
                    return aGetUserQueryResponse();
                };
            `,
        });
        assertCompiles(project);

        const { seeded } = (await project.load()) as any;
        assert.deepEqual(seeded(), seeded());
    });

    // `scalars` takes raw expressions, so literals make the whole output deterministic
    // without a seeded PRNG. This is the recipe the README recommends for snapshot tests.
    it('produces identical output when scalars are configured as literals', async () => {
        const project = await generate('deterministic-scalars', {
            schema,
            documents: [`query GetUser { user { id name age status } tags }`],
            config: {
                scalars: {
                    String: `'string'`,
                    Int: '1',
                    ID: `'id'`,
                },
            },
            check: `
                import { aGetUserQueryResponse } from './mocks.js';
                export const first = aGetUserQueryResponse();
                export const second = aGetUserQueryResponse();
            `,
        });
        assertCompiles(project);

        const { first, second } = (await project.load()) as any;
        assert.deepEqual(first, second);
        assert.deepEqual(first, {
            user: { id: 'id', name: 'string', age: 1, status: 'ACTIVE' },
            tags: ['string'],
        });
    });

    it('exports DeepPartial and a per-operation Overrides alias', async () => {
        const project = await generate('deep-partial-export', {
            schema,
            documents: [`query GetUser { user { id name } }`],
            check: `
                import {
                    aGetUserQueryResponse,
                    DeepPartial,
                    GetUserQueryOverrides,
                } from './mocks.js';
                import { GetUserQuery } from './types.js';

                const viaDeepPartial = (overrides?: DeepPartial<GetUserQuery>) =>
                    aGetUserQueryResponse(overrides);
                const viaAlias = (overrides?: GetUserQueryOverrides) =>
                    aGetUserQueryResponse(overrides);

                export const result = viaDeepPartial({ user: { name: 'Alice' } });
                export const aliased = viaAlias({ user: { name: 'Bob' } });
            `,
        });
        assertCompiles(project);

        const { result, aliased } = (await project.load()) as any;
        assert.equal(result.user.name, 'Alice');
        assert.equal(aliased.user.name, 'Bob');
    });

    it('rejects an unselected field through the Overrides alias', async () => {
        const project = await generate('overrides-alias-rejects', {
            schema,
            documents: [`query GetUser { user { id } }`],
            check: `
                import { GetUserQueryOverrides } from './mocks.js';
                export const overrides: GetUserQueryOverrides = { user: { name: 'Alice' } };
            `,
        });
        assertTypeErrors(project, [/'name' does not exist in type/]);
    });
});

/**
 * Every identifier this plugin emits that also has to exist in typesFile or
 * operationTypesFile is named by the `typescript` plugins, which run schema names through
 * `namingConvention`. `pascalCase` is a fix-point for most names, so these cases all use
 * names where it is not: consecutive capitals.
 */
describe('naming convention agrees with the typescript plugins', () => {
    const acronymSchema = buildSchema(`
        type Query {
            status: AIStatus!
            statuses: [AIStatus!]!
            label: String!
        }

        enum AIStatus {
            ACTIVE
            NOT_READY
        }
    `);

    it('converts enum type names the way the typescript plugin does', async () => {
        const project = await generate('naming-enum-acronym', {
            schema: acronymSchema,
            documents: [`query GetStatus { status statuses }`],
            check: `
                import { aGetStatusQueryResponse } from './mocks.js';
                export const result = aGetStatusQueryResponse({});
            `,
        });
        assertCompiles(project);

        assert.match(project.schemaSource, /export enum AiStatus/);
        const { result } = (await project.load()) as any;
        assert.equal(result.status, 'ACTIVE');
        assert.deepEqual(result.statuses, ['ACTIVE']);
    });

    it('follows namingConvention: keep for enum types and values', async () => {
        const project = await generate('naming-enum-keep', {
            schema: acronymSchema,
            documents: [`query GetStatus { status }`],
            config: { namingConvention: 'keep' },
            typesConfig: { namingConvention: 'keep' },
            check: `
                import { aGetStatusQueryResponse } from './mocks.js';
                export const result = aGetStatusQueryResponse({});
            `,
        });
        assertCompiles(project);

        assert.match(project.schemaSource, /export enum AIStatus/);
        assert.match(project.mocksSource, /AIStatus\.ACTIVE/);
    });

    it('applies typesPrefix and typesSuffix to enum types and values', async () => {
        const project = await generate('naming-enum-affixes', {
            schema: acronymSchema,
            documents: [`query GetStatus { status }`],
            config: { typesPrefix: 'Sdk', typesSuffix: 'T' },
            typesConfig: { typesPrefix: 'Sdk', typesSuffix: 'T' },
            check: `
                import { aSdkGetStatusQueryTResponse } from './mocks.js';
                export const result = aSdkGetStatusQueryTResponse({});
            `,
        });
        assertCompiles(project);

        // typesPrefix does not apply to enum members, only typesSuffix -- mirroring
        // buildEnumValuesBlock's useTypesPrefix: false.
        assert.match(project.schemaSource, /export enum SdkAiStatusT/);
        assert.match(project.mocksSource, /SdkAiStatusT\.ActiveT/);
    });

    it('keeps an all-underscore enum value intact', async () => {
        // pascalCase('_') is the empty string, which emitted `Underscored.` -- a syntax error,
        // not just a wrong name. typescript leaves it as `_`.
        const project = await generate('naming-enum-underscore', {
            schema: buildSchema(`
                type Query { value: Underscored! }
                enum Underscored { _ OTHER }
            `),
            documents: [`query GetValue { value }`],
            check: `
                import { aGetValueQueryResponse } from './mocks.js';
                export const result = aGetValueQueryResponse({});
            `,
        });
        assertCompiles(project);

        assert.match(project.mocksSource, /Underscored\._/);
        const { result } = (await project.load()) as any;
        assert.equal(result.value, '_');
    });

    it('converts operation type names the way typescript-operations does', async () => {
        const project = await generate('naming-operation-acronym', {
            schema: acronymSchema,
            documents: [`query GETStatus { label }`],
            check: `
                import { aGetStatusQueryResponse } from './mocks.js';
                export const result = aGetStatusQueryResponse({});
            `,
        });
        assertCompiles(project);

        assert.match(project.typesSource, /export type GetStatusQuery/);
    });

    it('follows omitOperationSuffix for operation type names', async () => {
        const project = await generate('naming-operation-omit-suffix', {
            schema: acronymSchema,
            documents: [`query GetStatus { label }`],
            config: { omitOperationSuffix: true },
            typesConfig: { omitOperationSuffix: true },
            check: `
                import { aGetStatusResponse } from './mocks.js';
                export const result = aGetStatusResponse({});
            `,
        });
        assertCompiles(project);
    });
});
