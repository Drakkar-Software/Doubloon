// ProductRegistry lives in @doubloon/core so it can be shared with @doubloon/server
// without circular dependencies.
export { createProductRegistry } from '@doubloon/core';
export type { ProductRegistry, ProductRegistryEntry } from '@doubloon/core';
