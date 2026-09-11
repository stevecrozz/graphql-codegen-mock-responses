import {
    GraphQLSchema,
    OperationDefinitionNode,
    Kind,
    SelectionSetNode,
    GraphQLObjectType,
    GraphQLOutputType,
    GraphQLNamedType,
    isScalarType,
    isEnumType,
    getNamedType,
    FieldNode,
    isListType,
    isNonNullType,
    isObjectType,
    isInterfaceType,
    isUnionType,
    FragmentDefinitionNode,
    SelectionNode,
} from 'graphql';
import { Types } from '@graphql-codegen/plugin-helpers';
import { pascalCase } from 'change-case-all';
import { sentenceCase } from 'sentence-case';
const article = (word: string): string => /^[aeiou]/i.test(word) ? 'an' : 'a';
import { RUNTIME_HELPERS } from './runtime.js';
import { LeafGenerator } from './leafGenerator.js';

export type ConditionalFieldsMode = 'omit' | 'include';

export interface BuildOperationFactoriesArgs {
    schema: GraphQLSchema;
    documents: Types.DocumentFile[];
    listElementCount: number;
    prefix: string | undefined;
    conditionalFields: ConditionalFieldsMode;
    generateLeaf: LeafGenerator;
}

export interface BuildOperationFactoriesResult {
    output: string;
    operationTypeImports: string[];
}

const operationLocation = (op: OperationDefinitionNode): string => {
    const src = op.loc?.source.name ?? '<unknown source>';
    const line = op.loc?.startToken.line ?? '?';
    return `${src}:${line}`;
};

const operationTypeSuffix = (op: OperationDefinitionNode): string => {
    switch (op.operation) {
        case 'query':
            return 'Query';
        case 'mutation':
            return 'Mutation';
        case 'subscription':
            return 'Subscription';
        default:
            throw new Error(`Unknown operation type: ${op.operation}`);
    }
};

const operationTypeName = (op: OperationDefinitionNode): string =>
    `${pascalCase(op.name!.value)}${operationTypeSuffix(op)}`;

const factoryName = (op: OperationDefinitionNode, prefix: string | undefined): string => {
    const tn = operationTypeName(op);
    const art = prefix !== undefined ? prefix : article(sentenceCase(tn).split(' ')[0]);
    return `${art}${tn}Response`;
};

const collectOperations = (documents: Types.DocumentFile[]): OperationDefinitionNode[] => {
    const seen = new Map<string, OperationDefinitionNode>();
    const ops: OperationDefinitionNode[] = [];
    for (const file of documents) {
        for (const def of file.document!.definitions) {
            if (def.kind !== Kind.OPERATION_DEFINITION) continue;
            if (!def.name) continue;
            const name = def.name.value;
            const prior = seen.get(name);
            if (prior) {
                throw new Error(
                    `Plugin "graphql-codegen-mock-responses" found two operations named "${name}":\n` +
                        `  - ${operationLocation(prior)}\n` +
                        `  - ${operationLocation(def)}\n` +
                        `Each named operation must have a unique name.`,
                );
            }
            seen.set(name, def);
            ops.push(def);
        }
    }
    return ops;
};

const collectFragments = (documents: Types.DocumentFile[]): Map<string, FragmentDefinitionNode> => {
    const map = new Map<string, FragmentDefinitionNode>();
    for (const file of documents) {
        for (const def of file.document!.definitions) {
            if (def.kind === Kind.FRAGMENT_DEFINITION) {
                map.set(def.name.value, def);
            }
        }
    }
    return map;
};

interface WalkContext {
    schema: GraphQLSchema;
    listElementCount: number;
    conditionalFields: ConditionalFieldsMode;
    closures: string[];
    closureIdSeq: { n: number };
    generateLeaf: LeafGenerator;
    fragments: Map<string, FragmentDefinitionNode>;
}

const unwrap = (t: GraphQLOutputType): GraphQLNamedType => getNamedType(t) as GraphQLNamedType;

