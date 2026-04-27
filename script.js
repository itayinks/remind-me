// =============================================
// REMIND ME — script.js
// Voice → time parse → Google Calendar + local
// =============================================

// --- CONFIG: fill these in after Google setup ---
const GOOGLE_CLIENT_ID = 'YOUR_CLIENT_ID.apps.googleusercontent.com';
const GOOGLE_API_KEY   = 'YOUR_API_KEY';
// -----------------------------------------------

// =============================================
// STATE
// =============================================
let reminders   = JSON.parse(localStorage.getItem('rm_reminders') || '[]');
let isRecording = false;
let recognition = null;
let pendingText = '';
let tokenClient = null;
let accessToken = null;
let gapiReady   = false;

// =============================================
// BOOT
// =============================================
document.addEventListener('DOMContentLoaded', () => {
  initVoice();
  renderAll();
  restoreAlarms();
  requestNotifPerm();
  registerSW();

  // Manual input
  document.getElementById('addBtn').addEventListener('click', handleManualAdd);
  document.getElementById('manualInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') handleManualAdd();
  });

  // Modal
  document.getElementById('modalCancel').addEventListener('click', closeModal);
  document.getElementById('modalConfirm').addEventListener('click', confirmReminder);
  document.getElementById('modalOverlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeModal();
  });

  // Google auth button
  document.getElementById('gcalBtn').addEventListener('click', handleGCalAuth);
});

// =============================================
// VOICE INPUT
// =============================================
function initVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SR) {
    document.getElementById('voiceLabel').textContent = 'TYPE YOUR REMINDER BELOW';
    return;
  }

  recognition = new SR();
  recognition.continuous   = false;
  recognition.interimResults = true;
  recognition.lang         = 'en-US';

  recognition.onstart = () => {
    isRecording = true;
    document.getElementById('voiceBtn').classList.add('recording');
    document.getElementById('voiceLabel').textContent = 'LISTENING...';
    document.getElementById('voiceTranscript').textContent = '';
  };

  recognition.onresult = e => {
    let transcript = '';
    for (let i = 0; i < e.results.length; i++) {
      transcript += e.results[i][0].transcript;
    }
    document.getElementById('voiceTranscript').textContent = transcript;

    if (e.results[e.results.length - 1].isFinal) {
      pendingText = transcript;
    }
  };

  recognition.onend = () => {
    stopRecording();
    if (pendingText) {
      openModal(pendingText);
      pendingText = '';
    }
  };

  recognition.onerror = err => {
    console.error('Speech error:', err.error);
    stopRecording();
    if (err.error !== 'no-speech') showToast('COULD NOT HEAR — TRY AGAIN');
  };

  const btn = document.getElementById('voiceBtn');
  btn.addEventListener('touchstart', e => { e.preventDefault(); startRecording(); }, { passive: false });
  btn.addEventListener('touchend',   e => { e.preventDefault(); stopSpeech(); },    { passive: false });
  btn.addEventListener('mousedown',  () => startRecording());
  btn.addEventListener('mouseup',    () => stopSpeech());
}

function startRecording() {
  if (!recognition || isRecording) return;
  try { recognition.start(); } catch (_) {}
}

function stopSpeech() {
  if (!recognition || !isRecording) return;
  recognition.stop();
}

function stopRecording() {
  isRecording = false;
  document.getElementById('voiceBtn').classList.remove('recording');
  document.getElementById('voiceLabel').textContent = 'HOLD TO SPEAK';
}

