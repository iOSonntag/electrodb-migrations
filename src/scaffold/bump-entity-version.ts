import { extname } from 'node:path';
import { Project, SyntaxKind } from 'ts-morph';
import { EDBMigrationError } from '../errors/base.js';

/**
 * Internal error class — NOT re-exported from `src/index.ts` per RESEARCH A7.
 * Thrown by {@link bumpEntityVersion} for any condition that prevents a safe
 * in-place edit of the user's entity source. SCF-04 / Pitfall #5.
 */
export class EDBEntitySourceEditError extends EDBMigrationError {
  readonly code = 'EDB_ENTITY_SOURCE_EDIT_ERROR' as const;
}

export interface BumpEntityVersionArgs {
  /** Absolute path to the user's entity source file (must end in `.ts`). */
  sourceFilePath: string;
  /** Top-level variable name of the entity (e.g. `'User'`). */
  entityName: string;
  /** The version literal value currently expected on disk (string form, e.g. `'1'`). */
  fromVersion: string;
  /** The version literal value to write (string form, e.g. `'2'`). */
  toVersion: string;
}

/**
 * Locate `<entityName>.model.version` in a TypeScript source file and replace
 * the literal with `toVersion`, preserving comments / whitespace / quote style /
 * indentation / line endings byte-for-byte outside the literal.
 *
 * Refuses (with {@link EDBEntitySourceEditError}) if:
 *   - the file is not `.ts` (`.cjs`, `.mjs`, `.js` not supported in v0.1)
 *   - `entityName` is not a top-level variable in the file
 *   - the variable's initializer is not `new Entity(...)`
 *   - the constructor's first argument is not an inline object literal
 *   - the `model` property is not an inline object literal
 *   - the `version` property is not an inline literal (e.g. bound to a constant)
 *   - the on-disk literal value does not match `fromVersion`
 *
 * **The ONLY ts-morph site in the framework.** The build-invariant test
 * `tests/unit/build/no-tsmorph-in-library.test.ts` allowlists this exact file
 * path; any other source file importing `ts-morph` will fail that test.
 *
 * Lazy-loaded by Plan 07's `scaffold/create.ts` via dynamic
 * `await import('./bump-entity-version.js')` so the ts-morph closure stays
 * out of the library bundle entirely (FND-06).
 */
