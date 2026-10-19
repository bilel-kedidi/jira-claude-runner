// Owns the native-messaging connection so the job keeps running after the popup closes.
// An open native port keeps the MV3 service worker alive.
const NATIVE_HOST = 'com.jira_claude.runner';
const MAX_LOGS = 1000;

let port = null;
let job = null;

// A fresh service worker never has a live port, so any "running" job is stale.
chrome.storage.session.get('job').then(({ job: stale }) => {
  if (stale?.status === 'running' && !port) {
    stale.status = 'failed';
    stale.result = { ok: false, error: 'Extension restarted while the job was running.' };
    chrome.storage.session.set({ job: stale });
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'start') sendResponse(start(msg.payload));
  else if (msg.type === 'cancel') {
    if (port) port.postMessage({ type: 'cancel' });
    sendResponse({ ok: true });
  } else if (msg.type === 'chat') {
    sendResponse(startChat(msg));
  } else if (msg.type === 'chat-cancel') {
    if (chatPort) chatPort.postMessage({ type: 'cancel' });
    sendResponse({ ok: true });
  } else if (msg.type === 'chat-clear') {
    clearChat(msg.ticketKey).then(() => sendResponse({ ok: true }));
    return true;
  } else if (msg.type === 'clear') {
    if (!port) { job = null; chrome.storage.session.remove('job'); }
    sendResponse({ ok: !port });
  }
});

function save() {
  chrome.storage.session.set({ job });
}

function addLog(text, level = 'info') {
  job.logs.push({ t: Date.now(), level, text });
  if (job.logs.length > MAX_LOGS) job.logs.splice(0, job.logs.length - MAX_LOGS);
}

function start(payload) {
  if (port) return { ok: false, error: 'A job is already running.' };
  job = {
    status: 'running',
    ticket: payload.ticket.key,
    summary: payload.ticket.summary,
    project: payload.project.name,
    step: 'Starting',
    logs: [],
    result: null,
    startedAt: Date.now(),
  };
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST);
  } catch (e) {
    port = null;
    return { ok: false, error: e.message };
  }
  port.onMessage.addListener(onHostMessage);
  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError?.message;
    port = null;
    if (job?.status === 'running') {
      job.status = 'failed';
      job.result = { ok: false, error: err || 'Native host exited unexpectedly.' };
      save();
    }
  });
  port.postMessage({ type: 'run', job: payload });
  save();
  return { ok: true };
}

function onHostMessage(m) {
  if (!job) return;
  if (m.type === 'log') addLog(m.text, m.level);
  else if (m.type === 'step') job.step = m.step;
  else if (m.type === 'done') {
    job.status = m.ok ? 'done' : 'failed';
    job.result = m;
    job.finishedAt = Date.now();
    if (port) { port.disconnect(); port = null; }
    notify();
  }
  save();
}

function notify() {
  const r = job.result;
  const message = r.ok
    ? (r.commit ? `Committed ${r.commit} on ${r.branch} (${r.files.length} files)` : `No changes on ${r.branch}`)
    : r.error;
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icon.png',
    title: `${job.ticket}: ${r.ok ? 'done' : 'failed'}`,
    message: String(message).slice(0, 250),
  });
}

// ---------------------------------------------------------------- chat
// Chats live in storage.session as { [ticketKey]: { project, sessionId, busy, messages: [{role, text}] } }.
// role: 'user' | 'assistant' | 'tool' (activity lines while Claude searches) | 'error'

let chatPort = null;

async function getChats() {
  return (await chrome.storage.session.get('chats')).chats || {};
}

async function updateChat(key, fn) {
  const chats = await getChats();
  chats[key] = fn(chats[key] || { messages: [] });
  await chrome.storage.session.set({ chats });
  return chats[key];
}

async function clearChat(key) {
  if (chatPort) return;
  const chats = await getChats();
  delete chats[key];
  await chrome.storage.session.set({ chats });
}

function startChat({ ticket, project, message }) {
  if (chatPort) return { ok: false, error: 'Claude is still answering the previous question.' };
  const key = ticket.key;
  try {
    chatPort = chrome.runtime.connectNative(NATIVE_HOST);
  } catch (e) {
    chatPort = null;
    return { ok: false, error: e.message };
  }
  const port = chatPort;
  // Serialize storage writes so activity lines never race each other.
  let queue = Promise.resolve();
  const update = (fn) => { queue = queue.then(() => updateChat(key, fn)); return queue; };

  update((c) => {
    // A different project means a different repo: start a fresh Claude session.
    const sameProject = c.project === project.name;
    return {
      ...c,
      project: project.name,
      sessionId: sameProject ? c.sessionId : null,
      busy: true,
      messages: [...c.messages, { role: 'user', text: message }],
    };
  }).then((c) => {
    port.postMessage({ type: 'chat', ticket, project, sessionId: c.sessionId, message });
  });

  port.onMessage.addListener((m) => {
    if (m.type === 'log' && m.level === 'tool') {
      update((c) => ({ ...c, messages: [...c.messages, { role: 'tool', text: m.text.replace(/^🔧 /, '') }] }));
    } else if (m.type === 'done') {
      update((c) => ({
        ...c,
        busy: false,
        sessionId: m.sessionId || c.sessionId,
        messages: [...c.messages, m.ok ? { role: 'assistant', text: m.reply } : { role: 'error', text: m.error }],
      }));
      port.disconnect();
      chatPort = null;
    }
  });
  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError?.message;
    if (chatPort !== port) return;
    chatPort = null;
    update((c) => ({ ...c, busy: false, messages: [...c.messages, { role: 'error', text: err || 'Native host exited unexpectedly.' }] }));
  });
  return { ok: true };
}

// Clear stale "busy" flags left by a previous service worker.
getChats().then((chats) => {
  let changed = false;
  for (const c of Object.values(chats)) if (c.busy) { c.busy = false; changed = true; }
  if (changed) chrome.storage.session.set({ chats });
});