const pickBranch = (
    schema: GraphQLSchema,
    parentType: GraphQLNamedType,
    selectionSet: SelectionSetNode,
): GraphQLObjectType | null => {
    if (isObjectType(parentType)) return parentType;

    const candidateNames = new Set<string>();
    for (const sel of selectionSet.selections) {
        if (sel.kind === Kind.INLINE_FRAGMENT && sel.typeCondition) {
            candidateNames.add(sel.typeCondition.name.value);
        }
    }

    if (candidateNames.size === 0) {
        if (isUnionType(parentType)) {
            const types = parentType
                .getTypes()
                .slice()
                .sort((a, b) => a.name.localeCompare(b.name));
            return types[0] ?? null;
        }
        if (isInterfaceType(parentType)) {
            const types = schema
                .getImplementations(parentType)
                .objects.slice()
                .sort((a, b) => a.name.localeCompare(b.name));
            return types[0] ?? null;
        }
        return null;
    }

    const sorted = Array.from(candidateNames).sort((a, b) => a.localeCompare(b));
    const chosen = schema.getType(sorted[0]);
    if (isObjectType(chosen)) return chosen;
    if (isInterfaceType(chosen)) {
        const types = schema
            .getImplementations(chosen)
            .objects.slice()
            .sort((a, b) => a.name.localeCompare(b.name));
        return types[0] ?? null;
    }
    if (isUnionType(chosen)) {
        const types = chosen
            .getTypes()
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name));
        return types[0] ?? null;
    }
    return null;
};

const nextClosureName = (ctx: WalkContext, hint: string): string => {
    const id = ++ctx.closureIdSeq.n;
    return `make${pascalCase(hint)}_${id}`;
};

const selectsTypename = (
    selectionSet: SelectionSetNode,
    fragments: Map<string, FragmentDefinitionNode>,
    seen: Set<string> = new Set(),
): boolean => {
    for (const sel of selectionSet.selections) {
        if (sel.kind === Kind.FIELD && sel.name.value === '__typename') return true;
        if (sel.kind === Kind.INLINE_FRAGMENT && selectsTypename(sel.selectionSet, fragments, seen)) return true;
        if (sel.kind === Kind.FRAGMENT_SPREAD) {
            if (seen.has(sel.name.value)) continue;
            const frag = fragments.get(sel.name.value);
            if (!frag) continue;
            seen.add(sel.name.value);
            if (selectsTypename(frag.selectionSet, fragments, seen)) return true;
        }
    }
    return false;
};

const collectInlineFragmentTypeNames = (
    schema: GraphQLSchema,
    selectionSet: SelectionSetNode,
    fragments: Map<string, FragmentDefinitionNode>,
    names: Set<string>,
    seen: Set<string>,
): void => {
    for (const sel of selectionSet.selections) {
        if (sel.kind === Kind.INLINE_FRAGMENT && sel.typeCondition) {
            const t = schema.getType(sel.typeCondition.name.value);
            if (isObjectType(t)) {
                names.add(t.name);
            } else if (isInterfaceType(t)) {
                for (const impl of schema.getImplementations(t).objects) names.add(impl.name);
            } else if (isUnionType(t)) {
                for (const member of t.getTypes()) names.add(member.name);
            }
        } else if (sel.kind === Kind.FRAGMENT_SPREAD) {
            if (seen.has(sel.name.value)) continue;
            const frag = fragments.get(sel.name.value);
            if (!frag) continue;
            seen.add(sel.name.value);
            collectInlineFragmentTypeNames(schema, frag.selectionSet, fragments, names, seen);
        }
    }
};

