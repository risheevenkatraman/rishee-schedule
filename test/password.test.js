import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scryptSync, timingSafeEqual } from 'node:crypto';
import { createPasswordLoader } from '../storage/password.js';

test('password loading is lazy, shared, and retries after credentials recover', async () => {
  let calls = 0;
  const failures = [];
  const getPassword = createPasswordLoader(
    async () => {
      calls++;
      if (calls === 1)
        throw Object.assign(new Error('private provider details'), {
          name: 'CredentialsProviderError',
        });
      return 'test-password-after-recovery';
    },
    (error) => failures.push(error.name),
  );
  assert.equal(calls, 0);
  const first = getPassword();
  assert.equal(first, getPassword());
  await assert.rejects(
    first,
    (error) =>
      error.status === 503 &&
      !error.message.includes('private provider details'),
  );
  const [auth, same] = await Promise.all([getPassword(), getPassword()]);
  assert.equal(calls, 2);
  assert.equal(auth, same);
  assert.deepEqual(failures, ['CredentialsProviderError']);
  assert.ok(
    timingSafeEqual(
      auth.passwordHash,
      scryptSync('test-password-after-recovery', auth.salt, 64),
    ),
  );
});
