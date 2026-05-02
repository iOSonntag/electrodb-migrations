import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

// Preconfigured for DDB Local. Assumes `docker compose up -d` is running on port 8000.
// Credentials are fake — DDB Local accepts any non-empty value.
export const rawClient = new DynamoDBClient({
  endpoint: 'http://localhost:8000',
  region: 'us-east-1',
  credentials: {
    accessKeyId: 'fake',
    secretAccessKey: 'fake',
  },
});

export const docClient = DynamoDBDocumentClient.from(rawClient);