const selectedBranches = (
    schema: GraphQLSchema,
    parentType: GraphQLNamedType,
    selectionSet: SelectionSetNode,
    fragments: Map<string, FragmentDefinitionNode>,
): GraphQLObjectType[] => {
    const names = new Set<string>();
    collectInlineFragmentTypeNames(schema, selectionSet, fragments, names, new Set());
    return Array.from(names)
        .sort((a, b) => a.localeCompare(b))
        .map((n) => schema.getType(n))
        .filter(isObjectType) as GraphQLObjectType[];
};

const emitCallbackDispatch = (
    selectionSet: SelectionSetNode,
    parentType: GraphQLNamedType,
    ctx: WalkContext,
    overrideAccess: string,
): string => {
    const branches = selectedBranches(ctx.schema, parentType, selectionSet, ctx.fragments);
    const branchEntries: string[] = [];
    for (const branch of branches) {
        const literal = walkSelectionSet(selectionSet, branch, ctx, '_o');
        const closureName = nextClosureName(ctx, branch.name);
        ctx.closures.push(`
    const ${closureName} = (_o?: any): any => {
        const _defaults = ${literal};
        return mergeOverrides(_defaults, _o);
    };`);
        branchEntries.push(`'${branch.name}': ${closureName}`);
    }
    return `pickByCallback({ ${branchEntries.join(', ')} }, '${branches[0].name}', ${overrideAccess})`;
};

const walkField = (
    field: FieldNode,
    parentType: GraphQLObjectType,
    ctx: WalkContext,
    overrideAccess: string,
): string => {
    const fieldName = field.name.value;
    const aliasOrName = field.alias?.value ?? fieldName;
    if (fieldName === '__typename') {
        return `${aliasOrName}: '${parentType.name}' as const`;
    }
    const fieldDef = parentType.getFields()[fieldName];
    if (!fieldDef) return `${aliasOrName}: null`;

    const childOverride = `${overrideAccess}?.${aliasOrName}`;

    let t = fieldDef.type;
    if (isNonNullType(t)) t = t.ofType;
    const fieldIsList = isListType(t);

    if (fieldIsList) {
        let inner: GraphQLOutputType = isListType(t) ? t.ofType : t;
        if (isNonNullType(inner)) inner = inner.ofType;
        const innerNamed = getNamedType(inner);
        const makeName = nextClosureName(ctx, aliasOrName);

        const isAbstract = isInterfaceType(innerNamed) || isUnionType(innerNamed);
        if (isAbstract && field.selectionSet && selectsTypename(field.selectionSet, ctx.fragments)) {
            const branches = selectedBranches(ctx.schema, innerNamed!, field.selectionSet, ctx.fragments);
            if (branches.length >= 1) {
                const branchEntries: string[] = [];
                for (const branch of branches) {
                    const literal = walkSelectionSet(field.selectionSet, branch, ctx, '_o');
                    const closureName = nextClosureName(ctx, branch.name);
                    ctx.closures.push(`
    const ${closureName} = (_o?: any): any => {
        const _defaults = ${literal};
        return mergeOverrides(_defaults, _o);
    };`);
                    branchEntries.push(`'${branch.name}': ${closureName}`);
                }
                return `${aliasOrName}: applyBranchedArrayOverride({ ${branchEntries.join(', ')} }, '${
                    branches[0].name
                }', ${childOverride}, ${ctx.listElementCount})`;
            }
        }

        let elemBody: string;
        if (isScalarType(innerNamed) || isEnumType(innerNamed)) {
            elemBody = ctx.generateLeaf(parentType.name, field.name.value, inner);
        } else if (isObjectType(innerNamed) && field.selectionSet) {
            elemBody = walkSelectionSet(field.selectionSet, innerNamed, ctx, '_o');
        } else if (isAbstract && field.selectionSet) {
            elemBody = walkSelectionSet(field.selectionSet, innerNamed!, ctx, '_o');
        } else {
            elemBody = 'null';
        }

        ctx.closures.push(`
    const ${makeName} = (_o?: any): any => {
        const _defaults = ${elemBody};
        return mergeOverrides(_defaults, _o);
    };`);

        return `${aliasOrName}: applyArrayOverride(${makeName}, ${childOverride}, ${ctx.listElementCount})`;
    }

    const named = unwrap(fieldDef.type);
    if (isScalarType(named) || isEnumType(named)) {
        return `${aliasOrName}: ${ctx.generateLeaf(parentType.name, fieldName, fieldDef.type)}`;
    }
    if (isObjectType(named) && field.selectionSet) {
        return `${aliasOrName}: ${walkSelectionSet(field.selectionSet, named, ctx, childOverride)}`;
    }
    if ((isInterfaceType(named) || isUnionType(named)) && field.selectionSet) {
        if (selectsTypename(field.selectionSet, ctx.fragments)) {
            const branches = selectedBranches(ctx.schema, named, field.selectionSet, ctx.fragments);
            if (branches.length >= 1) {
                return `${aliasOrName}: ${emitCallbackDispatch(field.selectionSet, named, ctx, childOverride)}`;
            }
        }
        return `${aliasOrName}: ${walkSelectionSet(field.selectionSet, named, ctx, `(${childOverride} as any)`)}`;
    }
    return `${aliasOrName}: null`;
};

