import { createClient } from "@supabase/supabase-js";

// Keys can come from (a) the single-file HTML (window globals you edit at the
// top of the file) or (b) a Vite .env file. Placeholders are treated as unset.
const isReal = (v) => !!v && !/^PALITAN|^__PALITAN|YOUR-/.test(String(v));
const winUrl = typeof window !== "undefined" ? window.__SUPABASE_URL__ : undefined;
const winKey = typeof window !== "undefined" ? window.__SUPABASE_ANON_KEY__ : undefined;
const SUPABASE_URL = isReal(winUrl) ? winUrl : import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = isReal(winKey) ? winKey : import.meta.env.VITE_SUPABASE_ANON_KEY;

export const CONFIGURED = isReal(SUPABASE_URL) && isReal(SUPABASE_ANON_KEY);
export const supabase = CONFIGURED ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

// ---------------- AUTH ----------------
export const auth = {
  async getSession() {
    const { data } = await supabase.auth.getSession();
    return data ? data.session : null;
  },
  onChange(cb) {
    const { data } = supabase.auth.onAuthStateChange((_e, session) => cb(session));
    return () => { try { data.subscription.unsubscribe(); } catch (e) {} };
  },
  async signIn(email, password) {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data.session;
  },
  async signUp(email, password, meta) {
    const { data, error } = await supabase.auth.signUp({
      email, password, options: { data: meta || {} },
    });
    if (error) throw error;
    return data;
  },
  async signOut() { try { await supabase.auth.signOut(); } catch (e) {} },
  async resetPassword(email) {
    const { error } = await supabase.auth.resetPasswordForEmail(email);
    if (error) throw error;
  },
  async getProfile(userId) {
    const { data, error } = await supabase.from("profiles").select("*").eq("id", userId).maybeSingle();
    if (error) throw error;
    if (data) return data;
    // fallback kung hindi tumakbo ang trigger
    const { data: made, error: e2 } = await supabase.from("profiles")
      .insert({ id: userId, full_name: "", position: "", unit: "AV" }).select().single();
    if (e2) throw e2;
    return made;
  },
  async updateProfile(userId, patch) {
    const { data, error } = await supabase.from("profiles").update(patch).eq("id", userId).select().single();
    if (error) throw error;
    return data;
  },
  async listProfiles() {
    const { data, error } = await supabase.from("profiles").select("*").order("full_name");
    if (error) throw error;
    return data || [];
  },
};

