import { PluginFunction, Types } from '@graphql-codegen/plugin-helpers';
import { GraphQLSchema } from 'graphql';
import { buildOperationFactories, ConditionalFieldsMode } from './operationFactories.js';
import { createLeafGenerator, ScalarGenerators } from './leafGenerator.js';
import { NamingConfig, createNaming } from './naming.js';

/**
 * The naming keys have to match whatever `typescript` / `typescript-operations` were given,
 * since this plugin imports the identifiers those plugins emit. They default to the same
 * defaults, so the common case needs no config; see naming.ts and ISSUES.md #11.
 */
export interface MockResponsesPluginConfig extends NamingConfig {
    typesFile: string;
    operationTypesFile: string;
    listElementCount?: number;
    prefix?: string;
    /**
     * How to treat fields selected under `@skip`/`@include`. `'omit'` (the default) leaves
     * them out of the defaults, matching a server that was told not to send them; `'include'`
     * generates data for them unconditionally.
     */
    conditionalFields?: ConditionalFieldsMode;
    scalars?: ScalarGenerators;
}

export const plugin: PluginFunction<MockResponsesPluginConfig> = (
    schema: GraphQLSchema,
    documents: Types.DocumentFile[],
    config: MockResponsesPluginConfig,
) => {
    if (!config.typesFile) {
        throw new Error('graphql-codegen-mock-responses requires "typesFile" to be set.');
    }
    if (!config.operationTypesFile) {
        throw new Error('graphql-codegen-mock-responses requires "operationTypesFile" to be set.');
    }

    const listElementCount = config.listElementCount ?? 1;
    const conditionalFields = config.conditionalFields ?? 'omit';
    if (conditionalFields !== 'omit' && conditionalFields !== 'include') {
        throw new Error(
            `graphql-codegen-mock-responses: "conditionalFields" must be "omit" or "include", got "${conditionalFields}".`,
        );
    }
    const naming = createNaming(config);
    const enumTypes = new Set<string>();
    const generateLeaf = createLeafGenerator(config.scalars, enumTypes, naming);

    const { output, operationTypeImports } = buildOperationFactories({
        schema,
        documents,
        listElementCount,
        prefix: config.prefix,
        conditionalFields,
        generateLeaf,
        naming,
    });

    const enumTypeImports = Array.from(enumTypes).sort();

    if (!output) return '';

    const fakerImport = `import { faker } from '@faker-js/faker';\n`;

    const operationImport = operationTypeImports.length > 0
        ? `import { ${operationTypeImports.join(', ')} } from '${config.operationTypesFile}';\n`
        : '';

    const enumImport = enumTypeImports.length > 0
        ? `import { ${enumTypeImports.join(', ')} } from '${config.typesFile}';\n`
        : '';

    return `${fakerImport}${operationImport}${enumImport}${output}`;
};
