import { hostname } from 'node:os';

// Default appliedBy: hostname:pid. Used when the caller doesn't supply one.
// CI/CD environments where hostname is meaningless should pass an explicit
// appliedBy (e.g. CI_JOB_ID) into createMigrationsClient.
export const defaultAppliedBy = (): string => `${hostname()}:${process.pid}`;
