const $ = (id) => document.getElementById(id);
let directUploads = false;
async function uploadDocument(taskId, file) {
  if (!directUploads)
    return api(
      `/api/tasks/${taskId}/files?name=${encodeURIComponent(file.name)}`,
      { method: 'POST', body: file },
    );
  const prepared = await send(`/api/tasks/${taskId}/files/prepare`, 'POST', {
    name: file.name,
    size: file.size,
  });
  const form = new FormData();
  for (const [key, value] of Object.entries(prepared.fields))
    form.append(key, value);
  form.append('file', file);
  const response = await fetch(prepared.url, {
    method: 'POST',
    body: form,
    credentials: 'omit',
  });
  if (!response.ok)
    throw new Error('Document upload failed. Please try again.');
  return send(`/api/tasks/${taskId}/files/complete`, 'POST', {
    id: prepared.id,
  });
}
let tasks = [],
  month = new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  filter = 'all',
  editing = null;
const dateKey = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const today = () => dateKey(new Date());
const escapeHtml = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  );
const formatDate = (s) =>
  new Date(`${s}T12:00:00`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
const statusLabel = (s) =>
  ({ planned: 'Planned', active: 'In progress', done: 'Completed' })[s];
async function api(url, options = {}) {
  const res = await fetch(url, options);
  const value = await res.json();
  if (!res.ok) {
    if (res.status === 401 && url !== '/api/login') lock();
    throw new Error(value.error || 'Request failed.');
  }
  return value;
}
const send = (url, method, value) =>
  api(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
function toast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  setTimeout(() => ($('toast').hidden = true), 4000);
}
function lock() {
  finances = [];
  resetFinanceForm();
  $('finance-list').replaceChildren();
  $('finance-total').textContent = 'Total: 0.00';
  tasks = [];
  $('workspace').hidden = true;
  $('login').hidden = false;
  $('task-dialog').close();
  $('calendar-grid').replaceChildren();
  $('task-list').replaceChildren();
  $('document-list').replaceChildren();
  $('overview-notes').textContent = '';
  $('overview-documents').replaceChildren();
  $('dialog-title').textContent = 'New task';
  $('task-form').reset();
  $('password').value = '';
}
async function refresh() {
  const results = await Promise.all([api('/api/tasks'), api('/api/finances')]);
  [tasks, finances] = results;
  render();
  renderFinances();
}
async function unlock(showWelcome = false) {
  if (showWelcome) {
    $('login').hidden = true;
    $('welcome-loading').hidden = false;
  }
  try {
    await Promise.all([
      refresh(),
      showWelcome
        ? new Promise((resolve) =>
            setTimeout(
              resolve,
              window.matchMedia('(prefers-reduced-motion: reduce)').matches
                ? 400
                : 2800,
            ),
          )
        : Promise.resolve(),
    ]);
    $('login').hidden = true;
    $('workspace').hidden = false;
  } catch (error) {
    lock();
    throw error;
  } finally {
    $('welcome-loading').hidden = true;
  }
}
$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const button = e.target.querySelector('button');
  button.disabled = true;
  $('login-error').textContent = '';
  try {
    await send('/api/login', 'POST', { password: $('password').value });
    $('password').value = '';
    await unlock(true);
  } catch (err) {
    $('login-error').textContent = err.message;
  } finally {
    button.disabled = false;
  }
});
$('logout').onclick = async () => {
  try {
    await send('/api/logout', 'POST', {});
    lock();
  } catch (e) {
    toast(e.message);
  }
};
$('today-label').textContent = new Date().toLocaleDateString(undefined, {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
});
function render() {
  $('total-count').textContent = tasks.length;
  $('active-count').textContent = tasks.filter(
    (t) => t.status === 'active',
  ).length;
  $('done-count').textContent = tasks.filter((t) => t.status === 'done').length;
  $('month-label').textContent = month.toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });
  const visible = tasks.filter((t) => filter === 'all' || t.status === filter);
  const first = new Date(month);
  first.setDate(1 - ((first.getDay() + 6) % 7));
  const last = new Date(month.getFullYear(), month.getMonth() + 1, 0);
  const weekCount = Math.ceil(
    (((month.getDay() + 6) % 7) + last.getDate()) / 7,
  );
  $('calendar-grid').replaceChildren();
  for (let w = 0; w < weekCount; w++) {
    const dates = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(first);
      d.setDate(d.getDate() + w * 7 + i);
      return d;
    });
    const keys = dates.map(dateKey),
      week = document.createElement('div');
    week.className = 'calendar-week';
    const days = document.createElement('div');
    days.className = 'day-backgrounds';
    dates.forEach((d, i) => {
      const b = document.createElement('button');
      b.className = `day-cell ${d.getMonth() !== month.getMonth() ? 'outside' : ''} ${keys[i] === today() ? 'is-today' : ''}`;
      b.innerHTML = `<span>${d.getDate()}</span>${keys[i] === today() ? '<small>TODAY</small>' : ''}`;
      b.setAttribute(
        'aria-label',
        `Add task on ${d.toLocaleDateString(undefined, { dateStyle: 'full' })}`,
      );
      b.onclick = () => openTask(null, keys[i]);
      days.append(b);
    });
    week.append(days);
    const bars = document.createElement('div');
    bars.className = 'week-bars';
    const lanes = [];
    visible
      .filter((t) => t.start <= keys[6] && t.end >= keys[0])
      .sort(
        (a, b) => a.start.localeCompare(b.start) || b.end.localeCompare(a.end),
      )
      .forEach((t) => {
        const start = Math.max(
          0,
          keys.findIndex((k) => k >= t.start),
        );
        const end =
          t.end >= keys[6] ? 6 : keys.findLastIndex((k) => k <= t.end);
        let lane = lanes.findIndex((n) => n < start);
        if (lane < 0) lane = lanes.length;
        lanes[lane] = end;
        const b = document.createElement('button');
        b.className = `task-bar ${t.color} ${t.status === 'done' ? 'completed' : ''}`;
        b.style.gridColumn = `${start + 1} / ${end + 2}`;
        b.style.gridRow = lane + 1;
        b.title = `${t.title} · ${statusLabel(t.status)} · ${formatDate(t.start)} – ${formatDate(t.end)}`;
        b.innerHTML = `<span class="task-bar-title">${t.status === 'done' ? '✓ ' : '<span class="bar-dot"></span>'}${escapeHtml(t.title)}</span>${t.showProgress ? `<span class="bar-percent">${t.progress}%</span><span class="tiny-progress" style="width:${t.progress}%"></span>` : ''}`;
        b.onclick = () => openTask(t);
        bars.append(b);
      });
    week.style.minHeight = `${Math.max(112, 43 + lanes.length * 33)}px`;
    week.append(bars);
    $('calendar-grid').append(week);
  }
  const upcoming = visible
    .filter((t) => t.status !== 'done')
    .sort((a, b) => a.start.localeCompare(b.start))
    .slice(0, 6);
  $('upcoming-count').textContent = upcoming.length.toString().padStart(2, '0');
  $('task-list').innerHTML = upcoming.length
    ? ''
    : `<div class="empty-state"><span>✧</span><h3>${tasks.length ? 'No open tasks' : 'No tasks yet'}</h3><p>${tasks.length ? 'No open tasks in this view.' : 'Add a task to get started.'}</p><button class="outline-button" id="empty-add">＋ Add a task</button></div>`;
  if ($('empty-add')) $('empty-add').onclick = () => openTask();
  upcoming.forEach((t) => {
    const b = document.createElement('button');
    b.className = 'task-row';
    b.innerHTML = `<span class="row-icon ${t.color}">${t.status === 'active' ? '◷' : '▤'}</span><span class="row-title"><strong>${escapeHtml(t.title)}</strong><small>${formatDate(t.start)}${t.start !== t.end ? ` — ${formatDate(t.end)}` : ''}${t.files.length ? ` &nbsp; · &nbsp; ${t.files.length} document${t.files.length > 1 ? 's' : ''}` : ''}</small></span><span class="status-pill ${t.status}">${statusLabel(t.status)}</span>${t.showProgress ? `<span class="row-progress"><span><i style="width:${t.progress}%"></i></span><small>${t.progress}%</small></span>` : '<span class="no-progress">—</span>'}<span class="row-arrow">↗</span>`;
    b.onclick = () => openTask(t);
    $('task-list').append(b);
  });
}
$('prev-month').onclick = () => {
  month.setMonth(month.getMonth() - 1);
  render();
};
$('next-month').onclick = () => {
  month.setMonth(month.getMonth() + 1);
  render();
};
$('today-button').onclick = $('calendar-nav').onclick = () => {
  month = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  render();
};
document.querySelectorAll('[data-filter]').forEach(
  (b) =>
    (b.onclick = () => {
      filter = b.dataset.filter;
      document
        .querySelectorAll('[data-filter]')
        .forEach((el) => el.classList.toggle('active', el === b));
      render();
    }),
);
function renderDocuments() {
  $('document-list').replaceChildren();
  const current = tasks.find((t) => t.id === editing);
  (current?.files || []).forEach((f) => {
    const row = document.createElement('div');
    row.className = 'document-row';
    const a = document.createElement('a');
    a.href = `/api/files/${f.id}`;
    a.textContent = `↧ ${f.name}`;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'icon-button';
    b.textContent = '×';
    b.setAttribute('aria-label', `Remove ${f.name}`);
    b.onclick = async () => {
      if (!confirm(`Remove “${f.name}”?`)) return;
      try {
        await api(`/api/files/${f.id}`, { method: 'DELETE' });
        await refresh();
        renderDocuments();
      } catch (e) {
        $('form-error').textContent = e.message;
      }
    };
    row.append(a, b);
    $('document-list').append(row);
  });
  Array.from($('task-files').files).forEach((f) => {
    const p = document.createElement('p');
    p.className = 'pending-file';
    p.textContent = `＋ ${f.name} · ready to upload`;
    $('document-list').append(p);
  });
}
function renderTaskOverview(task) {
  $('overview-status').className = `status-pill ${task.status}`;
  $('overview-status').textContent = statusLabel(task.status);
  for (const field of ['start', 'end']) {
    $('overview-' + field).textContent = new Date(
      `${task[field]}T12:00:00`,
    ).toLocaleDateString(undefined, { dateStyle: 'long' });
  }
  $('overview-notes').textContent = task.description || 'No notes added yet.';
  $('overview-progress-section').hidden = !task.showProgress;
  $('overview-progress').value = task.progress;
  $('overview-percent').textContent = `${task.progress}%`;
  $('overview-documents').replaceChildren();
  for (const file of task.files || []) {
    const row = document.createElement('div');
    row.className = 'document-row';
    const link = document.createElement('a');
    link.href = `/api/files/${file.id}`;
    link.textContent = file.name;
    row.append(link);
    $('overview-documents').append(row);
  }
  if (!task.files?.length)
    $('overview-documents').textContent = 'No documents attached.';
}
function openTask(task = null, date = today(), edit = false) {
  editing = task?.id || null;
  const overview = Boolean(task && !edit);
  $('task-overview').hidden = !overview;
  $('task-form').hidden = overview;
  $('task-form').reset();
  $('dialog-title').textContent = overview
    ? task.title
    : task
      ? 'Edit task'
      : 'New task';
  if (overview) renderTaskOverview(task);
  $('task-title').value = task?.title || '';
  $('task-description').value = task?.description || '';
  $('task-start').value = task?.start || date;
  $('task-end').value = task?.end || date;
  $('task-end').min = $('task-start').value;
  $('task-status').value = task?.status || 'planned';
  $('task-color').value = task?.color || 'green';
  $('show-progress').checked = task?.showProgress || false;
  $('task-progress').value = $('progress-number').value = task?.progress || 0;
  $('progress-controls').hidden = !$('show-progress').checked;
  $('delete-task').hidden = !task;
  $('form-error').textContent = '';
  renderDocuments();
  if (!$('task-dialog').open) $('task-dialog').showModal();
  $('task-dialog').scrollTop = 0;
  (overview ? $('edit-task') : $('task-title')).focus();
}
$('add-task').onclick = () => openTask();
$('edit-task').onclick = () => {
  const task = tasks.find((t) => t.id === editing);
  if (task) openTask(task, today(), true);
};
$('close-dialog').onclick = $('close-overview').onclick = () =>
  $('task-dialog').close();