// row (Postgres) <-> record (app) mapping
const rowToRec = (r) => ({
  id: r.id,
  control: r.control || "",
  label: r.label || "",
  person: r.person || "",
  purpose: r.purpose || "",
  items: Array.isArray(r.items) ? r.items : [],
  requestedBy: r.requested_by || "",
  requestedDate: r.requested_date || "",
  authorizedBy: r.authorized_by || "",
  authorizedDate: r.authorized_date || "",
  status: r.status || "draft",
  sort: r.sort_key || "",
  releasedAt: r.released_at || null,
  returnedAt: r.returned_at || null,
  ownerId: r.owner_id || null,
  section: r.section || "",
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const recToRow = (r) => ({
  control: r.control || "",
  label: r.label || "",
  person: r.person || "",
  purpose: r.purpose || "",
  items: r.items || [],
  requested_by: r.requestedBy || "",
  requested_date: r.requestedDate || "",
  authorized_by: r.authorizedBy || "",
  authorized_date: r.authorizedDate || "",
  status: r.status || "draft",
  sort_key: r.sort || "",
  released_at: r.releasedAt || null,
  returned_at: r.returnedAt || null,
  owner_id: r.ownerId || null,
  section: r.section || "",
  updated_at: new Date().toISOString(),
});


// inventory row <-> app item.  NOTE: `qty` is the quantity/unit-of-issue text
// (kept in the `unit` DB column for backward compat); `section` is AV / DOSTv.
const rowToInv = (v) => ({
  id: v.id,
  desc: v.description || "",
  serial: v.serial || "",
  unit: v.unit || "1",
  section: v.section || "",
  category: v.category || "",
  acquiredDate: v.acquired_date || "",
  usefulLife: v.useful_life_years == null ? 5 : v.useful_life_years,
  assetStatus: v.asset_status || "serviceable",
  propertyNo: v.property_no || "",
  cost: v.acquisition_cost == null ? "" : String(v.acquisition_cost),
  notes: v.notes || "",
});

const invToRow = (it, isPatch) => {
  const row = {
    description: it.desc || "",
    serial: it.serial || "",
    unit: it.unit || "1",
    section: it.section || "",
    category: it.category || "",
    acquired_date: it.acquiredDate ? it.acquiredDate : null,
    useful_life_years: it.usefulLife === "" || it.usefulLife == null ? null : Number(it.usefulLife),
    asset_status: it.assetStatus || "serviceable",
    property_no: it.propertyNo || "",
    acquisition_cost: it.cost === "" || it.cost == null ? null : Number(it.cost),
    notes: it.notes || "",
  };
  if (isPatch) Object.keys(row).forEach((k) => { if (row[k] === undefined) delete row[k]; });
  return row;
};

export const db = {
  // ---- records ----
  async listRecords() {
    const { data, error } = await supabase.from("records").select("*").order("sort_key", { ascending: false });
    if (error) throw error;
    return (data || []).map(rowToRec);
  },
  async insertRecord(rec) {
    const { data, error } = await supabase.from("records").insert(recToRow(rec)).select().single();
    if (error) throw error;
    return rowToRec(data);
  },
  async updateRecord(rec) {
    const { data, error } = await supabase.from("records").update(recToRow(rec)).eq("id", rec.id).select().single();
    if (error) throw error;
    return rowToRec(data);
  },
  async deleteRecord(id) {
    const { error } = await supabase.from("records").delete().eq("id", id);
    if (error) throw error;
  },

  // ---- inventory ----
  async listInventory() {
    const { data, error } = await supabase.from("inventory").select("*").order("description");
    if (error) throw error;
    return (data || []).map(rowToInv);
  },
  async addInventory(it) {
    const { data, error } = await supabase.from("inventory").insert(invToRow(it)).select().single();
    if (error) throw error;
    return rowToInv(data);
  },
  async updateInventory(id, patch) {
    const { data, error } = await supabase.from("inventory").update(invToRow(patch, true)).eq("id", id).select().single();
    if (error) throw error;
    return rowToInv(data);
  },
  async deleteInventory(id) {
    const { error } = await supabase.from("inventory").delete().eq("id", id);
    if (error) throw error;
  },

  // ---- people ----
  async listPeople() {
    const { data, error } = await supabase.from("people").select("*").order("name");
    if (error) throw error;
    return (data || []).map((p) => ({ id: p.id, name: p.name, position: p.position || "" }));
  },
  async updatePerson(id, patch) {
    const { data, error } = await supabase.from("people")
      .update({ name: patch.name, position: patch.position || "" }).eq("id", id).select().single();
    if (error) throw error;
    return { id: data.id, name: data.name, position: data.position || "" };
  },
  async deletePerson(id) {
    const { error } = await supabase.from("people").delete().eq("id", id);
    if (error) throw error;
  },
  async addPerson(p) {
    const { data, error } = await supabase.from("people").insert({ name: p.name, position: p.position || "" }).select().single();
    if (error) throw error;
    return { id: data.id, name: data.name, position: data.position || "" };
  },

  // ---- settings ----
  async getSettings() {
    const { data, error } = await supabase.from("app_settings").select("data").eq("id", "default").maybeSingle();
    if (error) throw error;
    return data ? data.data : null;
  },
  async saveSettings(s) {
    const { error } = await supabase.from("app_settings").upsert({ id: "default", data: s, updated_at: new Date().toISOString() });
    if (error) throw error;
  },

  // ---- control number (atomic, server-side) ----
  async nextControl(prefix) {
    const { data, error } = await supabase.rpc("next_control", { p_prefix: prefix || "" });
    if (error) throw error;
    return data;
  },

  // ---- restore from a backup file (adds the backup's rows) ----
  async restore(parsed) {
    const recs = (parsed.records || []).map(recToRow);
    if (recs.length) { const { error } = await supabase.from("records").insert(recs); if (error) throw error; }
    const inv = (parsed.inventory || []).map((v) => invToRow(v));
    if (inv.length) { const { error } = await supabase.from("inventory").insert(inv); if (error) throw error; }
    const ppl = (parsed.people || []).filter((p) => p.name).map((p) => ({ name: p.name, position: p.position || "" }));
    if (ppl.length) { const { error } = await supabase.from("people").insert(ppl); if (error) throw error; }
    if (parsed.settings) { await this.saveSettings(parsed.settings); }
  },
};