// =============================================
// TIME / TITLE PARSING
// =============================================
function parseReminder(raw) {
  const text  = raw.trim();
  const lower = text.toLowerCase();
  let title   = text;
  const date  = new Date();
  let timeParsed = false;

  // "in X hours and Y minutes"
  const hoursAndMins = lower.match(/in\s+(\d+)\s*hours?\s+(?:and\s+)?(\d+)\s*min/);
  if (hoursAndMins) {
    date.setHours(date.getHours() + +hoursAndMins[1]);
    date.setMinutes(date.getMinutes() + +hoursAndMins[2]);
    title = title.replace(/in\s+\d+\s*hours?\s+(?:and\s+)?\d+\s*min\w*/gi, '').trim();
    timeParsed = true;
  }

  // "in X hours"
  if (!timeParsed) {
    const inH = lower.match(/in\s+(\d+)\s*hours?/);
    if (inH) {
      date.setHours(date.getHours() + +inH[1]);
      title = title.replace(/in\s+\d+\s*hours?/gi, '').trim();
      timeParsed = true;
    }
  }

  // "in X minutes"
  if (!timeParsed) {
    const inM = lower.match(/in\s+(\d+)\s*min/);
    if (inM) {
      date.setMinutes(date.getMinutes() + +inM[1]);
      title = title.replace(/in\s+\d+\s*min\w*/gi, '').trim();
      timeParsed = true;
    }
  }

  // "tomorrow"
  if (lower.includes('tomorrow')) {
    date.setDate(date.getDate() + 1);
    title = title.replace(/tomorrow/gi, '').trim();
  }

  // "at X:XX am/pm" or "at X am/pm"
  const atMatch = lower.match(/at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (atMatch) {
    let h = +atMatch[1];
    const m    = atMatch[2] ? +atMatch[2] : 0;
    const mer  = atMatch[3];
    if (mer === 'pm' && h !== 12) h += 12;
    if (mer === 'am' && h === 12) h  = 0;
    if (!mer && h < 7)            h += 12; // assume PM for ambiguous low numbers
    date.setHours(h, m, 0, 0);
    title = title.replace(/at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?/gi, '').trim();
    timeParsed = true;
  }

  // "tonight" → 8pm, "this evening" → 7pm
  if (!timeParsed && lower.includes('tonight')) {
    date.setHours(20, 0, 0, 0);
    title = title.replace(/tonight/gi, '').trim();
    timeParsed = true;
  }
  if (!timeParsed && lower.includes('this evening')) {
    date.setHours(19, 0, 0, 0);
    title = title.replace(/this evening/gi, '').trim();
    timeParsed = true;
  }

  // Default: +1 hour from now
  if (!timeParsed) {
    date.setHours(date.getHours() + 1, 0, 0, 0);
  }

  // Strip reminder prefixes
  title = title
    .replace(/^(remind me to|remind me|remember to|remember|don't forget to|don't forget|please remind me to)\s*/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (!title) title = 'Reminder';
  title = title[0].toUpperCase() + title.slice(1);

  return { title, date };
}

function formatDisplay(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true
  }).toUpperCase();
}

function toDatetimeLocal(date) {
  const d = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
}

// =============================================
// MODAL
// =============================================
function openModal(rawText) {
  const { title, date } = parseReminder(rawText);

  document.getElementById('modalTitle').textContent     = title;
  document.getElementById('modalTime').value            = toDatetimeLocal(date);
  document.getElementById('modalOverlay').classList.add('open');
}

function closeModal() {
  document.getElementById('modalOverlay').classList.remove('open');
}

function handleManualAdd() {
  const inp = document.getElementById('manualInput');
  const val = inp.value.trim();
  if (!val) return;
  openModal(val);
  inp.value = '';
}

function confirmReminder() {
  const title     = document.getElementById('modalTitle').textContent.trim();
  const timeValue = document.getElementById('modalTime').value;

  if (!title)     { showToast('PLEASE ADD A TITLE'); return; }
  if (!timeValue) { showToast('PLEASE SET A TIME');  return; }

  const reminder = {
    id:     Date.now(),
    title,
    date:   new Date(timeValue).toISOString(),
    done:   false,
    gcalId: null
  };

  reminders.push(reminder);
  save();
  renderAll();
  scheduleAlarm(reminder);

  if (accessToken) addToGCal(reminder);

  closeModal();
  showToast('REMINDER SAVED');
}

// =============================================
// STORAGE & RENDER
// =============================================
function save() {
  localStorage.setItem('rm_reminders', JSON.stringify(reminders));
}

function renderAll() {
  const now     = new Date();
  const endDay  = new Date(now);
  endDay.setHours(23, 59, 59, 999);

  const today    = reminders.filter(r => new Date(r.date) <= endDay).sort(byDate);
  const upcoming = reminders.filter(r => new Date(r.date) >  endDay).sort(byDate);

  renderList('todayList',    today,    'No reminders yet. Start speaking.');
  renderList('upcomingList', upcoming, 'Nothing upcoming.');

  document.getElementById('todayCount').textContent    = today.length    + ' TASK' + (today.length    !== 1 ? 'S' : '');
  document.getElementById('upcomingCount').textContent = upcoming.length + ' TASK' + (upcoming.length !== 1 ? 'S' : '');
}

function byDate(a, b) { return new Date(a.date) - new Date(b.date); }

