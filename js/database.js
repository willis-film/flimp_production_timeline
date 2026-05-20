// ── database.js ───────────────────────────────────────────────────────────
// Supabase client wrapper + all query and save functions.
// All other modules import data stores and query functions from here.
// The hosted Supabase instance is the backend — this file is the client-side
// interface to it.
// ─────────────────────────────────────────────────────────────────────────

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const SUPABASE_URL = 'https://dtyvyqdgbhabimcaczls.supabase.co';
const SUPABASE_KEY = 'sb_publishable_ppamkHmRjqIHKUzEk1wOIA_SYTo8EGF';

export const db = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Runtime data stores — populated by loadReferenceData() on init ─────────
// Exported so other modules can read them after init.
export let PRODUCTS       = [];   // [{group, color, items:[name,...]}]
export let NA_PRODUCTS    = new Set();
export let PM_ELIGIBLE    = new Set(); // products with eligible_pm = true
export let ROUNDS_DEFAULTS = {};  // {product: {new, renewal}}
export let ALL_PHASES     = {};   // {product_name: [{name,dur,owner,applies_to,...}]}
export let ROUND_GROUPS   = {};   // {product_name: [{group_name,default_rounds,...}]}
export let PRECONDITIONS  = {};   // {product_name: [{checklist_label,phase_name,applies_to}]}
export let VALID_PARENTS  = {};   // {child_product: Set([valid_parent_product,...])}

// ── Load all reference data from Supabase ─────────────────────────────────
export async function loadReferenceData() {
  try {
    const [
      { data: products,      error: e1 },
      { data: phases,        error: e2 },
      { data: roundGroups,   error: e3 },
      { data: preconditions, error: e4 },
      { data: relationships, error: e5 }
    ] = await Promise.all([
      db.from('products').select('*').eq('active', true).order('sort_order'),
      db.from('product_phases').select('*').order('phase_order'),
      db.from('round_groups').select('*').order('group_order'),
      db.from('phase_preconditions').select('*'),
      db.from('product_relationships').select('*')
    ]);

    if (e1 || e2 || e3 || e4 || e5) throw new Error((e1||e2||e3||e4||e5).message);

    // ── PRODUCTS grouped structure ──
    const groupMap = {};
    products.forEach(p => {
      if (!groupMap[p.group_name]) {
        groupMap[p.group_name] = { group: p.group_name, color: p.group_color, items: [] };
      }
      groupMap[p.group_name].items.push(p.name);
    });
    const GROUP_ORDER = ['Videos','Microsites','Traditional Media','Companion Piece'];
    PRODUCTS = Object.values(groupMap).sort((a,b) => {
      const ai = GROUP_ORDER.indexOf(a.group);
      const bi = GROUP_ORDER.indexOf(b.group);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });

    // ── NA_PRODUCTS ──
    NA_PRODUCTS = new Set(products.filter(p => p.is_not_renewable).map(p => p.name));

    // ── PM_ELIGIBLE ──
    PM_ELIGIBLE = new Set(products.filter(p => p.eligible_pm).map(p => p.name));

    // ── ROUNDS_DEFAULTS ──
    ROUNDS_DEFAULTS = {};
    products.forEach(p => {
      ROUNDS_DEFAULTS[p.name] = {
        new:     p.default_rounds         || 2,
        renewal: p.default_rounds_renewal || p.default_rounds || 2
      };
    });

    // ── ALL_PHASES ──
    ALL_PHASES = {};
    phases.forEach(ph => {
      if (!ALL_PHASES[ph.product_name]) ALL_PHASES[ph.product_name] = [];
      ALL_PHASES[ph.product_name].push({
        name:               ph.phase_name,
        dur:                ph.duration_standard || 1,
        durMin:             ph.duration_minimum  || 1,
        owner:              ph.owner || 'Flimp',
        applies_to:         ph.applies_to || 'both',
        renewal_phase_name: ph.renewal_phase_name || '',
        round_group_name:   ph.round_group_name   || '',
        is_milestone:       ph.is_milestone       || false,
        phase_order:        ph.phase_order
      });
    });
    Object.keys(ALL_PHASES).forEach(k => {
      ALL_PHASES[k].sort((a,b) => a.phase_order - b.phase_order);
    });

    // ── ROUND_GROUPS ──
    ROUND_GROUPS = {};
    roundGroups.forEach(rg => {
      if (!ROUND_GROUPS[rg.product_name]) ROUND_GROUPS[rg.product_name] = [];
      ROUND_GROUPS[rg.product_name].push({
        group_name:         rg.group_name,
        default_rounds:     rg.default_rounds || 2,
        group_order:        rg.group_order,
        is_user_adjustable: rg.is_user_adjustable !== false
      });
    });

    // ── PRECONDITIONS ──
    PRECONDITIONS = {};
    preconditions.forEach(pc => {
      if (!PRECONDITIONS[pc.product_name]) PRECONDITIONS[pc.product_name] = [];
      PRECONDITIONS[pc.product_name].push({
        checklist_label: pc.checklist_label,
        phase_name:      pc.phase_name,
        applies_to:      pc.applies_to || 'both'
      });
    });

    // ── VALID_PARENTS ──
    VALID_PARENTS = {};
    relationships.forEach(r => {
      if (!VALID_PARENTS[r.child_product]) VALID_PARENTS[r.child_product] = new Set();
      VALID_PARENTS[r.child_product].add(r.valid_parent_product);
    });

    return true;
  } catch (err) {
    console.error('loadReferenceData failed:', err);
    return false;
  }
}

