import type { Entity, EntityItem } from 'electrodb';

export type MigrationDefinition<
  // biome-ignore lint/suspicious/noExplicitAny: ElectroDB's Entity has 4 required type params; no narrower bound exists for a "any entity" constraint
  TFrom extends Entity<any, any, any, any>,
  // biome-ignore lint/suspicious/noExplicitAny: same as above
  TTo extends Entity<any, any, any, any>,
> = {
  readonly id: string;
  readonly entityName: string;
  readonly from: TFrom;
  readonly to: TTo;
  readonly up: (item: EntityItem<TFrom>) => Promise<EntityItem<TTo>>;
  readonly down?: (item: EntityItem<TTo>) => Promise<EntityItem<TFrom>>;
};

// Identity function — the types carry all the weight.
// At runtime, defineMigration is a no-op that returns the definition as-is,
// giving the TypeScript compiler the generic context it needs to type up/down.
export const defineMigration = <
  // biome-ignore lint/suspicious/noExplicitAny: same Entity constraint as MigrationDefinition above
  TFrom extends Entity<any, any, any, any>,
  // biome-ignore lint/suspicious/noExplicitAny: same as above
  TTo extends Entity<any, any, any, any>,
>(
  definition: MigrationDefinition<TFrom, TTo>,
): MigrationDefinition<TFrom, TTo> => definition;
