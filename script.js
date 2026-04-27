// =============================================
// REMIND ME — script.js
// =============================================

// --- PASTE YOUR CREDENTIALS HERE ---
const GOOGLE_CLIENT_ID = '675506173530-dusft5u0aq9fbro2t601hja544ti3kpb.apps.googleusercontent.com';
const GOOGLE_API_KEY   = 'AIzaSyDr8njd_KNxIqghqTxqheXOCVKmk03dMx4';
// ------------------------------------

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
  showInstallBanner();

  document.getElementById('addBtn').addEventListener('click', handleManualAdd);
  document.getElementById('manualInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') handleManualAdd();
  });
  document.getElementById('modalCancel').addEventListener('click', closeModal);
  document.getElementById('modalConfirm').addEventListener('click', confirmReminder);
  document.getElementById('modalOverlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeModal();
  });
  document.getElementById('gcalBtn').addEventListener('click', handleGCalAuth);
  document.getElementById('installDismiss').addEventListener('click', () => {
    document.getElementById('installBanner').style.display = 'none';
    localStorage.setItem('rm_install_dismissed', '1');
  });
});

// =============================================
// iOS INSTALL BANNER
// =============================================
function showInstallBanner() {
  const isIOS       = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const isInstalled = window.navigator.standalone === true;
  const isDismissed = localStorage.getItem('rm_install_dismissed');
  const banner      = document.getElementById('installBanner');
  if (isIOS && !isInstalled && !isDismissed) {
    banner.style.display = 'flex';
  }
}