const mergeFieldNodes = (a: FieldNode, b: FieldNode): FieldNode => {
    if (!a.selectionSet) return b;
    if (!b.selectionSet) return a;
    return {
        ...a,
        selectionSet: {
            kind: Kind.SELECTION_SET,
            selections: [...a.selectionSet.selections, ...b.selectionSet.selections],
        },
    };
};

/**
 * True when a `@skip`/`@include` on this node leaves the field's presence up to runtime
 * variables. A statically resolved directive — `@skip(if: false)`, `@include(if: true)` —
 * means the field is always sent, so it is not conditional.
 */
const hasConditionalDirective = (sel: SelectionNode): boolean =>
    (sel.directives ?? []).some((directive) => {
        const name = directive.name.value;
        if (name !== 'skip' && name !== 'include') return false;
        const arg = directive.arguments?.find((a) => a.name.value === 'if');
        if (arg?.value.kind === Kind.BOOLEAN) {
            return name === 'skip' ? arg.value.value : !arg.value.value;
        }
        return true;
    });

interface CollectedField {
    node: FieldNode;
    /** Every occurrence of this response key was gated on a `@skip`/`@include`. */
    conditional: boolean;
}

const collectFields = (
    selectionSet: SelectionSetNode,
    concrete: GraphQLObjectType,
    ctx: WalkContext,
    seenFragments: Set<string>,
    merged: Map<string, CollectedField>,
    inheritedConditional = false,
): void => {
    for (const sel of selectionSet.selections) {
        // A field selected twice is conditional only if every occurrence is gated, so the
        // flag has to be tracked here: mergeFieldNodes keeps the first node's directives
        // and drops the second's.
        const conditional = inheritedConditional || hasConditionalDirective(sel);
        if (sel.kind === Kind.FIELD) {
            const key = sel.alias?.value ?? sel.name.value;
            const existing = merged.get(key);
            merged.set(key, {
                node: existing ? mergeFieldNodes(existing.node, sel) : sel,
                conditional: existing ? existing.conditional && conditional : conditional,
            });
        } else if (sel.kind === Kind.INLINE_FRAGMENT) {
            const cond = sel.typeCondition?.name.value;
            if (cond && !typeConditionMatches(ctx.schema, concrete, cond)) continue;
            collectFields(sel.selectionSet, concrete, ctx, seenFragments, merged, conditional);
        } else if (sel.kind === Kind.FRAGMENT_SPREAD) {
            // Keyed on the flag as well as the name, so a fragment spread both gated and
            // ungated in the same selection set contributes its ungated occurrence too.
            // Still terminates on cycles: the flag only ever goes false -> true.
            const fragKey = `${sel.name.value}:${conditional}`;
            if (seenFragments.has(fragKey)) continue;
            const frag = ctx.fragments.get(sel.name.value);
            if (!frag) continue;
            const fragCond = frag.typeCondition.name.value;
            if (!typeConditionMatches(ctx.schema, concrete, fragCond)) continue;
            seenFragments.add(fragKey);
            collectFields(frag.selectionSet, concrete, ctx, seenFragments, merged, conditional);
        }
    }
};

