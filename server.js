import http from 'node:http';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createLocalStorage } from './storage/local.js';
import { createCloudStorage, loadCloudPassword } from './storage/aws.js';
import { createPasswordLoader } from './storage/password.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const cloudConfig = process.env.APP_CLOUD_CONFIG
  ? JSON.parse(process.env.APP_CLOUD_CONFIG)
  : null;
const store = cloudConfig
  ? createCloudStorage(cloudConfig)
  : createLocalStorage(process.env.DATA_DIR || path.join(root, 'data'));
let password = process.env.APP_PASSWORD;
if (!cloudConfig && !password) {
  const passwordFile = path.join(root, 'docs', 'password.txt');
  mkdirSync(path.dirname(passwordFile), { recursive: true });
  if (!existsSync(passwordFile))
    writeFileSync(passwordFile, randomBytes(18).toString('base64url'), {
      mode: 0o600,
    });
  password = readFileSync(passwordFile, 'utf8').trim();
  console.log(`Your app password is saved in ${passwordFile}`);
}
const getPassword = createPasswordLoader(
  () => (cloudConfig ? loadCloudPassword(cloudConfig) : password),
  (error) => {
    // Presence flags only; never log credentials, tokens, endpoint values, or secret content.
    console.error(
      JSON.stringify({
        event: 'workspace-auth-load-failed',
        phase: 'request',
        errorName: error.name,
        hasEnvironmentCredentials: Boolean(
          process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY,
        ),
        hasContainerCredentialEndpoint: Boolean(
          process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI ||
          process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI,
        ),
        hasWebIdentityTokenFile: Boolean(
          process.env.AWS_WEB_IDENTITY_TOKEN_FILE,
        ),
        hasNamedProfile: Boolean(process.env.AWS_PROFILE),
      }),
    );
  },
);
const financeCategories = [
  'Org',
  'Personal/Shopping',
  'Family',
  'Marriage/Future',
];
function financeInput(value) {
  if (
    typeof value.purpose !== 'string' ||
    !value.purpose.trim() ||
    value.purpose.length > 160 ||
    !Number.isSafeInteger(value.amountCents) ||
    value.amountCents <= 0 ||
    value.amountCents > 99999999999 ||
    !financeCategories.includes(value.category)
  ) {
    throw Object.assign(
      new Error(
        'Enter a purpose, a positive amount with up to two decimal places, and a valid category.',
      ),
      { status: 400 },
    );
  }
  return {
    purpose: value.purpose.trim(),
    amountCents: value.amountCents,
    category: value.category,
  };
}
const sessions = new Map(),
  attempts = new Map();
const json = (res, code, value) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
};
async function body(req, limit = 65536) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit)
      throw Object.assign(new Error('File or request is too large.'), {
        status: 413,
      });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function validDate(value) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !isNaN(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}
function taskInput(t) {
  if (
    typeof t.title !== 'string' ||
    !t.title.trim() ||
    t.title.length > 160 ||
    typeof t.description !== 'string' ||
    t.description.length > 10000 ||
    !validDate(t.start) ||
    !validDate(t.end) ||
    t.end < t.start ||
    !['planned', 'active', 'done'].includes(t.status) ||
    typeof t.showProgress !== 'boolean' ||
    !Number.isInteger(t.progress) ||
    t.progress < 0 ||
    t.progress > 100 ||
    !['green', 'blue', 'orange', 'purple'].includes(t.color)
  )
    throw Object.assign(
      new Error('Please check the task title, dates, and progress.'),
      { status: 400 },
    );
  return {
    title: t.title.trim(),
    description: t.description,
    start: t.start,
    end: t.end,
    status: t.status,
    showProgress: Number(t.showProgress),
    progress: t.progress,
    color: t.color,
  };
}
const cleanFilename = (name) =>
  name.replace(/[\x00-\x1f\\/]/g, '_').slice(0, 200) || 'document';
