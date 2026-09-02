import { PluginFunction, Types } from '@graphql-codegen/plugin-helpers';
import { GraphQLSchema } from 'graphql';
import { buildOperationFactories } from './operationFactories.js';
import { createLeafGenerator, ScalarGenerators } from './leafGenerator.js';

export interface MockResponsesPluginConfig {
    typesFile: string;
    operationTypesFile: string;
    listElementCount?: number;
    prefix?: string;
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
    const enumTypes = new Set<string>();
    const generateLeaf = createLeafGenerator(config.scalars, enumTypes);

    const { output, operationTypeImports } = buildOperationFactories({
        schema,
        documents,
        listElementCount,
        prefix: config.prefix,
        generateLeaf,
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
