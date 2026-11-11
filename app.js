/* Recipe Box — a static recipe database that stores everything in the
   signed-in user's own Google Drive. No server, no secrets. */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* Constants                                                           */
  /* ------------------------------------------------------------------ */

  const CONFIG = window.RECIPE_BOX_CONFIG || {};
  const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
  const SCOPES = 'openid email profile ' + DRIVE_SCOPE;

  const DRIVE = 'https://www.googleapis.com/drive/v3';
  const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
  const DOCS = 'https://docs.googleapis.com/v1/documents';
  const USERINFO = 'https://www.googleapis.com/oauth2/v3/userinfo';

  const MIME_FOLDER = 'application/vnd.google-apps.folder';
  const MIME_SHEET = 'application/vnd.google-apps.spreadsheet';
  const MIME_DOC = 'application/vnd.google-apps.document';

  // Files are marked with this Drive appProperty so they can be found again.
  const ROLE_KEY = 'recipeBoxRole';
  const ROLE = { folder: 'folder', index: 'index', template: 'template', recipe: 'recipe' };

  const COLUMNS = ['id', 'title', 'ingredientTags', 'mealTags', 'cuisineTags', 'otherTags',
    'docId', 'docUrl', 'createdAt', 'updatedAt'];

  const TAG_TYPES = [
    { key: 'ingredientTags', label: 'Ingredients', css: 'ingredient', placeholder: 'e.g. tomato, basil' },
    { key: 'mealTags', label: 'Meal', css: 'meal', placeholder: 'e.g. dinner, dessert' },
    { key: 'cuisineTags', label: 'Cuisine', css: 'cuisine', placeholder: 'e.g. italian' },
    { key: 'otherTags', label: 'Other', css: 'other', placeholder: 'e.g. quick, vegetarian' },
  ];

  const LS_LAST_EMAIL = 'recipeBox.lastEmail';
  const LS_SORT = 'recipeBox.sort';
  const LS_SESSION = 'recipeBox.session';
  const LS_CACHE = 'recipeBox.cache.'; // + email: that account's file ids and recipe list

  /* ------------------------------------------------------------------ */
  /* State                                                               */
  /* ------------------------------------------------------------------ */

  const state = {
    token: null,
    tokenExpiry: 0,
    user: null,          // { email, name, picture }
    store: null,         // { folderId, sheetId, templateId, gridId }
    recipes: [],
    loading: false,
    loadError: null,
    query: '',
    selected: new Set(), // "tagKey|tag"
    deep: false,         // "Search inside recipes"
    deepIds: null,       // Set of docIds matching the Drive full-text search
    deepPending: false,
    sort: 'title',
    editing: null,       // recipe being edited, or null when adding
    accountEpoch: 0,     // bumps on every sign-in / switch / sign-out
  };

  class AppError extends Error {
    constructor(message, code) {
      super(message);
      this.code = code || 'error';
    }
  }

  /* ------------------------------------------------------------------ */
  /* Small helpers                                                       */
  /* ------------------------------------------------------------------ */

  const $ = (id) => document.getElementById(id);

  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const c of children.flat()) if (c != null) node.append(c);
    return node;
  }

  function normaliseTag(raw) {
    return String(raw == null ? '' : raw).replace(/,/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function parseTags(cell) {
    const out = [];
    for (const part of String(cell == null ? '' : cell).split(',')) {
      const t = normaliseTag(part);
      if (t && !out.includes(t)) out.push(t);
    }
    return out;
  }

  function newId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'r-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function formatDate(iso) {
    const d = new Date(iso);
    if (!iso || isNaN(d)) return '';
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function docUrlFor(docId) {
    return 'https://docs.google.com/document/d/' + docId + '/edit';
  }

  function isConfigured() {
    const id = CONFIG.CLIENT_ID || '';
    return /\.apps\.googleusercontent\.com$/.test(id) && !/^YOUR_CLIENT_ID/.test(id);
  }

  function lsGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function lsSet(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* private mode */ } }
  function lsRemove(key) { try { localStorage.removeItem(key); } catch (e) { /* private mode */ } }

  /* ------------------------------------------------------------------ */
  /* Loading indicator + messages                                        */
  /* ------------------------------------------------------------------ */

  let busyCount = 0;
  const busyLabels = [];

  function updateBusy() {
    const busy = busyCount > 0;
    $('progress').hidden = !busy;
    $('busy-pill').hidden = !busy;
    document.body.setAttribute('aria-busy', busy ? 'true' : 'false');
    const label = busyLabels[busyLabels.length - 1] || 'Talking to Google…';
    if (busy) {
      $('busy-label').textContent = label;
      if ($('status').textContent !== label) $('status').textContent = label;
    } else {
      $('status').textContent = '';
    }
  }

  /** Show the loading indicator for as long as `promise` is pending. */
  async function track(promise, label) {
    busyCount++;
    if (label) busyLabels.push(label);
    updateBusy();
    try {
      return await promise;
    } finally {
      busyCount--;
      if (label) busyLabels.splice(busyLabels.lastIndexOf(label), 1);
      updateBusy();
    }
  }

  function toast(message, opts) {
    opts = opts || {};
    const isError = opts.type === 'error';
    const node = el('div', { class: 'toast' + (isError ? ' toast-error' : ''), role: isError ? 'alert' : 'status' },
      el('span', { class: 'toast-text', text: message }));
    if (opts.action) {
      node.append(el('a', { class: 'toast-action', href: opts.action.href, target: '_blank', rel: 'noopener', text: opts.action.label }));
    }
    const close = el('button', { class: 'toast-close', type: 'button', 'aria-label': 'Dismiss message', text: '×' });
    close.addEventListener('click', () => node.remove());
    node.append(close);
    $('toasts').append(node);
    setTimeout(() => node.remove(), opts.action ? 20000 : isError ? 12000 : 5000);
  }

  function showError(err) {
    console.error(err);
    if (err && (err.code === 'reauth' || err.code === 'signedout')) {
      if (state.user) { $('reauth-banner').hidden = false; return; }
    }
    if (err && err.code === 'cancelled') return;
    toast((err && err.message) || 'Something went wrong.', { type: 'error' });
  }

  /* ------------------------------------------------------------------ */
  /* Google sign-in (Google Identity Services token client)              */
  /* ------------------------------------------------------------------ */

  let tokenClient = null;
  let pendingAuth = null;
  let refreshing = null;

  function authError(type, description) {
    switch (type) {
      case 'popup_closed':
      case 'popup_closed_by_user':
        return new AppError('Sign-in was cancelled.', 'cancelled');
      case 'popup_failed_to_open':
        return new AppError('Your browser blocked the Google sign-in window. Allow pop-ups for this site and try again.', 'popup');
      case 'access_denied':
        return new AppError('Permission denied. Recipe Box needs your permission to create its files in Google Drive. If you see "Access blocked", add this Google account as a test user (see the README).', 'denied');
      case 'interaction_required':
      case 'login_required':
      case 'consent_required':
      case 'account_selection_required':
        return new AppError('Google needs you to sign in again.', 'reauth');
      case 'invalid_client':
        return new AppError('Google did not recognise the Client ID in config.js. Check it was pasted correctly.', 'config');
      default:
        return new AppError('Google sign-in failed' + (description ? ': ' + description : type ? ' (' + type + ').' : '.'), 'auth');
    }
  }

  function ensureTokenClient() {
    if (tokenClient) return tokenClient;
    const oauth2 = window.google && google.accounts && google.accounts.oauth2;
    if (!oauth2) {
      throw new AppError('Google sign-in has not loaded. Check your internet connection (or any ad/script blocker), then try again.', 'network');
    }
    tokenClient = oauth2.initTokenClient({
      client_id: CONFIG.CLIENT_ID,
      scope: SCOPES,
      callback: (resp) => {
        const p = pendingAuth;
        pendingAuth = null;
        if (!p) return;
        if (resp.error) return p.reject(authError(resp.error, resp.error_description));
        if (!oauth2.hasGrantedAllScopes(resp, DRIVE_SCOPE)) {
          return p.reject(new AppError('Recipe Box was not given access to its Google Drive files. Sign in again and tick the Google Drive checkbox on the permission screen.', 'denied'));
        }
        p.resolve(resp);
      },
      error_callback: (err) => {
        const p = pendingAuth;
        pendingAuth = null;
        if (p) p.reject(authError(err && err.type, err && err.message));
      },
    });
    return tokenClient;
  }

  /** Ask Google for an access token. prompt: 'select_account' | '' (silent when possible). */
  function requestToken(prompt, hint) {
    return new Promise((resolve, reject) => {
      let client;
      try { client = ensureTokenClient(); } catch (e) { return reject(e); }
      if (pendingAuth) pendingAuth.reject(new AppError('Sign-in was restarted.', 'cancelled'));
      pendingAuth = { resolve, reject };
      const options = { prompt: prompt };
      if (hint) options.login_hint = hint;
      client.requestAccessToken(options);
    });
  }

  function applyToken(resp) {
    state.token = resp.access_token;
    const seconds = Number(resp.expires_in) || 3600;
    state.tokenExpiry = Date.now() + (seconds - 60) * 1000;
    saveSession();
  }

  /** Silently get a fresh token for the current account (token lasts ~1 hour). */
  function refreshToken() {
    if (!state.user) return Promise.reject(new AppError('You are signed out. Please sign in again.', 'signedout'));
    if (!refreshing) {
      const hint = state.user && state.user.email;
      refreshing = track(requestToken('', hint), 'Renewing your Google session…')
        .then((resp) => { applyToken(resp); $('reauth-banner').hidden = true; })
        .catch((err) => {
          throw new AppError('Your Google session has expired. Press Reconnect to carry on.', err.code === 'network' ? 'network' : 'reauth');
        })
        .finally(() => { refreshing = null; });
    }
    return refreshing;
  }

  // Staying signed in: this browser remembers who you are, your latest
  // short-lived Google token (about 1 hour) and a copy of your recipe list.
  // When the token runs out it is renewed silently; nothing here is a
  // long-lived credential, and Sign out wipes all of it.
  function saveSession() {
    if (!state.user) return;
    lsSet(LS_SESSION, JSON.stringify({ token: state.token, expiry: state.tokenExpiry, user: state.user }));
  }

  function loadSession() {
    try {
      const s = JSON.parse(lsGet(LS_SESSION) || 'null');
      if (s && s.user && s.user.email) return s;
    } catch (e) { /* ignore */ }
    return null;
  }

  function clearSession() {
    lsRemove(LS_SESSION);
  }

  function tokenIsFresh() {
    return !!state.token && Date.now() < state.tokenExpiry;
  }

  function saveCache() {
    if (!state.user || !state.store) return;
    lsSet(LS_CACHE + state.user.email, JSON.stringify({ store: state.store, recipes: state.recipes }));
  }

  /** Show the remembered recipe list straight away, before Google has answered. */
  function applyCache() {
    try {
      const c = JSON.parse(lsGet(LS_CACHE + state.user.email) || 'null');
      if (!c || !c.store || !c.store.sheetId || !Array.isArray(c.recipes)) return false;
      state.store = c.store;
      state.recipes = c.recipes.filter((r) => r && r.id).map((r) => {
        TAG_TYPES.forEach((t) => { if (!Array.isArray(r[t.key])) r[t.key] = []; });
        r.title = String(r.title || '');
        return r;
      });
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ------------------------------------------------------------------ */
  /* REST helper: adds the token, shows loading, retries once on 401     */
  /* ------------------------------------------------------------------ */

  async function httpError(res) {
    let detail = '';
    let reason = '';
    try {
      const body = await res.json();
      const e = body && body.error;
      if (e && typeof e === 'object') {
        detail = e.message || '';
        reason = (e.errors && e.errors[0] && e.errors[0].reason) || e.status || '';
      } else if (body && body.error_description) {
        detail = body.error_description;
      }
    } catch (e) { /* not JSON */ }

    if (res.status === 401) return new AppError('You are signed out of Google. Please sign in again.', 'reauth');
    if (res.status === 403) {
      if (/has not been used|is disabled|accessNotConfigured|SERVICE_DISABLED/i.test(detail + ' ' + reason)) {
        return new AppError('A Google API is not enabled for this project. Enable the Drive, Sheets and Docs APIs in Google Cloud (README, step 1), wait a minute, then refresh.', 'api-disabled');
      }
      if (/rate|quota/i.test(reason + ' ' + detail)) {
        return new AppError('Google is limiting requests right now. Wait a moment and try again.', 'rate');
      }
      return new AppError('Permission denied. Recipe Box can only open files it created itself.' + (detail ? ' (' + detail + ')' : ''), 'forbidden');
    }
    if (res.status === 404) return new AppError('That file could not be found in Google Drive. It may have been deleted. Try Refresh.', 'notfound');
    if (res.status === 429) return new AppError('Too many requests. Wait a moment and try again.', 'rate');
    if (res.status >= 500) return new AppError('Google had a temporary problem (' + res.status + '). Please try again.', 'server');
    return new AppError('Google returned an error (' + res.status + ')' + (detail ? ': ' + detail : '.'), 'http');
  }

  async function api(url, opts) {
    opts = opts || {};
    if (!tokenIsFresh()) await refreshToken();

    const headers = { Authorization: 'Bearer ' + state.token };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

    let res;
    try {
      res = await track(fetch(url, {
        method: opts.method || 'GET',
        headers: headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      }));
    } catch (e) {
      throw new AppError('Network error. Check your internet connection and try again.', 'network');
    }

    if (res.status === 401 && !opts.retried) {
      await refreshToken();
      return api(url, Object.assign({}, opts, { retried: true }));
    }
    if (!res.ok) throw await httpError(res);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  const qs = (params) => new URLSearchParams(params).toString();

  /* ------------------------------------------------------------------ */
  /* Storage setup: folder, index Sheet, template Doc                    */
  /* ------------------------------------------------------------------ */

  function setRole(fileId, role) {
    return api(DRIVE + '/files/' + fileId + '?' + qs({ fields: 'id' }), {
      method: 'PATCH',
      body: { appProperties: { [ROLE_KEY]: role } },
    });
  }

  async function createFolder() {
    const f = await api(DRIVE + '/files?' + qs({ fields: 'id' }), {
      method: 'POST',
      body: { name: 'Recipe Box', mimeType: MIME_FOLDER, appProperties: { [ROLE_KEY]: ROLE.folder } },
    });
    return f.id;
  }

  async function createIndexSheet(folderId) {
    const f = await api(DRIVE + '/files?' + qs({ fields: 'id' }), {
      method: 'POST',
      body: { name: 'Recipe Index', mimeType: MIME_SHEET, parents: [folderId] },
    });
    await writeHeaderRow(f.id);
    // Cosmetic: bold, frozen header row. Not essential, so failures are ignored.
    try {
      const gridId = await fetchGridId(f.id);
      await api(SHEETS + '/' + f.id + ':batchUpdate', {
        method: 'POST',
        body: {
          requests: [
            { updateSheetProperties: { properties: { sheetId: gridId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
            { repeatCell: { range: { sheetId: gridId, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: 'userEnteredFormat.textFormat.bold' } },
          ],
        },
      });
    } catch (e) { console.warn('Could not format the header row', e); }
    // Only mark the file once it is fully set up, so a half-made file is never reused.
    await setRole(f.id, ROLE.index);
    return f.id;
  }

  function writeHeaderRow(sheetId) {
    return api(SHEETS + '/' + sheetId + '/values/A1:J1?' + qs({ valueInputOption: 'RAW' }), {
      method: 'PUT',
      body: { values: [COLUMNS] },
    });
  }

  async function fetchGridId(sheetId) {
    const meta = await api(SHEETS + '/' + sheetId + '?' + qs({ fields: 'sheets.properties(sheetId,index)' }));
    const sheets = (meta && meta.sheets) || [];
    sheets.sort((a, b) => (a.properties.index || 0) - (b.properties.index || 0));
    return sheets.length ? sheets[0].properties.sheetId : 0;
  }

  async function createTemplateDoc(folderId) {
    const f = await api(DRIVE + '/files?' + qs({ fields: 'id' }), {
      method: 'POST',
      body: { name: 'Recipe Template', mimeType: MIME_DOC, parents: [folderId] },
    });

    const lines = [
      ['{{TITLE}}', 'TITLE'],
      ['{{TAGS}}', 'SUBTITLE'],
      ['Ingredients', 'HEADING_1'],
      ['', null],
      ['Steps', 'HEADING_1'],
      ['', null],
      ['Notes', 'HEADING_1'],
    ];
    const requests = [{
      insertText: { location: { index: 1 }, text: lines.map((l) => l[0]).join('\n') + '\n' },
    }];
    let index = 1;
    for (const [text, style] of lines) {
      const end = index + text.length + 1; // +1 for the newline
      if (style) {
        requests.push({
          updateParagraphStyle: {
            range: { startIndex: index, endIndex: end },
            paragraphStyle: { namedStyleType: style },
            fields: 'namedStyleType',
          },
        });
      }
      index = end;
    }
    await api(DOCS + '/' + f.id + ':batchUpdate', { method: 'POST', body: { requests: requests } });
    await setRole(f.id, ROLE.template);
    return f.id;
  }

  /** Find this account's Recipe Box files, creating whatever is missing. */
  async function setupStorage() {
    const roleClause = [ROLE.folder, ROLE.index, ROLE.template]
      .map((r) => "appProperties has { key='" + ROLE_KEY + "' and value='" + r + "' }")
      .join(' or ');
    const found = await api(DRIVE + '/files?' + qs({
      q: '(' + roleClause + ') and trashed = false',
      fields: 'files(id, mimeType, appProperties)',
      orderBy: 'createdTime',
      pageSize: '100',
      spaces: 'drive',
    }));
    const byRole = {};
    for (const f of (found && found.files) || []) {
      const role = f.appProperties && f.appProperties[ROLE_KEY];
      if (role && !byRole[role]) byRole[role] = f.id; // oldest wins
    }

    const folderId = byRole[ROLE.folder] || await track(createFolder(), 'Creating your Recipe Box folder…');
    const sheetId = byRole[ROLE.index] || await track(createIndexSheet(folderId), 'Creating your Recipe Index sheet…');
    const templateId = byRole[ROLE.template] || await track(createTemplateDoc(folderId), 'Creating your Recipe Template…');

    state.store = { folderId: folderId, sheetId: sheetId, templateId: templateId, gridId: null };
  }

  /* ------------------------------------------------------------------ */
  /* Recipe index (the Sheet)                                            */
  /* ------------------------------------------------------------------ */

  function rowToRecipe(row) {
    const get = (i) => (row[i] == null ? '' : String(row[i]));
    const r = { id: get(0), title: get(1), docId: get(6), docUrl: get(7), createdAt: get(8), updatedAt: get(9) };
    TAG_TYPES.forEach((t, i) => { r[t.key] = parseTags(row[2 + i]); });
    if (!r.docUrl && r.docId) r.docUrl = docUrlFor(r.docId);
    return r;
  }

  function recipeToRow(r) {
    return [r.id, r.title].concat(TAG_TYPES.map((t) => r[t.key].join(',')), [r.docId, r.docUrl, r.createdAt, r.updatedAt]);
  }

  async function loadIndex() {
    const sheetId = state.store.sheetId;
    const data = await track(api(SHEETS + '/' + sheetId + '/values/A1:J'), 'Loading your recipes…');
    const rows = (data && data.values) || [];
    if (!rows.length) await writeHeaderRow(sheetId); // header was removed by hand: put it back
    state.recipes = rows.slice(1).map(rowToRecipe).filter((r) => r.id);
    saveCache();
  }

  /** Current 1-based row number of a recipe (looked up fresh, in case rows moved). */
  async function findRow(id) {
    const data = await api(SHEETS + '/' + state.store.sheetId + '/values/A:A');
    const rows = (data && data.values) || [];
    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][0] == null ? '' : rows[i][0]) === id) return i + 1;
    }
    throw new AppError('That recipe is no longer in the index. Press Refresh to reload.', 'stale');
  }

  function tagSummary(tags) {
    const all = [];
    TAG_TYPES.forEach((t) => tags[t.key].forEach((tag) => { if (!all.includes(tag)) all.push(tag); }));
    return all.join(', ');
  }

  async function copyTemplate(title) {
    const body = { name: title, parents: [state.store.folderId], appProperties: { [ROLE_KEY]: ROLE.recipe } };
    const url = () => DRIVE + '/files/' + state.store.templateId + '/copy?' + qs({ fields: 'id' });
    try {
      return await api(url(), { method: 'POST', body: body });
    } catch (err) {
      if (err.code !== 'notfound') throw err;
      // The template (or folder) was deleted: rebuild what is missing and try once more.
      await setupStorage();
      body.parents = [state.store.folderId];
      return api(url(), { method: 'POST', body: body });
    }
  }

  async function createRecipe(title, tags) {
    const doc = await track(copyTemplate(title), 'Creating the recipe Doc…');
    try {
      await track(api(DOCS + '/' + doc.id + ':batchUpdate', {
        method: 'POST',
        body: {
          requests: [
            { replaceAllText: { containsText: { text: '{{TITLE}}', matchCase: true }, replaceText: title } },
            { replaceAllText: { containsText: { text: '{{TAGS}}', matchCase: true }, replaceText: tagSummary(tags) } },
          ],
        },
      }), 'Filling in the recipe Doc…');

      const now = new Date().toISOString();
      const recipe = Object.assign({ id: newId(), title: title, docId: doc.id, docUrl: docUrlFor(doc.id), createdAt: now, updatedAt: now }, tags);
      await track(api(SHEETS + '/' + state.store.sheetId + '/values/A1:J1:append?' + qs({ valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' }), {
        method: 'POST',
        body: { values: [recipeToRow(recipe)] },
      }), 'Adding the recipe to your index…');
      state.recipes.push(recipe);
      saveCache();
      return recipe;
    } catch (err) {
      // Don't leave an orphaned Doc behind if the recipe could not be indexed.
      api(DRIVE + '/files/' + doc.id + '?' + qs({ fields: 'id' }), { method: 'PATCH', body: { trashed: true } }).catch(() => {});
      throw err;
    }
  }

  async function updateRecipe(recipe, title, tags) {
    const updated = Object.assign({}, recipe, tags, { title: title, updatedAt: new Date().toISOString() });
    const row = await track(findRow(recipe.id), 'Saving your changes…');
    await track(api(SHEETS + '/' + state.store.sheetId + '/values/A' + row + ':J' + row + '?' + qs({ valueInputOption: 'RAW' }), {
      method: 'PUT',
      body: { values: [recipeToRow(updated)] },
    }), 'Saving your changes…');
    // The list may have been reloaded in the background while the form was open.
    Object.assign(state.recipes.find((r) => r.id === recipe.id) || recipe, updated);
    saveCache();

    if (recipe.docId) {
      try {
        await track(api(DRIVE + '/files/' + recipe.docId + '?' + qs({ fields: 'id' }), { method: 'PATCH', body: { name: title } }), 'Renaming the recipe Doc…');
      } catch (err) {
        if (err.code === 'notfound') toast('The index was updated, but the Google Doc for this recipe no longer exists.', { type: 'error' });
        else throw new AppError('The index was updated, but the Google Doc could not be renamed. ' + err.message, err.code);
      }
    }
  }

  async function getGridId() {
    if (state.store.gridId == null) state.store.gridId = await fetchGridId(state.store.sheetId);
    return state.store.gridId;
  }

  async function deleteRecipe(recipe) {
    if (recipe.docId) {
      try {
        await track(api(DRIVE + '/files/' + recipe.docId + '?' + qs({ fields: 'id' }), { method: 'PATCH', body: { trashed: true } }), 'Moving the Doc to Drive trash…');
      } catch (err) {
        if (err.code !== 'notfound') throw err; // already gone: still remove the row
      }
    }
    const gridId = await getGridId();
    const row = await track(findRow(recipe.id), 'Removing the recipe from your index…');
    await track(api(SHEETS + '/' + state.store.sheetId + ':batchUpdate', {
      method: 'POST',
      body: { requests: [{ deleteDimension: { range: { sheetId: gridId, dimension: 'ROWS', startIndex: row - 1, endIndex: row } } }] },
    }), 'Removing the recipe from your index…');
    state.recipes = state.recipes.filter((r) => r.id !== recipe.id);
    saveCache();
  }

  /* ------------------------------------------------------------------ */
  /* Search inside recipes (Drive full-text search)                      */
  /* ------------------------------------------------------------------ */

  let deepSeq = 0;
  let deepTimer = null;

  async function runDeepSearch() {
    const seq = ++deepSeq;
    const q = state.query.trim();
    if (!state.deep || q.length < 2 || !state.store) {
      state.deepIds = null;
      state.deepPending = false;
      renderList();
      return;
    }
    state.deepPending = true;
    renderList();
    try {
      const escaped = q.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      const ids = new Set();
      let pageToken = '';
      do {
        const params = {
          q: "fullText contains '" + escaped + "' and '" + state.store.folderId + "' in parents and trashed = false",
          fields: 'nextPageToken, files(id)',
          pageSize: '200',
          spaces: 'drive',
        };
        if (pageToken) params.pageToken = pageToken;
        const page = await track(api(DRIVE + '/files?' + qs(params)), 'Searching inside your recipes…');
        ((page && page.files) || []).forEach((f) => ids.add(f.id));
        pageToken = (page && page.nextPageToken) || '';
      } while (pageToken && seq === deepSeq);
      if (seq !== deepSeq) return;
      state.deepIds = ids;
    } catch (err) {
      if (seq !== deepSeq) return;
      state.deepIds = new Set();
      showError(err);
    } finally {
      if (seq === deepSeq) {
        state.deepPending = false;
        renderList();
      }
    }
  }

  function scheduleDeepSearch() {
    clearTimeout(deepTimer);
    deepTimer = setTimeout(runDeepSearch, 450);
  }

  /* ------------------------------------------------------------------ */
  /* Filtering + rendering                                               */
  /* ------------------------------------------------------------------ */

  function matchesLocal(recipe, terms) {
    const hay = (recipe.title + ' ' + TAG_TYPES.map((t) => recipe[t.key].join(' ')).join(' ')).toLowerCase();
    return terms.every((term) => hay.includes(term));
  }

  function visibleRecipes() {
    const q = state.query.trim().toLowerCase();
    const terms = q ? q.split(/\s+/) : [];
    const useDeep = state.deep && q.length >= 2;
    const selected = Array.from(state.selected).map((s) => s.split('|'));

    const list = state.recipes.filter((r) => {
      if (!selected.every(([key, tag]) => r[key].includes(tag))) return false; // AND logic
      if (!terms.length) return true;
      if (matchesLocal(r, terms)) return true;
      return useDeep && state.deepIds != null && state.deepIds.has(r.docId);
    });

    if (state.sort === 'updated') {
      list.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    } else {
      list.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true }));
    }
    return list;
  }

  function tagCounts(key) {
    const counts = new Map();
    for (const r of state.recipes) for (const t of r[key]) counts.set(t, (counts.get(t) || 0) + 1);
    return counts;
  }

  function renderChips() {
    // Drop selections whose tag no longer exists.
    for (const s of Array.from(state.selected)) {
      const [key, tag] = s.split('|');
      if (!state.recipes.some((r) => r[key].includes(tag))) state.selected.delete(s);
    }

    const groups = $('chip-groups');
    groups.textContent = '';
    let any = false;
    for (const type of TAG_TYPES) {
      const counts = tagCounts(type.key);
      if (!counts.size) continue;
      any = true;
      const tags = Array.from(counts.keys()).sort((a, b) => a.localeCompare(b));
      const headingId = 'chips-' + type.css;
      groups.append(el('div', { class: 'chip-group', role: 'group', 'aria-labelledby': headingId },
        el('h3', { id: headingId, class: 'chip-group-label', text: type.label }),
        el('div', { class: 'chips' }, tags.map((tag) => {
          const id = type.key + '|' + tag;
          const pressed = state.selected.has(id);
          return el('button', {
            class: 'chip chip-' + type.css + (pressed ? ' is-selected' : ''),
            type: 'button',
            'aria-pressed': pressed ? 'true' : 'false',
            'data-chip': id,
          }, tag, el('span', { class: 'chip-count', text: String(counts.get(tag)) }));
        }))));
    }
    $('filters').hidden = !any;
    $('clear-filters-btn').hidden = state.selected.size === 0;
  }

  function renderCard(recipe) {
    const tagList = el('ul', { class: 'card-tags', 'aria-label': 'Tags' });
    for (const type of TAG_TYPES) {
      for (const tag of recipe[type.key]) {
        tagList.append(el('li', { class: 'tag tag-' + type.css, title: type.label, text: tag }));
      }
    }
    const menuId = 'menu-' + recipe.id;
    const updated = formatDate(recipe.updatedAt);

    return el('li', { class: 'card' },
      el('div', { class: 'card-top' },
        el('h3', { class: 'card-title' },
          recipe.docUrl
            ? el('a', { class: 'card-link', href: recipe.docUrl, target: '_blank', rel: 'noopener' },
              recipe.title, el('span', { class: 'sr-only', text: ' (opens the Google Doc in a new tab)' }))
            : el('span', { text: recipe.title })),
        el('div', { class: 'card-menu' },
          el('button', {
            class: 'icon-btn card-menu-btn', type: 'button', 'aria-haspopup': 'true', 'aria-expanded': 'false',
            'aria-controls': menuId, 'aria-label': 'Options for ' + recipe.title, 'data-menu': menuId,
          }, el('span', { 'aria-hidden': 'true', text: '⋮' })),
          el('div', { id: menuId, class: 'menu', hidden: true },
            el('button', { class: 'menu-item', type: 'button', 'data-action': 'edit', 'data-id': recipe.id, text: 'Edit title & tags' }),
            el('button', { class: 'menu-item menu-item-danger', type: 'button', 'data-action': 'delete', 'data-id': recipe.id, text: 'Delete' })))),
      tagList.children.length ? tagList : null,
      el('p', { class: 'card-meta', text: updated ? 'Updated ' + updated : '' }));
  }

  function renderList() {
    const list = $('recipe-list');
    const empty = $('empty-state');
    const count = $('result-count');
    closeMenus();
    list.textContent = '';
    empty.textContent = '';
    empty.hidden = true;

    const total = state.recipes.length;
    const filtering = state.query.trim() !== '' || state.selected.size > 0;

    if (state.loading && !total) {
      count.textContent = '';
      empty.hidden = false;
      empty.append(el('span', { class: 'spinner spinner-lg', 'aria-hidden': 'true' }), el('p', { text: 'Loading your recipes…' }));
      return;
    }
    if (state.loadError && !total) {
      count.textContent = '';
      empty.hidden = false;
      empty.append(
        el('p', { class: 'empty-title', text: 'Your recipes could not be loaded' }),
        el('p', { text: state.loadError.message }),
        el('button', { class: 'btn btn-primary', type: 'button', onclick: refresh, text: 'Try again' }));
      return;
    }
    if (!total) {
      count.textContent = '';
      empty.hidden = false;
      empty.append(
        el('p', { class: 'empty-title', text: 'Your recipe box is empty' }),
        el('p', { text: 'Press the + button to add your first recipe.' }));
      return;
    }

    const visible = visibleRecipes();
    const searchingDeep = state.deep && state.deepPending;
    count.textContent = (filtering ? visible.length + ' of ' + total : String(total)) +
      (total === 1 ? ' recipe' : ' recipes') + (searchingDeep ? ' · searching inside recipes…' : '');

    if (!visible.length) {
      empty.hidden = false;
      if (searchingDeep) {
        empty.append(el('span', { class: 'spinner spinner-lg', 'aria-hidden': 'true' }), el('p', { text: 'Searching inside your recipes…' }));
      } else {
        empty.append(
          el('p', { class: 'empty-title', text: 'No recipes match' }),
          el('p', { text: state.deep ? 'Nothing matched in titles, tags or recipe text.' : 'Try fewer filters, or switch on "Search inside recipes".' }),
          el('button', { class: 'btn', type: 'button', onclick: clearAllFilters, text: 'Clear search and filters' }));
      }
      return;
    }
    for (const recipe of visible) list.append(renderCard(recipe));
  }

  function render() {
    renderChips();
    renderList();
  }

  function clearAllFilters() {
    state.query = '';
    $('search-input').value = '';
    state.selected.clear();
    state.deepIds = null;
    deepSeq++;
    state.deepPending = false;
    render();
    $('search-input').focus();
  }

  /* ------------------------------------------------------------------ */
  /* Pop-up menus (card menu + account menu)                             */
  /* ------------------------------------------------------------------ */

  function closeMenus(returnFocus) {
    document.querySelectorAll('[aria-haspopup][aria-expanded="true"]').forEach((btn) => {
      btn.setAttribute('aria-expanded', 'false');
      const menu = $(btn.getAttribute('aria-controls'));
      if (menu) menu.hidden = true;
      if (returnFocus) btn.focus();
    });
  }

  function toggleMenu(btn) {
    const open = btn.getAttribute('aria-expanded') === 'true';
    closeMenus();
    if (open) return;
    const menu = $(btn.getAttribute('aria-controls'));
    if (!menu) return;
    btn.setAttribute('aria-expanded', 'true');
    menu.hidden = false;
    const first = menu.querySelector('.menu-item');
    if (first) first.focus();
  }

  function onMenuKeydown(e) {
    const menu = e.target.closest && e.target.closest('.menu');
    if (e.key === 'Escape') {
      if (document.querySelector('[aria-haspopup][aria-expanded="true"]')) { closeMenus(true); e.stopPropagation(); }
      return;
    }
    if (!menu || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
    const items = Array.from(menu.querySelectorAll('.menu-item'));
    const i = items.indexOf(document.activeElement);
    const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
    items[next].focus();
    e.preventDefault();
  }

  /* ------------------------------------------------------------------ */
  /* Tag input with autocomplete                                         */
  /* ------------------------------------------------------------------ */

  function createTagInput(type) {
    let tags = [];
    const inputId = 'tags-' + type.css;
    const list = el('ul', { class: 'tag-input-list' });
    const input = el('input', {
      id: inputId, type: 'text', class: 'tag-input-text', autocomplete: 'off', autocapitalize: 'none',
      spellcheck: 'false', placeholder: type.placeholder, enterkeyhint: 'done',
    });
    const suggestions = el('div', { class: 'suggestions', role: 'group', 'aria-label': 'Suggested ' + type.label.toLowerCase() + ' tags' });
    const box = el('div', { class: 'tag-input' }, list, input);
    const root = el('div', { class: 'field' },
      el('label', { for: inputId, text: type.label + ' tags' }), box, suggestions);

    function renderTags() {
      list.textContent = '';
      tags.forEach((tag) => {
        list.append(el('li', { class: 'tag tag-' + type.css },
          tag,
          el('button', { type: 'button', class: 'tag-remove', 'aria-label': 'Remove ' + tag, onclick: () => { remove(tag); input.focus(); } },
            el('span', { 'aria-hidden': 'true', text: '×' }))));
      });
    }

    function renderSuggestions() {
      suggestions.textContent = '';
      const typed = normaliseTag(input.value);
      const counts = tagCounts(type.key);
      const options = Array.from(counts.keys())
        .filter((t) => !tags.includes(t) && (!typed || t.includes(typed)))
        .sort((a, b) => {
          if (typed) {
            const pa = a.startsWith(typed) ? 0 : 1;
            const pb = b.startsWith(typed) ? 0 : 1;
            if (pa !== pb) return pa - pb;
          }
          return counts.get(b) - counts.get(a) || a.localeCompare(b);
        })
        .slice(0, 8);
      options.forEach((tag) => {
        suggestions.append(el('button', {
          type: 'button', class: 'chip chip-suggest', 'aria-label': 'Add tag ' + tag,
          onclick: () => { input.value = ''; add(tag); input.focus(); },
        }, '+ ' + tag));
      });
    }

    function add(raw) {
      String(raw).split(',').forEach((part) => {
        const t = normaliseTag(part);
        if (t && !tags.includes(t)) tags.push(t);
      });
      renderTags();
      renderSuggestions();
    }

    function remove(tag) {
      tags = tags.filter((t) => t !== tag);
      renderTags();
      renderSuggestions();
    }

    function commit() {
      if (input.value.trim()) add(input.value);
      input.value = '';
      renderSuggestions();
    }

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault(); // Enter adds a tag; it must not submit the form
        commit();
      } else if (e.key === ',') {
        e.preventDefault();
        commit();
      } else if (e.key === 'Backspace' && !input.value && tags.length) {
        remove(tags[tags.length - 1]);
      }
    });
    input.addEventListener('input', () => {
      if (input.value.includes(',')) commit(); // pasted lists, mobile keyboards
      else renderSuggestions();
    });
    box.addEventListener('click', (e) => { if (e.target === box || e.target === list) input.focus(); });

    return {
      root: root,
      key: type.key,
      set(next) { tags = next.slice(); input.value = ''; renderTags(); renderSuggestions(); },
      get() { return tags.slice(); },
      commit: commit,
    };
  }

  const tagInputs = [];

  /* ------------------------------------------------------------------ */
  /* Add / edit dialog                                                   */
  /* ------------------------------------------------------------------ */

  function showNotice(node, message) {
    node.textContent = message || '';
    node.hidden = !message;
  }

  function openRecipeDialog(recipe) {
    if (!state.store) {
      toast('Your Recipe Box is not ready yet. Press Refresh and try again.', { type: 'error' });
      return;
    }
    state.editing = recipe || null;
    $('recipe-dialog-title').textContent = recipe ? 'Edit recipe' : 'New recipe';
    $('form-save').textContent = recipe ? 'Save changes' : 'Save recipe';
    $('title-input').value = recipe ? recipe.title : '';
    $('title-input').removeAttribute('aria-invalid');
    $('title-error').hidden = true;
    showNotice($('form-error'), '');
    tagInputs.forEach((t) => t.set(recipe ? recipe[t.key] : []));
    setFormBusy(false);
    $('recipe-dialog').showModal();
    $('title-input').focus();
    // Renew the Google token now, during this click, so Save goes straight through.
    if (!tokenIsFresh()) tryRenew();
  }

  function setFormBusy(busy) {
    $('form-save').disabled = busy;
    $('form-cancel').disabled = busy;
    $('recipe-form').setAttribute('aria-busy', busy ? 'true' : 'false');
    if (busy) $('form-save').textContent = 'Saving…';
    else $('form-save').textContent = state.editing ? 'Save changes' : 'Save recipe';
  }

  async function onSubmitRecipe(e) {
    e.preventDefault();
    if ($('form-save').disabled) return;
    const title = $('title-input').value.replace(/\s+/g, ' ').trim();
    if (!title) {
      $('title-error').hidden = false;
      $('title-input').setAttribute('aria-invalid', 'true');
      $('title-input').focus();
      return;
    }
    $('title-error').hidden = true;
    $('title-input').removeAttribute('aria-invalid');
    showNotice($('form-error'), '');

    const tags = {};
    tagInputs.forEach((t) => { t.commit(); tags[t.key] = t.get(); });
    const editing = state.editing;

    // Browsers only allow a new tab to open during the click itself, so open
    // it now and point it at the new Doc once Google has created it.
    // (Skipped when the Google token needs renewing first: that renewal needs
    // this click, and a link to the Doc is shown afterwards instead.)
    let win = null;
    if (!editing && tokenIsFresh()) {
      try {
        win = window.open('', '_blank');
        if (win) {
          win.document.title = 'Creating recipe…';
          win.document.body.style.cssText = 'font:16px system-ui,sans-serif;padding:2rem;color:#2E2218;background:#FBF6EE';
          win.document.body.textContent = 'Creating your recipe in Google Docs…';
        }
      } catch (err) { /* pop-up blocked: a link is offered instead */ }
    }

    setFormBusy(true);
    try {
      if (editing) {
        await updateRecipe(editing, title, tags);
        toast('Recipe updated.');
      } else {
        const recipe = await createRecipe(title, tags);
        if (win && !win.closed) {
          try { win.opener = null; } catch (err) { /* ignore */ }
          win.location.href = recipe.docUrl;
          win = null;
          toast('Recipe created and opened in a new tab.');
        } else {
          toast('Recipe created.', { action: { label: 'Open the Doc', href: recipe.docUrl } });
        }
      }
      $('recipe-dialog').close();
      render();
    } catch (err) {
      console.error(err);
      if (win) { try { win.close(); } catch (e2) { /* ignore */ } }
      showNotice($('form-error'), err.message || 'The recipe could not be saved.');
      if (err.code === 'reauth') $('reauth-banner').hidden = false;
      render();
    } finally {
      setFormBusy(false);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Delete confirmation                                                 */
  /* ------------------------------------------------------------------ */

  let deleting = null;

  function openDeleteDialog(recipe) {
    deleting = recipe;
    $('confirm-text').textContent = '"' + recipe.title + '" will be removed from your recipe list and its Google Doc moved to your Drive trash (you can restore it from there for 30 days).';
    showNotice($('confirm-error'), '');
    $('confirm-ok').disabled = false;
    $('confirm-cancel').disabled = false;
    $('confirm-ok').textContent = 'Delete';
    $('confirm-dialog').showModal();
    $('confirm-cancel').focus();
  }

  async function onConfirmDelete() {
    if (!deleting) return;
    $('confirm-ok').disabled = true;
    $('confirm-cancel').disabled = true;
    $('confirm-ok').textContent = 'Deleting…';
    try {
      await deleteRecipe(deleting);
      $('confirm-dialog').close();
      toast('Recipe deleted. Its Doc is in your Drive trash.');
      deleting = null;
      render();
    } catch (err) {
      console.error(err);
      showNotice($('confirm-error'), err.message || 'The recipe could not be deleted.');
      if (err.code === 'reauth') $('reauth-banner').hidden = false;
      $('confirm-ok').disabled = false;
      $('confirm-cancel').disabled = false;
      $('confirm-ok').textContent = 'Delete';
    }
  }

  /* ------------------------------------------------------------------ */
  /* Account flow                                                        */
  /* ------------------------------------------------------------------ */

  function renderSignin() {
    const last = lsGet(LS_LAST_EMAIL);
    const configured = isConfigured();
    $('config-notice').hidden = configured;
    $('signin-btn').disabled = !configured;
    $('continue-btn').disabled = !configured;
    if (last) {
      $('continue-btn').hidden = false;
      $('continue-btn').textContent = 'Continue as ' + last;
      $('signin-btn').classList.remove('btn-primary');
      $('signin-btn-label').textContent = 'Use a different Google account';
    } else {
      $('continue-btn').hidden = true;
      $('signin-btn').classList.add('btn-primary');
      $('signin-btn-label').textContent = 'Sign in with Google';
    }
  }

  function renderAccount() {
    const u = state.user || {};
    $('account-email').textContent = u.email || '';
    $('account-menu-email').textContent = u.email || '';
    $('account-menu-name').textContent = u.name || '';
    $('account-menu-name').hidden = !u.name;
    $('account-btn').setAttribute('aria-label', 'Account: ' + (u.email || '') + '. Open account menu');
    const avatar = $('avatar');
    avatar.textContent = '';
    const initial = el('span', { text: ((u.name || u.email || '?').trim()[0] || '?').toUpperCase() });
    if (u.picture) {
      const img = el('img', { src: u.picture, alt: '', referrerpolicy: 'no-referrer', width: '32', height: '32' });
      img.addEventListener('error', () => { avatar.textContent = ''; avatar.append(initial); });
      avatar.append(img);
    } else {
      avatar.append(initial);
    }
  }

  function showScreen(signedIn) {
    $('signin-screen').hidden = signedIn;
    $('app').hidden = !signedIn;
  }

  function resetCollection() {
    state.accountEpoch++;
    state.store = null;
    state.recipes = [];
    state.loadError = null;
    state.query = '';
    state.selected.clear();
    state.deepIds = null;
    state.deepPending = false;
    deepSeq++;
    $('search-input').value = '';
    $('reauth-banner').hidden = true;
  }

  /** Sign in. mode: 'choose' opens Google's account chooser; 'continue' reuses the remembered account. */
  async function signIn(mode) {
    const switching = !!state.user;
    showNotice($('signin-error'), '');
    try {
      const hint = mode === 'continue' ? lsGet(LS_LAST_EMAIL) : null;
      const resp = await track(requestToken(mode === 'continue' ? '' : 'select_account', hint), 'Waiting for Google sign-in…');

      const previous = { token: state.token, tokenExpiry: state.tokenExpiry };
      state.token = resp.access_token;
      state.tokenExpiry = Date.now() + ((Number(resp.expires_in) || 3600) - 60) * 1000;
      let info;
      try {
        info = await track(api(USERINFO), 'Checking who is signed in…');
      } catch (err) {
        state.token = previous.token;
        state.tokenExpiry = previous.tokenExpiry;
        throw err;
      }
      if (!info || !info.email) throw new AppError('Google did not say which account signed in. Please try again.', 'auth');

      const sameAccount = switching && state.user.email === info.email;
      state.user = { email: info.email, name: info.name || '', picture: info.picture || '' };
      lsSet(LS_LAST_EMAIL, info.email);
      saveSession();
      renderAccount();
      $('reauth-banner').hidden = true;
      if (sameAccount && state.store) return; // same account chosen again: nothing to reload

      resetCollection();
      applyCache(); // if this account was used here before, show its recipes while Google loads
      showScreen(true);
      await loadAccount();
    } catch (err) {
      if (switching) { showError(err); return; }
      console.error(err);
      if (err.code !== 'cancelled') showNotice($('signin-error'), err.message || 'Sign-in failed.');
    }
  }

  function signOut() {
    const token = state.token;
    try {
      if (token && window.google && google.accounts && google.accounts.oauth2) {
        google.accounts.oauth2.revoke(token, () => {});
      }
    } catch (e) { console.warn('Could not revoke the token', e); }
    if (state.user) lsRemove(LS_CACHE + state.user.email);
    state.token = null;
    state.tokenExpiry = 0;
    state.user = null;
    clearSession();
    // The email address stays remembered so signing back in is one click
    // ("Continue as ..."). Only the address is kept: no token, no recipes.
    resetCollection();
    render();
    renderSignin();
    showScreen(false);
    ($('continue-btn').hidden ? $('signin-btn') : $('continue-btn')).focus();
  }

  async function reconnect() {
    try {
      const resp = await track(requestToken('', state.user && state.user.email), 'Reconnecting to Google…');
      applyToken(resp);
      $('reauth-banner').hidden = true;
      await refresh();
    } catch (err) {
      if (err.code !== 'cancelled') toast(err.message, { type: 'error' });
    }
  }

  /* ---- Staying signed in across visits ---- */

  function tryRenew() {
    return refreshToken().then(() => true, () => false);
  }

  /** Google's sign-in script loads asynchronously; wait briefly for it. */
  async function waitForGis() {
    for (let i = 0; i < 50; i++) {
      if (window.google && google.accounts && google.accounts.oauth2) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  }

  /**
   * Returning visit with an expired token. The remembered recipes are already
   * on screen. Try to renew with Google straight away; browsers often block
   * that without a click, in which case it happens on the first click instead.
   */
  async function resumeSilently() {
    const epoch = state.accountEpoch;
    if (!state.store) { state.loading = true; render(); }
    const renewed = (await waitForGis()) && (await tryRenew());
    if (epoch !== state.accountEpoch) return;
    state.loading = false;
    if (renewed) return state.store ? refresh() : loadAccount();
    if (state.store) {
      armGestureResume();
    } else {
      state.loadError = new AppError('Press Try again to reconnect to Google and load your recipes.', 'reauth');
      render();
    }
  }

  function armGestureResume() {
    const handler = (e) => {
      // Leave link clicks alone (they open a Doc) and anything in the account menu.
      if (e.target.closest && e.target.closest('a, .account, #reauth-banner')) return;
      document.removeEventListener('click', handler, true);
      if (!state.user || tokenIsFresh()) return;
      const epoch = state.accountEpoch;
      tryRenew().then((ok) => {
        if (ok && epoch === state.accountEpoch && !$('refresh-btn').disabled) refresh();
      });
    };
    document.addEventListener('click', handler, true);
  }

  /** First load for an account: find or create its files, then read the index. */
  async function loadAccount() {
    const epoch = state.accountEpoch;
    state.loading = true;
    state.loadError = null;
    render();
    try {
      await track(setupStorage(), 'Finding your Recipe Box in Google Drive…');
      if (epoch !== state.accountEpoch) return;
      await loadIndex();
    } catch (err) {
      if (epoch !== state.accountEpoch) return;
      state.loadError = err;
      showError(err);
    } finally {
      if (epoch === state.accountEpoch) {
        state.loading = false;
        render();
        if (state.deep) runDeepSearch();
      }
    }
  }

  async function refresh() {
    if (state.loading) return;
    if (!state.store) return loadAccount();
    const epoch = state.accountEpoch;
    const btn = $('refresh-btn');
    btn.disabled = true;
    btn.classList.add('is-spinning');
    state.loadError = null;
    try {
      await loadIndex();
    } catch (err) {
      if (epoch !== state.accountEpoch) return;
      if (err.code === 'notfound') {
        // The index Sheet was deleted: look for the files again (recreates what is missing).
        state.store = null;
        state.recipes = [];
        btn.disabled = false;
        btn.classList.remove('is-spinning');
        return loadAccount();
      }
      state.loadError = err;
      showError(err);
    } finally {
      btn.disabled = false;
      btn.classList.remove('is-spinning');
      if (epoch === state.accountEpoch) {
        render();
        if (state.deep) runDeepSearch();
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Wiring                                                              */
  /* ------------------------------------------------------------------ */

  function init() {
    // Tag inputs for the add/edit form
    const tagFields = $('tag-fields');
    TAG_TYPES.forEach((type) => {
      const input = createTagInput(type);
      tagInputs.push(input);
      tagFields.append(input.root);
    });

    const savedSort = lsGet(LS_SORT);
    if (savedSort === 'updated' || savedSort === 'title') state.sort = savedSort;
    $('sort-select').value = state.sort;

    // Sign-in screen
    $('signin-btn').addEventListener('click', () => signIn('choose'));
    $('continue-btn').addEventListener('click', () => signIn('continue'));

    // Header
    $('refresh-btn').addEventListener('click', refresh);
    $('account-btn').addEventListener('click', (e) => { e.stopPropagation(); toggleMenu($('account-btn')); });
    $('switch-btn').addEventListener('click', () => { closeMenus(); signIn('choose'); });
    $('signout-btn').addEventListener('click', () => { closeMenus(); signOut(); });
    $('reauth-btn').addEventListener('click', reconnect);

    // Search
    $('search-input').addEventListener('input', (e) => {
      state.query = e.target.value;
      if (state.deep) {
        state.deepIds = null;
        state.deepPending = state.query.trim().length >= 2;
        scheduleDeepSearch();
      }
      renderList();
    });
    $('deep-toggle').addEventListener('change', (e) => {
      state.deep = e.target.checked;
      $('deep-hint').hidden = !state.deep;
      $('search-input').placeholder = state.deep ? 'Search titles, tags and recipe text…' : 'Search titles and tags…';
      runDeepSearch();
    });
    $('sort-select').addEventListener('change', (e) => {
      state.sort = e.target.value;
      lsSet(LS_SORT, state.sort);
      renderList();
    });

    // Tag filter chips
    $('chip-groups').addEventListener('click', (e) => {
      const chip = e.target.closest('[data-chip]');
      if (!chip) return;
      const id = chip.getAttribute('data-chip');
      if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
      render();
      const again = document.querySelector('[data-chip="' + CSS.escape(id) + '"]');
      if (again) again.focus();
    });
    $('clear-filters-btn').addEventListener('click', () => {
      state.selected.clear();
      render();
      $('search-input').focus();
    });

    // Recipe cards: menu button + menu actions
    $('recipe-list').addEventListener('click', (e) => {
      const menuBtn = e.target.closest('[data-menu]');
      if (menuBtn) { e.stopPropagation(); toggleMenu(menuBtn); return; }
      const action = e.target.closest('[data-action]');
      if (!action) return;
      const recipe = state.recipes.find((r) => r.id === action.getAttribute('data-id'));
      closeMenus();
      if (!recipe) return;
      if (action.getAttribute('data-action') === 'edit') openRecipeDialog(recipe);
      else openDeleteDialog(recipe);
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.menu')) closeMenus();
    });
    document.addEventListener('keydown', onMenuKeydown);

    // Add / edit dialog
    $('add-btn').addEventListener('click', () => openRecipeDialog(null));
    $('recipe-form').addEventListener('submit', onSubmitRecipe);
    $('form-cancel').addEventListener('click', () => $('recipe-dialog').close());
    $('recipe-dialog').addEventListener('cancel', (e) => { if ($('form-save').disabled) e.preventDefault(); });

    // Delete dialog
    $('confirm-ok').addEventListener('click', onConfirmDelete);
    $('confirm-cancel').addEventListener('click', () => $('confirm-dialog').close());
    $('confirm-dialog').addEventListener('cancel', (e) => { if ($('confirm-ok').disabled) e.preventDefault(); });

    window.addEventListener('offline', () => toast('You are offline. Recipe Box needs an internet connection to reach Google Drive.', { type: 'error' }));

    renderSignin();

    // Returning visit: stay signed in. Show the remembered recipes at once,
    // then catch up with Google in the background.
    const session = isConfigured() ? loadSession() : null;
    if (session) {
      state.user = session.user;
      if (session.token && session.expiry > Date.now() + 30000) {
        state.token = session.token;
        state.tokenExpiry = session.expiry;
      }
      renderAccount();
      const cached = applyCache();
      showScreen(true);
      render();
      if (!tokenIsFresh()) resumeSilently();
      else if (cached) refresh();
      else loadAccount();
    } else {
      showScreen(false);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
