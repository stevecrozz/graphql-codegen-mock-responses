import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSchema, parse } from 'graphql';
import { plugin } from '../src/index.js';
import { Types } from '@graphql-codegen/plugin-helpers';

const schema = buildSchema(`
    type Query {
        user(id: ID!): User
        users: [User!]!
        search(q: String!): [SearchResult!]!
    }

    type Mutation {
        createUser(name: String!): User!
    }

    type User {
        id: ID!
        name: String!
        email: String!
        age: Int
        avatar: Avatar
        status: Status!
        friends: [User!]!
    }

    type Avatar {
        id: ID!
        url: String!
    }

    enum Status {
        ACTIVE
        INACTIVE
        PENDING
    }

    union SearchResult = User | Document

    type Document {
        id: ID!
        title: String!
    }
`);

const makeDocs = (sources: string[]): Types.DocumentFile[] =>
    sources.map((s) => ({ document: parse(s) }));

describe('graphql-codegen-mock-responses', () => {
    it('generates a factory for a simple query', () => {
        const result = plugin(
            schema,
            makeDocs([`query GetUser($id: ID!) { user(id: $id) { id name email age } }`]),
            { typesFile: './types' },
        );
        const output = String(result);
        assert.ok(output.includes("import { faker } from '@faker-js/faker'"));
        assert.ok(output.includes("import { GetUserQuery } from './types'"));
        assert.ok(output.includes('export const aGetUserQueryResponse'));
        assert.ok(output.includes('faker.string.uuid()'));
        assert.ok(output.includes('faker.lorem.word()'));
        assert.ok(output.includes('faker.number.int('));
    });

    it('walks nested objects', () => {
        const result = plugin(
            schema,
            makeDocs([`query GetUser($id: ID!) { user(id: $id) { id avatar { id url } } }`]),
            { typesFile: './types' },
        );
        const output = String(result);
        assert.ok(output.includes('avatar:'));
        assert.ok(output.includes('url:'));
    });

    it('handles __typename when selected', () => {
        const result = plugin(
            schema,
            makeDocs([`query GetUser($id: ID!) { user(id: $id) { __typename id } }`]),
            { typesFile: './types' },
        );
        const output = String(result);
        assert.ok(output.includes("__typename: 'User' as const"));
    });

    it('handles union dispatch with __typename', () => {
        const result = plugin(
            schema,
            makeDocs([
                `query Search($q: String!) { search(q: $q) { __typename ... on User { id name } ... on Document { id title } } }`,
            ]),
            { typesFile: './types' },
        );
        const output = String(result);
        assert.ok(output.includes('applyBranchedArrayOverride'));
        assert.ok(output.includes("'Document'"));
        assert.ok(output.includes("'User'"));
    });

    it('supports custom scalar generators', () => {
        const result = plugin(
            schema,
            makeDocs([`query GetUser($id: ID!) { user(id: $id) { id email } }`]),
            { typesFile: './types', scalars: { String: 'faker.internet.email()' } },
        );
        const output = String(result);
        assert.ok(output.includes('faker.internet.email()'));
    });

    it('returns empty string with no operations', () => {
        const result = plugin(schema, makeDocs([`fragment F on User { id }`]), { typesFile: './types' });
        assert.equal(String(result), '');
    });

    it('throws when typesFile is not set', () => {
        assert.throws(
            () => plugin(schema, makeDocs([`query GetUser($id: ID!) { user(id: $id) { id } }`]), {} as any),
            /typesFile/,
        );
    });

    it('generates list fields with applyArrayOverride', () => {
        const result = plugin(
            schema,
            makeDocs([`query GetUsers { users { id name } }`]),
            { typesFile: './types' },
        );
        const output = String(result);
        assert.ok(output.includes('applyArrayOverride'));
    });

    it('respects listElementCount', () => {
        const result = plugin(
            schema,
            makeDocs([`query GetUsers { users { id name } }`]),
            { typesFile: './types', listElementCount: 3 },
        );
        const output = String(result);
        assert.ok(output.includes(', 3)'));
    });

    it('handles named fragment spreads', () => {
        const result = plugin(
            schema,
            makeDocs([
                `fragment UserFields on User { id name email }`,
                `query GetUser($id: ID!) { user(id: $id) { ...UserFields avatar { id url } } }`,
            ]),
            { typesFile: './types' },
        );
        const output = String(result);
        assert.ok(output.includes('export const aGetUserQueryResponse'));
        assert.ok(output.includes('name:'));
        assert.ok(output.includes('email:'));
        assert.ok(output.includes('avatar:'));
    });

    it('handles field aliases', () => {
        const result = plugin(
            schema,
            makeDocs([`query GetUser($id: ID!) { user(id: $id) { identifier: id displayName: name } }`]),
            { typesFile: './types' },
        );
        const output = String(result);
        assert.ok(output.includes('identifier:'));
        assert.ok(output.includes('displayName:'));
        assert.ok(!output.includes(' id:'));
    });

    it('generates enum values', () => {
        const result = plugin(
            schema,
            makeDocs([`query GetUser($id: ID!) { user(id: $id) { id status } }`]),
            { typesFile: './types' },
        );
        const output = String(result);
        assert.ok(output.includes("'ACTIVE'"));
    });

    it('generates a mutation factory', () => {
        const result = plugin(
            schema,
            makeDocs([`mutation CreateUser($name: String!) { createUser(name: $name) { id name } }`]),
            { typesFile: './types' },
        );
        const output = String(result);
        assert.ok(output.includes('export const aCreateUserMutationResponse'));
        assert.ok(output.includes('CreateUserMutation'));
    });

    it('supports prefix config', () => {
        const result = plugin(
            schema,
            makeDocs([`query GetUser($id: ID!) { user(id: $id) { id } }`]),
            { typesFile: './types', prefix: 'mock' },
        );
        const output = String(result);
        assert.ok(output.includes('export const mockGetUserQueryResponse'));
    });

    it('generates multiple operations from one document', () => {
        const result = plugin(
            schema,
            makeDocs([
                `query GetUser($id: ID!) { user(id: $id) { id } }`,
                `query GetUsers { users { id } }`,
            ]),
            { typesFile: './types' },
        );
        const output = String(result);
        assert.ok(output.includes('export const aGetUserQueryResponse'));
        assert.ok(output.includes('export const aGetUsersQueryResponse'));
        assert.ok(output.includes('GetUserQuery, GetUsersQuery'));
    });

    it('throws on duplicate operation names', () => {
        assert.throws(
            () => plugin(
                schema,
                makeDocs([
                    `query GetUser($id: ID!) { user(id: $id) { id } }`,
                    `query GetUser($id: ID!) { user(id: $id) { id name } }`,
                ]),
                { typesFile: './types' },
            ),
            /two operations named "GetUser"/,
        );
    });

    it('handles nested lists', () => {
        const result = plugin(
            schema,
            makeDocs([`query GetUser($id: ID!) { user(id: $id) { id friends { id name } } }`]),
            { typesFile: './types' },
        );
        const output = String(result);
        assert.ok(output.includes('friends:'));
        assert.ok(output.includes('applyArrayOverride'));
    });
});
