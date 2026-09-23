import { randomBytes, scryptSync, createHash } from 'node:crypto';

// Resolve cloud authentication during a request, not while starting the server.
// Share concurrent loads, but do not cache failures: a later request can retry.
export function createPasswordLoader(loadPassword, onFailure = () => {}) {
  let pending;
  return function getPassword() {
    if (!pending) {
      pending = Promise.resolve()
        .then(loadPassword)
        .then((password) => {
          const salt = randomBytes(16);
          return {
            salt,
            passwordHash: scryptSync(password, salt, 64),
            passwordVersion: createHash('sha256')
              .update(password)
              .digest('hex'),
          };
        })
        .catch((error) => {
          pending = undefined;
          onFailure(error);
          throw Object.assign(
            new Error(
              'The workspace is temporarily unavailable. Please try again shortly.',
            ),
            { status: 503 },
          );
        });
    }
    return pending;
  };
}
