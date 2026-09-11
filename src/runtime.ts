export const RUNTIME_HELPERS = `
type _BranchKeys<T> = T extends { __typename: infer K extends string } ? K : never;
type _HasMultipleBranches<T, K = _BranchKeys<T>> =
    [K] extends [never] ? false :
    K extends K
        ? [Exclude<_BranchKeys<T>, K>] extends [never] ? false : true
        : false;
type Branches<T> = {
    [P in _BranchKeys<T>]: (o?: DeepPartial<Extract<T, { __typename: P }>>) => Extract<T, { __typename: P }>;
};

type _PerBranchPartial<T> = T extends object ? { [K in keyof T]?: _Field<T[K]> } : T;

type _Field<T> = [T] extends [never]
    ? T
    : 0 extends (1 & T) ? T
    : _HasMultipleBranches<NonNullable<T>> extends true
        ? _PerBranchPartial<NonNullable<T>> | ((b: Branches<NonNullable<T>>) => NonNullable<T>)
        : DeepPartial<T>;

export type DeepPartial<T> = [T] extends [never]
    ? T
    : 0 extends (1 & T) ? T
    : [NonNullable<T>] extends [Array<infer U>]
        ? Extract<T, null | undefined> | (_HasMultipleBranches<NonNullable<U>> extends true
            ? Array<U> | ((b: Branches<NonNullable<U>>) => U[])
            : Array<DeepPartial<U>> | ((make: (o?: DeepPartial<U>) => U) => U[]))
        : T extends object ? { [K in keyof T]?: _Field<T[K]> } : T;

type _NoInfer<T> = [T][T extends any ? 0 : never];

function mergeOverrides<T>(defaults: T, overrides: _NoInfer<DeepPartial<T>> | undefined): T {
    if (overrides === undefined) return defaults;
    if (overrides === null) return overrides as unknown as T;
    if (typeof overrides === 'function') return defaults;
    if (Array.isArray(defaults) && Array.isArray(overrides)) {
        return defaults;
    }
    if (Array.isArray(defaults) || Array.isArray(overrides)) {
        return overrides as unknown as T;
    }
    if (typeof defaults !== 'object' || defaults === null) {
        return overrides as unknown as T;
    }
    if (typeof overrides !== 'object') {
        return overrides as unknown as T;
    }
    const out: any = { ...defaults };
    for (const key of Object.keys(overrides)) {
        const ov = (overrides as any)[key];
        if (ov === undefined) continue;
        out[key] = mergeOverrides((defaults as any)[key], ov);
    }
    return out;
}

function _hasOverride(overrides: unknown, key: string): boolean {
    if (typeof overrides !== 'object' || overrides === null) return false;
    return (overrides as Record<string, unknown>)[key] !== undefined;
}

function applyArrayOverride<T, O>(
    makeDefault: (o?: DeepPartial<T>) => T,
    override: O,
    count: number,
): T[] {
    if (override === null || override === undefined) {
        const arr: T[] = [];
        for (let i = 0; i < count; i++) arr.push(makeDefault());
        return arr;
    }
    if (typeof override === 'function') {
        return (override as (m: (o?: DeepPartial<T>) => T) => T[])(makeDefault);
    }
    return (override as any[]).map((el) => makeDefault(el));
}

function pickByCallback<T>(
    branches: Record<string, (o?: any) => T>,
    defaultBranch: string,
    override: T | ((b: Record<string, (o?: any) => T>) => T) | undefined | null,
): T {
    if (typeof override === 'function') {
        return (override as (b: Record<string, (o?: any) => T>) => T)(branches);
    }
    return branches[defaultBranch](override ?? undefined);
}

function applyBranchedArrayOverride<T, O>(
    branches: Record<string, (o?: any) => T>,
    defaultBranch: string,
    override: O,
    count: number,
): T[] {
    if (override === null || override === undefined) {
        const arr: T[] = [];
        for (let i = 0; i < count; i++) arr.push(branches[defaultBranch]());
        return arr;
    }
    if (typeof override === 'function') {
        return (override as (b: Record<string, (o?: any) => T>) => T[])(branches);
    }
    return override as T[];
}
`;
