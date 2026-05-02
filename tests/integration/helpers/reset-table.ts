import {
  CreateTableCommand,
  DeleteTableCommand,
  type DynamoDBClient,
  ResourceNotFoundException,
} from '@aws-sdk/client-dynamodb';

// Drops and recreates a single-table-design DDB table suitable for our entities
// plus arbitrary user entities. Schema: pk (HASH) + sk (RANGE), both string.
// PAY_PER_REQUEST avoids the throughput config dance for tests.
export const resetTable = async (client: DynamoDBClient, tableName: string): Promise<void> => {
  try {
    await client.send(new DeleteTableCommand({ TableName: tableName }));
  } catch (err) {
    if (!(err instanceof ResourceNotFoundException)) throw err;
  }

  await client.send(
    new CreateTableCommand({
      TableName: tableName,
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    }),
  );
};
