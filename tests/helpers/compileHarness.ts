import { GraphQLSchema, parse } from 'graphql';
import { Types } from '@graphql-codegen/plugin-helpers';
import * as typescriptPlugin from '@graphql-codegen/typescript';
import * as typescriptOperationsPlugin from '@graphql-codegen/typescript-operations';
import ts from 'typescript';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { plugin as mockResponsesPlugin, MockResponsesPluginConfig } from '../../src/index.js';

// Projects live under tests/.tmp so that Node and tsc resolve @faker-js/faker and the
// package's own "type": "module" from the repo root.
const TMP_ROOT = path.join(import.meta.dirname, '..', '.tmp');

export interface GenerateOptions {
    schema: GraphQLSchema;
    /** Operation and fragment sources. */
    documents: string[];
    /** Plugin config; typesFile and operationTypesFile are supplied. */
    config?: Omit<MockResponsesPluginConfig, 'typesFile' | 'operationTypesFile'>;
    /**
     * Config forwarded to `typescript` and `typescript-operations`. Naming keys
     * (`namingConvention`, `typesPrefix`, `typesSuffix`, ...) have to be given here *and* in
     * `config` to mirror a real codegen.yml, since the generated module has to agree with
     * the identifiers those plugins emit.
     */
    typesConfig?: Record<string, unknown>;
    /**
     * Consumer source type-checked against the generated factories, and executed by
     * load(). Import from './mocks.js' and export whatever the test asserts on.
     */
    check?: string;
}

export interface GeneratedProject {
    dir: string;
    schemaSource: string;
    typesSource: string;
    mocksSource: string;
    /** Type errors, one formatted string per diagnostic, "file(line,col): message". */
    typecheck(): string[];
    /** Executes check.ts and returns its module namespace. */
    load(): Promise<Record<string, unknown>>;
}

const COMPILER_OPTIONS: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    lib: ['lib.es2022.d.ts'],
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    types: [],
};

const toDocumentFiles = (documents: string[]): Types.DocumentFile[] =>
    documents.map((source, i) => ({ document: parse(source), location: `document-${i}.graphql` }));

const pluginOutputToString = (output: Types.PluginOutput | string): string => {
    if (typeof output === 'string') return output;
    return [...(output.prepend ?? []), output.content, ...(output.append ?? [])].join('\n');
};

/**
 * Schema types (schema.ts) and operation types (types.ts) go in separate files, with the
 * operations plugin pointed at the first via importSchemaTypesFrom. Emitting both plugins
 * into one file — the layout our README recommends — currently produces a duplicate
 * declaration for every enum and input an operation touches.
 */
const generateSchemaTypes = async (
    schema: GraphQLSchema,
    documents: Types.DocumentFile[],
    typesConfig: Record<string, unknown>,
): Promise<string> =>
    pluginOutputToString(await typescriptPlugin.plugin(schema, documents, { ...typesConfig }, { outputFile: 'schema.ts' }));

const generateOperationTypes = async (
    schema: GraphQLSchema,
    documents: Types.DocumentFile[],
    typesConfig: Record<string, unknown>,
): Promise<string> =>
    pluginOutputToString(
        await typescriptOperationsPlugin.plugin(
            schema,
            documents,
            { ...typesConfig, importSchemaTypesFrom: './schema.js', emitLegacyCommonJSImports: false },
            { outputFile: 'types.ts' },
        ),
    );

/**
 * Writes a types.ts / mocks.ts / check.ts trio to tests/.tmp/<name> and returns handles
 * for type-checking and executing it. Files are left in place after the run so failures
 * can be inspected; `name` must be unique across spec files, since it is the directory.
 */
export const generate = async (name: string, options: GenerateOptions): Promise<GeneratedProject> => {
    const documents = toDocumentFiles(options.documents);
    const typesConfig = options.typesConfig ?? {};
    const schemaSource = await generateSchemaTypes(options.schema, documents, typesConfig);
    const typesSource = await generateOperationTypes(options.schema, documents, typesConfig);
    const mocksSource = String(
        mockResponsesPlugin(options.schema, documents, {
            ...options.config,
            typesFile: './schema.js',
            operationTypesFile: './types.js',
        }),
    );
    const checkSource = options.check ?? '';

    const dir = path.join(TMP_ROOT, name);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'schema.ts'), schemaSource);
    fs.writeFileSync(path.join(dir, 'types.ts'), typesSource);
    fs.writeFileSync(path.join(dir, 'mocks.ts'), mocksSource);
    fs.writeFileSync(path.join(dir, 'check.ts'), checkSource);

    const rootNames = [path.join(dir, 'mocks.ts'), path.join(dir, 'check.ts')];

    return {
        dir,
        schemaSource,
        typesSource,
        mocksSource,
        typecheck: () => {
            const program = ts.createProgram(rootNames, COMPILER_OPTIONS);
            return ts
                .getPreEmitDiagnostics(program)
                .map((diagnostic) => {
                    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
                    if (!diagnostic.file || diagnostic.start === undefined) {
                        return `TS${diagnostic.code}: ${message}`;
                    }
                    const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
                    const file = path.basename(diagnostic.file.fileName);
                    return `${file}(${line + 1},${character + 1}): TS${diagnostic.code}: ${message}`;
                });
        },
        load: () => import(path.join(dir, 'check.ts')),
    };
};

// The generated sources stay on disk after the run, so point at them rather than
// inlining a few hundred lines into every assertion message.
const withSources = (project: GeneratedProject, message: string): string =>
    `${message}\n\nGenerated sources: ${path.relative(process.cwd(), project.dir)}/{schema,types,mocks,check}.ts`;

/** Asserts the generated module and the check source type-check cleanly. */
export const assertCompiles = (project: GeneratedProject): void => {
    const diagnostics = project.typecheck();
    assert.deepEqual(
        diagnostics,
        [],
        withSources(project, `Expected no type errors, got:\n${diagnostics.join('\n')}`),
    );
};

/**
 * Asserts the check source produces exactly one type error per pattern, and that the
 * generated module itself is clean. Use for the casts the plugin is meant to reject.
 */
export const assertTypeErrors = (project: GeneratedProject, patterns: RegExp[]): void => {
    const diagnostics = project.typecheck();
    const generatedErrors = diagnostics.filter((d) => !d.startsWith('check.ts'));
    assert.deepEqual(
        generatedErrors,
        [],
        withSources(project, `Expected errors only in check.ts, but generated code failed:\n${generatedErrors.join('\n')}`),
    );
    for (const pattern of patterns) {
        assert.ok(
            diagnostics.some((d) => pattern.test(d)),
            withSources(project, `Expected a type error matching ${pattern}, got:\n${diagnostics.join('\n') || '(none)'}`),
        );
    }
    assert.equal(
        diagnostics.length,
        patterns.length,
        withSources(project, `Expected ${patterns.length} type error(s), got:\n${diagnostics.join('\n')}`),
    );
};

