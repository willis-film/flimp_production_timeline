// ── dashboard.js ──────────────────────────────────────────────────────────
// Dashboard SPA — lists saved timelines, supports opening, reviewing,
// and saving new versions. Loaded only by dashboard.html.
// Imports from database.js and engine.js only — never touches ui.js.
// ─────────────────────────────────────────────────────────────────────────

import { fetchTimelines, fetchTimelineById, saveTimelineVersion, loadReferenceData } from './database.js';
import { fmtDateShort, esc } from './engine.js';

// ── Init ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Load reference data (needed for product/phase display)
  await loadReferenceData();

  // Pre-fill PM filter from localStorage
  const savedPm = localStorage.getItem('flimp_pm');
  const pmFilter = document.getElementById('dashPmFilter');
  if (savedPm && pmFilter) pmFilter.value = savedPm;

  pmFilter?.addEventListener('change', () => loadTimelines());
  document.getElementById('dashRefresh')?.addEventListener('click', () => loadTimelines());

  await loadTimelines();
});

// ── Load and render timeline list ─────────────────────────────────────────
async function loadTimelines() {
  const pmFilter = document.getElementById('dashPmFilter')?.value || null;
  const listEl   = document.getElementById('dashTimelineList');
  if (!listEl) return;

  listEl.innerHTML = '<div class="dash-loading">Loading timelines…</div>';

  try {
    const timelines = await fetchTimelines({ pm: pmFilter || undefined });
    renderTimelineList(timelines);
  } catch (err) {
    console.error('loadTimelines failed:', err);
    listEl.innerHTML = '<div class="dash-error">Failed to load timelines.</div>';
  }
}

// ── Render the list of timelines ──────────────────────────────────────────
function renderTimelineList(timelines) {
  const listEl = document.getElementById('dashTimelineList');
  listEl.innerHTML = '';

  if (!timelines.length) {
    listEl.innerHTML = '<div class="dash-empty">No timelines saved yet.</div>';
    return;
  }

  timelines.forEach(tl => {
    const card = document.createElement('div');
    card.className = 'dash-card';

    const versions = tl.timeline_versions || [];
    const latestVersion = Math.max(...versions.map(v => v.version_number), 0);

    card.innerHTML = `
      <div class="dash-card-main">
        <div class="dash-card-title">${esc(tl.project_name)}</div>
        <div class="dash-card-meta">${esc(tl.client_name)} &middot; PM: ${esc(tl.pm_name)}</div>
        <div class="dash-card-dates">
          Start: ${fmtDateShort(new Date(tl.start_date))}
          ${tl.due_date ? ` &middot; Due: ${fmtDateShort(new Date(tl.due_date))}` : ''}
          &middot; ${esc(String(tl.span_days))}d
        </div>
      </div>
      <div class="dash-card-actions">
        <span class="dash-version-badge">v${latestVersion}</span>
        <button class="dash-open-btn" data-id="${esc(String(tl.id))}">Open</button>
      </div>`;

    card.querySelector('.dash-open-btn').addEventListener('click', () => openTimeline(tl.id));
    listEl.appendChild(card);
  });
}

// ── Open a single timeline for review ────────────────────────────────────
async function openTimeline(id) {
  const detailEl = document.getElementById('dashDetail');
  if (!detailEl) return;

  detailEl.innerHTML = '<div class="dash-loading">Loading…</div>';
  detailEl.style.display = 'block';

  try {
    const tl = await fetchTimelineById(id);
    renderTimelineDetail(tl);
  } catch (err) {
    console.error('openTimeline failed:', err);
    detailEl.innerHTML = '<div class="dash-error">Failed to load timeline.</div>';
  }
}

// ── Render a single timeline detail view ─────────────────────────────────
function renderTimelineDetail(tl) {
  const detailEl = document.getElementById('dashDetail');

  // Latest version is first (ordered desc in fetchTimelineById)
  const latestVersion = tl.timeline_versions?.[0];
  if (!latestVersion) {
    detailEl.innerHTML = '<div class="dash-error">No versions found.</div>';
    return;
  }

  const milestoneGroups = JSON.parse(latestVersion.milestone_groups || '[]');
  // Rehydrate dates (stored as ISO strings in DB)
  milestoneGroups.forEach(g => { g.date = new Date(g.date); });

  const deliverables = JSON.parse(latestVersion.deliverables || '[]');
  const startDate    = new Date(tl.start_date);
  const dueDate      = tl.due_date ? new Date(tl.due_date) : null;

  detailEl.innerHTML = `
    <div class="dash-detail-header">
      <div>
        <div class="dash-detail-title">${esc(tl.project_name)}</div>
        <div class="dash-detail-meta">${esc(tl.client_name)} &middot; PM: ${esc(tl.pm_name)} &middot; v${latestVersion.version_number}</div>
      </div>
      <button class="dash-close-btn" id="dashCloseBtn">✕ Close</button>
    </div>
    <div class="dash-detail-body">
      <table class="unified-tl-table" id="dashTlTable">
        <thead>
          <tr>
            <th>Party</th><th>Deliverable</th><th>Task</th><th style="text-align:right">Due Date</th>
          </tr>
        </thead>
        <tbody id="dashTlBody"></tbody>
      </table>
    </div>`;

  document.getElementById('dashCloseBtn').addEventListener('click', () => {
    detailEl.style.display = 'none';
  });

  const tbody = document.getElementById('dashTlBody');
  milestoneGroups.forEach(group => {
    const tr = document.createElement('tr');
    if (group.isPastDue) tr.style.background = 'var(--red-bg)';
    // Prefer the display alias (set via the review-block rename) so the dashboard
    // matches what went out in the exports. Older saved versions have no label —
    // fall back to the canonical product name.
    const dels  = [...new Set(group.items.map(m => m.deliverableLabel || m.deliverable))].map(esc).join(', ');
    const tasks = [...new Set(group.items.map(m => m.task))].map(esc).join(', ');
    tr.innerHTML = `
      <td>${esc(group.owner)}</td>
      <td class="td-deliverable">${dels}</td>
      <td>${tasks}</td>
      <td class="td-date" style="${group.isPastDue ? 'color:var(--red)' : ''}">${fmtDateShort(group.date)}</td>`;
    tbody.appendChild(tr);
  });
}
