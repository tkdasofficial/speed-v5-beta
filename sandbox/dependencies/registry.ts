/** Package registry contract (metadata lookup). Implemented in a later phase. */
export interface PackageMetadata { name: string; latest: string; versions: readonly string[] }
export interface PackageRegistry { lookup(name: string): Promise<PackageMetadata | null> }
export const isValidPackageName = (n: string): boolean => /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(n);