// =============================================
// VOICE — tap once to start, tap again to stop
// =============================================
function initVoice() {
  const SR  = window.SpeechRecognition || window.webkitSpeechRecognition;
  const btn = document.getElementById('voiceBtn');

  if (!SR) {
    document.getElementById('voiceLabel').textContent = 'TYPE YOUR REMINDER BELOW';
    btn.style.opacity = '0.4';
    btn.disabled = true;
    return;
  }

  recognition = new SR();
  recognition.continuous     = false;
  recognition.interimResults = true;
  recognition.lang           = 'en-US';
  recognition.maxAlternatives = 1;

  recognition.onstart = () => {
    isRecording = true;
    btn.classList.add('recording');
    document.getElementById('voiceLabel').textContent = 'LISTENING... TAP TO STOP';
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

  recognition.onspeechend = () => recognition.stop();

  recognition.onend = () => {
    isRecording = false;
    btn.classList.remove('recording');
    document.getElementById('voiceLabel').textContent = 'TAP TO SPEAK';
    if (pendingText) {
      openModal(pendingText);
      pendingText = '';
    }
  };

  recognition.onerror = err => {
    isRecording = false;
    btn.classList.remove('recording');
    document.getElementById('voiceLabel').textContent = 'TAP TO SPEAK';
    if (err.error === 'not-allowed') showToast('ALLOW MICROPHONE IN SETTINGS');
    else if (err.error !== 'no-speech') showToast('COULD NOT HEAR — TRY AGAIN');
  };

  btn.addEventListener('click', () => {
    if (isRecording) {
      recognition.stop();
    } else {
      document.getElementById('voiceTranscript').textContent = '';
      try { recognition.start(); } catch (_) {}
    }
  });

  document.getElementById('voiceLabel').textContent = 'TAP TO SPEAK';
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

  const hoursAndMins = lower.match(/in\s+(\d+)\s*hours?\s+(?:and\s+)?(\d+)\s*min/);
  if (hoursAndMins) {
    date.setHours(date.getHours() + +hoursAndMins[1]);
    date.setMinutes(date.getMinutes() + +hoursAndMins[2]);
    title = title.replace(/in\s+\d+\s*hours?\s+(?:and\s+)?\d+\s*min\w*/gi, '').trim();
    timeParsed = true;
  }

  if (!timeParsed) {
    const inH = lower.match(/in\s+(\d+(?:\.\d+)?)\s*hours?/);
    if (inH) {
      date.setMinutes(date.getMinutes() + Math.round(parseFloat(inH[1]) * 60));
      title = title.replace(/in\s+[\d.]+\s*hours?/gi, '').trim();
      timeParsed = true;
    }
  }

  if (!timeParsed) {
    const inM = lower.match(/in\s+(\d+)\s*min/);
    if (inM) {
      date.setMinutes(date.getMinutes() + +inM[1]);
      title = title.replace(/in\s+\d+\s*min\w*/gi, '').trim();
      timeParsed = true;
    }
  }

  if (!timeParsed) {
    const inD = lower.match(/in\s+(\d+)\s*days?/);
    if (inD) {
      date.setDate(date.getDate() + +inD[1]);
      title = title.replace(/in\s+\d+\s*days?/gi, '').trim();
      timeParsed = true;
    }
  }

  if (lower.includes('tomorrow')) {
    date.setDate(date.getDate() + 1);
    title = title.replace(/tomorrow/gi, '').trim();
  }

  const atMatch = lower.match(/at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (atMatch) {
    let h     = +atMatch[1];
    const m   = atMatch[2] ? +atMatch[2] : 0;
    const mer = atMatch[3];
    if (mer === 'pm' && h !== 12) h += 12;
    if (mer === 'am' && h === 12) h  = 0;
    if (!mer && h < 7)            h += 12;
    date.setHours(h, m, 0, 0);
    title = title.replace(/at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?/gi, '').trim();
    timeParsed = true;
  }

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
  if (!timeParsed && lower.includes('this morning')) {
    date.setHours(9, 0, 0, 0);
    title = title.replace(/this morning/gi, '').trim();
    timeParsed = true;
  }

  if (!timeParsed) date.setHours(date.getHours() + 1, 0, 0, 0);

  title = title
    .replace(/^(remind me to|remind me|remember to|remember|don't forget to|don't forget|please remind me to|i need to|i have to)\s*/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (!title) title = 'Reminder';
  title = title[0].toUpperCase() + title.slice(1);

  return { title, date };
}

function formatDisplay(dateStr) {
  return new Date(dateStr).toLocaleString('en-US', {
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
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalTime').value        = toDatetimeLocal(date);
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
  closeModal();

  if (accessToken && gapiReady) {
    // Fully automatic — goes straight to Google Calendar, no confirmation needed
    addToGCal(reminder);
    showToast('SAVING TO GOOGLE CALENDAR...');
  } else {
    showToast('REMINDER SAVED LOCALLY');
  }
}

// =============================================
// STORAGE & RENDER
// =============================================
function save() {
  localStorage.setItem('rm_reminders', JSON.stringify(reminders));
}

function renderAll() {
  const endDay = new Date();
  endDay.setHours(23, 59, 59, 999);

  const today    = reminders.filter(r => new Date(r.date) <= endDay).sort(byDate);
  const upcoming = reminders.filter(r => new Date(r.date) >  endDay).sort(byDate);

  renderList('todayList',    today,    'No reminders yet. Tap the mic.');
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
        ${r.gcalId ? '<div class="reminder-gcal">✓ IN GOOGLE CALENDAR</div>' : ''}
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
    new Notification('REMIND ME', { body: reminder.title, tag: 'rm-' + reminder.id });
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
// GOOGLE CALENDAR API
// One-time connect → automatic forever after
// =============================================

// Called automatically when Google API script loads
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

// Called automatically when Google Sign-In script loads
function gisLoaded() {
  if (GOOGLE_CLIENT_ID === 'YOUR_CLIENT_ID.apps.googleusercontent.com') return;

  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope:     'https://www.googleapis.com/auth/calendar.events',
    callback:  resp => {
      if (resp.error) {
        accessToken = null;
        localStorage.removeItem('rm_gcal_ok');
        updateGCalStatus(false);
        showToast('GOOGLE AUTH FAILED — TRY RECONNECTING');
        return;
      }
      accessToken = resp.access_token;
      localStorage.setItem('rm_gcal_ok', '1');
      updateGCalStatus(true);
    }
  });

  // If user already connected before, silently reconnect — no popup
  if (localStorage.getItem('rm_gcal_ok')) {
    tokenClient.requestAccessToken({ prompt: '' });
  }
}

function handleGCalAuth() {
  if (GOOGLE_CLIENT_ID === 'YOUR_CLIENT_ID.apps.googleusercontent.com') {
    showToast('PASTE YOUR GOOGLE CLIENT ID FIRST');
    return;
  }
  if (!tokenClient) { showToast('LOADING GOOGLE...'); return; }

  if (accessToken) {
    // Disconnect
    google.accounts.oauth2.revoke(accessToken, () => {
      accessToken = null;
      localStorage.removeItem('rm_gcal_ok');
      updateGCalStatus(false);
    });
  } else {
    // First-time connect — shows Google login popup
    tokenClient.requestAccessToken({ prompt: 'consent' });
  }
}

function updateGCalStatus(connected) {
  const btn    = document.getElementById('gcalBtn');
  const status = document.getElementById('gcalStatus');
  const notice = document.getElementById('gcalNotice');

  if (connected) {
    status.textContent = 'GOOGLE CONNECTED ✓';
    btn.classList.add('connected');
    if (notice) notice.style.display = 'none';
  } else {
    status.textContent = 'CONNECT GOOGLE CALENDAR';
    btn.classList.remove('connected');
    if (notice) notice.style.display = 'block';
  }
}

async function addToGCal(reminder) {
  if (!accessToken || !gapiReady) return;
  try {
    gapi.client.setToken({ access_token: accessToken });

    const start = new Date(reminder.date);
    const end   = new Date(start.getTime() + 60 * 60 * 1000);

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
    showToast('✓ ADDED TO GOOGLE CALENDAR');
  } catch (err) {
    console.error('GCal error:', err);
    // Token may have expired — try to refresh silently
    if (err.status === 401 && tokenClient) {
      tokenClient.requestAccessToken({ prompt: '' });
      showToast('RECONNECTING TO GOOGLE...');
    } else {
      showToast('GOOGLE CALENDAR ERROR');
    }
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
  toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}

// =============================================
// SERVICE WORKER
// =============================================
function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(console.error);
  }
}
