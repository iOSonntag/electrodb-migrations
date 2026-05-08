/**
 * Read/write classifier for `blockMode: 'writes-only'` (GRD-05).
 *
 * The classifier matches against `context.commandName` from the AWS SDK
 * middleware second argument (stable across SDK v3 minor versions per
 * RESEARCH.md A4). Both raw `@aws-sdk/client-dynamodb` *Command classes and
 * the `@aws-sdk/lib-dynamodb` DocumentClient wrappers must be covered.
 */
import { describe, expect, it } from 'vitest';
import { isReadCommand } from '../../../src/guard/classify.js';

describe('isReadCommand (GRD-05)', () => {
  it.each([
    // @aws-sdk/client-dynamodb (raw)
    ['GetItemCommand', true],
    ['QueryCommand', true],
    ['ScanCommand', true],
    ['BatchGetItemCommand', true],
    ['TransactGetItemsCommand', true],
    // @aws-sdk/lib-dynamodb (DocumentClient)
    ['GetCommand', true],
    ['BatchGetCommand', true],
    ['TransactGetCommand', true],
    // Writes (raw)
    ['PutItemCommand', false],
    ['UpdateItemCommand', false],
    ['DeleteItemCommand', false],
    ['BatchWriteItemCommand', false],
    ['TransactWriteItemsCommand', false],
    // Writes (DocumentClient)
    ['PutCommand', false],
    ['UpdateCommand', false],
    ['DeleteCommand', false],
    ['BatchWriteCommand', false],
    ['TransactWriteCommand', false],
  ] as const)('classifies %s as read=%s', (name, expected) => {
    expect(isReadCommand(name)).toBe(expected);
  });

  it('returns false for undefined', () => {
    expect(isReadCommand(undefined)).toBe(false);
  });

  it('returns false for an unknown command name', () => {
    expect(isReadCommand('NotARealCommand')).toBe(false);
  });
});
