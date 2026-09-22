import { EnumValueDefinitionNode, Kind, OperationDefinitionNode } from 'graphql';
import { NamingConvention, convertFactory } from '@graphql-codegen/visitor-plugin-common';
import { pascalCase } from 'change-case-all';

/**
 * Every identifier this plugin emits that also has to exist in `typesFile` or
 * `operationTypesFile` is named by the `typescript` / `typescript-operations` plugins, not by
 * us. Those plugins run schema names through `convertName`, so we have to run them through the
 * same function with the same config or we emit imports for names that were never exported --
 * `AIStatus` where `typescript` wrote `AiStatus` (ISSUES.md #11).
 *
 * Defaults here mirror those plugins' defaults rather than being required, so the common case
 * stays correct without the user restating config they already gave the `typescript` plugin.
 */
export interface NamingConfig {
    /**
     * Must match the `typescript` plugins' `namingConvention`. Defaults, like theirs, to
     * `change-case-all#pascalCase`.
     */
    namingConvention?: NamingConvention;
    typesPrefix?: string;
    typesSuffix?: string;
    /** Whether `typesPrefix`/`typesSuffix` apply to enum type names. Defaults to true. */
    enumPrefix?: boolean;
    enumSuffix?: boolean;
    /** Drops the `Query`/`Mutation`/`Subscription` suffix from operation type names. */
    omitOperationSuffix?: boolean;
    /** Drops the suffix only when the operation name already ends with it. */
    dedupeOperationSuffix?: boolean;
    /** Extra suffix `typescript-operations` appends to the result type. */
    operationResultSuffix?: string;
}

export interface Naming {
    /** The name `typesFile` exports for a schema enum. */
    enumType(schemaName: string): string;
    /** The name `typesFile` gives one of that enum's members. */
    enumValue(schemaName: string): string;
    /** The name `operationTypesFile` exports for an operation's result type. */
    operationType(op: OperationDefinitionNode): string;
}

/** Mirrors `convertName` in visitor-plugin-common/cjs/naming.js. */
const applyAffixes = (
    converted: string,
    { typesPrefix, typesSuffix }: { typesPrefix: string; typesSuffix: string },
    { useTypesPrefix = true, useTypesSuffix = true }: { useTypesPrefix?: boolean; useTypesSuffix?: boolean },
): string => `${useTypesPrefix ? typesPrefix : ''}${converted}${useTypesSuffix ? typesSuffix : ''}`;

const operationRootName = (op: OperationDefinitionNode): string => pascalCase(op.operation);

/**
 * Mirrors `getOperationSuffix` in visitor-plugin-common/cjs/base-visitor.js: the suffix is
 * dropped entirely under `omitOperationSuffix`, or when `dedupeOperationSuffix` is set and the
 * operation name already ends with it.
 */
const operationSuffix = (op: OperationDefinitionNode, config: NamingConfig): string => {
    const operationType = operationRootName(op);
    if (config.omitOperationSuffix) return '';
    const name = op.name?.value ?? '';
    if (config.dedupeOperationSuffix && name.toLowerCase().endsWith(operationType.toLowerCase())) return '';
    return operationType;
};

export const createNaming = (config: NamingConfig = {}): Naming => {
    const convert = convertFactory({ namingConvention: config.namingConvention });
    const affixes = {
        typesPrefix: config.typesPrefix ?? '',
        typesSuffix: config.typesSuffix ?? '',
    };
    const enumPrefix = config.enumPrefix ?? true;
    const enumSuffix = config.enumSuffix ?? true;

    return {
        enumType: (schemaName) =>
            applyAffixes(convert(schemaName), affixes, {
                useTypesPrefix: enumPrefix,
                useTypesSuffix: enumSuffix,
            }),

        // Enum members are converted as EnumValueDefinition nodes, which is what selects the
        // `enumValues` half of an object-form namingConvention. Underscores are only collapsed
        // when the name is not all underscores, or the result is not a valid identifier.
        enumValue: (schemaName) => {
            const onlyUnderscores = /^_+$/.test(schemaName);
            const node: EnumValueDefinitionNode = {
                kind: Kind.ENUM_VALUE_DEFINITION,
                name: { kind: Kind.NAME, value: schemaName },
            };
            const converted = convert(node, { transformUnderscore: !onlyUnderscores });
            return applyAffixes(converted, affixes, { useTypesPrefix: false, useTypesSuffix: enumSuffix });
        },

        // typescript-operations concatenates the suffix *before* converting, so `GETUser` +
        // `Query` converts as one string and yields `GetUserQuery`, not `GETUserQuery`.
        operationType: (op) => {
            const suffix = operationSuffix(op, config) + (config.operationResultSuffix ?? '');
            return applyAffixes(convert(op.name!.value + suffix), affixes, {});
        },
    };
};
