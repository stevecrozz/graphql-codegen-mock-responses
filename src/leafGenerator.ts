import {
    GraphQLOutputType,
    isNonNullType,
    isListType,
    isEnumType,
    getNamedType,
} from 'graphql';
import { Naming, createNaming } from './naming.js';

export interface ScalarGenerators {
    [scalarName: string]: string;
}

const BUILT_IN_SCALARS: Record<string, string> = {
    String: `faker.lorem.word()`,
    Int: `faker.number.int({ min: 1, max: 9999 })`,
    Float: `faker.number.float({ min: 0, max: 100, fractionDigits: 2 })`,
    Boolean: `faker.datatype.boolean()`,
    ID: `faker.string.uuid()`,
};

export type LeafGenerator = (typeName: string, fieldName: string, gqlType: GraphQLOutputType) => string;

export const createLeafGenerator = (
    customScalars?: ScalarGenerators,
    enumTypes?: Set<string>,
    naming: Naming = createNaming(),
): LeafGenerator => {
    // The name recorded here is the one imported from typesFile, so it has to be the converted
    // name rather than the schema name -- see naming.ts.
    const enumMember = (schemaTypeName: string, schemaValueName: string): string => {
        const typeName = naming.enumType(schemaTypeName);
        enumTypes?.add(typeName);
        return `${typeName}.${naming.enumValue(schemaValueName)}`;
    };

    return (_typeName, _fieldName, gqlType) => {
        let t = gqlType;
        if (isNonNullType(t)) t = t.ofType;

        if (isListType(t)) {
            let inner = t.ofType;
            if (isNonNullType(inner)) inner = inner.ofType;
            const named = getNamedType(inner);
            if (!named) return 'null';
            if (isEnumType(named)) {
                const firstValue = named.getValues()[0];
                if (!firstValue) return 'null';
                return enumMember(named.name, firstValue.name);
            }
            const scalar = customScalars?.[named.name] ?? BUILT_IN_SCALARS[named.name];
            return scalar ?? `'${named.name}-scalar'`;
        }

        const named = getNamedType(t);
        if (!named) return 'null';

        if (isEnumType(named)) {
            const firstValue = named.getValues()[0];
            if (!firstValue) return 'null';
            return enumMember(named.name, firstValue.name);
        }

        const scalar = customScalars?.[named.name] ?? BUILT_IN_SCALARS[named.name];
        return scalar ?? `'${named.name}-scalar'`;
    };
};
