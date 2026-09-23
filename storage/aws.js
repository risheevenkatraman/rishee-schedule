import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  CopyObjectCommand,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

export async function loadCloudPassword(config) {
  const client = new SecretsManagerClient({ region: config.region });
  const result = await client.send(
    new GetSecretValueCommand({ SecretId: config.secretArn }),
  );
  let password;
  try {
    password = JSON.parse(result.SecretString)?.password;
  } catch {
    throw new Error(
      'The cloud password secret must be a JSON object with a password field.',
    );
  }
  if (typeof password !== 'string' || password.length < 16)
    throw new Error('The cloud password must contain at least 16 characters.');
  return password;
}

export function createCloudStorage(config, clients = {}) {
  const dynamo =
    clients.dynamo ||
    DynamoDBDocumentClient.from(new DynamoDBClient({ region: config.region }));
  const s3 = clients.s3 || new S3Client({ region: config.region });
  const TableName = config.table;
  const key = (type, id) => ({ pk: type, sk: id });
  const clean = (item) => {
    if (!item) return undefined;
    const { pk, sk, ...record } = item;
    return record;
  };
  const store = {
    cloud: true,
    bucketOrigin: `https://${config.bucket}.s3.${config.region}.amazonaws.com`,
    async get(type, id) {
      return clean(
        (
          await dynamo.send(
            new GetCommand({
              TableName,
              Key: key(type, id),
              ConsistentRead: true,
            }),
          )
        ).Item,
      );
    },
    async list(type) {
      const records = [];
      let cursor;
      do {
        const page = await dynamo.send(
          new QueryCommand({
            TableName,
            KeyConditionExpression: 'pk = :pk',
            ExpressionAttributeValues: { ':pk': type },
            ConsistentRead: true,
            ExclusiveStartKey: cursor,
          }),
        );
        records.push(...page.Items.map(clean));
        cursor = page.LastEvaluatedKey;
      } while (cursor);
      return records.filter((record) => !record.deleting);
    },
    async create(type, record) {
      await dynamo.send(
        new PutCommand({
          TableName,
          Item: { ...record, ...key(type, record.id) },
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
    },
    async update(type, id, record) {
      const entries = Object.entries(record);
      await dynamo.send(
        new UpdateCommand({
          TableName,
          Key: key(type, id),
          ConditionExpression: 'attribute_exists(pk)',
          UpdateExpression: `SET ${entries.map((_, i) => `#f${i} = :v${i}`).join(', ')}`,
          ExpressionAttributeNames: Object.fromEntries(
            entries.map(([name], i) => [`#f${i}`, name]),
          ),
          ExpressionAttributeValues: Object.fromEntries(
            entries.map(([, value], i) => [`:v${i}`, value]),
          ),
        }),
      );
    },
    async delete(type, id) {
      if (type === 'tasks') {
        // A tombstone prevents an upload from attaching to a task during deletion.
        await store.update('tasks', id, { deleting: true });
        for (const file of await store.list('files'))
          if (file.taskId === id) await store.delete('files', file.id);
      }
      if (type === 'files') {
        const file = await store.get(type, id);
        if (file)
          await s3.send(
            new DeleteObjectCommand({
              Bucket: config.bucket,
              Key: file.objectKey,
            }),
          );
      }
      await dynamo.send(new DeleteCommand({ TableName, Key: key(type, id) }));
    },
    async consumeAttempt(id) {
      const expiresAt = Math.floor(Date.now() / 900000) * 900 + 1800;
      const result = await dynamo.send(
        new UpdateCommand({
          TableName,
          Key: key('attempts', id),
          UpdateExpression: 'SET expiresAt = :expiry ADD #count :one',
          ExpressionAttributeNames: { '#count': 'count' },
          ExpressionAttributeValues: { ':expiry': expiresAt, ':one': 1 },
          ReturnValues: 'ALL_NEW',
        }),
      );
      return result.Attributes.count;
    },
    async prepareUpload(taskId, id, name, size) {
      const objectKey = `uploads/${taskId}/${id}`;
      await store.create('uploads', {
        id,
        taskId,
        name,
        size,
        objectKey,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      });
      const post = await createPresignedPost(s3, {
        Bucket: config.bucket,
        Key: objectKey,
        Expires: 300,
        Fields: { 'Content-Type': 'application/octet-stream' },
        Conditions: [
          ['content-length-range', size, size],
          ['eq', '$Content-Type', 'application/octet-stream'],
        ],
      });
      return { id, ...post };
    },
    async completeUpload(taskId, id) {
      const pending = await store.get('uploads', id);
      if (
        !pending ||
        pending.taskId !== taskId ||
        pending.expiresAt <= Date.now() / 1000
      )
        throw Object.assign(
          new Error('Upload expired. Please choose the file again.'),
          { status: 400 },
        );
      const head = await s3.send(
        new HeadObjectCommand({
          Bucket: config.bucket,
          Key: pending.objectKey,
        }),
      );
      if (head.ContentLength !== pending.size)
        throw Object.assign(new Error('Upload size did not match.'), {
          status: 400,
        });
      const { expiresAt, ...file } = pending;
      file.objectKey = `documents/${taskId}/${id}`;
      await s3.send(
        new CopyObjectCommand({
          Bucket: config.bucket,
          Key: file.objectKey,
          CopySource: `${config.bucket}/${pending.objectKey}`,
          CopySourceIfMatch: head.ETag,
        }),
      );
      await dynamo.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName,
                Key: key('tasks', taskId),
                ConditionExpression:
                  'attribute_exists(pk) AND attribute_not_exists(deleting)',
              },
            },
            { Put: { TableName, Item: { ...file, ...key('files', id) } } },
            { Delete: { TableName, Key: key('uploads', id) } },
          ],
        }),
      );
    },
    async download(file) {
      return getSignedUrl(
        s3,
        new GetObjectCommand({
          Bucket: config.bucket,
          Key: file.objectKey,
          ResponseContentType: 'application/octet-stream',
          ResponseContentDisposition: `attachment; filename="document"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/'/g, '%27')}`,
        }),
        { expiresIn: 60 },
      );
    },
  };
  return store;
}