$('cancel-dialog').onclick = () => {
  const task = tasks.find((t) => t.id === editing);
  if (task) openTask(task);
  else $('task-dialog').close();
};
$('task-start').onchange = () => {
  $('task-end').min = $('task-start').value;
  if ($('task-end').value < $('task-start').value)
    $('task-end').value = $('task-start').value;
};
$('show-progress').onchange = () =>
  ($('progress-controls').hidden = !$('show-progress').checked);
$('task-progress').oninput = () =>
  ($('progress-number').value = $('task-progress').value);
$('progress-number').oninput = () =>
  ($('task-progress').value = $('progress-number').value);
$('task-files').onchange = renderDocuments;
$('task-form').onsubmit = async (e) => {
  e.preventDefault();
  $('form-error').textContent = '';
  const files = Array.from($('task-files').files);
  if (files.some((f) => f.size > 20 * 1024 * 1024)) {
    $('form-error').textContent = 'Each document must be 20 MB or smaller.';
    return;
  }
  const task = {
    title: $('task-title').value,
    description: $('task-description').value,
    start: $('task-start').value,
    end: $('task-end').value,
    status: $('task-status').value,
    color: $('task-color').value,
    showProgress: $('show-progress').checked,
    progress: Number($('progress-number').value),
  };
  $('save-task').disabled = true;
  $('save-task').textContent = 'Saving…';
  try {
    const result = await send(
      editing ? `/api/tasks/${editing}` : '/api/tasks',
      editing ? 'PUT' : 'POST',
      task,
    );
    editing ||= result.id;
    for (const f of files) {
      await uploadDocument(editing, f);
      const remaining = new DataTransfer();
      Array.from($('task-files').files)
        .filter(
          (item) =>
            item !== f &&
            !(
              item.name === f.name &&
              item.size === f.size &&
              item.lastModified === f.lastModified
            ),
        )
        .forEach((item) => remaining.items.add(item));
      $('task-files').files = remaining.files;
    }
    await refresh();
    openTask(tasks.find((t) => t.id === editing));
    toast('Task saved.');
  } catch (err) {
    $('form-error').textContent = err.message;
    try {
      await refresh();
      renderDocuments();
    } catch {}
  } finally {
    $('save-task').disabled = false;
    $('save-task').textContent = 'Save task ↗';
  }
};
$('delete-task').onclick = async () => {
  if (!editing || !confirm('Delete this task and all its documents?')) return;
  try {
    await api(`/api/tasks/${editing}`, { method: 'DELETE' });
    await refresh();
    $('task-dialog').close();
    toast('Task deleted.');
  } catch (e) {
    $('form-error').textContent = e.message;
  }
};
let finances = [];
let editingFinance = null;
const financeTags = {
  Org: 'purple',
  'Personal/Shopping': 'orange',
  Family: 'blue',
  'Marriage/Future': 'green',
};
const formatAmount = (cents) =>
  (cents / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
function resetFinanceForm() {
  editingFinance = null;
  $('finance-form').reset();
  $('finance-save').textContent = 'Add finance';
  $('finance-cancel').hidden = true;
  $('finance-error').textContent = '';
}
function renderFinances() {
  $('finance-total').textContent =
    `Total: ${formatAmount(finances.reduce((sum, entry) => sum + entry.amountCents, 0))}`;
  $('finance-list').replaceChildren();
  if (!finances.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'No finances added yet.';
    $('finance-list').append(empty);
  }
  finances.forEach((entry) => {
    const row = document.createElement('div');
    row.className = 'finance-row';
    row.innerHTML = `<strong class="finance-purpose">${escapeHtml(entry.purpose)}</strong><span class="finance-tag ${financeTags[entry.category]}">${escapeHtml(entry.category)}</span><span class="finance-amount">${formatAmount(entry.amountCents)}</span>`;
    const actions = document.createElement('div');
    actions.className = 'finance-row-actions';
    const statusLabel = document.createElement('label');
    statusLabel.className = 'finance-status-label';
    statusLabel.textContent = 'Payment status';
    const status = document.createElement('select');
    status.className = 'finance-status';
    status.dataset.status = entry.status;
    status.setAttribute('aria-label', `Payment status for ${entry.purpose}`);
    for (const value of ['Unpaid', 'Paid']) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value;
      status.append(option);
    }
    status.value = entry.status;
    status.onchange = async () => {
      status.disabled = true;
      $('finance-error').textContent = '';
      try {
        await send(`/api/finances/${entry.id}`, 'PATCH', {
          status: status.value,
        });
        entry.status = status.value;
        status.dataset.status = entry.status;
        toast(`Marked as ${entry.status.toLowerCase()}.`);
      } catch (error) {
        status.value = entry.status;
        $('finance-error').textContent = error.message;
      } finally {
        status.disabled = false;
      }
    };
    statusLabel.append(status);
    row.append(statusLabel);
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'outline-button';
    edit.textContent = 'Edit';
    edit.setAttribute('aria-label', `Edit ${entry.purpose}`);
    edit.onclick = () => {
      editingFinance = entry.id;
      $('finance-purpose').value = entry.purpose;
      $('finance-amount').value = (entry.amountCents / 100).toFixed(2);
      $('finance-category').value = entry.category;
      $('finance-save').textContent = 'Save changes';
      $('finance-cancel').hidden = false;
      $('finance-error').textContent = '';
      $('finance-purpose').focus();
    };
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'danger';
    remove.textContent = 'Delete';
    remove.setAttribute('aria-label', `Delete ${entry.purpose}`);
    remove.onclick = async () => {
      if (!confirm(`Delete finance entry "${entry.purpose}"?`)) return;
      remove.disabled = true;
      try {
        await api(`/api/finances/${entry.id}`, { method: 'DELETE' });
        if (editingFinance === entry.id) resetFinanceForm();
        await refresh();
        toast('Finance entry deleted.');
      } catch (error) {
        $('finance-error').textContent = error.message;
      } finally {
        remove.disabled = false;
      }
    };
    actions.append(edit, remove);
    row.append(actions);
    $('finance-list').append(row);
  });
}
$('finance-cancel').onclick = resetFinanceForm;
$('finance-form').onsubmit = async (event) => {
  event.preventDefault();
  const amount = $('finance-amount').value;
  if (!/^\d+(\.\d{1,2})?$/.test(amount)) {
    $('finance-error').textContent =
      'Enter a positive amount with up to two decimal places.';
    return;
  }
  const value = {
    purpose: $('finance-purpose').value,
    amountCents: Math.round(Number(amount) * 100),
    category: $('finance-category').value,
  };
  $('finance-save').disabled = true;
  $('finance-error').textContent = '';
  try {
    await send(
      editingFinance ? `/api/finances/${editingFinance}` : '/api/finances',
      editingFinance ? 'PUT' : 'POST',
      value,
    );
    resetFinanceForm();
    await refresh();
    toast('Finance entry saved.');
  } catch (error) {
    $('finance-error').textContent = error.message;
  } finally {
    $('finance-save').disabled = false;
  }
};
api('/api/session')
  .then((s) => {
    directUploads = Boolean(s.directUploads);
    return s.authenticated ? unlock() : lock();
  })
  .catch((e) => {
    lock();
    $('login-error').textContent = e.message;
  });
