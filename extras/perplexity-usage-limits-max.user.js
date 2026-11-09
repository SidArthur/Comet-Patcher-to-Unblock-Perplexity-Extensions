// ==UserScript==
// @name         Perplexity – Usage Limits & Settings
// @namespace    https://perplexity.ai/
// @version      5.1.0-max
// @license MIT 
// @description  Draggable, resizable usage-limits panel with dark/light theme memory
// @author       userscript
// @match        https://www.perplexity.ai/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  /* ═══════════════════════════════════════════════════════════════════════════
   *  PERPLEXITY USAGE LIMITS & SETTINGS USERSCRIPT
   *  -----------------------------------------------------------------------------
   *  Overview:
   *  This script injects a draggable, resizable, and theme-aware UI panel into
   *  the Perplexity.ai web interface. The panel displays real-time usage limits
   *  (Pro searches, Research, Labs, etc.), MCP integrations, and critical user
   *  settings by intercepting Perplexity's internal API responses.
   *
   *  Architecture:
   *  1. CONFIG: Static mappings for limits, settings, and UI selectors.
   *  2. PREFERENCES: localStorage wrapper for saving panel state (position, size, theme).
   *  3. CSS: Injected styles for dark/light themes and panel components.
   *  4. HELPERS: Utility functions for data formatting and HTML generation.
   *  5. FETCH & RENDER: Core logic to authenticate, fetch API data, and update the DOM.
   *  6. EVENT HOOKS: Listens for user interactions (search submissions) to trigger refreshes.
   *  7. UI BEHAVIORS: Logic for dragging, resizing, and positioning the panel.
   *  8. BOOTSTRAP: Initialization logic and SPA (Single Page Application) route handling.
   * ═══════════════════════════════════════════════════════════════════════════ */

  // ── CONFIG ─────────────────────────────────────────────────────────────────
  /**
   * Defines the core search limits tracked by the panel.
   * `key` matches the property name returned by the `/rest/rate-limit/all` endpoint.
   * `total` is the known maximum limit (if null, it's treated as an uncapped/unbounded metric).
   */
  // Totals are per plan. The rate-limit API only returns *remaining* counts, so
  // totals come from this table, then self-correct: whenever the API reports a
  // remaining value higher than the table, that value becomes the new total
  // (stored per account in localStorage as a high-water mark).
  const PLAN_LIMITS = {
    pro: {
      remaining_pro:              { label: 'Pro',      total: 200  },
      remaining_research:         { label: 'Research', total: 20   },
      remaining_agentic_research: { label: 'Agentic',  total: null },
      remaining_labs:             { label: 'Labs',     total: 25   },
    },
    max: {
      remaining_pro:              { label: 'Pro',      total: 600  },
      remaining_research:         { label: 'Research', total: 200  },
      remaining_agentic_research: { label: 'Agentic',  total: 50   },
      remaining_labs:             { label: 'Labs',     total: 250  },
    },
  };
  let _planTier = null;   // raw tier string from /api/auth/session
  const planKey = () => {
    const t = String(_planTier || '').toLowerCase();
    if (t.includes('max')) return 'max';
    if (t.includes('pro'))  return 'pro';
    return null; // unknown → decide from observed numbers
  };
  const HWM_KEY = () => `pplx_panel_hwm_${_accountId || 'anon'}`;
  const loadHwm = () => { try { return JSON.parse(localStorage.getItem(HWM_KEY())) || {}; } catch { return {}; } };
  const saveHwm = o => { try { localStorage.setItem(HWM_KEY(), JSON.stringify(o)); } catch {} };
  /** Returns { label, total } for a limit key, using plan table + high-water mark. */
  function limitSpec(key, remaining) {
    const hwm = loadHwm();
    if (typeof remaining === 'number' && remaining > (hwm[key] || 0)) { hwm[key] = remaining; saveHwm(hwm); }
    let pk = planKey();
    if (!pk) pk = Object.keys(PLAN_LIMITS.pro).some(k => (hwm[k] || 0) > (PLAN_LIMITS.pro[k].total || 0)) ? 'max' : 'pro';
    const base = PLAN_LIMITS[pk][key];
    const total = Math.max(base.total || 0, hwm[key] || 0) || null;
    return { label: base.label, total, plan: pk };
  }
  const SEARCH_LIMITS = PLAN_LIMITS.pro; // key list only; totals resolved by limitSpec()

  /**
   * Defines the user settings fields displayed in the panel.
   * `type` determines how the value is rendered (e.g., booleans render as ✓/✗).
   */
  const SETTINGS_FIELDS = [
    { key: 'upload_limit',                   label: 'Upload Limit',      type: 'number' },
    { key: 'pages_limit',                    label: 'Pages Limit',       type: 'number' },
    { key: 'create_limit',                   label: 'Create Limit',      type: 'number' },
    { key: 'article_image_upload_limit',     label: 'Img Upload Limit',  type: 'number' },
    { key: 'daily_attachment_limit',         label: 'Daily Attachments', type: 'number' },
    { key: 'disable_training',               label: 'Training Disabled', type: 'bool'   },
    { key: 'has_ai_profile',                 label: 'AI Profile',        type: 'bool'   },
    { key: 'default_model',                  label: 'Default Model',     type: 'string' },
    { key: 'default_image_generation_model', label: 'Image Model',       type: 'string' },
    { key: 'default_video_generation_model', label: 'Video Model',       type: 'string' },
  ];

  /**
   * Mapping of internal MCP (Model Context Protocol) source keys to human-readable names.
   * This translates raw API identifiers into friendly labels for the UI.
   */
  const MCP_NAMES = {
    asana_mcp_merge:           'Asana',           box:                       'Box',
    cbinsights_mcp_cashmere:   'CBInsights',      confluence_mcp_merge:      'Confluence',
    crunchbase:                'Crunchbase',       dropbox:                   'Dropbox',
    factset:                   'FactSet',          gcal:                      'Google Calendar',
    github_mcp_direct:         'GitHub',           google_drive:              'Google Drive',
    jira_mcp_merge:            'Jira',             linear_alt:                'Linear',
    microsoft_teams_mcp_merge: 'MS Teams',         notion_mcp:                'Notion',
    onedrive:                  'OneDrive',         org:                       'Organization',
    outlook:                   'Outlook',          pitchbook_mcp_cashmere:    'Pitchbook',
    scholar:                   'Scholar',          sharepoint:                'SharePoint',
    slack_direct:              'Slack',            social:                    'Social',
    statista_mcp_cashmere:     'Statista',         web:                       'Web',
    wiley_mcp_cashmere:        'Wiley',
  };

  /**
   * CSS selectors used to identify Perplexity's search input fields.
   * Used for anchoring the panel near the input and hooking submission events.
   */
  const INPUT_SEL = [
    'textarea[placeholder]', '[data-testid="search-input"]',
    'div[contenteditable="true"]', '[role="textbox"]', 'form textarea',
  ].join(', ');

  // ── PREFERENCES (localStorage) ─────────────────────────────────────────────
  /**
   * Manages persistent user preferences using localStorage.
   * Stores panel coordinates, dimensions, and theme choice under a specific key.
   */
  const PREFS_KEY = 'pplx_panel_v5';
  const loadPrefs  = () => { try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch { return {}; } };
  const savePrefs  = patch => { try { localStorage.setItem(PREFS_KEY, JSON.stringify({ ...loadPrefs(), ...patch })); } catch {} };

  // ── CSS ────────────────────────────────────────────────────────────────────
  /**
   * Injects the styles required for the panel.
   * Uses CSS variables to support seamless switching between Dark (default) and Light themes.
   */
  document.head.appendChild(Object.assign(document.createElement('style'), { textContent: `

    /* ── CSS variables — dark (default) ─────────────────────── */
    #pplx-panel {
      --bg:        #1c1c1c;
      --bg-head:   rgba(255,255,255,0.025);
      --bg-foot:   rgba(255,255,255,0.01);
      --border:    rgba(255,255,255,0.09);
      --sep:       rgba(255,255,255,0.06);
      --track:     rgba(255,255,255,0.08);
      --hover:     rgba(255,255,255,0.035);
      --text:      #ededed;
      --lbl:       #95959d;
      --sec:       #a3a3a4;
      --dim:       #a0a0aa;
      --shadow:    0 0 0 0.5px rgba(255,255,255,0.04), 0 4px 8px rgba(0,0,0,0.3), 0 14px 32px rgba(0,0,0,0.5);
      --resize-bg: rgba(255,255,255,0.12);
      --cursor-drag: grab;
    }

    /* ── CSS variables — light ───────────────────────────────── */
    #pplx-panel.pp-light {
      --bg:        #ffffff;
      --bg-head:   rgba(0,0,0,0.015);
      --bg-foot:   rgba(0,0,0,0.01);
      --border:    rgba(0,0,0,0.1);
      --sep:       rgba(0,0,0,0.07);
      --track:     rgba(0,0,0,0.09);
      --hover:     rgba(0,0,0,0.03);
      --text:      #3f4145;
      --lbl:       #6b7280;
      --sec:       #5f636c;
      --dim:       #cecece;
      --time:      #616872;
      --shadow:    0 0 0 1px rgba(0,0,0,0.08), 0 4px 12px rgba(0,0,0,0.1), 0 12px 28px rgba(0,0,0,0.08);
      --resize-bg: rgba(0,0,0,0.12);
      --cursor-drag: grab;
    }

    /* ── Panel shell ─────────────────────────────────────────── */
    /* The main container. Fixed position to float above page content. */
    #pplx-panel {
      position: fixed;
      z-index: 99999;
      width: 222px;
      min-width: 185px;
      min-height: 180px;
      max-height: calc(100vh - 20px);
      display: flex;
      flex-direction: column;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 14px;
      overflow: hidden;
      color: var(--text);
      font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      font-size: 12.5px;
      line-height: 1.45;
      box-shadow: var(--shadow);
      transition: opacity 0.2s ease, box-shadow 0.2s ease;
      user-select: none;
    }
    #pplx-panel.pp-hidden { opacity: 0; pointer-events: none; }
    #pplx-panel.pp-dragging { transition: none; cursor: grabbing !important; box-shadow: var(--shadow), 0 0 0 2px #20b2aa44; }

    /* ── Header ─────────────────────────────────────────────── */
    /* Top bar of the panel, acts as the drag handle. */
    .pp-head {
      flex-shrink: 0;
      display: flex; align-items: center; justify-content: space-between;
      padding: 9px 11px 9px 13px;
      background: var(--bg-head);
      border-bottom: 1px solid var(--sep);
      cursor: var(--cursor-drag);
    }
    .pp-head-left { display: flex; align-items: center; gap: 7px; }
    .pp-head-label {
      font-size: 11px; font-weight: 600; letter-spacing: 0.3px;
      color: var(--lbl);
      pointer-events: none;
    }
    #pplx-countdown { font-size: 10px; font-weight: 400; color: #fbbf24; margin-left: 1px; }

    /* Status indicator dot. Live (green) or Pending (yellow). */
    .pp-dot {
      flex-shrink: 0;
      width: 6px; height: 6px; border-radius: 50%;
      background: var(--dim);
      transition: background 0.35s, box-shadow 0.35s;
      pointer-events: none;
    }
    .pp-dot.live    { background: #20b2aa; box-shadow: 0 0 0 3px rgba(32,178,170,0.2); }
    .pp-dot.pending { background: #fbbf24; box-shadow: 0 0 0 3px rgba(251,191,36,0.2); }

    .pp-head-actions { display: flex; gap: 1px; flex-shrink: 0; }
    .pp-btn-icon {
      appearance: none; background: none; border: none;
      padding: 3px 5px; border-radius: 6px; cursor: pointer;
      color: var(--sec); font-size: 13px; line-height: 1;
      transition: color 0.15s, background 0.15s;
    }
    .pp-btn-icon:hover { color: var(--text); background: var(--hover); }

    /* ── Scrollable body ─────────────────────────────────────── */
    /* Wrapper for the dynamic data content. */
    .pp-body {
      flex: 1;
      overflow-y: auto;
      overflow-x: hidden;
      min-height: 60px;
      padding: 4px 0 2px;
      scrollbar-width: thin;
      scrollbar-color: var(--dim) transparent;
    }

    /* ── Section label ───────────────────────────────────────── */
    .pp-sec {
      padding: 9px 13px 4px;
      font-size: 9.5px; font-weight: 700;
      letter-spacing: 0.9px; text-transform: uppercase;
      color: var(--sec);
    }
    .pp-sec.first { padding-top: 6px; }
    .pp-sep { height: 1px; margin: 4px 0; background: var(--sep); }

    /* ── Standard row ────────────────────────────────────────── */
    .pp-row {
      display: flex; align-items: center; justify-content: space-between;
      padding: 3.5px 13px; gap: 8px; min-height: 24px;
    }
    .pp-row:hover { background: var(--hover); }
    .pp-lbl { color: var(--lbl); font-size: 11.5px; white-space: nowrap; flex-shrink: 0; }
    .pp-val { font-size: 12px; font-weight: 600; text-align: right; color: var(--text); }

    /* Value color modifiers based on threshold/type */
    .pp-val.v-zero  { color: var(--dim); font-weight: 400; font-style: italic; }
    .pp-val.v-crit  { color: #f87171; }
    .pp-val.v-low   { color: #fb923c; }
    .pp-val.v-warn  { color: #fbbf24; }
    .pp-val.v-bool-y { color: #20b2aa; }
    .pp-val.v-bool-n { color: var(--lbl); font-weight: 400; }
    .pp-val.v-str    { color: #818cf8; font-weight: 500; font-size: 11px; }

    /* ── Search / MCP row (with bar) ─────────────────────────── */
    /* Specialized row that includes a visual progress bar. */
    .pp-bar-row {
      padding: 4px 13px 7px;
    }
    .pp-bar-row:hover { background: var(--hover); }
    .pp-bar-top {
      display: flex; align-items: baseline;
      justify-content: space-between;
      margin-bottom: 4px;
    }
    .pp-bar-count { font-size: 12px; font-weight: 600; color: var(--text); }
    .pp-bar-total { font-size: 10px; font-weight: 400; color: var(--dim); }
    .pp-track {
      height: 3px;
      background: var(--track);
      border-radius: 99px; overflow: hidden;
    }
    .pp-fill { height: 100%; border-radius: 99px; transition: width 0.55s cubic-bezier(.4,0,.2,1); }

    /* ── Footer ─────────────────────────────────────────────── */
    .pp-foot {
      flex-shrink: 0;
      display: flex; align-items: center; justify-content: space-between;
      padding: 5px 11px 6px 13px;
      border-top: 1px solid var(--sep);
      background: var(--bg-foot);
    }
    .pp-timestamp { font-size: 9.5px; color: var(--time); }
    .pp-btn-sm {
      appearance: none; background: none; cursor: pointer;
      border: 1px solid var(--border);
      border-radius: 6px; padding: 2px 9px;
      font-size: 10px; color: var(--sec);
      font-family: inherit;
      transition: border-color 0.15s, color 0.15s;
    }
    .pp-btn-sm:hover { border-color: var(--lbl); color: var(--text); }

    /* ── Resize handle (bottom-right corner) ─────────────────── */
    .pp-resize {
      position: absolute;
      bottom: 0; right: 0;
      width: 16px; height: 16px;
      cursor: se-resize;
      z-index: 10;
      background:
        linear-gradient(135deg,
          transparent 30%,
          var(--resize-bg) 30%, var(--resize-bg) 40%,
          transparent 40%,
          transparent 55%,
          var(--resize-bg) 55%, var(--resize-bg) 65%,
          transparent 65%
        );
      border-radius: 0 0 14px 0;
    }

    /* ── Toggle pill ─────────────────────────────────────────── */
    /* The floating button used to reopen the panel if closed. */
    #pplx-toggle {
      position: fixed; z-index: 99998;
      background: var(--bg, #1c1c1c);
      border: 1px solid var(--border, rgba(255,255,255,0.09));
      border-radius: 99px;
      height: 27px; padding: 0 11px;
      display: flex; align-items: center; gap: 5px;
      cursor: pointer;
      color: var(--sec, #52525b);
      font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      font-size: 10.5px; font-weight: 600; letter-spacing: 0.3px;
      white-space: nowrap;
      box-shadow: 0 2px 8px rgba(0,0,0,0.35);
      transition: border-color 0.15s, color 0.15s;
    }
    #pplx-toggle.pp-light {
      background: #ffffff;
      border-color: rgba(0,0,0,0.1);
      color: #6b7280;
      box-shadow: 0 2px 8px rgba(0,0,0,0.12);
    }
    #pplx-toggle:hover { border-color: var(--lbl, #71717a); color: var(--text, #ededed); }
    .pp-toggle-dot {
      width: 5px; height: 5px; border-radius: 50%;
      background: #3f3f46;
      transition: background 0.35s;
      flex-shrink: 0;
    }

    /* ── States ─────────────────────────────────────────────── */
    .pp-loading { padding: 18px 13px; text-align: center; font-size: 11px; color: var(--sec); }
    .pp-error   { padding: 8px 13px; font-size: 11px; color: #f87171; }
  ` }));

  // ── HELPERS ────────────────────────────────────────────────────────────────
  /**
   * Determines the fill color for the progress bar based on percentage remaining.
   * >60% = Green (safe), 25-60% = Yellow (warning), <25% = Red (critical).
   */
  const fillColor = pct => pct > 60 ? '#20b2aa' : pct > 25 ? '#fbbf24' : '#f87171';

  /**
   * Assigns a CSS class to search values based on the remaining count.
   * Provides visual cues for low limits.
   */
  function searchValClass(n) {
    if (n === 0)  return 'v-zero';
    if (n <= 3)   return 'v-crit';
    if (n <= 10)  return 'v-low';
    if (n <= 25)  return 'v-warn';
    return '';
  }

  /**
   * Formats a setting value for HTML rendering based on its declared type.
   */
  function settingRender(v, type) {
    if (v === null || v === undefined) return { html: '—', cls: 'v-zero' };
    if (type === 'bool')   return { html: v ? '✓' : '✗', cls: v ? 'v-bool-y' : 'v-bool-n' };
    if (type === 'string') return { html: v, cls: 'v-str' };
    return { html: String(v), cls: '' };
  }

  /**
   * Generates the HTML structure for a usage limit row, including the visual bar.
   */
  function barRowHTML(label, remaining, total) {
    const pct  = total > 0 ? Math.round((remaining / total) * 100) : 0;
    const col  = fillColor(pct);
    const vcls = searchValClass(remaining);
    return `<div class="pp-bar-row">
      <div class="pp-bar-top">
        <span class="pp-lbl">${label}</span>
        <span class="pp-bar-count ${vcls}">${remaining}<span class="pp-bar-total"> / ${total}</span></span>
      </div>
      <div class="pp-track"><div class="pp-fill" style="width:${pct}%;background:${col}"></div></div>
    </div>`;
  }

  // ── BUILD HTML ─────────────────────────────────────────────────────────────
  /**
   * Constructs the inner HTML for the panel body based on API responses.
   * Handles both standard rows and bar rows, gracefully filtering missing data.
   * 
   * @param {Object|null} rate - The rate limit data object.
   * @param {Object|null} settings - The user settings data object.
   * @returns {string} The raw HTML string to inject into the panel body.
   */
  function buildHTML(rate, settings) {
    let h = '<div class="pp-sec first">Searches</div>';

    // Render Search Limits
    if (rate) {
      Object.keys(SEARCH_LIMITS).forEach(key => {
        const remaining = rate[key];
        if (remaining === undefined) return;
        const { label, total } = limitSpec(key, remaining);
        if (total !== null) {
          h += barRowHTML(label, remaining, total);
        } else {
          const vcls = searchValClass(remaining);
          h += `<div class="pp-row"><span class="pp-lbl">${label}</span><span class="pp-val ${vcls}">${remaining}</span></div>`;
        }
      });
    } else {
      h += '<div class="pp-error">⚠ Rate limit data unavailable</div>';
    }

    // Render MCP (Model Context Protocol) Sources if available and active
    const mcpRaw = rate?.sources?.source_to_limit;
    if (mcpRaw) {
      const active = Object.entries(mcpRaw).filter(([, v]) => v.monthly_limit !== null && v.monthly_limit !== 0);
      if (active.length) {
        h += '<div class="pp-sep"></div><div class="pp-sec">MCP Sources</div>';
        active.forEach(([key, { monthly_limit, remaining }]) => {
          h += barRowHTML(MCP_NAMES[key] || key, remaining, monthly_limit);
        });
      }
    }

    // Render User Settings
    h += '<div class="pp-sep"></div><div class="pp-sec">Settings</div>';
    if (settings) {
      SETTINGS_FIELDS.forEach(({ key, label, type }) => {
        const raw = settings[key];
        if (raw === undefined) return;
        const { html: vhtml, cls } = settingRender(raw, type);
        h += `<div class="pp-row"><span class="pp-lbl">${label}</span><span class="pp-val ${cls}">${vhtml}</span></div>`;
      });
    } else {
      h += '<div class="pp-error">⚠ Settings data unavailable</div>';
    }
    return h;
  }

  // ── ACCOUNT RESOLUTION ─────────────────────────────────────────────────────
  /**
   * FIX: Multi-tenant Account Routing & Cloudflare WAF Requirements
   * 
   * Perplexity's API now strictly requires the `x-pplx-account` header to associate
   * requests with your Pro session. Without it, the API falls back to unauthenticated
   * responses, yielding `0` for all limits.
   * 
   * This variable caches the user ID so we only fetch it once per session.
   */
  let _accountId = null;

  /**
   * Fetches the current user's account ID from Perplexity's auth session endpoint.
   * 
   * @returns {Promise<string|null>} The account ID, or null if it cannot be resolved.
   */
  async function getAccountId() {
    if (_accountId) return _accountId;
    try {
      const res = await fetch('/api/auth/session?version=2.18&source=default', {
        credentials: 'include',
        headers: { 'x-app-apiclient': 'default', 'x-app-apiversion': '2.18' }
      });
      const data = await res.json();
      if (data?.user?.id) _accountId = data.user.id;
      _planTier = data?.user?.subscription_tier || data?.user?.payment_tier || _planTier;
      const lbl = document.querySelector('#pplx-panel .pp-head-label');
      if (lbl && planKey()) lbl.textContent = `Usage Limits · ${planKey() === 'max' ? 'Max' : 'Pro'}`;
    } catch (_) {}
    return _accountId;
  }

  // ── FETCH & RENDER ─────────────────────────────────────────────────────────
  /**
   * Core data-fetching function. 
   * Calls the rate-limit and settings endpoints in parallel, passing the required
   * headers and query parameters to bypass Cloudflare WAF and target the correct tenant.
   * Updates the UI DOM with the fetched data.
   */
  async function fetchAndRender() {
    const panel = document.getElementById('pplx-panel');
    if (!panel) return;
    const body  = panel.querySelector('.pp-body');
    const dot   = panel.querySelector('.pp-dot');
    const tdot  = document.querySelector('.pp-toggle-dot');
    const ts    = panel.querySelector('.pp-timestamp');
    const cd    = document.getElementById('pplx-countdown');

    // Set UI to pending state while fetching
    if (dot)  dot.classList.remove('live', 'pending');
    if (tdot) tdot.style.background = '#3f3f46';

    // Resolve Account ID prior to making data calls
    const acc = await getAccountId();
    
    // Construct mandatory headers required by Perplexity's updated API gateway
    const reqHeaders = {
      'x-app-apiclient': 'default',
      'x-app-apiversion': '2.18',
      ...(acc ? { 'x-pplx-account': acc } : {})
    };

    // Fetch both endpoints simultaneously. Promise.allSettled ensures that if one 
    // endpoint fails, the other can still render successfully.
    const [r1, r2] = await Promise.allSettled([
      fetch('/rest/rate-limit/all?version=2.18&source=default', { 
        credentials: 'include', 
        headers: reqHeaders 
      }).then(r => r.json()),
      fetch('/rest/user/settings?skip_connector_picker_credentials=true&version=2.18&source=default', { 
        credentials: 'include', 
        headers: reqHeaders 
      }).then(r => r.json()),
    ]);

    const rate     = r1.status === 'fulfilled' ? r1.value : null;
    const settings = r2.status === 'fulfilled' ? r2.value : null;

    // Inject generated HTML and restore UI to "live" state
    if (body) body.innerHTML = buildHTML(rate, settings);
    if (dot)  dot.classList.add('live');
    if (tdot) tdot.style.background = '#20b2aa';
    if (ts)   ts.textContent = new Date().toLocaleTimeString('en-CA', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
    if (cd)   cd.textContent = '';
  }

  // ── POST-QUERY REFRESH ─────────────────────────────────────────────────────
  let _rt = null, _ct = null; // Timers for refresh delay and countdown

  /**
   * Triggers a delayed refresh (3 seconds) to allow Perplexity's backend to update
   * usage counters after a user submits a query. Shows a visual countdown.
   */
  function scheduleRefresh() {
    clearTimeout(_rt); clearInterval(_ct);
    const dot  = document.querySelector('#pplx-panel .pp-dot');
    const tdot = document.querySelector('.pp-toggle-dot');
    const cd   = document.getElementById('pplx-countdown');
    
    // Set to pending state
    if (dot)  { dot.classList.remove('live'); dot.classList.add('pending'); }
    if (tdot) tdot.style.background = '#fbbf24';
    
    let s = 3;
    if (cd) cd.textContent = ` (${s}s)`;
    _ct = setInterval(() => { 
      s--; 
      if (cd) cd.textContent = s > 0 ? ` (${s}s)` : ''; 
      if (s <= 0) clearInterval(_ct); 
    }, 1000);
    
    // Execute refresh after 3 seconds
    _rt = setTimeout(() => { clearInterval(_ct); fetchAndRender(); }, 3000);
  }

  /**
   * Hooks into the native `window.fetch` and DOM input events to detect when 
   * the user submits a search query. 
   * Also passively captures the `x-pplx-account` header from Perplexity's own 
   * network requests to cache the account ID without making an extra API call.
   */
  function hookSubmitEvents() {
    const _orig = window.fetch;
    window.fetch = function (...a) {
      try {
        // Passively capture account ID from page's native requests
        const hdrs = a[1]?.headers;
        const acc = hdrs?.['x-pplx-account'] || (typeof hdrs?.get === 'function' ? hdrs.get('x-pplx-account') : null);
        if (acc) _accountId = acc;

        // If a POST request is made to the REST API (and isn't our own rate-limit/settings call), schedule a refresh.
        const url = typeof a[0] === 'string' ? a[0] : a[0] instanceof Request ? a[0].url : '';
        if ((a[1]?.method || 'GET').toUpperCase() === 'POST' &&
            url.includes('/rest/') && !url.includes('/rest/rate-limit') && !url.includes('/rest/user/settings'))
          scheduleRefresh();
      } catch (_) {}
      return _orig.apply(this, a);
    };
    
    // Listen for "Enter" key presses in search inputs
    document.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey &&
          (e.target.matches(INPUT_SEL) || !!e.target.closest('[role="textbox"],form')))
        scheduleRefresh();
    }, true);
    
    // Listen for clicks on submit/search buttons
    document.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      const lbl = (b.getAttribute('aria-label') || '').toLowerCase();
      if (b.type === 'submit' || lbl.includes('send') || lbl.includes('submit') || lbl.includes('search'))
        scheduleRefresh();
    }, true);
  }

  // ── THEME ──────────────────────────────────────────────────────────────────
  /**
   * Applies the selected theme (Dark or Light) to the panel and toggle button.
   * @param {boolean} isDark - If true, applies dark theme. If false, applies light theme.
   */
  function applyTheme(isDark) {
    const panel  = document.getElementById('pplx-panel');
    const toggle = document.getElementById('pplx-toggle');
    if (!panel) return;
    panel.classList.toggle('pp-light', !isDark);
    if (toggle) toggle.classList.toggle('pp-light', !isDark);
    const btn = panel.querySelector('[data-a="theme"]');
    if (btn) btn.textContent = isDark ? '☀' : '☾';
  }

  /**
   * Toggles the theme between dark and light, saving the preference to localStorage.
   */
  function toggleTheme() {
    const panel = document.getElementById('pplx-panel');
    if (!panel) return;
    const nowDark = panel.classList.contains('pp-light'); // was light → going dark
    applyTheme(nowDark);
    savePrefs({ dark: nowDark });
  }

  // ── DRAG ───────────────────────────────────────────────────────────────────
  /**
   * Attaches mouse event listeners to the panel header to allow the panel 
   * to be dragged freely across the viewport. 
   * Constrains movement to within the current window dimensions.
   */
  function makeDraggable(panel) {
    const handle = panel.querySelector('.pp-head');
    let sx = 0, sy = 0;

    handle.addEventListener('mousedown', e => {
      if (e.target.closest('button')) return; // Ignore drags starting on buttons
      e.preventDefault();
      const rect = panel.getBoundingClientRect();
      sx = e.clientX - rect.left;
      sy = e.clientY - rect.top;
      panel.classList.add('pp-dragging');

      const onMove = e => {
        let x = e.clientX - sx;
        let y = e.clientY - sy;
        // Boundary checks
        x = Math.max(0, Math.min(window.innerWidth  - panel.offsetWidth,  x));
        y = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, y));
        panel.style.left   = x + 'px';
        panel.style.top    = y + 'px';
        panel.style.bottom = 'auto';
        panel.style.right  = 'auto';
      };
      const onUp = () => {
        panel.classList.remove('pp-dragging');
        // Save final position
        savePrefs({ x: parseInt(panel.style.left), y: parseInt(panel.style.top), anchored: true });
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup',   onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup',   onUp);
    });
  }

  // ── RESIZE ─────────────────────────────────────────────────────────────────
  /**
   * Attaches mouse event listeners to the bottom-right corner handle to allow 
   * the panel to be resized. Enforces minimum width and height.
   */
  function makeResizable(panel) {
    const handle = panel.querySelector('.pp-resize');
    handle.addEventListener('mousedown', e => {
      e.preventDefault(); e.stopPropagation();
      const sx = e.clientX, sy = e.clientY;
      const sw = panel.offsetWidth, sh = panel.offsetHeight;

      const onMove = e => {
        const w = Math.max(185, sw + e.clientX - sx);
        const h = Math.max(180, sh + e.clientY - sy);
        panel.style.width  = w + 'px';
        panel.style.height = h + 'px';
      };
      const onUp = () => {
        // Save final dimensions
        savePrefs({ w: panel.offsetWidth, h: panel.offsetHeight });
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup',   onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup',   onUp);
    });
  }

  // ── POSITION (respects saved anchor) ───────────────────────────────────────
  /**
   * Calculates and applies the initial position for the panel and toggle button.
   * If the user has previously dragged the panel, it restores those coordinates.
   * Otherwise, it auto-anchors the panel next to the main search input field.
   */
  function positionPanel() {
    const panel  = document.getElementById('pplx-panel');
    const toggle = document.getElementById('pplx-toggle');
    if (!panel || !toggle) return;

    const prefs = loadPrefs();

    // Panel Positioning
    if (prefs.anchored && prefs.x !== undefined) {
      // Restore saved position
      const x = Math.max(0, Math.min(window.innerWidth  - panel.offsetWidth,  prefs.x));
      const y = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, prefs.y || 0));
      panel.style.left = x + 'px'; panel.style.top = y + 'px'; panel.style.bottom = 'auto';
    } else {
      // Auto-anchor to the left of the search input
      const inp = document.querySelector(INPUT_SEL);
      if (inp) {
        const r   = inp.getBoundingClientRect();
        const pw  = panel.offsetWidth || 222;
        const lft = Math.max(8, r.left - pw - 12);
        const ph  = panel.offsetHeight || 380;
        const top = Math.min(window.innerHeight - ph - 8, Math.max(8, r.top + r.height / 2 - ph / 2));
        panel.style.left = lft + 'px'; panel.style.top = top + 'px'; panel.style.bottom = 'auto';
      } else {
        // Fallback if no input is found
        panel.style.left = '12px'; panel.style.bottom = '90px'; panel.style.top = 'auto';
      }
    }

    // Toggle Button Positioning (always tracks the input box)
    const inp = document.querySelector(INPUT_SEL);
    if (inp) {
      const r   = inp.getBoundingClientRect();
      const pw  = panel.offsetWidth || 222;
      const lft = Math.max(8, r.left - pw - 12);
      toggle.style.left   = lft + 'px';
      toggle.style.bottom = (window.innerHeight - r.top + 10) + 'px';
      toggle.style.top    = 'auto';
    } else {
      toggle.style.left = '12px'; toggle.style.bottom = '58px'; toggle.style.top = 'auto';
    }
  }

  // ── INJECT ─────────────────────────────────────────────────────────────────
  /**
   * Constructs the panel DOM, appends it to the page body, and initializes 
   * all event listeners (drag, resize, buttons). Calls the first data fetch.
   */
  function inject() {
    if (document.getElementById('pplx-panel')) return; // Prevent double-injection

    const prefs  = loadPrefs();
    const isDark = prefs.dark !== false;

    // Build Main Panel
    const panel = document.createElement('div');
    panel.id = 'pplx-panel';
    panel.innerHTML = `
      <div class="pp-head">
        <div class="pp-head-left">
          <span class="pp-dot"></span>
          <span class="pp-head-label">Usage Limits</span>
          <span id="pplx-countdown"></span>
        </div>
        <div class="pp-head-actions">
          <button class="pp-btn-icon" data-a="theme"   title="Toggle theme">☀</button>
          <button class="pp-btn-icon" data-a="refresh" title="Refresh">↻</button>
          <button class="pp-btn-icon" data-a="close"   title="Hide">✕</button>
        </div>
      </div>
      <div class="pp-body"><div class="pp-loading">Loading…</div></div>
      <div class="pp-foot">
        <span class="pp-timestamp">—</span>
        <button class="pp-btn-sm" data-a="refresh">Refresh</button>
      </div>
      <div class="pp-resize" title="Resize"></div>
    `;

    // Apply saved dimensions
    if (prefs.w) panel.style.width  = prefs.w + 'px';
    if (prefs.h) panel.style.height = prefs.h + 'px';

    document.body.appendChild(panel);

    // Build Floating Toggle Button
    const toggle = document.createElement('button');
    toggle.id = 'pplx-toggle';
    toggle.innerHTML = '<span class="pp-toggle-dot"></span>Limits';
    document.body.appendChild(toggle);

    // Apply saved theme
    applyTheme(isDark);

    // Bind UI Actions
    panel.addEventListener('click', e => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'close')   panel.classList.add('pp-hidden');
      if (a === 'refresh') fetchAndRender();
      if (a === 'theme')   toggleTheme();
    });
    
    toggle.addEventListener('click', () => panel.classList.toggle('pp-hidden'));

    // Initialize behaviors
    makeDraggable(panel);
    makeResizable(panel);
    positionPanel();
    fetchAndRender();
    
    // Reposition on window resize
    window.addEventListener('resize', positionPanel);
  }

  // ── BOOT ───────────────────────────────────────────────────────────────────
  /**
   * Bootstraps the script. Hooks events immediately, but delays panel injection 
   * slightly to ensure Perplexity's SPA DOM has settled. 
   * Uses a MutationObserver to handle client-side route changes (navigating between pages).
   */
  hookSubmitEvents();
  
  const boot = () => setTimeout(inject, 1600);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // Monitor for SPA route changes
  let _lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== _lastUrl) {
      _lastUrl = location.href;
      // If URL changes, wait for DOM to update, then re-inject or reposition
      setTimeout(() => { 
        if (!document.getElementById('pplx-panel')) inject(); 
        else positionPanel(); 
      }, 1200);
    } else {
      // If DOM mutated but URL didn't, just reposition (e.g., input box moved)
      positionPanel();
    }
  }).observe(document.body, { childList: true, subtree: false });
  
  // Handle browser back/forward navigation
  window.addEventListener('popstate', () => setTimeout(positionPanel, 600));

})();