import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';

test('private calendar: authentication, validation, persistence and document access', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'daymark-test-'));
  const legacy = new DatabaseSync(path.join(directory, 'schedule.sqlite'));
  legacy.exec(
    "CREATE TABLE finances (id TEXT PRIMARY KEY, purpose TEXT NOT NULL, amountCents INTEGER NOT NULL, category TEXT NOT NULL, createdAt TEXT NOT NULL); INSERT INTO finances VALUES ('abcdef', 'Existing entry', 1500, 'Org', '2026-01-01')",
  );
  legacy.close();
  const port = 34000 + Math.floor(Math.random() * 10000);
  let child;
  async function start() {
    child = spawn(process.execPath, ['server.js'], {
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        APP_PASSWORD: 'integration-test-password',
        DATA_DIR: directory,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Server startup timed out')),
        10000,
      );
      child.stdout.on('data', (data) => {
        if (data.toString().includes('Calendar ready')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code) => {
        if (code !== null) {
          clearTimeout(timer);
          reject(new Error(`Server exited: ${code}`));
        }
      });
    });
  }
  async function stop() {
    if (child && child.exitCode === null) {
      const done = once(child, 'exit');
      child.kill();
      await done;
    }
  }
  const request = (url, options = {}) =>
    fetch(`http://127.0.0.1:${port}${url}`, options);
  let cookie;
  const authorized = (url, method = 'GET', value) =>
    request(url, {
      method,
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
  async function login() {
    const response = await request('/api/login', {
      method: 'POST',
      body: JSON.stringify({ password: 'integration-test-password' }),
    });
    assert.equal(response.status, 200);
    cookie = response.headers.get('set-cookie').split(';')[0];
    assert.match(response.headers.get('set-cookie'), /HttpOnly/);
  }
  try {
    await start();
    assert.equal((await request('/')).status, 200);
    assert.equal((await request('/api/tasks')).status, 401);
    assert.equal(
      (
        await request('/api/login', {
          method: 'POST',
          body: JSON.stringify({ password: 'wrong' }),
        })
      ).status,
      401,
    );
    await login();
    assert.equal(
      (
        await request('/api/tasks', {
          method: 'POST',
          headers: { Cookie: cookie, Origin: 'https://evil.example' },
          body: '{}',
        })
      ).status,
      403,
    );
    assert.equal((await request('/api/finances')).status, 401);
    const migrated = await (await authorized('/api/finances')).json();
    assert.equal(migrated[0].status, 'Unpaid');
    assert.equal(migrated[0].amountCents, 1500);
    await authorized('/api/finances/abcdef', 'DELETE');
    const finance = {
      purpose: 'Venue deposit',
      amountCents: 12345,
      category: 'Marriage/Future',
    };
    for (const invalid of [
      { ...finance, amountCents: -1 },
      { ...finance, amountCents: 1.5 },
      { ...finance, category: 'Other' },
      { ...finance, purpose: ' ' },
    ]) {
      assert.equal(
        (await authorized('/api/finances', 'POST', invalid)).status,
        400,
      );
    }
    const financeResponse = await authorized('/api/finances', 'POST', finance);
    assert.equal(financeResponse.status, 201);
    const financeId = (await financeResponse.json()).id;
    assert.equal(
      (await (await authorized('/api/finances')).json())[0].status,
      'Unpaid',
    );
    assert.equal(
      (
        await request(`/api/finances/${financeId}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'Paid' }),
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await authorized(`/api/finances/${financeId}`, 'PATCH', {
          status: 'Invalid',
        })
      ).status,
      400,
    );
    for (const status of ['Paid', 'Unpaid', 'Paid']) {
      assert.equal(
        (await authorized(`/api/finances/${financeId}`, 'PATCH', { status }))
          .status,
        200,
      );
      const updated = (await (await authorized('/api/finances')).json())[0];
      assert.equal(updated.status, status);
      assert.equal(updated.purpose, finance.purpose);
      assert.equal(updated.amountCents, finance.amountCents);
    }
    assert.equal(
      (
        await authorized(`/api/finances/${financeId}`, 'PUT', {
          ...finance,
          amountCents: 23456,
          category: 'Family',
        })
      ).status,
      200,
    );
    const task = {
      title: 'Plan launch',
      description: 'Notes',
      start: '2026-09-23',
      end: '2026-09-26',
      status: 'active',
      showProgress: true,
      progress: 35,
      color: 'green',
    };
    assert.equal(
      (await authorized('/api/tasks', 'POST', { ...task, end: '2026-09-22' }))
        .status,
      400,
    );
    assert.equal(
      (await authorized('/api/tasks', 'POST', { ...task, progress: 101 }))
        .status,
      400,
    );
    const created = await authorized('/api/tasks', 'POST', task);
    assert.equal(created.status, 201);
    const { id } = await created.json();
    const upload = await request(`/api/tasks/${id}/files?name=notes.txt`, {
      method: 'POST',
      headers: { Cookie: cookie },
      body: 'Private document content',
    });
    assert.equal(upload.status, 201);
    const file = await upload.json();
    assert.equal((await request(`/api/files/${file.id}`)).status, 401);
    const download = await authorized(`/api/files/${file.id}`);
    assert.equal(await download.text(), 'Private document content');
    assert.match(download.headers.get('content-disposition'), /attachment/);
    assert.equal(
      (
        await authorized(`/api/tasks/${id}`, 'PUT', {
          ...task,
          progress: 80,
          showProgress: false,
        })
      ).status,
      200,
    );
    await stop();
    await start();
    assert.equal((await authorized('/api/tasks')).status, 401);
    await login();
    const savedFinances = await (await authorized('/api/finances')).json();
    assert.equal(savedFinances[0].amountCents, 23456);
    assert.equal(savedFinances[0].status, 'Paid');
    assert.equal(savedFinances[0].category, 'Family');
    assert.equal(savedFinances[0].purpose, 'Venue deposit');
    assert.equal(
      (await authorized(`/api/finances/${financeId}`, 'DELETE')).status,
      200,
    );
    assert.deepEqual(await (await authorized('/api/finances')).json(), []);
    const saved = await (await authorized('/api/tasks')).json();
    assert.equal(saved.length, 1);
    assert.equal(saved[0].progress, 80);
    assert.equal(saved[0].showProgress, false);
    assert.equal(saved[0].files[0].name, 'notes.txt');
    assert.equal((await authorized(`/api/tasks/${id}`, 'DELETE')).status, 200);
    assert.equal((await authorized(`/api/files/${file.id}`)).status, 404);
    assert.deepEqual(await (await authorized('/api/tasks')).json(), []);
    await authorized('/api/logout', 'POST', {});
    assert.equal((await authorized('/api/tasks')).status, 401);
  } finally {
    await stop();
    await rm(directory, { recursive: true, force: true });
  }
});
