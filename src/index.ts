import { PluginFunction, Types } from '@graphql-codegen/plugin-helpers';
import { GraphQLSchema } from 'graphql';
import { buildOperationFactories } from './operationFactories.js';
import { createLeafGenerator, ScalarGenerators } from './leafGenerator.js';

export interface MockResponsesPluginConfig {
    typesFile: string;
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

    const listElementCount = config.listElementCount ?? 1;
    const generateLeaf = createLeafGenerator(config.scalars);

    const { output, operationTypeImports } = buildOperationFactories({
        schema,
        documents,
        typesFile: config.typesFile,
        listElementCount,
        prefix: config.prefix,
        generateLeaf,
    });

    if (!output) return '';

    const typeImport = operationTypeImports.length > 0
        ? `import { ${operationTypeImports.join(', ')} } from '${config.typesFile}';\n`
        : '';

    const fakerImport = `import { faker } from '@faker-js/faker';\n`;

    return `${fakerImport}${typeImport}${output}`;
};
