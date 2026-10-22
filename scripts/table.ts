// Creates the DynamoDB table with the same keys and index as template.yaml.
// Used by the local dev server and the tests (against dynalite).
import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';

export async function createTable(endpoint: string, tableName: string): Promise<void> {
  const client = new DynamoDBClient({ endpoint, region: 'local', credentials: { accessKeyId: 'local', secretAccessKey: 'local' } });
  await client.send(new CreateTableCommand({
    TableName: tableName,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [
      { AttributeName: 'pk', AttributeType: 'S' },
      { AttributeName: 'sk', AttributeType: 'S' },
      { AttributeName: 'date', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'pk', KeyType: 'HASH' },
      { AttributeName: 'sk', KeyType: 'RANGE' },
    ],
    LocalSecondaryIndexes: [{
      IndexName: 'byDate',
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'date', KeyType: 'RANGE' },
      ],
      Projection: { ProjectionType: 'ALL' },
    }],
  }));
  client.destroy();
}