const walkSelectionSet = (
    selectionSet: SelectionSetNode,
    parentType: GraphQLNamedType,
    ctx: WalkContext,
    overrideAccess: string,
): string => {
    let concrete: GraphQLObjectType;
    if (isObjectType(parentType)) {
        concrete = parentType;
    } else {
        const picked = pickBranch(ctx.schema, parentType, selectionSet);
        if (!picked) return '{}';
        concrete = picked;
    }

    const merged = new Map<string, CollectedField>();
    collectFields(selectionSet, concrete, ctx, new Set(), merged);

    const entries: string[] = [];
    for (const [key, field] of merged) {
        const entry = walkField(field.node, concrete, ctx, overrideAccess);
        if (field.conditional && ctx.conditionalFields === 'omit') {
            // The server sends this field only when the variable says so, so leave it out
            // unless the caller asked for it. Guarding rather than dropping the entry keeps
            // an override from producing a partial object where the type promises a whole
            // one, and skips the faker work when the field is absent.
            entries.push(`...(_hasOverride(${overrideAccess}, '${key}') ? { ${entry} } : {})`);
        } else {
            entries.push(entry);
        }
    }
    return `{\n            ${entries.join(',\n            ')},\n        }`;
};

const typeConditionMatches = (schema: GraphQLSchema, concrete: GraphQLObjectType, conditionName: string): boolean => {
    if (concrete.name === conditionName) return true;
    const conditionType = schema.getType(conditionName);
    if (!conditionType) return false;
    if (isInterfaceType(conditionType)) {
        return concrete.getInterfaces().some((i) => i.name === conditionType.name);
    }
    if (isUnionType(conditionType)) {
        return conditionType.getTypes().some((t) => t.name === concrete.name);
    }
    return false;
};

const buildFactory = (
    op: OperationDefinitionNode,
    schema: GraphQLSchema,
    listElementCount: number,
    prefix: string | undefined,
    conditionalFields: ConditionalFieldsMode,
    generateLeaf: LeafGenerator,
    fragments: Map<string, FragmentDefinitionNode>,
): string => {
    const opType = schema.getRootType(op.operation);
    if (!opType) return '';
    const typeName = operationTypeName(op);
    const fnName = factoryName(op, prefix);
    const ctx: WalkContext = {
        schema,
        listElementCount,
        conditionalFields,
        closures: [],
        closureIdSeq: { n: 0 },
        generateLeaf,
        fragments,
    };
    const literal = walkSelectionSet(op.selectionSet, opType, ctx, 'overrides');
    const closures = ctx.closures.join('\n');
    return `
export type ${typeName}Overrides = DeepPartial<${typeName}>;

export const ${fnName} = (
    overrides?: ${typeName}Overrides,
): ${typeName} => {${closures}
    const defaults: ${typeName} = ${literal};
    return mergeOverrides(defaults, overrides);
};
`;
};

export const buildOperationFactories = (args: BuildOperationFactoriesArgs): BuildOperationFactoriesResult => {
    const ops = collectOperations(args.documents);
    if (ops.length === 0) return { output: '', operationTypeImports: [] };

    const fragments = collectFragments(args.documents);

    const factories = ops
        .map((op) =>
            buildFactory(
                op,
                args.schema,
                args.listElementCount,
                args.prefix,
                args.conditionalFields,
                args.generateLeaf,
                fragments,
            ),
        )
        .join('\n');
    const imports = ops.map((op) => operationTypeName(op));
    return {
        output: `\n${RUNTIME_HELPERS}\n${factories}`,
        operationTypeImports: imports,
    };
};