function renderList(listId, items, emptyMsg) {
  const el = document.getElementById(listId);
  if (!items.length) {
    el.innerHTML = `<p class="empty-state">${emptyMsg}</p>`;
    return;
  }
  el.innerHTML = items.map(r => `
    <div class="reminder-card ${r.done ? 'done' : ''}" data-id="${r.id}">
      <button class="check-btn ${r.done ? 'checked' : ''}" onclick="toggleDone(${r.id})" aria-label="${r.done ? 'Mark undone' : 'Mark done'}"></button>
      <div class="reminder-content">
        <div class="reminder-title">${esc(r.title)}</div>
        <div class="reminder-time">${formatDisplay(r.date)}</div>
        ${r.gcalId ? '<div class="reminder-gcal">ADDED TO GOOGLE CALENDAR</div>' : ''}
      </div>
      <button class="reminder-delete" onclick="deleteReminder(${r.id})" aria-label="Delete">×</button>
    </div>
  `).join('');
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function toggleDone(id) {
  const r = reminders.find(r => r.id === id);
  if (r) { r.done = !r.done; save(); renderAll(); }
}

function deleteReminder(id) {
  reminders = reminders.filter(r => r.id !== id);
  save();
  renderAll();
}

// =============================================
// NOTIFICATIONS & ALARMS
// =============================================
async function requestNotifPerm() {
  if ('Notification' in window && Notification.permission === 'default') {
    await Notification.requestPermission();
  }
}

function scheduleAlarm(reminder) {
  const delay = new Date(reminder.date) - new Date();
  if (delay <= 0 || delay > 24 * 60 * 60 * 1000) return;

  setTimeout(() => {
    const r = reminders.find(r => r.id === reminder.id);
    if (r && !r.done) fire(r);
  }, delay);
}

function restoreAlarms() {
  reminders.forEach(r => {
    if (!r.done && new Date(r.date) > new Date()) scheduleAlarm(r);
  });
}

function fire(reminder) {
  beep();
  if (Notification.permission === 'granted') {
    new Notification('REMIND ME', {
      body: reminder.title,
      tag:  'rm-' + reminder.id
    });
  }
  showToast('⏰ ' + reminder.title.toUpperCase());
}

function beep() {
  try {
    const ctx  = new (window.AudioContext || window.webkitAudioContext)();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.setValueAtTime(880,  ctx.currentTime);
    osc.frequency.setValueAtTime(1100, ctx.currentTime + 0.12);
    osc.frequency.setValueAtTime(880,  ctx.currentTime + 0.24);
    gain.gain.setValueAtTime(0.28, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.55);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.55);
  } catch (_) {}
}

// =============================================
// GOOGLE CALENDAR
// =============================================

// Called by <script onload="gapiLoaded()">
function gapiLoaded() {
  if (GOOGLE_API_KEY === 'YOUR_API_KEY') return;
  gapi.load('client', async () => {
    await gapi.client.init({
      apiKey: GOOGLE_API_KEY,
      discoveryDocs: ['https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest']
    });
    gapiReady = true;
  });
}

// Called by <script onload="gisLoaded()">
function gisLoaded() {
  if (GOOGLE_CLIENT_ID === 'YOUR_CLIENT_ID.apps.googleusercontent.com') return;
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope:     'https://www.googleapis.com/auth/calendar.events',
    callback:  resp => {
      if (resp.error) { showToast('GOOGLE AUTH FAILED'); return; }
      accessToken = resp.access_token;
      document.getElementById('gcalStatus').textContent = 'GOOGLE CONNECTED ✓';
      document.getElementById('gcalBtn').classList.add('connected');
      showToast('GOOGLE CALENDAR CONNECTED');
    }
  });
}

function handleGCalAuth() {
  if (GOOGLE_CLIENT_ID === 'YOUR_CLIENT_ID.apps.googleusercontent.com') {
    showToast('ADD YOUR GOOGLE CLIENT ID FIRST — SEE SETUP GUIDE');
    return;
  }
  if (!tokenClient) { showToast('GOOGLE API STILL LOADING...'); return; }

  if (accessToken) {
    // Sign out
    google.accounts.oauth2.revoke(accessToken, () => {
      accessToken = null;
      document.getElementById('gcalStatus').textContent = 'CONNECT GOOGLE';
      document.getElementById('gcalBtn').classList.remove('connected');
    });
  } else {
    tokenClient.requestAccessToken({ prompt: 'consent' });
  }
}

async function addToGCal(reminder) {
  if (!accessToken || !gapiReady) return;
  try {
    gapi.client.setToken({ access_token: accessToken });
    const start = new Date(reminder.date);
    const end   = new Date(start.getTime() + 60 * 60 * 1000); // +1 hour

    const res = await gapi.client.calendar.events.insert({
      calendarId: 'primary',
      resource: {
        summary: reminder.title,
        start:   { dateTime: start.toISOString() },
        end:     { dateTime: end.toISOString() },
        reminders: {
          useDefault: false,
          overrides: [
            { method: 'popup', minutes: 0 },
            { method: 'popup', minutes: 5 }
          ]
        }
      }
    });

    const r = reminders.find(r => r.id === reminder.id);
    if (r) { r.gcalId = res.result.id; save(); renderAll(); }
    showToast('ADDED TO GOOGLE CALENDAR');
  } catch (err) {
    console.error('GCal error:', err);
    showToast('GOOGLE CALENDAR ERROR — CHECK CONSOLE');
  }
}

// =============================================
// TOAST
// =============================================
let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

// =============================================
// SERVICE WORKER (PWA offline support)
// =============================================
function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(console.error);
  }
}
