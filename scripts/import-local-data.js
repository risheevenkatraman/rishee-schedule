import { existsSync } from 'node:fs';
import path from 'node:path';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { createLocalStorage } from '../storage/local.js';
import { createCloudStorage } from '../storage/aws.js';

if (!process.argv.includes('--confirm'))
  throw new Error(
    'This uploads local tasks, finances, and documents to AWS. Read docs/amplify-setup.md, then pass --confirm.',
  );
const config = {
  region: process.env.APP_REGION || 'us-east-2',
  table: process.env.APP_TABLE_NAME,
  bucket: process.env.APP_BUCKET_NAME,
};
if (!config.table || !config.bucket)
  throw new Error(
    'Set APP_TABLE_NAME and APP_BUCKET_NAME from your CloudFormation outputs.',
  );
const directory = path.resolve(process.env.DATA_DIR || 'data');
if (!existsSync(path.join(directory, 'schedule.sqlite')))
  throw new Error('The local database does not exist.');
const local = createLocalStorage(directory);
const cloud = createCloudStorage(config);
const s3 = new S3Client({ region: config.region });
for (const type of ['tasks', 'finances']) {
  let imported = 0;
  for (const record of await local.list(type)) {
    if (await cloud.get(type, record.id)) continue;
    await cloud.create(type, record);
    imported++;
  }
  console.log(
    `Imported ${imported} ${type} records; existing IDs were skipped.`,
  );
}
let documents = 0;
for (const metadata of await local.list('files')) {
  if (await cloud.get('files', metadata.id)) continue;
  const file = await local.get('files', metadata.id);
  // An interrupted prior import may have left an expired pending upload.
  if (await cloud.get('uploads', file.id))
    await cloud.delete('uploads', file.id);
  await cloud.prepareUpload(file.taskId, file.id, file.name, file.size);
  await s3.send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: `uploads/${file.taskId}/${file.id}`,
      Body: Buffer.from(file.bytes),
      ContentType: 'application/octet-stream',
    }),
  );
  await cloud.completeUpload(file.taskId, file.id);
  documents++;
}
console.log(
  `Imported ${documents} documents. Local data was not deleted. Passwords and sessions were not imported.`,
);
