export interface ZoningRolloutCounty {
  stateCode: 'NC' | 'SC';
  county: string;
  priority: 1 | 2;
}

const NC_PRIORITY = [
  'Mecklenburg', 'Gaston', 'Cabarrus', 'Union', 'Wake', 'Guilford',
  'Forsyth', 'Cumberland', 'Davidson', 'Wayne', 'New Hanover', 'Pender',
] as const;

const SC_PRIORITY = [
  'York', 'Lancaster', 'Richland', 'Lexington', 'Greenville',
  'Spartanburg', 'Charleston', 'Berkeley', 'Dorchester', 'Horry',
] as const;

const ALL_SC_COUNTIES = [
  'Abbeville', 'Aiken', 'Allendale', 'Anderson', 'Bamberg', 'Barnwell',
  'Beaufort', 'Berkeley', 'Calhoun', 'Charleston', 'Cherokee', 'Chester',
  'Chesterfield', 'Clarendon', 'Colleton', 'Darlington', 'Dillon', 'Dorchester',
  'Edgefield', 'Fairfield', 'Florence', 'Georgetown', 'Greenville', 'Greenwood',
  'Hampton', 'Horry', 'Jasper', 'Kershaw', 'Lancaster', 'Laurens', 'Lee',
  'Lexington', 'Marion', 'Marlboro', 'McCormick', 'Newberry', 'Oconee',
  'Orangeburg', 'Pickens', 'Richland', 'Saluda', 'Spartanburg', 'Sumter',
  'Union', 'Williamsburg', 'York',
] as const;

const scPrioritySet = new Set<string>(SC_PRIORITY);

/** Discovery/onboarding order. This is not a source table: every active source
 * still has to pass official-publisher, current-layer, and point-query proof. */
export const ZONING_ROLLOUT_COUNTIES: readonly ZoningRolloutCounty[] = Object.freeze([
  ...NC_PRIORITY.map((county) => ({ stateCode: 'NC' as const, county, priority: 1 as const })),
  ...ALL_SC_COUNTIES.map((county) => ({
    stateCode: 'SC' as const,
    county,
    priority: scPrioritySet.has(county) ? 1 as const : 2 as const,
  })),
]);