const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ${store.cloud ? store.bucketOrigin : ''}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
  );
  try {
    const url = new URL(req.url, 'http://localhost'),
      route = url.pathname;
    if (
      !['GET', 'HEAD'].includes(req.method) &&
      req.headers.origin &&
      (cloudConfig
        ? req.headers.origin !== cloudConfig.origin
        : new URL(req.headers.origin).host !== req.headers.host)
    )
      return json(res, 403, { error: 'Request origin rejected.' });
    const sid = req.headers.cookie?.match(/(?:^|;\s*)session=([a-f0-9]+)/)?.[1];
    const auth =
      route.startsWith('/api/') &&
      (sid || (route === '/api/login' && req.method === 'POST'))
        ? await getPassword()
        : null;
    const session =
      route.startsWith('/api/') && sid && store.cloud
        ? await store.get('sessions', sid)
        : null;
    const authorized = store.cloud
      ? Boolean(
          session &&
          session.expiry > Date.now() &&
          session.passwordVersion === auth?.passwordVersion,
        )
      : sid && sessions.get(sid) > Date.now();
    if (route === '/api/login' && req.method === 'POST') {
      const ip = store.cloud
        ? `workspace-${Math.floor(Date.now() / 900000)}`
        : req.socket.remoteAddress;
      let attempt = store.cloud
        ? {
            count: (await store.consumeAttempt(ip)) - 1,
            until: Date.now() + 900000,
          }
        : attempts.get(ip);
      if (!attempt || attempt.until < Date.now()) {
        attempt = { count: 0, until: Date.now() + 900000 };
        attempts.set(ip, attempt);
      }
      if (attempt.count >= 10)
        return json(res, 429, {
          error: 'Too many attempts. Please try again in 15 minutes.',
        });
      const input = JSON.parse((await body(req)).toString());
      attempt.count++;
      if (
        typeof input.password !== 'string' ||
        !timingSafeEqual(
          scryptSync(input.password, auth.salt, 64),
          auth.passwordHash,
        )
      )
        return json(res, 401, {
          error: 'That password isn’t correct. Please try again.',
        });
      if (store.cloud) await store.delete('attempts', ip);
      else attempts.delete(ip);
      const token = randomBytes(32).toString('hex');
      if (store.cloud)
        await store.create('sessions', {
          id: token,
          expiry: Date.now() + 43200000,
          expiresAt: Math.floor(Date.now() / 1000) + 43200,
          passwordVersion: auth.passwordVersion,
        });
      else sessions.set(token, Date.now() + 43200000);
      res.setHeader(
        'Set-Cookie',
        `session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${store.cloud || process.env.COOKIE_SECURE === 'true' ? '; Secure' : ''}`,
      );
      return json(res, 200, { ok: true });
    }
    if (route === '/api/session')
      return json(res, 200, {
        authenticated: Boolean(authorized),
        directUploads: store.cloud,
      });
    if (route.startsWith('/api/') && !authorized)
      return json(res, 401, { error: 'Please unlock your workspace.' });
    if (route === '/api/logout' && req.method === 'POST') {
      if (store.cloud) await store.delete('sessions', sid);
      else sessions.delete(sid);
      res.setHeader(
        'Set-Cookie',
        'session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
      );
      return json(res, 200, { ok: true });
    }
    if (route === '/api/finances' && req.method === 'GET') {
      return json(
        res,
        200,
        (await store.list('finances')).sort(
          (a, b) =>
            b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
        ),
      );
    }
    if (route === '/api/finances' && req.method === 'POST') {
      const fields = financeInput(JSON.parse((await body(req)).toString()));
      const id = randomBytes(12).toString('hex');
      await store.create('finances', {
        id,
        ...fields,
        createdAt: new Date().toISOString(),
        status: 'Unpaid',
      });
      return json(res, 201, { id });
    }
    const financeMatch = route.match(/^\/api\/finances\/([a-f0-9]+)$/);
    if (financeMatch && ['PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      const id = financeMatch[1];
      if (!(await store.get('finances', id)))
        return json(res, 404, { error: 'Finance entry not found.' });
      if (req.method === 'PATCH') {
        const { status } = JSON.parse((await body(req)).toString());
        if (!['Unpaid', 'Paid'].includes(status))
          return json(res, 400, { error: 'Choose Unpaid or Paid.' });
        await store.update('finances', id, { status });
      } else if (req.method === 'DELETE') await store.delete('finances', id);
      else
        await store.update(
          'finances',
          id,
          financeInput(JSON.parse((await body(req)).toString())),
        );
      return json(res, 200, { ok: true });
    }
    if (route === '/api/tasks' && req.method === 'GET') {
      const files = await store.list('files');
      const tasks = await store.list('tasks');
      return json(
        res,
        200,
        tasks
          .sort(
            (a, b) =>
              a.start.localeCompare(b.start) || a.title.localeCompare(b.title),
          )
          .map((t) => ({
            ...t,
            showProgress: Boolean(t.showProgress),
            files: files
              .filter((f) => f.taskId === t.id)
              .map(({ id, taskId, name, size }) => ({
                id,
                taskId,
                name,
                size,
              })),
          })),
      );
    }
    if (route === '/api/tasks' && req.method === 'POST') {
      const fields = taskInput(JSON.parse((await body(req)).toString()));
      const id = randomBytes(12).toString('hex');
      await store.create('tasks', { id, ...fields });
      return json(res, 201, { id });
    }
    const taskMatch = route.match(/^\/api\/tasks\/([a-f0-9]+)$/);
    if (taskMatch && ['PUT', 'DELETE'].includes(req.method)) {
      const id = taskMatch[1];
      if (!(await store.get('tasks', id)))
        return json(res, 404, { error: 'Task not found.' });
      if (req.method === 'DELETE') await store.delete('tasks', id);
      else
        await store.update(
          'tasks',
          id,
          taskInput(JSON.parse((await body(req)).toString())),
        );
      return json(res, 200, { ok: true });
    }
    const uploadMatch = route.match(
      /^\/api\/tasks\/([a-f0-9]+)\/files(?:\/(prepare|complete))?$/,
    );
    if (uploadMatch && req.method === 'POST') {
      const task = await store.get('tasks', uploadMatch[1]);
      if (!task || task.deleting)
        return json(res, 404, { error: 'Task not found.' });
      if (store.cloud) {
        const input = JSON.parse((await body(req)).toString());
        if (uploadMatch[2] === 'prepare') {
          if (
            typeof input.name !== 'string' ||
            !Number.isSafeInteger(input.size) ||
            input.size < 0 ||
            input.size > 20 * 1024 * 1024
          )
            return json(res, 400, {
              error: 'Each document must be 20 MB or smaller.',
            });
          const id = randomBytes(12).toString('hex');
          return json(
            res,
            201,
            await store.prepareUpload(
              task.id,
              id,
              cleanFilename(input.name),
              input.size,
            ),
          );
        }
        if (uploadMatch[2] === 'complete' && typeof input.id === 'string') {
          await store.completeUpload(task.id, input.id);
          return json(res, 201, { id: input.id });
        }
        return json(res, 400, {
          error: 'Use the direct document upload flow.',
        });
      }
      const bytes = await body(req, 20 * 1024 * 1024);
      const name = cleanFilename(url.searchParams.get('name') || 'document');
      const id = randomBytes(12).toString('hex');
      await store.create('files', {
        id,
        taskId: task.id,
        name,
        bytes,
        size: bytes.length,
      });
      return json(res, 201, { id });
    }
    const fileMatch = route.match(/^\/api\/files\/([a-f0-9]+)$/);
    if (fileMatch && ['GET', 'DELETE'].includes(req.method)) {
      const file = await store.get('files', fileMatch[1]);
      if (!file) return json(res, 404, { error: 'Document not found.' });
      const task = await store.get('tasks', file.taskId);
      if (!task || task.deleting)
        return json(res, 404, { error: 'Task not found.' });
      if (req.method === 'DELETE') {
        await store.delete('files', file.id);
        return json(res, 200, { ok: true });
      }
      if (store.cloud) {
        res.writeHead(302, { Location: await store.download(file) });
        return res.end();
      }
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="document"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/'/g, '%27')}`,
      });
      return res.end(Buffer.from(file.bytes));
    }
    const assets = {
      '/': ['index.html', 'text/html'],
      '/app.js': ['app.js', 'text/javascript'],
      '/style.css': ['style.css', 'text/css'],
    };
    if (req.method === 'GET' && assets[route]) {
      const [file, type] = assets[route];
      res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
      return res.end(readFileSync(path.join(root, 'public', file)));
    }
    json(res, 404, { error: 'Not found.' });
  } catch (error) {
    if (!error.status && !(error instanceof SyntaxError))
      console.error('Request failed:', error.name, error.message);
    json(res, error.status || (error instanceof SyntaxError ? 400 : 500), {
      error: error.status
        ? error.message
        : error instanceof SyntaxError
          ? 'Invalid request.'
          : 'Something went wrong. Please try again.',
    });
  }
});
server.listen(
  Number(process.env.PORT || 3000),
  process.env.HOST || (store.cloud ? '0.0.0.0' : '127.0.0.1'),
  () =>
    console.log(
      `Calendar ready at http://${process.env.HOST || (store.cloud ? '0.0.0.0' : '127.0.0.1')}:${process.env.PORT || 3000}`,
    ),
);
setInterval(() => {
  const now = Date.now();
  for (const [key, expiry] of sessions) if (expiry <= now) sessions.delete(key);
  for (const [key, value] of attempts)
    if (value.until <= now) attempts.delete(key);
}, 60000).unref();
