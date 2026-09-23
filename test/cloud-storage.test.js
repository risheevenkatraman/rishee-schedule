import { test } from 'node:test';
import assert from 'node:assert/strict';
import { S3Client } from '@aws-sdk/client-s3';
import { createCloudStorage } from '../storage/aws.js';

const config = {
  region: 'us-east-2',
  table: 'test-table',
  bucket: 'test-bucket',
};
function fakeDynamo() {
  const records = new Map();
  const calls = [];
  const id = (key) => `${key.pk}/${key.sk}`;
  return {
    records,
    calls,
    async send(command) {
      calls.push(command);
      const input = command.input;
      switch (command.constructor.name) {
        case 'GetCommand':
          return { Item: records.get(id(input.Key)) };
        case 'PutCommand':
          records.set(id(input.Item), structuredClone(input.Item));
          return {};
        case 'DeleteCommand':
          records.delete(id(input.Key));
          return {};
        case 'QueryCommand':
          return {
            Items: [...records.values()].filter(
              (record) => record.pk === input.ExpressionAttributeValues[':pk'],
            ),
          };
        case 'UpdateCommand': {
          const record = records.get(id(input.Key));
          if (input.ConditionExpression && !record)
            throw new Error('ConditionalCheckFailedException');
          if (input.UpdateExpression.includes('ADD #count')) {
            const next = {
              ...input.Key,
              expiresAt: input.ExpressionAttributeValues[':expiry'],
              count: (record?.count || 0) + 1,
            };
            records.set(id(input.Key), next);
            return { Attributes: next };
          }
          for (const [placeholder, field] of Object.entries(
            input.ExpressionAttributeNames,
          ))
            record[field] =
              input.ExpressionAttributeValues[placeholder.replace('#f', ':v')];
          return {};
        }
        case 'TransactWriteCommand': {
          const check = input.TransactItems[0].ConditionCheck;
          const task = records.get(id(check.Key));
          if (!task || task.deleting)
            throw new Error('TransactionCanceledException');
          const file = input.TransactItems[1].Put.Item;
          records.set(id(file), structuredClone(file));
          records.delete(id(input.TransactItems[2].Delete.Key));
          return {};
        }
        default:
          throw new Error(`Unexpected command ${command.constructor.name}`);
      }
    },
  };
}
function fakeS3(size = 10) {
  const client = new S3Client({
    region: config.region,
    credentials: {
      accessKeyId: 'TESTONLY',
      secretAccessKey: 'test-only-secret',
    },
  });
  const calls = [];
  client.send = async (command) => {
    calls.push(command);
    if (command.constructor.name === 'HeadObjectCommand')
      return { ContentLength: size, ETag: 'test-etag' };
    return {};
  };
  return { client, calls };
}

test('cloud records and sessions are shared across instances; status updates preserve fields', async () => {
  const dynamo = fakeDynamo();
  const { client: s3 } = fakeS3();
  const first = createCloudStorage(config, { dynamo, s3 });
  const second = createCloudStorage(config, { dynamo, s3 });
  await first.create('finances', {
    id: 'one',
    purpose: 'Venue',
    amountCents: 12550,
    category: 'Marriage/Future',
    status: 'Unpaid',
  });
  await second.update('finances', 'one', { status: 'Paid' });
  const finance = await first.get('finances', 'one');
  assert.equal(finance.status, 'Paid');
  assert.equal(finance.amountCents, 12550);
  assert.equal(finance.pk, undefined);
  await first.create('sessions', {
    id: 'session',
    expiry: Date.now() + 10000,
    passwordVersion: 'version',
  });
  assert.equal(
    (await second.get('sessions', 'session')).passwordVersion,
    'version',
  );
  await second.delete('sessions', 'session');
  assert.equal(await first.get('sessions', 'session'), undefined);
  assert.equal(await first.consumeAttempt('window'), 1);
  assert.equal(await second.consumeAttempt('window'), 2);
  await assert.rejects(
    first.update('finances', 'missing', { status: 'Paid' }),
    /ConditionalCheck/,
  );
});

test('cloud list paginates and excludes tasks being deleted', async () => {
  let pages = 0;
  const dynamo = {
    async send(command) {
      assert.equal(command.input.ConsistentRead, true);
      pages++;
      return pages === 1
        ? {
            Items: [{ pk: 'tasks', sk: 'a', id: 'a' }],
            LastEvaluatedKey: { pk: 'tasks', sk: 'a' },
          }
        : {
            Items: [
              { pk: 'tasks', sk: 'b', id: 'b' },
              { pk: 'tasks', sk: 'c', id: 'c', deleting: true },
            ],
          };
    },
  };
  const store = createCloudStorage(config, { dynamo, s3: fakeS3().client });
  assert.deepEqual(await store.list('tasks'), [{ id: 'a' }, { id: 'b' }]);
  assert.equal(pages, 2);
});

test('direct uploads constrain size and key, validate completion, and gate task deletion', async () => {
  const dynamo = fakeDynamo();
  const { client: s3, calls } = fakeS3();
  const store = createCloudStorage(config, { dynamo, s3 });
  await store.create('tasks', { id: 'task' });
  const upload = await store.prepareUpload('task', 'file', 'notes.txt', 10);
  const policy = JSON.parse(
    Buffer.from(upload.fields.Policy, 'base64').toString(),
  );
  assert.ok(
    policy.conditions.some(
      (condition) =>
        Array.isArray(condition) &&
        condition[0] === 'content-length-range' &&
        condition[1] === 10 &&
        condition[2] === 10,
    ),
  );
  assert.equal(upload.fields.key, 'uploads/task/file');
  await assert.rejects(store.completeUpload('other-task', 'file'), /expired/);
  await store.completeUpload('task', 'file');
  const file = await store.get('files', 'file');
  assert.equal(file.objectKey, 'documents/task/file');
  assert.equal(
    calls.find((command) => command.constructor.name === 'CopyObjectCommand')
      .input.CopySourceIfMatch,
    'test-etag',
  );
  assert.equal(await store.get('uploads', 'file'), undefined);
  const url = new URL(await store.download(file));
  assert.equal(url.searchParams.get('X-Amz-Expires'), '60');
  await store.delete('tasks', 'task');
  assert.equal(await store.get('tasks', 'task'), undefined);
  assert.equal(await store.get('files', 'file'), undefined);
  assert.ok(
    calls.some((command) => command.constructor.name === 'DeleteObjectCommand'),
  );
  await store.create('tasks', { id: 'task2', deleting: true });
  await store.prepareUpload('task2', 'pending', 'pending.txt', 10);
  await assert.rejects(
    store.completeUpload('task2', 'pending'),
    /TransactionCanceled/,
  );
  assert.equal(await store.get('files', 'pending'), undefined);
  await store.prepareUpload('task2', 'bad-size', 'bad.txt', 11);
  await assert.rejects(
    store.completeUpload('task2', 'bad-size'),
    /size did not match/,
  );
});