// ── Save a timeline to Supabase ────────────────────────────────────────────
// Inserts into `timelines` and an initial row in `timeline_versions`.
// Returns { timelineId } on success, throws on failure.
export async function saveTimelineToDb({ pm, client, project, startDate, dueDate, milestoneGroups, deliverables, projectSpanDays }) {
  // Clamp string lengths before insert — Supabase parameterizes so no SQL injection
  // risk, but unbounded strings could hit DB column limits.
  const safe = str => String(str || '').trim().slice(0, 255);

  const { data: tlData, error: tlErr } = await db
    .from('timelines')
    .insert({
      pm_name:      safe(pm),
      client_name:  safe(client),
      project_name: safe(project),
      start_date:   startDate,
      due_date:     dueDate || null,
      span_days:    projectSpanDays,
      created_at:   new Date().toISOString()
    })
    .select('id')
    .single();

  if (tlErr) throw tlErr;

  const { error: vErr } = await db
    .from('timeline_versions')
    .insert({
      timeline_id:     tlData.id,
      version_number:  1,
      milestone_groups: JSON.stringify(milestoneGroups),
      deliverables:    JSON.stringify(deliverables),
      created_at:      new Date().toISOString()
    });

  if (vErr) throw vErr;

  return { timelineId: tlData.id };
}

// ── Fetch all timelines for dashboard ─────────────────────────────────────
export async function fetchTimelines({ pm } = {}) {
  let query = db
    .from('timelines')
    .select('*, timeline_versions(version_number, created_at)')
    .order('created_at', { ascending: false });

  if (pm) query = query.eq('pm_name', pm);

  const { data, error } = await query;
  if (error) throw error;
  return data;
}

// ── Fetch a single timeline with its latest version ───────────────────────
export async function fetchTimelineById(id) {
  const { data, error } = await db
    .from('timelines')
    .select('*, timeline_versions(*)')
    .eq('id', id)
    .order('version_number', { foreignTable: 'timeline_versions', ascending: false })
    .single();

  if (error) throw error;
  return data;
}

// ── Save a new version of an existing timeline ────────────────────────────
export async function saveTimelineVersion({ timelineId, milestoneGroups, deliverables }) {
  // Get current max version number
  const { data: versions } = await db
    .from('timeline_versions')
    .select('version_number')
    .eq('timeline_id', timelineId)
    .order('version_number', { ascending: false })
    .limit(1);

  const nextVersion = versions?.[0]?.version_number + 1 || 1;

  const { error } = await db
    .from('timeline_versions')
    .insert({
      timeline_id:      timelineId,
      version_number:   nextVersion,
      milestone_groups: JSON.stringify(milestoneGroups),
      deliverables:     JSON.stringify(deliverables),
      created_at:       new Date().toISOString()
    });

  if (error) throw error;
  return { version: nextVersion };
}