export async function bumpEntityVersion(args: BumpEntityVersionArgs): Promise<void> {
  if (extname(args.sourceFilePath) !== '.ts') {
    throw new EDBEntitySourceEditError(
      `bumpEntityVersion: Phase 2 supports .ts user entity files only. Got: ${args.sourceFilePath}. Convert to TypeScript or open an issue for .js/.cjs/.mjs support.`,
      { sourceFilePath: args.sourceFilePath },
    );
  }

  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
  });
  const sourceFile = project.addSourceFileAtPath(args.sourceFilePath);

  // 1. Top-level variable named `entityName`.
  const variableDeclaration = sourceFile.getVariableDeclaration(args.entityName);
  if (!variableDeclaration) {
    throw new EDBEntitySourceEditError(`bumpEntityVersion: '${args.entityName}' not found as a top-level variable in ${args.sourceFilePath}. Migration NOT bumped.`, {
      sourceFilePath: args.sourceFilePath,
      entityName: args.entityName,
    });
  }

  // 2. Initializer must be `new Entity(...)`.
  const initializer = variableDeclaration.getInitializer();
  if (!initializer || !initializer.isKind(SyntaxKind.NewExpression)) {
    throw new EDBEntitySourceEditError(`bumpEntityVersion: '${args.entityName}' initializer is not a 'new Entity(...)' expression in ${args.sourceFilePath}.`, {
      sourceFilePath: args.sourceFilePath,
      entityName: args.entityName,
    });
  }
  const newExpr = initializer.asKindOrThrow(SyntaxKind.NewExpression);

  // 3. First argument must be an inline object literal.
  const arg0 = newExpr.getArguments()[0];
  if (!arg0 || !arg0.isKind(SyntaxKind.ObjectLiteralExpression)) {
    throw new EDBEntitySourceEditError(`bumpEntityVersion: '${args.entityName}' constructor has no inline object-literal argument in ${args.sourceFilePath}.`, {
      sourceFilePath: args.sourceFilePath,
      entityName: args.entityName,
    });
  }
  const configObj = arg0.asKindOrThrow(SyntaxKind.ObjectLiteralExpression);

  // 4. `model` property must be an inline object literal.
  const modelProp = configObj.getProperty('model');
  if (!modelProp || !modelProp.isKind(SyntaxKind.PropertyAssignment)) {
    throw new EDBEntitySourceEditError(`bumpEntityVersion: '${args.entityName}' has no inline 'model' property assignment in ${args.sourceFilePath}. Inline the model literal and re-run.`, {
      sourceFilePath: args.sourceFilePath,
      entityName: args.entityName,
    });
  }
  const modelInit = modelProp.asKindOrThrow(SyntaxKind.PropertyAssignment).getInitializer();
  if (!modelInit || !modelInit.isKind(SyntaxKind.ObjectLiteralExpression)) {
    throw new EDBEntitySourceEditError(`bumpEntityVersion: '${args.entityName}'.model is not an inline object literal in ${args.sourceFilePath}.`, {
      sourceFilePath: args.sourceFilePath,
      entityName: args.entityName,
    });
  }
  const modelObj = modelInit.asKindOrThrow(SyntaxKind.ObjectLiteralExpression);

  // 5. `version` property must be an inline literal (or AsExpression of one).
  const versionProp = modelObj.getProperty('version');
  if (!versionProp || !versionProp.isKind(SyntaxKind.PropertyAssignment)) {
    throw new EDBEntitySourceEditError(`bumpEntityVersion: '${args.entityName}'.model.version is missing or not an inline assignment in ${args.sourceFilePath}.`, {
      sourceFilePath: args.sourceFilePath,
      entityName: args.entityName,
    });
  }
  const versionInit = versionProp.asKindOrThrow(SyntaxKind.PropertyAssignment).getInitializer();
  if (!versionInit) {
    throw new EDBEntitySourceEditError(`bumpEntityVersion: '${args.entityName}'.model.version has no initializer in ${args.sourceFilePath}.`, {
      sourceFilePath: args.sourceFilePath,
      entityName: args.entityName,
    });
  }

  // 6. Drill into AsExpression (`'1' as const`) to reach the inner literal.
  let literalNode = versionInit;
  if (literalNode.isKind(SyntaxKind.AsExpression)) {
    literalNode = literalNode.asKindOrThrow(SyntaxKind.AsExpression).getExpression();
  }

  // 7. Determine literal kind, parse the current value, and compute the new literal text.
  const literalKind = literalNode.getKind();
  let currentValue: string;
  let newLiteralText: string;

  if (literalKind === SyntaxKind.StringLiteral) {
    // Preserve quote style by inspecting the original raw text.
    const originalText = literalNode.getText();
    const isDoubleQuoted = originalText.startsWith('"');
    currentValue = originalText.slice(1, -1); // strip quotes
    newLiteralText = isDoubleQuoted ? `"${args.toVersion}"` : `'${args.toVersion}'`;
  } else if (literalKind === SyntaxKind.NoSubstitutionTemplateLiteral) {
    const originalText = literalNode.getText();
    currentValue = originalText.slice(1, -1); // strip backticks
    newLiteralText = `\`${args.toVersion}\``;
  } else if (literalKind === SyntaxKind.NumericLiteral) {
    currentValue = literalNode.getText();
    newLiteralText = args.toVersion; // emit numeric without quotes
  } else if (literalKind === SyntaxKind.Identifier) {
    throw new EDBEntitySourceEditError(
      `bumpEntityVersion: '${args.entityName}'.model.version is bound to a constant identifier '${literalNode.getText()}' rather than an inline literal. Inline the version literal in ${args.sourceFilePath} and re-run.`,
      {
        sourceFilePath: args.sourceFilePath,
        entityName: args.entityName,
        found: literalNode.getText(),
      },
    );
  } else {
    throw new EDBEntitySourceEditError(`bumpEntityVersion: '${args.entityName}'.model.version literal kind ${SyntaxKind[literalKind]} is not supported. Use a string, numeric, or template literal.`, {
      sourceFilePath: args.sourceFilePath,
      entityName: args.entityName,
    });
  }

  // 8. Refuse if the on-disk value does not match the caller's expectation.
  if (currentValue !== args.fromVersion) {
    throw new EDBEntitySourceEditError(
      `bumpEntityVersion: '${args.entityName}'.model.version is '${currentValue}', expected '${args.fromVersion}'. Snapshot/source disagree — run \`baseline\` or resolve manually.`,
      {
        sourceFilePath: args.sourceFilePath,
        entityName: args.entityName,
        found: currentValue,
        expected: args.fromVersion,
      },
    );
  }

  // 9. Surgical replacement of the inner literal node only — preserves all
  // surrounding bytes (per RESEARCH §Pattern 3 + Pitfall 3: do NOT set
  // manipulationSettings; replaceWithText on the leaf node is the most
  // surgical edit).
  literalNode.replaceWithText(newLiteralText);

  await sourceFile.save();
}
