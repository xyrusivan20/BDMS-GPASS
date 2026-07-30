import { useState, useEffect, useRef, useMemo } from "react";
import {
  Printer, Plus, Trash2, Search, Save, Copy, Pencil, Package,
  FileText, Settings, X, Check, RotateCcw, Download, Eye, Star,
  Archive, AlertTriangle, ChevronDown, ChevronUp, ClipboardList,
  QrCode, Camera, History, Tag, Lock, LogOut, ShieldCheck, CalendarClock
} from "lucide-react";
import qrcode from "qrcode-generator";
import { db, auth, CONFIGURED } from "./db.js";
import { LETTERHEAD } from "./letterhead.js";

const MONTHS = ["JANUARY","FEBRUARY","MARCH","APRIL","MAY","JUNE","JULY","AUGUST","SEPTEMBER","OCTOBER","NOVEMBER","DECEMBER"];
const MON3 = { JAN:1, FEB:2, MAR:3, APR:4, MAY:5, JUN:6, JUL:7, AUG:8, SEP:9, OCT:10, NOV:11, DEC:12 };

const PAPERS = {
  legal:  { w: "8.5in", h: "14in", label: "Legal (8.5 × 14 in) — original" },
  folio:  { w: "8.5in", h: "13in", label: "Long / Folio (8.5 × 13 in)" },
  a4:     { w: "210mm", h: "297mm", label: "A4 (210 × 297 mm)" },
  letter: { w: "8.5in", h: "11in", label: "Letter (8.5 × 11 in)" },
};

// Sinukat na kapasidad kada papel (konserbatibo — mahabang description ang basehan).
// 2 kopya kada page ay kasya lang sa Legal/Folio; masyadong maikli ang A4/Letter.
const PAGE_FIT = {
  legal:  { 2: 12, 1: 26 },
  folio:  { 2: 11, 1: 26 },
  a4:     { 2: 0,  1: 24 },
  letter: { 2: 0,  1: 22 },
};
const fitLimit = (paper, copies) => {
  const t = PAGE_FIT[paper] || PAGE_FIT.legal;
  return t[copies === 1 ? 1 : 2];
};

const DEFAULT_SETTINGS = {
  appName: "Gate Pass System",
  formCode: "FR-FAD-GSPS No.002\nRev.04 (23 May 2025)",
  title: "GATE PASS",
  controlLabel: "Control No.",
  authPre: "To Guard on duty:  This authorizes",
  authPost: "to bring out the following property/ies,",
  purposeLabel: "Purpose/Activity/Event:",
  requestedLabel: "Requested by:",
  authorizedLabel: "Authorized by:",
  defaultAuthorizedBy: "ARLENE E. CENTENO / FAD-Chief",
  instructionsLabel: "Instructions:",
  instructions: [
    "This form must be filled-up completely/prepared in (2) copies: Original copy-Security Guard's File; Duplicate copy-Requestor's File,",
    "To be filed at least one (1) day before inclusive date of request",
    "For accountability, only permanent employees may sign as requestor",
    "Original copy to be turned over by the Security Guard on duty to the GSPS every Monday of the succeeding week",
  ],
  cols: {
    qty: "Qty./\nUnit",
    desc: "ARTICLES / Item Description (Brand, Model)",
    serial: "Serial No. / Property No. \n(if available)",
    out: "Date & Time the equipment is taken out",
    guard: "FOR GUARD USE ONLY",
    chkOut: "Checked & Inspected \nby the Guard on duty\n(name & signature)",
    ret: "Date & Time the equipment is returned",
    chkIn: "Checked & Inspected \nby the Guard on duty\n(name & signature)",
    remarks: "Remarks",
  },
  letterheadMode: "default", // "default" | "custom" | "text"
  letterheadCustom: "",
  orgLines: ["Republic of the Philippines", "YOUR ORGANIZATION NAME", "Address line, City"],
  paper: "legal",
  copies: 2,
  minRows: 11,
  controlAuto: true,
  controlPrefix: "",
  overdueDays: 7,
  sections: ["AV", "DOSTv"],
};

const uid = () => "r-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
const pad3 = (n) => String(n).padStart(3, "0");
const todayFmt = () => {
  const d = new Date();
  return String(d.getDate()).padStart(2, "0") + " " + MONTHS[d.getMonth()] + " " + d.getFullYear();
};
const sortKeyFromDate = (str) => {
  if (!str) return "";
  const m = String(str).match(/(\d{1,2})\s+([A-Za-z]+)\.?\s+(\d{4})/);
  if (!m) return "";
  const mm = MON3[m[2].toUpperCase().slice(0, 3)] || 0;
  if (!mm) return "";
  return m[3] + "-" + String(mm).padStart(2, "0") + "-" + String(m[1]).padStart(2, "0");
};

// ---- equipment checkout lifecycle ----
const CONDITIONS = ["OK", "Needs Repair", "Damaged", "For Incident Report", "Lost"];
const BAD_CONDITIONS = ["Needs Repair", "Damaged", "For Incident Report", "Lost"];

// unique identity of a physical item: serial first, else description
const itemKey = (it) => {
  const sn = (it.serial || "").trim().toUpperCase();
  if (sn) return "SN:" + sn;
  const d = (it.desc || "").trim().toUpperCase();
  return d ? "D:" + d : "";
};

// a pass whose gear is released and not yet returned
const isOut = (rec) => (rec.status === "released" || rec.status === "printed") && !rec.returnedAt;

const daysSince = (iso) => {
  if (!iso) return 0;
  const then = new Date(iso).getTime();
  if (isNaN(then)) return 0;
  return Math.floor((Date.now() - then) / 86400000);
};
const outSince = (rec) => rec.releasedAt || rec.createdAt || null;
const isOverdue = (rec, days) => isOut(rec) && daysSince(outSince(rec)) > (days || 7);

// build a map of every item currently OUT -> the record holding it (optionally excluding one record id)
const buildOutMap = (records, excludeId) => {
  const map = {};
  for (const r of records) {
    if (r.id === excludeId) continue;
    if (!isOut(r)) continue;
    for (const it of r.items || []) {
      const k = itemKey(it);
      if (k && !map[k]) map[k] = { record: r, item: it };
    }
  }
  return map;
};

// month helpers for the report (works off sort_key / dates)
const monthKey = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
const recordMonth = (rec) => {
  const k = rec.sort || sortKeyFromDate(rec.requestedDate);
  return k ? k.slice(0, 7) : "";
};
const isoMonth = (iso) => {
  if (!iso) return "";
  const dt = new Date(iso);
  return isNaN(dt.getTime()) ? "" : monthKey(dt);
};
const csvCell = (v) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

// full lifecycle of one physical item across all passes
const itemHistory = (records, key) => {
  const rows = [];
  for (const r of records) {
    for (const it of r.items || []) {
      if (itemKey(it) === key) {
        rows.push({
          control: r.control || "", label: r.label || "", person: r.person || r.requestedBy || "",
          date: r.requestedDate || "", status: r.status,
          returnedAt: r.returnedAt, condition: it.returnedCondition || "", remarks: it.returnedRemarks || "",
          sort: r.sort || sortKeyFromDate(r.requestedDate),
        });
        break;
      }
    }
  }
  return rows.sort((a, b) => (b.sort || "").localeCompare(a.sort || ""));
};

// ---- asset lifecycle / Estimated Useful Life (EUL) ----
// Sa GAM, ang EUL ay management prerogative ng ahensya. Defaults lang ito;
// i-adjust ayon sa karanasan ng opisina at sa Property Officer / COA.
const ASSET_STATUS = [
  { id: "serviceable", label: "Serviceable" },
  { id: "for_repair", label: "For Repair" },
  { id: "unserviceable", label: "Unserviceable" },
  { id: "disposed", label: "Disposed" },
];
const CATEGORY_EUL = [
  { id: "", label: "— walang kategorya —", eul: 5 },
  { id: "camera", label: "Camera / Lens", eul: 5 },
  { id: "computer", label: "Computer / Laptop", eul: 5 },
  { id: "lighting", label: "Lighting", eul: 7 },
  { id: "audio", label: "Audio", eul: 7 },
  { id: "support", label: "Tripod / Support / Rig", eul: 10 },
  { id: "network", label: "Network / Streaming", eul: 5 },
  { id: "furniture", label: "Furniture / Fixtures", eul: 10 },
  { id: "other", label: "Iba pa", eul: 5 },
];
const eulForCategory = (cat) => {
  const c = CATEGORY_EUL.find((x) => x.id === (cat || ""));
  return c ? c.eul : 5;
};

const ageYears = (acquired) => {
  if (!acquired) return null;
  const d = new Date(acquired);
  if (isNaN(d.getTime())) return null;
  return (Date.now() - d.getTime()) / (365.25 * 86400000);
};

// Returns {code, label, pct, age, tone}. Hindi automatic na disposal ang
// paglampas sa EUL — "for evaluation" ang tamang tawag.
const lifeStatus = (item) => {
  const manual = item.assetStatus || "serviceable";
  if (manual === "disposed") return { code: "disposed", label: "Disposed", tone: "muted", pct: 1, age: ageYears(item.acquiredDate) };
  if (manual === "unserviceable") return { code: "unserviceable", label: "Unserviceable", tone: "bad", pct: 1, age: ageYears(item.acquiredDate) };
  if (manual === "for_repair") return { code: "for_repair", label: "For Repair", tone: "warn", pct: null, age: ageYears(item.acquiredDate) };
  const age = ageYears(item.acquiredDate);
  const eul = Number(item.usefulLife) || 0;
  if (age == null) return { code: "nodate", label: "Walang petsa ng bili", tone: "muted", pct: null, age: null };
  if (!eul) return { code: "noeul", label: "Walang EUL", tone: "muted", pct: null, age };
  const pct = age / eul;
  if (pct >= 1) return { code: "beyond", label: "Lampas EUL — for evaluation", tone: "bad", pct, age };
  if (pct >= 0.8) return { code: "nearing", label: "Malapit nang mag-EUL", tone: "warn", pct, age };
  return { code: "ok", label: "Serviceable", tone: "ok", pct, age };
};

const fmtAge = (age) => (age == null ? "—" : age.toFixed(1) + " taon");

// bilang ng beses na na-flag na sira ang isang item (repair history)
const repairCount = (records, key) =>
  records.reduce((n, r) => n + (r.items || []).filter(
    (it) => itemKey(it) === key && BAD_CONDITIONS.includes(it.returnedCondition)
  ).length, 0);

// QR code as a data URL (encodes the serial string)
const qrDataUrl = (text, cell = 4) => {
  try {
    const qr = qrcode(0, "M");
    qr.addData(String(text || ""));
    qr.make();
    return qr.createDataURL(cell, 8);
  } catch (e) { return ""; }
};

function mergeSettings(loaded) {
  const s = loaded || {};
  return { ...DEFAULT_SETTINGS, ...s, cols: { ...DEFAULT_SETTINGS.cols, ...(s.cols || {}) } };
}

// ------------------------------------------------------------------
// STYLES — app chrome + tumpak na print form
// ------------------------------------------------------------------

const CSS = `
:root {
  --ink: #1B2A3A;
  --paper: #EFE9DC;
  --card: #FFFDF7;
  --line: #CDC3AC;
  --line-soft: #E0D8C4;
  --blue: #1D5FAF;
  --blue-dark: #164A8A;
  --red: #B3382E;
  --green: #2F6B4E;
  --tan: #E7DCC2;
  --mono: ui-monospace, "Cascadia Mono", "SF Mono", Menlo, Consolas, monospace;
  --sans: -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
}
#gp-app { background: var(--paper); color: var(--ink); font-family: var(--sans); min-height: 100vh; }
.ui-eyebrow { font-family: var(--mono); font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; color: #6B6350; }
.ui-mono { font-family: var(--mono); }
.ui-card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; }
.ui-input, .ui-select, .ui-textarea {
  width: 100%; background: #fff; border: 1px solid var(--line); border-radius: 7px;
  padding: 8px 10px; font-size: 14px; color: var(--ink); font-family: var(--sans);
}
.ui-input:focus, .ui-select:focus, .ui-textarea:focus { outline: 2px solid var(--blue); outline-offset: 0; border-color: var(--blue); }
.ui-label { display: block; font-family: var(--mono); font-size: 10.5px; letter-spacing: 0.1em; text-transform: uppercase; color: #6B6350; margin-bottom: 4px; }
.ui-btn {
  display: inline-flex; align-items: center; gap: 6px; border-radius: 8px; cursor: pointer;
  font-size: 13.5px; font-weight: 600; padding: 8px 13px; border: 1px solid var(--line);
  background: #fff; color: var(--ink); transition: background 0.12s, border-color 0.12s;
}
.ui-btn:hover { background: #F6F1E4; }
.ui-btn:focus-visible { outline: 2px solid var(--blue); outline-offset: 1px; }
.ui-btn-primary { background: var(--blue); border-color: var(--blue-dark); color: #fff; }
.ui-btn-primary:hover { background: var(--blue-dark); }
.ui-btn-danger { color: var(--red); border-color: #D8B0AA; }
.ui-btn-danger:hover { background: #F9EDEB; }
.ui-btn-ghost { border-color: transparent; background: transparent; }
.ui-btn-ghost:hover { background: #EFE8D8; }
.ui-btn[disabled] { opacity: 0.5; cursor: not-allowed; }
.ui-tab {
  display: inline-flex; align-items: center; gap: 7px; padding: 9px 14px; font-size: 13.5px; font-weight: 600;
  border: 1px solid transparent; border-bottom: none; border-radius: 10px 10px 0 0; color: #6B6350; cursor: pointer; background: transparent;
  white-space: nowrap;
}
.ui-tab.active { background: var(--card); border-color: var(--line); color: var(--ink); }
.stamp {
  font-family: var(--mono); font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase;
  border: 1.5px dashed currentColor; border-radius: 4px; padding: 2px 7px; transform: rotate(-2deg); display: inline-block;
}
.stamp-draft { color: #8A7F63; }
.stamp-printed { color: var(--blue); }
.stamp-imported { color: var(--green); }
.stamp-out { color: #B5761C; }
.stamp-returned { color: var(--green); }
.stamp-overdue { color: var(--red); border-style: solid; }
.conflict-banner {
  border: 1px solid #D8B0AA; background: #F9EDEB; border-radius: 9px; padding: 10px 12px; margin-bottom: 12px; font-size: 13px;
}
.conflict-banner b { color: var(--red); }
.pill {
  display: inline-flex; align-items: center; gap: 4px; font-family: var(--mono); font-size: 10px; letter-spacing: 0.06em;
  padding: 1px 7px; border-radius: 999px; text-transform: uppercase;
}
.pill-out { background: #F6E4CC; color: #8A5A12; }
.pill-ok { background: #DCEBE1; color: #2F6B4E; }
.pill-bad { background: #F5DDD9; color: #8C2F25; }
.pill-warn { background: #F6E4CC; color: #8A5A12; }
.pill-muted { background: #E7E1D2; color: #6B6350; }
.pill-unit { background: #DEE7F3; color: #1D5FAF; }
/* text overflow fixes — mahaba ang placeholder sa maliit na screen */
.ui-input, .ui-select { text-overflow: ellipsis; min-width: 0; }
.ui-input::placeholder { overflow: hidden; text-overflow: ellipsis; }
.search-wrap { flex: 1 1 220px; min-width: 0; }
.truncate-1 { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.lifebar { height: 5px; border-radius: 999px; background: #E7E1D2; overflow: hidden; margin-top: 5px; }
.lifebar > i { display: block; height: 100%; border-radius: 999px; }
.locked { opacity: 0.55; }
.authwrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
.dash-strip { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 14px; }
.dash-tile { flex: 1 1 120px; border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; background: var(--card); }
.dash-tile .n { font-size: 22px; font-weight: 700; line-height: 1; }
.dash-tile .l { font-family: var(--mono); font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: #6B6350; margin-top: 4px; }
.dash-tile.alert .n { color: var(--red); }
.dash-tile.warn .n { color: #B5761C; }
.rpt { background: #fff; color: #000; font-family: Arial, Helvetica, sans-serif; }
.rpt h2 { font-size: 15pt; margin: 0 0 2px; }
.rpt .sub { font-size: 9pt; color: #333; margin-bottom: 10px; }
.rpt h3 { font-size: 11pt; border-bottom: 1.5px solid #000; padding-bottom: 2px; margin: 14px 0 6px; }
.rpt table { width: 100%; border-collapse: collapse; font-size: 8.5pt; }
.rpt th, .rpt td { border: 1px solid #000; padding: 3px 5px; text-align: left; vertical-align: top; }
.rpt th { background: #eee; }
.rpt .muted { color: #555; font-style: italic; }
.rec-card { position: relative; }
.rec-tab {
  position: absolute; top: -9px; left: 12px; background: var(--tan); border: 1px solid var(--line);
  border-radius: 6px 6px 0 0; font-family: var(--mono); font-size: 10px; letter-spacing: 0.08em;
  padding: 1px 9px; color: #5D543E; max-width: 70%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.toast-box {
  position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%); z-index: 90;
  background: var(--ink); color: #fff; font-size: 13.5px; padding: 9px 16px; border-radius: 9px;
  box-shadow: 0 6px 18px rgba(0,0,0,0.25);
}

/* ---------------- FORM (parehong preview at print) ---------------- */
.gpsheet { background: #fff; width: 816px; padding: 20px 22px; box-shadow: 0 3px 14px rgba(27,42,58,0.18); }
.gpcopy { font-family: Arial, Helvetica, sans-serif; color: #000; width: 100%; }
.gphead { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; margin-bottom: 2px; }
.gplh { width: 60%; }
.gplh img { width: 100%; height: auto; display: block; }
.gporg { line-height: 1.22; padding: 1px 0; }
.gporg .l1 { font-size: 8.5pt; }
.gporg .l2 { font-size: 11.5pt; font-weight: bold; }
.gporg .l3 { font-size: 8.5pt; }
.gpcode { width: 27%; text-align: center; font-size: 8.5pt; font-weight: bold; white-space: pre-line; line-height: 1.2; padding-top: 3px; }
.gpbox { border: 1.5px solid #000; }
.gptitlerow { display: flex; border-bottom: 1px solid #000; }
.gptitle { width: 64%; text-align: center; font-size: 12.5pt; font-weight: bold; padding: 1px 0 1px; }
.gpctrl { width: 36%; border-left: 1px solid #000; font-size: 8.5pt; font-weight: bold; padding: 3px 6px 2px; display: flex; align-items: flex-start; gap: 6px; }
.gpctrlval { font-weight: bold; }
.gpauth { font-size: 8.5pt; font-weight: bold; padding: 3px 5px 3px 6px; min-height: 0.26in; display: flex; align-items: center; }
.gptable { width: 100%; border-collapse: collapse; table-layout: fixed; }
.gptable th, .gptable td { border: 1px solid #000; vertical-align: middle; word-wrap: break-word; }
.gptable th { font-size: 7pt; font-weight: bold; text-align: center; padding: 1px 2px; white-space: pre-line; line-height: 1.1; overflow-wrap: anywhere; }
.gptable th:first-child, .gptable td:first-child { border-left: 0; }
.gptable th:last-child, .gptable td:last-child { border-right: 0; }
.gptable thead tr:first-child th { border-top: 0; }
.gpitems td { font-size: 8pt; height: 14.5pt; padding: 1px 4px; line-height: 1.12; }
.gpitems .c { text-align: center; }
.gpitems .b { font-weight: bold; }
.gppurpose td {
  border-left: 0; border-right: 0; border-bottom: 0; font-size: 8.5pt; font-weight: bold;
  padding: 2px 4px 2px 5px; text-align: left; height: auto;
}
.gpsig { display: flex; padding: 5px 7px 6px 7px; font-size: 8.5pt; }
.gpsig .col-l { width: 50%; padding-right: 20px; }
.gpsig .col-r { width: 50%; padding-left: 6px; }
.gpsig .lbl { font-weight: bold; }
.gpsig .space { height: 12px; }
.gpsig .line { border-bottom: 1px solid #000; width: 82%; }
.gpsig .nm { font-weight: bold; margin-top: 1px; min-height: 11pt; }
.gpsig .dt { margin-top: 4px; }
.gpinstr { margin-top: 3px; font-size: 7pt; line-height: 1.2; }
.gpinstr .lbl { font-size: 8pt; font-weight: bold; }
.gpcut { border-top: 1.3px dashed #555; margin: 6px 0 6px; }

/* preview wrapper */
.gp-preview-scroll { overflow: auto; }

/* ---------------- PRINT ---------------- */
#print-root { display: none; }
@media print {
  body { background: #fff !important; }
  body * { visibility: hidden !important; }
  #print-root, #print-root * { visibility: visible !important; }
  #print-root { display: block !important; position: absolute; left: 0; top: 0; width: 100%; }
  #print-root .gpsheet { width: 100%; padding: 0; box-shadow: none; }
  .gpcopy { break-inside: avoid; page-break-inside: avoid; }
}
`;

// ------------------------------------------------------------------
// FORM COMPONENTS — sinusunod ang eksaktong layout ng FR-FAD-GSPS 002
// ------------------------------------------------------------------
function Letterhead({ s }) {
  if (s.letterheadMode === "custom" && s.letterheadCustom) {
    return <img src={s.letterheadCustom} alt="Letterhead" />;
  }
  if (s.letterheadMode === "text") {
    const [l1, l2, ...rest] = s.orgLines && s.orgLines.length ? s.orgLines : ["", "", ""];
    return (
      <div className="gporg">
        <div className="l1">{l1}</div>
        <div className="l2">{l2}</div>
        {rest.map((ln, i) => <div key={i} className="l3">{ln}</div>)}
      </div>
    );
  }
  return <img src={LETTERHEAD} alt="Letterhead" />;
}

function FormCopy({ rec, s }) {
  const count = Math.max(s.minRows || 11, (rec.items || []).length);
  const rows = Array.from({ length: count }, (_, i) => rec.items[i] || { qty: "", desc: "", serial: "", out: "" });
  return (
    <div className="gpcopy">
      <div className="gphead">
        <div className="gplh"><Letterhead s={s} /></div>
        <div className="gpcode">{s.formCode}</div>
      </div>
      <div className="gpbox">
        <div className="gptitlerow">
          <div className="gptitle">{s.title}</div>
          <div className="gpctrl">
            <span>{s.controlLabel}</span>
            <span className="gpctrlval">{rec.control}</span>
          </div>
        </div>
        <div className="gpauth">
          <span>
            {"\u00A0\u00A0"}{s.authPre}{" "}
            <b>{rec.person || "\u00A0".repeat(30)}</b>{" "}
            {s.authPost}
          </span>
        </div>
        <table className="gptable">
          <colgroup>
            <col style={{ width: "8.6%" }} />
            <col style={{ width: "25.7%" }} />
            <col style={{ width: "14.3%" }} />
            <col style={{ width: "10.5%" }} />
            <col style={{ width: "8.9%" }} />
            <col style={{ width: "10.4%" }} />
            <col style={{ width: "8.1%" }} />
            <col style={{ width: "13.5%" }} />
          </colgroup>
          <thead>
            <tr>
              <th rowSpan={2}>{s.cols.qty}</th>
              <th rowSpan={2}>{s.cols.desc}</th>
              <th rowSpan={2}>{s.cols.serial}</th>
              <th rowSpan={2}>{s.cols.out}</th>
              <th colSpan={4}>{s.cols.guard}</th>
            </tr>
            <tr>
              <th>{s.cols.chkOut}</th>
              <th>{s.cols.ret}</th>
              <th>{s.cols.chkIn}</th>
              <th>{s.cols.remarks}</th>
            </tr>
          </thead>
          <tbody className="gpitems">
            {rows.map((it, i) => (
              <tr key={i}>
                <td className="c">{it.qty}</td>
                <td>{it.desc}</td>
                <td className="c">{it.serial}</td>
                <td className="c b">{it.out}</td>
                <td></td>
                <td></td>
                <td></td>
                <td></td>
              </tr>
            ))}
          </tbody>
          <tbody className="gppurpose">
            <tr>
              <td colSpan={8}>{"\u00A0"}{s.purposeLabel} {rec.purpose}</td>
            </tr>
          </tbody>
        </table>
        <div className="gpsig">
          <div className="col-l">
            <div className="lbl">{s.requestedLabel}</div>
            <div className="space"></div>
            <div className="line"></div>
            <div className="nm">{rec.requestedBy}</div>
            <div className="dt">Date: {rec.requestedDate}</div>
          </div>
          <div className="col-r">
            <div className="lbl">{s.authorizedLabel}</div>
            <div className="space"></div>
            <div className="line"></div>
            <div className="nm">{rec.authorizedBy}</div>
            <div className="dt">Date: {rec.authorizedDate || "__________________________________"}</div>
          </div>
        </div>
      </div>
      <div className="gpinstr">
        <div className="lbl">{s.instructionsLabel}</div>
        {(s.instructions || []).map((ln, i) => <div key={i}>{ln}</div>)}
      </div>
    </div>
  );
}

function PrintSheet({ rec, s }) {
  const copies = Math.max(1, Math.min(2, s.copies || 2));
  return (
    <div className="gpsheet">
      {Array.from({ length: copies }, (_, i) => (
        <div key={i}>
          {i > 0 && <div className="gpcut"></div>}
          <FormCopy rec={rec} s={s} />
        </div>
      ))}
    </div>
  );
}

function ScaledForm({ rec, s }) {
  const wrapRef = useRef(null);
  const innerRef = useRef(null);
  const [dim, setDim] = useState({ scale: 0.5, h: 500 });
  useEffect(() => {
    const measure = () => {
      const w = wrapRef.current ? wrapRef.current.clientWidth : 816;
      const scale = Math.min(1, w / 816);
      const ih = innerRef.current ? innerRef.current.offsetHeight : 1000;
      setDim({ scale, h: ih * scale });
    };
    measure();
    const t = setTimeout(measure, 80);
    let ro = null;
    if (typeof ResizeObserver !== "undefined" && wrapRef.current) {
      ro = new ResizeObserver(measure);
      ro.observe(wrapRef.current);
      if (innerRef.current) ro.observe(innerRef.current);
    }
    window.addEventListener("resize", measure);
    return () => {
      clearTimeout(t);
      window.removeEventListener("resize", measure);
      if (ro) ro.disconnect();
    };
  }, [rec, s]);
  return (
    <div ref={wrapRef} className="w-full" style={{ height: dim.h }}>
      <div style={{ transform: "scale(" + dim.scale + ")", transformOrigin: "top left", width: 816 }}>
        <div ref={innerRef} className="gpsheet">
          <FormCopy rec={rec} s={s} />
        </div>
      </div>
    </div>
  );
}

function Stamp({ status, overdue }) {
  if (overdue) return <span className="stamp stamp-overdue">OVERDUE</span>;
  const map = {
    draft: { cls: "stamp stamp-draft", txt: "DRAFT" },
    printed: { cls: "stamp stamp-out", txt: "OUT" },
    released: { cls: "stamp stamp-out", txt: "OUT" },
    returned: { cls: "stamp stamp-returned", txt: "RETURNED" },
    imported: { cls: "stamp stamp-imported", txt: "ARCHIVE" },
  };
  const m = map[status] || map.draft;
  return <span className={m.cls}>{m.txt}</span>;
}

// ------------------------------------------------------------------
// EDITOR VIEW
// ------------------------------------------------------------------
function EditorView({ draft, setDraft, data, onSave, onPrint, onNew, addInventory, toast }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickQ, setPickQ] = useState("");
  const [showPreview, setShowPreview] = useState(false);
  const [outAll, setOutAll] = useState("");
  const [allowConflict, setAllowConflict] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const s = data.settings;
  const outMap = data.outMap || {};

  useEffect(() => { setAllowConflict(false); }, [draft.id]);

  const conflicts = useMemo(() => {
    const list = [];
    const seen = {};
    (draft.items || []).forEach((it, idx) => {
      const k = itemKey(it);
      if (!k) return;
      if (outMap[k]) {
        const r = outMap[k].record;
        list.push({ idx, type: "out", label: it.desc || it.serial, control: r.control, person: r.person, date: r.requestedDate });
      }
      if (seen[k] != null) list.push({ idx, type: "dup", label: it.desc || it.serial });
      else seen[k] = idx;
    });
    return list;
  }, [draft.items, outMap]);
  const hasConflict = conflicts.length > 0;
  const conflictByIdx = useMemo(() => {
    const m = {};
    conflicts.forEach((c) => { (m[c.idx] = m[c.idx] || []).push(c); });
    return m;
  }, [conflicts]);
  const guardedSave = () => { if (hasConflict && !allowConflict) { toast("Resolbahin muna ang equipment conflict (o i-override)"); return; } onSave(); };
  const guardedPrint = () => { if (hasConflict && !allowConflict) { toast("Resolbahin muna ang equipment conflict (o i-override)"); return; } onPrint(); };

  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const setItem = (i, patch) =>
    setDraft((d) => ({ ...d, items: d.items.map((it, j) => (j === i ? { ...it, ...patch } : it)) }));
  const addItem = () => setDraft((d) => ({ ...d, items: [...d.items, { qty: "1", desc: "", serial: "", out: "" }] }));
  const removeItem = (i) => setDraft((d) => ({ ...d, items: d.items.filter((_, j) => j !== i) }));

  const inInv = (it) =>
    data.inventory.some(
      (v) => v.desc.trim().toUpperCase() === (it.desc || "").trim().toUpperCase() &&
             (v.serial || "").trim().toUpperCase() === (it.serial || "").trim().toUpperCase()
    );

  const addFromInv = (v) => {
    setDraft((d) => ({ ...d, items: [...d.items.filter((x) => x.desc || x.serial), { qty: v.unit || "1", desc: v.desc, serial: v.serial, out: outAll || "" }] }));
    toast("Naidagdag: " + v.desc.slice(0, 40));
  };

  const saveItemToInv = (i) => {
    const it = draft.items[i];
    if (!it.desc) { toast("Walang description ang item"); return; }
    if (inInv(it)) { toast("Nasa inventory na ito"); return; }
    addInventory({ desc: it.desc, serial: it.serial || "", unit: it.qty || "1" });
    toast("Na-save sa inventory");
  };

  const handleScan = (code) => {
    setScanOpen(false);
    const norm = (code || "").trim().toUpperCase();
    if (!norm) return;
    const v = data.inventory.find((x) => (x.serial || "").trim().toUpperCase() === norm);
    if (v) {
      const outRef = outMap[itemKey(v)];
      if (outRef) { toast("OUT na: " + v.desc.slice(0, 28) + " (nasa " + (outRef.record.control || "ibang pass") + ")"); return; }
      addFromInv(v);
      return;
    }
    setDraft((d) => ({ ...d, items: [...d.items.filter((x) => x.desc || x.serial), { qty: "1", desc: "", serial: code.trim(), out: outAll || "" }] }));
    toast("Serial " + code.trim() + ": wala sa inventory — nilagay bilang bagong item");
  };

  const applyOutAll = () => {
    if (!outAll) return;
    setDraft((d) => ({ ...d, items: d.items.map((it) => ({ ...it, out: outAll })) }));
    toast("Nailagay sa lahat ng items");
  };

  const filteredInv = useMemo(() => {
    const q = pickQ.trim().toLowerCase();
    const list = q
      ? data.inventory.filter((v) => (v.desc + " " + v.serial).toLowerCase().includes(q))
      : data.inventory;
    return list.slice(0, 60);
  }, [pickQ, data.inventory]);

  const itemCount = draft.items.filter((x) => x.desc || x.serial).length;
  const copies = Math.max(1, Math.min(2, s.copies || 2));
  const limit = fitLimit(s.paper, copies);
  const overflow = itemCount > limit;

  return (
    <div className="xl:flex xl:gap-5 items-start">
      {/* LEFT: entry */}
      <div className="w-full xl:w-1/2 min-w-0">
        <div className="ui-card p-4 md:p-5">
          <div className="flex items-center justify-between gap-3 mb-4">
            <div>
              <div className="ui-eyebrow">{draft.id ? "Ine-edit" : "Bagong gate pass"}</div>
              <div className="ui-mono text-lg font-bold">{draft.control || "— walang control no. —"}</div>
            </div>
            <button className="ui-btn ui-btn-ghost" onClick={onNew} title="Bagong blankong pass">
              <RotateCcw size={15} /> Bago
            </button>
          </div>

          <div className="grid grid-cols-12 gap-3">
            <div className="col-span-12 md:col-span-7">
              <label className="ui-label">Reference / pangalan ng record</label>
              <input className="ui-input" value={draft.label} placeholder="hal. NS - BESPREN GOODIES 12-14 JULY"
                onChange={(e) => set({ label: e.target.value })} />
            </div>
            <div className="col-span-12 md:col-span-5">
              <label className="ui-label">Control No.</label>
              <input className="ui-input ui-mono" value={draft.control}
                onChange={(e) => set({ control: e.target.value })} />
            </div>
            <div className="col-span-12">
              <label className="ui-label">Sino ang dadala (authorizes)</label>
              <input className="ui-input" value={draft.person}
                placeholder="hal. JUAN A. DELA CRUZ, MARIA B. SANTOS, and PEDRO C. REYES"
                onChange={(e) => set({ person: e.target.value })} />
            </div>
            <div className="col-span-12">
              <label className="ui-label">Purpose / Activity / Event</label>
              <textarea className="ui-textarea" rows={2} value={draft.purpose}
                onChange={(e) => set({ purpose: e.target.value })} />
            </div>
          </div>

          {/* ITEMS */}
          <div className="mt-5">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
              <div className="ui-eyebrow">Mga gamit — {itemCount} item{itemCount === 1 ? "" : "s"}</div>
              <div className="flex gap-2">
                <button className="ui-btn" onClick={() => setScanOpen(true)}><Camera size={15} /> Scan</button>
                <button className="ui-btn" onClick={() => setPickerOpen(!pickerOpen)}>
                  <Package size={15} /> Mula sa inventory {pickerOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                </button>
                <button className="ui-btn" onClick={addItem}><Plus size={15} /> Item</button>
              </div>
            </div>

            {pickerOpen && (
              <div className="ui-card p-3 mb-3" style={{ background: "#F7F2E6" }}>
                <div className="relative mb-2">
                  <Search size={15} className="absolute left-3 top-3 opacity-50" />
                  <input className="ui-input pl-9" placeholder="Hanapin sa inventory (description o serial)…"
                    value={pickQ} onChange={(e) => setPickQ(e.target.value)} />
                </div>
                <div className="overflow-y-auto" style={{ maxHeight: 230 }}>
                  {filteredInv.length === 0 && <div className="text-sm opacity-60 py-2 px-1">Walang tumugma.</div>}
                  {filteredInv.map((v) => {
                    const outRef = outMap[itemKey(v)];
                    return (
                      <button key={v.id} disabled={!!outRef} onClick={() => addFromInv(v)}
                        className={"w-full text-left flex items-center gap-2 px-2 py-2 rounded-md " + (outRef ? "opacity-60 cursor-not-allowed" : "hover:bg-white")}
                        title={outRef ? "OUT — nasa " + (outRef.record.control || "ibang pass") + ", hindi pa naisasauli" : ""}>
                        {outRef ? <span className="pill pill-out shrink-0">OUT</span> : <Plus size={14} className="shrink-0 opacity-60" />}
                        <span className="text-sm flex-1 min-w-0 truncate">{v.desc}</span>
                        <span className="ui-mono text-xs opacity-60 shrink-0">{v.serial}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2 mb-3">
              <input className="ui-input" style={{ maxWidth: 260 }} placeholder='Date & time out (hal. "as needed")'
                value={outAll} onChange={(e) => setOutAll(e.target.value)} />
              <button className="ui-btn" onClick={applyOutAll}>Ilapat sa lahat</button>
            </div>

            <div className="flex flex-col gap-2">
              {draft.items.map((it, i) => (
                <div key={i} className="ui-card p-3" style={{ background: "#FFFEFA" }}>
                  <div className="grid grid-cols-12 gap-2">
                    <div className="col-span-3 sm:col-span-2">
                      <label className="ui-label">Qty/Unit</label>
                      <input className="ui-input" value={it.qty} onChange={(e) => setItem(i, { qty: e.target.value })} />
                    </div>
                    <div className="col-span-9 sm:col-span-10">
                      <label className="ui-label">Article / description (brand, model)</label>
                      <input className="ui-input" value={it.desc} onChange={(e) => setItem(i, { desc: e.target.value })} />
                    </div>
                    <div className="col-span-6 sm:col-span-5">
                      <label className="ui-label">Serial / property no.</label>
                      <input className="ui-input ui-mono" value={it.serial} onChange={(e) => setItem(i, { serial: e.target.value })} />
                    </div>
                    <div className="col-span-6 sm:col-span-4">
                      <label className="ui-label">Date & time out</label>
                      <input className="ui-input" value={it.out} onChange={(e) => setItem(i, { out: e.target.value })} />
                    </div>
                    <div className="col-span-12 sm:col-span-3 flex items-end justify-end gap-1">
                      <button className="ui-btn ui-btn-ghost" title="I-save sa inventory" onClick={() => saveItemToInv(i)}>
                        <Star size={15} fill={inInv(it) ? "currentColor" : "none"} />
                      </button>
                      <button className="ui-btn ui-btn-ghost ui-btn-danger" title="Tanggalin" onClick={() => removeItem(i)}>
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </div>
                  {conflictByIdx[i] && conflictByIdx[i].map((c, ci) => (
                    <div key={ci} className="text-xs mt-2" style={{ color: "var(--red)" }}>
                      {c.type === "out"
                        ? "\u26A0 OUT on " + (c.control || "another pass") + (c.person ? " (" + c.person + ")" : "") + " — not yet returned."
                        : "\u26A0 Duplicate item in this pass."}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>

          {/* SIGNATORIES */}
          <div className="grid grid-cols-12 gap-3 mt-5">
            <div className="col-span-12 md:col-span-7">
              <label className="ui-label">Requested by (PANGALAN / Position)</label>
              <input className="ui-input" list="gp-people" value={draft.requestedBy}
                onChange={(e) => set({ requestedBy: e.target.value })} />
              <datalist id="gp-people">
                {data.people.map((p, i) => (
                  <option key={i} value={p.name + (p.position ? " / " + p.position : "")} />
                ))}
              </datalist>
            </div>
            <div className="col-span-12 md:col-span-5">
              <label className="ui-label">Petsa ng request</label>
              <input className="ui-input" value={draft.requestedDate}
                onChange={(e) => set({ requestedDate: e.target.value })} />
            </div>
            <div className="col-span-12 md:col-span-7">
              <label className="ui-label">Authorized by</label>
              <input className="ui-input" value={draft.authorizedBy}
                onChange={(e) => set({ authorizedBy: e.target.value })} />
            </div>
            <div className="col-span-12 md:col-span-5">
              <label className="ui-label">Petsa ng approval (optional)</label>
              <input className="ui-input" value={draft.authorizedDate} placeholder="blank = may guhit"
                onChange={(e) => set({ authorizedDate: e.target.value })} />
            </div>
          </div>

          {overflow && (
            <div className="conflict-banner mt-5" style={{ borderColor: "#D9C08A", background: "#FBF3E0" }}>
              <div className="flex items-start gap-2">
                <AlertTriangle size={16} className="shrink-0" style={{ color: "#8A5A12", marginTop: 2 }} />
                <div className="text-xs">
                  <b style={{ color: "#8A5A12" }}>Baka lumagpas sa isang pahina.</b>{" "}
                  {limit === 0
                    ? "Ang " + (PAPERS[s.paper] ? PAPERS[s.paper].label.split(" (")[0] : s.paper) + " ay masikip para sa 2 kopya kada page. Palitan ang papel sa Legal/Folio, o gawing 1 kopya kada page sa Format tab."
                    : "Mga " + limit + " item lang ang kasya sa " + (PAPERS[s.paper] ? PAPERS[s.paper].label.split(" (")[0] : s.paper) + " kapag " + copies + " kopya kada page — " + itemCount + " ang nakalista. Pwedeng hatiin sa dalawang pass, o gawing 1 kopya kada page sa Format tab."}
                </div>
              </div>
            </div>
          )}

          {hasConflict && (
            <div className="conflict-banner mt-5">
              <div className="flex items-start gap-2">
                <AlertTriangle size={16} className="shrink-0" style={{ color: "var(--red)", marginTop: 2 }} />
                <div className="flex-1">
                  <b>Equipment conflict — {conflicts.length} issue{conflicts.length === 1 ? "" : "s"}.</b>
                  <ul className="mt-1" style={{ listStyle: "disc", paddingLeft: 18 }}>
                    {conflicts.map((c, i) => (
                      <li key={i} className="mt-0.5">
                        {c.type === "out"
                          ? <>“{c.label}” is still <b>OUT</b> on <span className="ui-mono">{c.control || "another pass"}</span>{c.person ? " (" + c.person + ")" : ""}{c.date ? ", " + c.date : ""} — not yet returned. Mark that pass <b>Returned</b> first, or remove this item.</>
                          : <>“{c.label}” is listed twice in this pass.</>}
                      </li>
                    ))}
                  </ul>
                  <label className="flex items-center gap-2 text-xs mt-2">
                    <input type="checkbox" checked={allowConflict} onChange={(e) => setAllowConflict(e.target.checked)} />
                    Override — issue anyway (para sa exception lang, hal. naisauli na pero hindi pa na-mark)
                  </label>
                </div>
              </div>
            </div>
          )}

          {/* ACTIONS */}
          <div className="flex flex-wrap gap-2 mt-6">
            <button className="ui-btn ui-btn-primary" onClick={guardedPrint}><Printer size={15} /> I-print / PDF</button>
            <button className="ui-btn" onClick={guardedSave}><Save size={15} /> I-save</button>
            <button className="ui-btn xl:hidden" onClick={() => setShowPreview(true)}><Eye size={15} /> Silipin</button>
          </div>
          <div className="text-xs opacity-60 mt-3">
            Tip: sa print dialog, piliin ang "Save as PDF" kung gusto mo ng PDF copy imbes na papel.
          </div>
        </div>
      </div>

      {/* RIGHT: live preview (desktop) */}
      <div className="hidden xl:block xl:w-1/2 min-w-0">
        <div className="ui-eyebrow mb-2">Live preview — ganito ang lalabas sa print</div>
        <ScaledForm rec={draft} s={s} />
      </div>

      {/* Mobile preview overlay */}
      {showPreview && (
        <div className="fixed inset-0 z-50 overflow-y-auto p-3" style={{ background: "rgba(27,42,58,0.92)" }}>
          <div className="flex justify-between items-center mb-3">
            <span className="ui-mono text-xs" style={{ color: "#E7DCC2" }}>PREVIEW</span>
            <div className="flex gap-2">
              <button className="ui-btn ui-btn-primary" onClick={() => { setShowPreview(false); guardedPrint(); }}>
                <Printer size={15} /> I-print
              </button>
              <button className="ui-btn" onClick={() => setShowPreview(false)}><X size={15} /> Isara</button>
            </div>
          </div>
          <ScaledForm rec={draft} s={s} />
        </div>
      )}

      {scanOpen && <ScanModal onDetect={handleScan} onClose={() => setScanOpen(false)} />}
    </div>
  );
}

// ------------------------------------------------------------------
// RECORDS VIEW — ang database
// ------------------------------------------------------------------
function RecordsView({ data, onEdit, onPrint, onDuplicate, onDelete, onOpenBackup, onReturn }) {
  const [q, setQ] = useState("");
  const [confirmId, setConfirmId] = useState(null);
  const [secFilter, setSecFilter] = useState("__all");
  const [mineOnly, setMineOnly] = useState(false);
  const overdueDays = data.overdueDays || 7;
  const myId = data.myId;
  const isAdmin = !!data.isAdmin;
  const sections = data.sections || [];
  const canManage = (r) => isAdmin || (r.ownerId && r.ownerId === myId);

  const stats = useMemo(() => {
    const recs = data.records;
    const thisMonth = monthKey(new Date());
    let out = 0, overdue = 0, returnedThisMonth = 0, flagged = 0;
    for (const r of recs) {
      if (isOut(r)) { out++; if (isOverdue(r, overdueDays)) overdue++; }
      if (r.status === "returned" && isoMonth(r.returnedAt) === thisMonth) returnedThisMonth++;
      flagged += (r.items || []).filter((it) => BAD_CONDITIONS.includes(it.returnedCondition)).length;
    }
    return { out, overdue, returnedThisMonth, flagged };
  }, [data.records, overdueDays]);

  const sorted = useMemo(() => {
    const list = [...data.records].sort((a, b) => {
      const ka = a.sort || "", kb = b.sort || "";
      if (ka && kb && ka !== kb) return kb.localeCompare(ka);
      if (ka && !kb) return -1;
      if (!ka && kb) return 1;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
    const t = q.trim().toLowerCase();
    return list.filter((r) => {
      if (secFilter !== "__all" && (r.section || "") !== secFilter) return false;
      if (mineOnly && r.ownerId !== myId) return false;
      if (!t) return true;
      const hay = [r.label, r.person, r.purpose, r.control, r.requestedBy,
        ...(r.items || []).map((it) => it.desc + " " + it.serial)].join(" ").toLowerCase();
      return hay.includes(t);
    });
  }, [data.records, q, secFilter, mineOnly, myId]);

  return (
    <div>
      <div className="dash-strip">
        <div className="dash-tile"><div className="n">{stats.out}</div><div className="l">Naka-labas (out)</div></div>
        <div className={"dash-tile" + (stats.overdue ? " alert" : "")}><div className="n">{stats.overdue}</div><div className="l">Overdue (&gt;{overdueDays}d)</div></div>
        <div className="dash-tile"><div className="n">{stats.returnedThisMonth}</div><div className="l">Naisauli buwang ito</div></div>
        <div className={"dash-tile" + (stats.flagged ? " warn" : "")}><div className="n">{stats.flagged}</div><div className="l">Flagged na gamit</div></div>
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="relative search-wrap">
          <Search size={15} className="absolute left-3 top-3 opacity-50" />
          <input className="ui-input pl-9" placeholder="Hanapin…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select className="ui-select" style={{ width: "auto" }} value={secFilter} onChange={(e) => setSecFilter(e.target.value)}>
          <option value="__all">Lahat ng section</option>
          {sections.map((u) => <option key={u} value={u}>{u}</option>)}
        </select>
        <button className={"ui-btn" + (mineOnly ? " ui-btn-primary" : "")} onClick={() => setMineOnly(!mineOnly)}>
          {mineOnly ? "Akin lang" : "Lahat"}
        </button>
        <span className="ui-mono text-xs opacity-70">{sorted.length}/{data.records.length}</span>
        <button className="ui-btn" onClick={onOpenBackup}><Download size={15} /> Backup</button>
      </div>

      {sorted.length === 0 && (
        <div className="ui-card p-8 text-center opacity-70">
          Walang record na tumugma. Gumawa ng bagong gate pass sa unang tab.
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
        {sorted.map((r) => {
          const n = (r.items || []).filter((x) => x.desc || x.serial).length;
          const out = isOut(r);
          const overdue = isOverdue(r, overdueDays);
          const flagged = (r.items || []).filter((it) => BAD_CONDITIONS.includes(it.returnedCondition)).length;
          return (
            <div key={r.id} className="ui-card rec-card p-4 pt-5" style={overdue ? { borderColor: "#D8B0AA" } : undefined}>
              <div className="rec-tab">{r.control || r.sort || "—"}</div>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-bold text-sm truncate-1" title={r.label}>{r.label || "(walang pangalan)"}</div>
                  <div className="text-xs opacity-70 truncate-1">{r.person || "—"}</div>
                </div>
                <div className="flex flex-col items-end gap-1 shrink-0">
                  <Stamp status={r.status} overdue={overdue} />
                  {r.section && <span className="pill pill-unit">{r.section}</span>}
                </div>
              </div>
              <div className="text-xs mt-2 opacity-80" style={{ minHeight: 30 }}>
                {(r.purpose || "").slice(0, 110)}{(r.purpose || "").length > 110 ? "…" : ""}
              </div>
              <div className="ui-mono text-xs opacity-60 mt-1">
                {n} item{n === 1 ? "" : "s"}{r.requestedDate ? " · " + r.requestedDate : ""}
                {out && <span style={{ color: overdue ? "var(--red)" : "#B5761C" }}> · {daysSince(outSince(r))}d out</span>}
              </div>
              {r.status === "returned" && (
                <div className="ui-mono text-xs mt-1" style={{ color: "var(--green)" }}>
                  Returned{r.returnedAt ? " " + new Date(r.returnedAt).toLocaleDateString() : ""}{flagged ? " · " + flagged + " flagged" : ""}
                </div>
              )}
              <div className="flex flex-wrap gap-2 mt-3">
                {out && (canManage(r)
                  ? <button className="ui-btn ui-btn-primary" onClick={() => onReturn(r)}><Check size={14} /> Return / Inspect</button>
                  : <span className="ui-btn locked" title="Ang naglabas lang (o admin) ang pwedeng mag-return"><Lock size={14} /> Return</span>)}
                <button className="ui-btn" onClick={() => onPrint(r)}><Printer size={14} /> Print</button>
                {canManage(r) ? (
                  <button className="ui-btn" onClick={() => onEdit(r)}><Pencil size={14} /> Edit</button>
                ) : (
                  <span className="ui-btn locked" title={"Pag-aari ni " + (r.requestedBy || "ibang user")}><Lock size={14} /> Edit</span>
                )}
                <button className="ui-btn" onClick={() => onDuplicate(r)} title="Gawing bagong pass ang parehong items">
                  <Copy size={14} /> Kopya
                </button>
                {canManage(r) && (confirmId === r.id ? (
                  <button className="ui-btn ui-btn-danger" onClick={() => { onDelete(r.id); setConfirmId(null); }}>
                    <AlertTriangle size={14} /> Sigurado?
                  </button>
                ) : (
                  <button className="ui-btn ui-btn-ghost ui-btn-danger" onClick={() => { setConfirmId(r.id); setTimeout(() => setConfirmId((c) => (c === r.id ? null : c)), 3000); }}>
                    <Trash2 size={14} />
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------
// INVENTORY VIEW
// ------------------------------------------------------------------
function InventoryView({ data, addInventory, updateInventory, deleteInventory, toast, onHistory, onPrintLabels, isAdmin }) {
  const [q, setQ] = useState("");
  const [secFilter, setSecFilter] = useState("__all");
  const [lifeFilter, setLifeFilter] = useState("__all");
  const [addOpen, setAddOpen] = useState(false);
  const [nu, setNu] = useState({ desc: "", serial: "", unit: "1", section: data.mySection || "AV", category: "", acquiredDate: "", usefulLife: 5, assetStatus: "serviceable", propertyNo: "", cost: "" });
  const [editId, setEditId] = useState(null);
  const [ed, setEd] = useState(null);
  const [confirmId, setConfirmId] = useState(null);

  const sections = data.sections || [];

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    return data.inventory.filter((v) => {
      if (secFilter !== "__all" && (v.section || "") !== secFilter) return false;
      if (lifeFilter !== "__all") {
        const st = lifeStatus(v).code;
        if (lifeFilter === "attention" && !["beyond", "nearing", "for_repair", "unserviceable"].includes(st)) return false;
        if (lifeFilter === "beyond" && st !== "beyond") return false;
        if (lifeFilter === "nodate" && st !== "nodate") return false;
      }
      if (!t) return true;
      return (v.desc + " " + v.serial + " " + (v.propertyNo || "") + " " + (v.category || "")).toLowerCase().includes(t);
    });
  }, [q, data.inventory, secFilter, lifeFilter]);

  const withSerial = filtered.filter((v) => (v.serial || "").trim());

  const doAdd = () => {
    if (!nu.desc.trim()) { toast("Lagyan ng description"); return; }
    addInventory({ ...nu, desc: nu.desc.trim(), serial: nu.serial.trim() });
    setNu({ ...nu, desc: "", serial: "", propertyNo: "", acquiredDate: "", cost: "" });
    toast("Naidagdag sa inventory");
  };

  const Field = ({ label, children, span }) => (
    <div className={"col-span-12 " + (span || "md:col-span-3")}>
      <label className="ui-label">{label}</label>
      {children}
    </div>
  );

  const editor = (val, set) => (
    <div className="grid grid-cols-12 gap-2">
      <Field label="Description (brand, model)" span="md:col-span-6">
        <input className="ui-input" value={val.desc} onChange={(e) => set({ ...val, desc: e.target.value })} />
      </Field>
      <Field label="Serial no.">
        <input className="ui-input ui-mono" value={val.serial} onChange={(e) => set({ ...val, serial: e.target.value })} />
      </Field>
      <Field label="Property no.">
        <input className="ui-input ui-mono" value={val.propertyNo} onChange={(e) => set({ ...val, propertyNo: e.target.value })} />
      </Field>
      <Field label="Section">
        <select className="ui-select" value={val.section} onChange={(e) => set({ ...val, section: e.target.value })}>
          {sections.map((u) => <option key={u} value={u}>{u}</option>)}
        </select>
      </Field>
      <Field label="Kategorya">
        <select className="ui-select" value={val.category}
          onChange={(e) => set({ ...val, category: e.target.value, usefulLife: eulForCategory(e.target.value) })}>
          {CATEGORY_EUL.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
      </Field>
      <Field label="Petsa ng bili">
        <input className="ui-input" type="date" value={val.acquiredDate || ""} onChange={(e) => set({ ...val, acquiredDate: e.target.value })} />
      </Field>
      <Field label="EUL (taon)">
        <input className="ui-input" type="number" min={1} max={50} value={val.usefulLife}
          onChange={(e) => set({ ...val, usefulLife: e.target.value })} />
      </Field>
      <Field label="Qty/Unit" span="md:col-span-2">
        <input className="ui-input" value={val.unit} onChange={(e) => set({ ...val, unit: e.target.value })} />
      </Field>
      <Field label="Halaga (₱, optional)" span="md:col-span-3">
        <input className="ui-input" type="number" value={val.cost} onChange={(e) => set({ ...val, cost: e.target.value })} />
      </Field>
      <Field label="Kondisyon" span="md:col-span-3">
        <select className="ui-select" value={val.assetStatus} onChange={(e) => set({ ...val, assetStatus: e.target.value })}>
          {ASSET_STATUS.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
        </select>
      </Field>
    </div>
  );

  return (
    <div>
      <div className="ui-card p-4 mb-4">
        <button className="ui-btn w-full justify-center" onClick={() => setAddOpen(!addOpen)}>
          <Plus size={15} /> Magdagdag ng equipment {addOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
        {addOpen && (
          <div className="mt-3">
            {editor(nu, setNu)}
            <button className="ui-btn ui-btn-primary mt-3" onClick={doAdd}><Plus size={15} /> Idagdag</button>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="relative search-wrap">
          <Search size={15} className="absolute left-3 top-3 opacity-50" />
          <input className="ui-input pl-9" placeholder="Hanapin…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select className="ui-select" style={{ width: "auto" }} value={secFilter} onChange={(e) => setSecFilter(e.target.value)}>
          <option value="__all">Lahat ng section</option>
          {sections.map((u) => <option key={u} value={u}>{u}</option>)}
        </select>
        <select className="ui-select" style={{ width: "auto" }} value={lifeFilter} onChange={(e) => setLifeFilter(e.target.value)}>
          <option value="__all">Lahat ng kondisyon</option>
          <option value="attention">Kailangan ng atensyon</option>
          <option value="beyond">Lampas EUL</option>
          <option value="nodate">Walang petsa ng bili</option>
        </select>
        <button className="ui-btn" onClick={() => { if (!withSerial.length) { toast("Walang item na may serial"); return; } onPrintLabels(withSerial); }}>
          <QrCode size={15} /> QR Labels
        </button>
        <span className="ui-mono text-xs opacity-70">{filtered.length}/{data.inventory.length}</span>
      </div>

      <div className="flex flex-col gap-2">
        {filtered.map((v) => {
          const ls = lifeStatus(v);
          const reps = repairCount(data.records || [], itemKey(v));
          const pillCls = ls.tone === "bad" ? "pill-bad" : ls.tone === "warn" ? "pill-warn" : ls.tone === "ok" ? "pill-ok" : "pill-muted";
          const barCol = ls.tone === "bad" ? "#B3382E" : ls.tone === "warn" ? "#B5761C" : "#2F6B4E";
          return (
            <div key={v.id} className="ui-card p-3">
              {editId === v.id ? (
                <div>
                  {editor(ed, setEd)}
                  <div className="flex gap-2 mt-3">
                    <button className="ui-btn ui-btn-primary" onClick={() => { updateInventory(v.id, ed); setEditId(null); toast("Na-update"); }}>
                      <Check size={15} /> I-save
                    </button>
                    <button className="ui-btn" onClick={() => setEditId(null)}><X size={15} /> Kanselahin</button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold truncate-1" style={{ maxWidth: "100%" }}>{v.desc}</span>
                      {v.section && <span className="pill pill-unit">{v.section}</span>}
                      <span className={"pill " + pillCls}>{ls.label}</span>
                      {reps >= 3 && <span className="pill pill-warn">{reps}× repair</span>}
                    </div>
                    <div className="ui-mono text-xs opacity-60 truncate-1 mt-1">
                      {v.serial || "walang serial"}{v.propertyNo ? " · " + v.propertyNo : ""} · qty {v.unit}
                    </div>
                    <div className="text-xs opacity-70 mt-1">
                      {v.acquiredDate ? "Bili: " + v.acquiredDate + " · edad " + fmtAge(ls.age) + " / EUL " + (v.usefulLife || "—") + "y" : "Walang petsa ng bili — idagdag para masubaybayan ang EUL"}
                    </div>
                    {ls.pct != null && (
                      <div className="lifebar"><i style={{ width: Math.min(100, ls.pct * 100) + "%", background: barCol }} /></div>
                    )}
                  </div>
                  <div className="flex flex-col gap-1 shrink-0">
                    <div className="flex gap-1">
                      <button className="ui-btn ui-btn-ghost" title="Item history" onClick={() => onHistory(v)}><History size={14} /></button>
                      <button className="ui-btn ui-btn-ghost" title="I-edit" onClick={() => { setEditId(v.id); setEd({ ...v }); }}><Pencil size={14} /></button>
                      {isAdmin && (confirmId === v.id ? (
                        <button className="ui-btn ui-btn-danger" onClick={() => { deleteInventory(v.id); setConfirmId(null); }}>Sigurado?</button>
                      ) : (
                        <button className="ui-btn ui-btn-ghost ui-btn-danger" title="Burahin (admin)" onClick={() => { setConfirmId(v.id); setTimeout(() => setConfirmId((c) => (c === v.id ? null : c)), 3000); }}>
                          <Trash2 size={14} />
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {filtered.length === 0 && <div className="ui-card p-6 text-center text-sm opacity-60">Walang tumugma.</div>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------
// SETTINGS VIEW — dito binabago ang format (white-label ready)
// ------------------------------------------------------------------
function SettingsView({ s, setSettings, resetSettings, toast, isAdmin }) {
  const [confirmReset, setConfirmReset] = useState(false);
  const setS = (patch) => setSettings({ ...s, ...patch });
  const setCol = (k, val) => setSettings({ ...s, cols: { ...s.cols, [k]: val } });

  const onFile = (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    if (f.size > 900000) { toast("Masyadong malaki ang image (max ~900KB)"); return; }
    const rd = new FileReader();
    rd.onload = () => { setSettings({ ...s, letterheadCustom: String(rd.result), letterheadMode: "custom" }); toast("Na-upload ang letterhead"); };
    rd.readAsDataURL(f);
  };

  const Sec = ({ title, children }) => (
    <div className="ui-card p-4 mb-4">
      <div className="ui-eyebrow mb-3">{title}</div>
      {children}
    </div>
  );

  if (!isAdmin) {
    return (
      <div className="ui-card p-6 max-w-xl">
        <div className="ui-eyebrow mb-2">Admin lang</div>
        <div className="text-sm">
          Ang pagbabago ng format ng form ay nakalaan sa admin para hindi ito magkaiba-iba.
          Kung kailangan mong magbago, sabihin sa admin ng system.
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl">
      <Sec title="Mga section / unit">
        <label className="ui-label">Isang section bawat linya (hal. AV, DOSTv)</label>
        <textarea className="ui-textarea ui-mono" rows={3}
          value={(s.sections || []).join("\n")}
          onChange={(e) => setS({ sections: e.target.value.split("\n").map((x) => x.trim()).filter(Boolean) })} />
        <div className="text-xs opacity-60 mt-1">
          Dito nahahati ang inventory at records para hindi maghalo ang gamit ng magkaibang section.
        </div>
      </Sec>

      <Sec title="Pangalan ng system">
        <input className="ui-input" value={s.appName} onChange={(e) => setS({ appName: e.target.value })} />
        <div className="text-xs opacity-60 mt-1">Ito ang lalabas sa header ng app — palitan kapag ibang office/kliyente ang gagamit.</div>
      </Sec>

      <Sec title="Letterhead">
        <div className="flex flex-col gap-2 mb-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" checked={s.letterheadMode === "default"} onChange={() => setS({ letterheadMode: "default" })} />
            Original na DOST-STII letterhead (galing sa Excel file)
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" checked={s.letterheadMode === "custom"} onChange={() => setS({ letterheadMode: "custom" })} />
            Custom image (i-upload ang sariling letterhead)
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" checked={s.letterheadMode === "text"} onChange={() => setS({ letterheadMode: "text" })} />
            Text lang (pangalan ng organisasyon)
          </label>
        </div>
        {s.letterheadMode === "custom" && (
          <div className="mb-3">
            <input type="file" accept="image/*" onChange={onFile} className="text-sm" />
            {s.letterheadCustom && <img src={s.letterheadCustom} alt="preview" className="mt-2 border" style={{ maxWidth: 380, borderColor: "var(--line)" }} />}
          </div>
        )}
        {s.letterheadMode === "text" && (
          <textarea className="ui-textarea ui-mono" rows={3} value={(s.orgLines || []).join("\n")}
            onChange={(e) => setS({ orgLines: e.target.value.split("\n") })} />
        )}
      </Sec>

      <Sec title="Papel at kopya">
        <div className="grid grid-cols-12 gap-3">
          <div className="col-span-12 md:col-span-6">
            <label className="ui-label">Laki ng papel</label>
            <select className="ui-select" value={s.paper} onChange={(e) => setS({ paper: e.target.value })}>
              {Object.entries(PAPERS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          </div>
          <div className="col-span-6 md:col-span-3">
            <label className="ui-label">Kopya kada page</label>
            <select className="ui-select" value={s.copies} onChange={(e) => setS({ copies: Number(e.target.value) })}>
              <option value={2}>2 (original + duplicate)</option>
              <option value={1}>1</option>
            </select>
          </div>
          <div className="col-span-12">
            <div className="text-xs" style={{ color: fitLimit(s.paper, s.copies) === 0 ? "var(--red)" : "#6B6350" }}>
              {fitLimit(s.paper, s.copies) === 0
                ? "⚠ Hindi kasya ang 2 kopya sa papel na ito. Piliin ang Legal o Folio, o gawing 1 kopya kada page."
                : "Kapasidad: mga " + fitLimit(s.paper, s.copies) + " item kada pahina sa setting na ito."}
            </div>
          </div>
          <div className="col-span-6 md:col-span-3">
            <label className="ui-label">Min. item rows</label>
            <input className="ui-input" type="number" min={1} max={20} value={s.minRows}
              onChange={(e) => setS({ minRows: Math.max(1, Math.min(20, Number(e.target.value) || 11)) })} />
          </div>
          <div className="col-span-6 md:col-span-3">
            <label className="ui-label">Overdue kung lampas (araw)</label>
            <input className="ui-input" type="number" min={1} max={90} value={s.overdueDays || 7}
              onChange={(e) => setS({ overdueDays: Math.max(1, Math.min(90, Number(e.target.value) || 7)) })} />
          </div>
        </div>
      </Sec>

      <Sec title="Control number">
        <label className="flex items-center gap-2 text-sm mb-2">
          <input type="checkbox" checked={s.controlAuto} onChange={(e) => setS({ controlAuto: e.target.checked })} />
          Auto-generate (taon-serye, hal. 2026-001)
        </label>
        <label className="ui-label">Prefix (optional)</label>
        <input className="ui-input ui-mono" style={{ maxWidth: 220 }} value={s.controlPrefix}
          placeholder="hal. STII-" onChange={(e) => setS({ controlPrefix: e.target.value })} />
      </Sec>

      <Sec title="Mga teksto ng form">
        <div className="grid grid-cols-12 gap-3">
          <div className="col-span-12 md:col-span-6">
            <label className="ui-label">Form code (taas-kanan)</label>
            <textarea className="ui-textarea ui-mono" rows={2} value={s.formCode} onChange={(e) => setS({ formCode: e.target.value })} />
          </div>
          <div className="col-span-6 md:col-span-3">
            <label className="ui-label">Titulo</label>
            <input className="ui-input" value={s.title} onChange={(e) => setS({ title: e.target.value })} />
          </div>
          <div className="col-span-6 md:col-span-3">
            <label className="ui-label">Label ng control</label>
            <input className="ui-input" value={s.controlLabel} onChange={(e) => setS({ controlLabel: e.target.value })} />
          </div>
          <div className="col-span-12 md:col-span-6">
            <label className="ui-label">Simula ng authorization line</label>
            <input className="ui-input" value={s.authPre} onChange={(e) => setS({ authPre: e.target.value })} />
          </div>
          <div className="col-span-12 md:col-span-6">
            <label className="ui-label">Dulo ng authorization line</label>
            <input className="ui-input" value={s.authPost} onChange={(e) => setS({ authPost: e.target.value })} />
          </div>
          <div className="col-span-12 md:col-span-4">
            <label className="ui-label">Purpose label</label>
            <input className="ui-input" value={s.purposeLabel} onChange={(e) => setS({ purposeLabel: e.target.value })} />
          </div>
          <div className="col-span-6 md:col-span-4">
            <label className="ui-label">Requested label</label>
            <input className="ui-input" value={s.requestedLabel} onChange={(e) => setS({ requestedLabel: e.target.value })} />
          </div>
          <div className="col-span-6 md:col-span-4">
            <label className="ui-label">Authorized label</label>
            <input className="ui-input" value={s.authorizedLabel} onChange={(e) => setS({ authorizedLabel: e.target.value })} />
          </div>
          <div className="col-span-12">
            <label className="ui-label">Default na authorized by</label>
            <input className="ui-input" value={s.defaultAuthorizedBy} onChange={(e) => setS({ defaultAuthorizedBy: e.target.value })} />
          </div>
          <div className="col-span-12">
            <label className="ui-label">Instructions (isang linya bawat item)</label>
            <textarea className="ui-textarea" rows={4} value={(s.instructions || []).join("\n")}
              onChange={(e) => setS({ instructions: e.target.value.split("\n") })} />
          </div>
        </div>
        <details className="mt-4">
          <summary className="ui-eyebrow cursor-pointer">Advanced: mga heading ng table</summary>
          <div className="grid grid-cols-12 gap-3 mt-3">
            {[["qty", "Qty column"], ["desc", "Articles column"], ["serial", "Serial column"], ["out", "Date out column"],
              ["guard", "Guard-use banner"], ["chkOut", "Checked (labas)"], ["ret", "Date returned"], ["chkIn", "Checked (balik)"], ["remarks", "Remarks"]].map(([k, lbl]) => (
              <div key={k} className="col-span-12 md:col-span-6">
                <label className="ui-label">{lbl}</label>
                <textarea className="ui-textarea" rows={2} value={s.cols[k]} onChange={(e) => setCol(k, e.target.value)} />
              </div>
            ))}
          </div>
        </details>
      </Sec>

      <div className="flex gap-2 mb-8">
        {confirmReset ? (
          <button className="ui-btn ui-btn-danger" onClick={() => { resetSettings(); setConfirmReset(false); }}>
            <AlertTriangle size={15} /> Sigurado? Ibabalik sa DOST default
          </button>
        ) : (
          <button className="ui-btn" onClick={() => { setConfirmReset(true); setTimeout(() => setConfirmReset(false), 3500); }}>
            <RotateCcw size={15} /> Ibalik sa DOST default (format lang)
          </button>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------
// BACKUP MODAL
// ------------------------------------------------------------------
function BackupModal({ data, onClose, onRestore, toast }) {
  const [restoreTxt, setRestoreTxt] = useState("");
  const json = useMemo(() => JSON.stringify(data), [data]);

  const download = () => {
    try {
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "gatepass-backup-" + new Date().toISOString().slice(0, 10) + ".json";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      toast("Sinubukang i-download — kung hindi lumabas, kopyahin na lang ang text");
    } catch (e) { toast("Hindi ma-download; kopyahin na lang ang text"); }
  };

  const copy = async () => {
    try { await navigator.clipboard.writeText(json); toast("Na-copy ang backup"); }
    catch (e) { toast("I-highlight at kopyahin manually ang text"); }
  };

  const doRestore = () => {
    try {
      const parsed = JSON.parse(restoreTxt);
      if (!parsed || !Array.isArray(parsed.records)) { toast("Mukhang hindi valid na backup file"); return; }
      onRestore(parsed);
      onClose();
    } catch (e) { toast("Hindi mabasa ang JSON"); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(27,42,58,0.6)" }}>
      <div className="ui-card p-5 w-full overflow-y-auto" style={{ maxWidth: 640, maxHeight: "88vh" }}>
        <div className="flex items-center justify-between mb-3">
          <div className="ui-eyebrow">Backup ng database</div>
          <button className="ui-btn ui-btn-ghost" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="text-sm mb-2">
          Lahat ng records, inventory, at settings — nasa isang JSON. I-save ito kung lilipat ka ng device o account.
        </div>
        <textarea className="ui-textarea ui-mono" rows={5} readOnly value={json} onFocus={(e) => e.target.select()} />
        <div className="flex gap-2 mt-2 mb-5">
          <button className="ui-btn ui-btn-primary" onClick={download}><Download size={15} /> I-download</button>
          <button className="ui-btn" onClick={copy}><Copy size={15} /> Kopyahin</button>
        </div>
        <div className="ui-eyebrow mb-2">I-restore mula sa backup</div>
        <textarea className="ui-textarea ui-mono" rows={4} placeholder="I-paste dito ang laman ng backup JSON…"
          value={restoreTxt} onChange={(e) => setRestoreTxt(e.target.value)} />
        <div className="flex gap-2 mt-2">
          <button className="ui-btn ui-btn-danger" onClick={doRestore}>
            <AlertTriangle size={15} /> I-restore (papalitan ang kasalukuyang data)
          </button>
        </div>
      </div>
    </div>
  );
}


// ------------------------------------------------------------------
// RETURN / INSPECT MODAL
// ------------------------------------------------------------------
function ReturnModal({ rec, onClose, onSubmit }) {
  const [date, setDate] = useState(todayFmt());
  const [items, setItems] = useState(
    (rec.items || []).map((it) => ({
      ...it,
      returnedCondition: it.returnedCondition || "OK",
      returnedRemarks: it.returnedRemarks || "",
    }))
  );
  const setIt = (i, patch) => setItems((arr) => arr.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const flagged = items.filter((x) => BAD_CONDITIONS.includes(x.returnedCondition)).length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(27,42,58,0.6)" }}>
      <div className="ui-card p-5 w-full overflow-y-auto" style={{ maxWidth: 680, maxHeight: "90vh" }}>
        <div className="flex items-center justify-between mb-1">
          <div className="ui-eyebrow">Return &amp; Inspect</div>
          <button className="ui-btn ui-btn-ghost" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="font-bold text-sm">{rec.control || rec.label}</div>
        <div className="text-xs opacity-70 mb-3">{rec.person || "—"}</div>

        <div className="flex items-center gap-2 mb-3">
          <label className="ui-label" style={{ margin: 0 }}>Petsa ng return</label>
          <input className="ui-input" style={{ maxWidth: 200 }} value={date} onChange={(e) => setDate(e.target.value)} />
        </div>

        <div className="ui-eyebrow mb-2">Kondisyon ng bawat gamit pagbalik</div>
        <div className="flex flex-col gap-2">
          {items.map((it, i) => {
            const bad = BAD_CONDITIONS.includes(it.returnedCondition);
            return (
              <div key={i} className="ui-card p-3" style={{ background: bad ? "#F9EDEB" : "#FFFEFA", borderColor: bad ? "#D8B0AA" : "var(--line)" }}>
                <div className="text-sm font-semibold truncate">{it.desc || "(walang pangalan)"}</div>
                <div className="ui-mono text-xs opacity-60 mb-2">{it.serial || "walang serial"}</div>
                <div className="grid grid-cols-12 gap-2">
                  <div className="col-span-5">
                    <label className="ui-label">Kondisyon</label>
                    <select className="ui-select" value={it.returnedCondition} onChange={(e) => setIt(i, { returnedCondition: e.target.value })}>
                      {CONDITIONS.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                  <div className="col-span-7">
                    <label className="ui-label">Remarks (kung may sira / incident)</label>
                    <input className="ui-input" value={it.returnedRemarks} placeholder="hal. cracked screen, needs incident report"
                      onChange={(e) => setIt(i, { returnedRemarks: e.target.value })} />
                  </div>
                </div>
              </div>
            );
          })}
          {items.length === 0 && <div className="text-sm opacity-60">Walang naka-listang gamit sa pass na ito.</div>}
        </div>

        <div className="flex flex-wrap items-center gap-2 mt-4">
          <button className="ui-btn ui-btn-primary" onClick={() => onSubmit({ returnedDate: date, items })}>
            <Check size={15} /> I-mark na Returned
          </button>
          <button className="ui-btn" onClick={onClose}>Kanselahin</button>
          {flagged > 0 && <span className="text-xs" style={{ color: "var(--red)" }}>{flagged} item{flagged === 1 ? "" : "s"} na flagged para sa report</span>}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------
// MONTHLY REPORT
// ------------------------------------------------------------------
function buildReport(records, ym, overdueDays) {
  const flagged = [];
  const activity = { issued: 0, returned: 0, itemsMoved: 0 };
  const freq = {};
  for (const r of records) {
    const rm = recordMonth(r);
    const retM = isoMonth(r.returnedAt);
    if (rm === ym || (r.releasedAt && isoMonth(r.releasedAt) === ym)) {
      if (r.status !== "imported" && r.status !== "draft") activity.issued++;
    }
    if (retM === ym) activity.returned++;
    if (rm === ym) {
      for (const it of r.items || []) {
        if (it.desc || it.serial) { activity.itemsMoved++; const k = (it.desc || it.serial); freq[k] = (freq[k] || 0) + 1; }
      }
    }
    // flagged items inspected this month
    if (retM === ym) {
      for (const it of r.items || []) {
        const bad = BAD_CONDITIONS.includes(it.returnedCondition);
        if (bad || (it.returnedRemarks && it.returnedRemarks.trim())) {
          flagged.push({
            desc: it.desc || "", serial: it.serial || "",
            condition: it.returnedCondition || "", remarks: it.returnedRemarks || "",
            person: r.person || r.requestedBy || "", control: r.control || "", date: r.returnedAt ? new Date(r.returnedAt).toLocaleDateString() : "",
          });
        }
      }
    }
  }
  const outNow = records.filter(isOut).map((r) => ({
    control: r.control || "", person: r.person || "", label: r.label || "",
    days: daysSince(outSince(r)), overdue: isOverdue(r, overdueDays),
    items: (r.items || []).filter((x) => x.desc || x.serial).map((x) => x.desc + (x.serial ? " (" + x.serial + ")" : "")).join(", "),
  })).sort((a, b) => b.days - a.days);
  const topItems = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 8);
  return { flagged, activity, outNow, topItems };
}

// Mga gamit na dapat suriin: lampas na sa EUL, malapit nang mag-EUL,
// unserviceable, o paulit-ulit nang nasisira. Hindi ibig sabihin nito na
// automatic nang for disposal — pang-evaluation ito ng Property Officer.
function buildAssetReview(inventory, records) {
  const rows = [];
  for (const v of inventory) {
    const ls = lifeStatus(v);
    const reps = repairCount(records, itemKey(v));
    const flag =
      ls.code === "beyond" ? "Lampas EUL" :
      ls.code === "unserviceable" ? "Unserviceable" :
      ls.code === "nearing" ? "Malapit nang mag-EUL" :
      ls.code === "for_repair" ? "For Repair" :
      reps >= 3 ? "Paulit-ulit ang sira" : "";
    if (!flag) continue;
    rows.push({
      desc: v.desc, serial: v.serial, propertyNo: v.propertyNo || "", section: v.section || "",
      acquired: v.acquiredDate || "", age: ls.age, eul: v.usefulLife || "", repairs: reps, flag,
      pct: ls.pct == null ? 0 : ls.pct,
    });
  }
  const order = { "Unserviceable": 0, "Lampas EUL": 1, "Paulit-ulit ang sira": 2, "For Repair": 3, "Malapit nang mag-EUL": 4 };
  return rows.sort((a, b) => (order[a.flag] - order[b.flag]) || (b.pct - a.pct));
}

function ReportsView({ data }) {
  const now = new Date();
  const [ym, setYm] = useState(monthKey(now));
  const overdueDays = data.overdueDays || 7;
  const rep = useMemo(() => buildReport(data.records, ym, overdueDays), [data.records, ym, overdueDays]);
  const review = useMemo(() => buildAssetReview(data.inventory || [], data.records), [data.inventory, data.records]);
  const [y, m] = ym.split("-").map(Number);
  const monthLabel = MONTHS[m - 1] + " " + y;

  const months = useMemo(() => {
    const set = new Set();
    for (const r of data.records) {
      const a = recordMonth(r); if (a) set.add(a);
      const b = isoMonth(r.returnedAt); if (b) set.add(b);
    }
    set.add(monthKey(now));
    return Array.from(set).sort().reverse();
  }, [data.records]);

  const exportCsv = () => {
    const head = ["Item", "Serial", "Condition", "Remarks", "Person", "Gate Pass", "Date"];
    const rows = rep.flagged.map((f) => [f.desc, f.serial, f.condition, f.remarks, f.person, f.control, f.date]);
    const csv = [head, ...rows].map((r) => r.map(csvCell).join(",")).join("\n");
    try {
      const blob = new Blob([csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "flagged-items-" + ym + ".csv";
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) {}
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div>
          <label className="ui-label">Buwan</label>
          <select className="ui-select" value={ym} onChange={(e) => setYm(e.target.value)} style={{ minWidth: 180 }}>
            {months.map((mm) => {
              const [yy, m2] = mm.split("-").map(Number);
              return <option key={mm} value={mm}>{MONTHS[m2 - 1]} {yy}</option>;
            })}
          </select>
        </div>
        <div className="flex-1" />
        <button className="ui-btn" onClick={exportCsv}><Download size={15} /> Flagged CSV</button>
        <button className="ui-btn ui-btn-primary" onClick={() => data.onPrintReport({ ...rep, review, monthLabel })}><Printer size={15} /> I-print report</button>
      </div>

      <div className="dash-strip">
        <div className="dash-tile"><div className="n">{rep.activity.issued}</div><div className="l">Na-isyu na pass</div></div>
        <div className="dash-tile"><div className="n">{rep.activity.returned}</div><div className="l">Naisauli</div></div>
        <div className="dash-tile"><div className="n">{rep.activity.itemsMoved}</div><div className="l">Gamit na lumabas</div></div>
        <div className={"dash-tile" + (rep.flagged.length ? " warn" : "")}><div className="n">{rep.flagged.length}</div><div className="l">Flagged na item</div></div>
        <div className={"dash-tile" + (review.filter((r) => r.flag === "Lampas EUL" || r.flag === "Unserviceable").length ? " alert" : "")}>
          <div className="n">{review.filter((r) => r.flag === "Lampas EUL" || r.flag === "Unserviceable").length}</div>
          <div className="l">For evaluation</div>
        </div>
      </div>

      <div className="ui-card p-4 mb-4">
        <div className="ui-eyebrow mb-2">Flagged na gamit — {monthLabel} (need repair / incident / may remarks)</div>
        {rep.flagged.length === 0 ? (
          <div className="text-sm opacity-60">Walang flagged na gamit para sa buwang ito. 🎉</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" style={{ borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ textAlign: "left", borderBottom: "2px solid var(--line)" }}>
                  <th className="py-1 pr-2">Gamit</th><th className="py-1 pr-2">Serial</th><th className="py-1 pr-2">Kondisyon</th>
                  <th className="py-1 pr-2">Remarks</th><th className="py-1 pr-2">Hawak</th><th className="py-1 pr-2">Pass</th>
                </tr>
              </thead>
              <tbody>
                {rep.flagged.map((f, i) => (
                  <tr key={i} style={{ borderBottom: "1px solid var(--line-soft)" }}>
                    <td className="py-1 pr-2">{f.desc}</td>
                    <td className="py-1 pr-2 ui-mono text-xs">{f.serial}</td>
                    <td className="py-1 pr-2"><span className="pill pill-out">{f.condition}</span></td>
                    <td className="py-1 pr-2">{f.remarks}</td>
                    <td className="py-1 pr-2">{f.person}</td>
                    <td className="py-1 pr-2 ui-mono text-xs">{f.control}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="ui-card p-4 mb-4">
        <div className="ui-eyebrow mb-1">Asset review — EUL at kondisyon ({review.length})</div>
        <div className="text-xs opacity-60 mb-2">
          Ang paglampas sa Estimated Useful Life ay hindi automatic na disposal — pang-evaluation ito ng Property/Supply Officer.
        </div>
        {review.length === 0 ? (
          <div className="text-sm opacity-60">Walang kailangang suriin ngayon.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" style={{ borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ textAlign: "left", borderBottom: "2px solid var(--line)" }}>
                  <th className="py-1 pr-2">Gamit</th><th className="py-1 pr-2">Serial</th><th className="py-1 pr-2">Sec</th>
                  <th className="py-1 pr-2">Edad / EUL</th><th className="py-1 pr-2">Repairs</th><th className="py-1 pr-2">Dahilan</th>
                </tr>
              </thead>
              <tbody>
                {review.map((r, i) => (
                  <tr key={i} style={{ borderBottom: "1px solid var(--line-soft)" }}>
                    <td className="py-1 pr-2">{r.desc}</td>
                    <td className="py-1 pr-2 ui-mono text-xs">{r.serial}</td>
                    <td className="py-1 pr-2 text-xs">{r.section}</td>
                    <td className="py-1 pr-2 text-xs">{fmtAge(r.age)} / {r.eul || "—"}y</td>
                    <td className="py-1 pr-2 text-xs">{r.repairs || "—"}</td>
                    <td className="py-1 pr-2"><span className={"pill " + (r.flag === "Malapit nang mag-EUL" || r.flag === "For Repair" ? "pill-warn" : "pill-bad")}>{r.flag}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="ui-card p-4">
        <div className="ui-eyebrow mb-2">Naka-labas ngayon ({rep.outNow.length})</div>
        {rep.outNow.length === 0 ? (
          <div className="text-sm opacity-60">Walang gamit na naka-labas.</div>
        ) : rep.outNow.map((o, i) => (
          <div key={i} className="flex items-start justify-between gap-2 py-1" style={{ borderBottom: "1px solid var(--line-soft)" }}>
            <div className="min-w-0">
              <div className="text-sm truncate">{o.items || o.label}</div>
              <div className="ui-mono text-xs opacity-60">{o.control} · {o.person}</div>
            </div>
            <span className="text-xs shrink-0" style={{ color: o.overdue ? "var(--red)" : "#B5761C" }}>{o.days}d{o.overdue ? " · OVERDUE" : ""}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ReportSheet({ rep, s }) {
  return (
    <div className="gpsheet">
      <div className="rpt">
        <h2>{s.appName} — Monthly Inventory Report</h2>
        <div className="sub">{rep.monthLabel} · generated {new Date().toLocaleDateString()}</div>

        <h3>Flagged Equipment (needs repair / incident / remarks)</h3>
        {rep.flagged.length === 0 ? <div className="muted">No flagged equipment this month.</div> : (
          <table>
            <thead><tr><th>Item</th><th>Serial</th><th>Condition</th><th>Remarks</th><th>Held by</th><th>Gate Pass</th><th>Date</th></tr></thead>
            <tbody>
              {rep.flagged.map((f, i) => (
                <tr key={i}><td>{f.desc}</td><td>{f.serial}</td><td>{f.condition}</td><td>{f.remarks}</td><td>{f.person}</td><td>{f.control}</td><td>{f.date}</td></tr>
              ))}
            </tbody>
          </table>
        )}

        <h3>Currently Out / Overdue</h3>
        {rep.outNow.length === 0 ? <div className="muted">Nothing out.</div> : (
          <table>
            <thead><tr><th>Gate Pass</th><th>Held by</th><th>Items</th><th>Days Out</th></tr></thead>
            <tbody>
              {rep.outNow.map((o, i) => (
                <tr key={i}><td>{o.control}</td><td>{o.person}</td><td>{o.items}</td><td>{o.days}{o.overdue ? " (OVERDUE)" : ""}</td></tr>
              ))}
            </tbody>
          </table>
        )}

        {rep.review && rep.review.length > 0 && (
          <>
            <h3>Asset Review — Estimated Useful Life &amp; Condition</h3>
            <div className="muted" style={{ fontSize: "7.5pt", marginBottom: 4 }}>
              Exceeding the EUL does not automatically mean disposal; this list is for evaluation by the Property/Supply Officer.
            </div>
            <table>
              <thead><tr><th>Item</th><th>Serial</th><th>Property No.</th><th>Section</th><th>Acquired</th><th>Age / EUL</th><th>Repairs</th><th>Reason</th></tr></thead>
              <tbody>
                {rep.review.map((r, i) => (
                  <tr key={i}>
                    <td>{r.desc}</td><td>{r.serial}</td><td>{r.propertyNo}</td><td>{r.section}</td>
                    <td>{r.acquired}</td><td>{fmtAge(r.age)} / {r.eul || "—"}y</td><td>{r.repairs || ""}</td><td>{r.flag}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        <h3>Activity Summary</h3>
        <table>
          <tbody>
            <tr><th>Passes issued</th><td>{rep.activity.issued}</td></tr>
            <tr><th>Passes returned</th><td>{rep.activity.returned}</td></tr>
            <tr><th>Items released</th><td>{rep.activity.itemsMoved}</td></tr>
          </tbody>
        </table>

        {rep.topItems && rep.topItems.length > 0 && (
          <>
            <h3>Most-Used Equipment</h3>
            <table>
              <thead><tr><th>Item</th><th>Times released</th></tr></thead>
              <tbody>{rep.topItems.map(([name, cnt], i) => <tr key={i}><td>{name}</td><td>{cnt}</td></tr>)}</tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------
// PER-ITEM HISTORY MODAL
// ------------------------------------------------------------------
function HistoryModal({ desc, serial, records, onClose }) {
  const key = itemKey({ serial, desc });
  const rows = useMemo(() => itemHistory(records, key), [records, key]);
  const repairs = rows.filter((r) => BAD_CONDITIONS.includes(r.condition)).length;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(27,42,58,0.6)" }}>
      <div className="ui-card p-5 w-full overflow-y-auto" style={{ maxWidth: 640, maxHeight: "88vh" }}>
        <div className="flex items-center justify-between mb-1">
          <div className="ui-eyebrow">Item history</div>
          <button className="ui-btn ui-btn-ghost" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="flex items-center gap-2">
          <img src={qrDataUrl(serial || desc, 3)} width={54} height={54} alt="" style={{ border: "1px solid var(--line)", borderRadius: 4 }} />
          <div className="min-w-0">
            <div className="font-bold text-sm truncate">{desc || "(walang pangalan)"}</div>
            <div className="ui-mono text-xs opacity-60">{serial || "walang serial"}</div>
          </div>
        </div>
        <div className="ui-mono text-xs opacity-70 mt-2 mb-3">
          {rows.length} beses ginamit{repairs ? " · " + repairs + " flagged/repair" : ""}
        </div>
        {rows.length === 0 ? (
          <div className="text-sm opacity-60">Wala pang record para sa item na ito.</div>
        ) : (
          <div className="flex flex-col gap-2">
            {rows.map((r, i) => {
              const bad = BAD_CONDITIONS.includes(r.condition);
              return (
                <div key={i} className="ui-card p-3" style={{ background: bad ? "#F9EDEB" : "#FFFEFA", borderColor: bad ? "#D8B0AA" : "var(--line)" }}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="ui-mono text-xs font-bold">{r.control || "—"}</div>
                    <Stamp status={r.status} />
                  </div>
                  <div className="text-sm mt-1">{r.person || "—"}{r.date ? " · " + r.date : ""}</div>
                  {r.label && <div className="text-xs opacity-70 truncate">{r.label}</div>}
                  {(r.condition || r.remarks) && (
                    <div className="text-xs mt-1" style={{ color: bad ? "var(--red)" : "var(--green)" }}>
                      {r.condition}{r.remarks ? " — " + r.remarks : ""}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------
// QR / BARCODE SCAN MODAL
// ------------------------------------------------------------------
function ScanModal({ onDetect, onClose }) {
  const [err, setErr] = useState("");
  const [manual, setManual] = useState("");
  const videoRef = useRef(null);
  const doneRef = useRef(false);

  useEffect(() => {
    let stream = null, raf = null, cancelled = false;
    const stop = () => { if (raf) cancelAnimationFrame(raf); if (stream) stream.getTracks().forEach((t) => t.stop()); };

    const supported = typeof window !== "undefined" && "BarcodeDetector" in window;
    const secure = typeof window !== "undefined" && (window.isSecureContext || location.protocol === "https:");
    if (!supported) { setErr("Hindi kayang mag-auto-scan ng browser na ito. I-type na lang ang serial sa baba. (Gumagana ang camera-scan sa Chrome/Android.)"); return; }
    if (!secure) { setErr("Kailangan naka-online (HTTPS) para gumana ang camera — hal. ang Netlify link, hindi ang double-click na file. Pwede munang i-type ang serial."); return; }

    (async () => {
      try {
        const detector = new window.BarcodeDetector({ formats: ["qr_code", "code_128", "code_39", "ean_13", "ean_8", "upc_a", "upc_e", "codabar", "itf"] });
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        if (cancelled) { stop(); return; }
        const v = videoRef.current;
        if (!v) return;
        v.srcObject = stream;
        await v.play().catch(() => {});
        const tick = async () => {
          if (cancelled || doneRef.current) return;
          try {
            const codes = await detector.detect(v);
            if (codes && codes.length && codes[0].rawValue) {
              doneRef.current = true; stop(); onDetect(String(codes[0].rawValue).trim()); return;
            }
          } catch (e) {}
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      } catch (e) {
        setErr("Hindi mabuksan ang camera: " + (e && e.message ? e.message : e) + ". I-type na lang ang serial.");
      }
    })();

    return () => { cancelled = true; stop(); };
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(27,42,58,0.85)" }}>
      <div className="ui-card p-4 w-full" style={{ maxWidth: 420 }}>
        <div className="flex items-center justify-between mb-2">
          <div className="ui-eyebrow">Scan QR / barcode</div>
          <button className="ui-btn ui-btn-ghost" onClick={onClose}><X size={16} /></button>
        </div>
        <div style={{ width: "100%", borderRadius: 8, overflow: "hidden", background: "#000", minHeight: err ? 0 : 220 }}>
          {!err && <video ref={videoRef} playsInline muted style={{ width: "100%", display: "block" }} />}
        </div>
        {err && <div className="text-xs mt-1" style={{ color: "var(--red)" }}>{err}</div>}
        <div className="mt-3">
          <label className="ui-label">O i-type ang serial</label>
          <div className="flex gap-2">
            <input className="ui-input ui-mono" value={manual} onChange={(e) => setManual(e.target.value)} placeholder="hal. MP2QK166"
              onKeyDown={(e) => { if (e.key === "Enter" && manual.trim()) onDetect(manual.trim()); }} />
            <button className="ui-btn ui-btn-primary" onClick={() => manual.trim() && onDetect(manual.trim())}>OK</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------
// PRINTABLE QR LABELS
// ------------------------------------------------------------------
function LabelsSheet({ items }) {
  return (
    <div className="gpsheet">
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignContent: "flex-start" }}>
        {items.map((v, i) => (
          <div key={i} style={{ width: 172, border: "1px solid #000", borderRadius: 4, padding: 6, display: "flex", gap: 7, alignItems: "center", breakInside: "avoid", pageBreakInside: "avoid" }}>
            <img src={qrDataUrl(v.serial || v.desc, 3)} width={62} height={62} alt="" style={{ flexShrink: 0 }} />
            <div style={{ fontFamily: "Arial, sans-serif", fontSize: "7.5pt", lineHeight: 1.22, overflow: "hidden" }}>
              <div style={{ fontWeight: "bold", maxHeight: "3.2em", overflow: "hidden" }}>{(v.desc || "").slice(0, 46)}</div>
              <div style={{ fontFamily: "monospace", marginTop: 2 }}>{v.serial}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------
// PROFILE MODAL
// ------------------------------------------------------------------
function ProfileModal({ profile, email, sections, onClose, onSave }) {
  const [name, setName] = useState(profile.full_name || "");
  const [pos, setPos] = useState(profile.position || "");
  const [unit, setUnit] = useState(profile.unit || sections[0] || "AV");
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(27,42,58,0.6)" }}>
      <div className="ui-card p-5 w-full" style={{ maxWidth: 420 }}>
        <div className="flex items-center justify-between mb-2">
          <div className="ui-eyebrow">Profile</div>
          <button className="ui-btn ui-btn-ghost" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="ui-mono text-xs opacity-60 mb-3 truncate-1">{email}</div>
        <div className="flex flex-col gap-3">
          <div>
            <label className="ui-label">Buong pangalan</label>
            <input className="ui-input" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid grid-cols-12 gap-2">
            <div className="col-span-7">
              <label className="ui-label">Posisyon</label>
              <input className="ui-input" value={pos} onChange={(e) => setPos(e.target.value)} />
            </div>
            <div className="col-span-5">
              <label className="ui-label">Section</label>
              <select className="ui-select" value={unit} onChange={(e) => setUnit(e.target.value)}>
                {sections.map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
            </div>
          </div>
        </div>
        <div className="text-xs opacity-60 mt-3">
          Role: <b>{profile.role === "admin" ? "Admin" : "Staff"}</b>. Ang admin lang ang pwedeng magbago ng role — sa Supabase.
        </div>
        <button className="ui-btn ui-btn-primary w-full justify-center mt-4"
          onClick={() => onSave({ full_name: name.trim().toUpperCase(), position: pos.trim(), unit })}>
          <Save size={15} /> I-save
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------
// AUTH SCREEN — sign in / sign up
// ------------------------------------------------------------------
function AuthScreen({ units, onDone }) {
  const [mode, setMode] = useState("in"); // "in" | "up"
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [name, setName] = useState("");
  const [pos, setPos] = useState("");
  const [unit, setUnit] = useState(units[0] || "AV");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  const submit = async () => {
    setErr(""); setMsg("");
    if (!email.trim() || !pw) { setErr("Kailangan ng email at password."); return; }
    if (mode === "up" && pw.length < 8) { setErr("Dapat 8 characters pataas ang password."); return; }
    if (mode === "up" && !name.trim()) { setErr("Ilagay ang buong pangalan."); return; }
    setBusy(true);
    try {
      if (mode === "in") {
        await auth.signIn(email.trim(), pw);
        onDone();
      } else {
        const res = await auth.signUp(email.trim(), pw, { full_name: name.trim().toUpperCase(), position: pos.trim(), unit });
        if (res && res.session) onDone();
        else setMsg("Nagawa na ang account. Kung may confirmation email, i-click muna ito bago mag-sign in.");
      }
    } catch (e) {
      setErr(e && e.message ? e.message : "Hindi matuloy.");
    } finally { setBusy(false); }
  };

  return (
    <div id="gp-app">
      <style>{CSS}</style>
      <div className="authwrap">
        <div className="ui-card p-5" style={{ width: "100%", maxWidth: 420 }}>
          <div className="ui-eyebrow">Gate Pass System</div>
          <h1 className="text-xl font-bold mb-1">{mode === "in" ? "Mag-sign in" : "Gumawa ng account"}</h1>
          <div className="text-xs opacity-70 mb-4">
            {mode === "in" ? "Gamitin ang opisyal na email mo." : "Isang beses lang ito. Pagkatapos, email + password na lang."}
          </div>

          <div className="flex flex-col gap-3">
            {mode === "up" && (
              <>
                <div>
                  <label className="ui-label">Buong pangalan</label>
                  <input className="ui-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="JUAN A. DELA CRUZ" />
                </div>
                <div className="grid grid-cols-12 gap-2">
                  <div className="col-span-7">
                    <label className="ui-label">Posisyon</label>
                    <input className="ui-input" value={pos} onChange={(e) => setPos(e.target.value)} placeholder="IO II" />
                  </div>
                  <div className="col-span-5">
                    <label className="ui-label">Section</label>
                    <select className="ui-select" value={unit} onChange={(e) => setUnit(e.target.value)}>
                      {units.map((u) => <option key={u} value={u}>{u}</option>)}
                    </select>
                  </div>
                </div>
              </>
            )}
            <div>
              <label className="ui-label">Email</label>
              <input className="ui-input" type="email" autoComplete="username" value={email}
                onChange={(e) => setEmail(e.target.value)} placeholder="pangalan@dost.gov.ph" />
            </div>
            <div>
              <label className="ui-label">Password</label>
              <input className="ui-input" type="password" autoComplete={mode === "in" ? "current-password" : "new-password"}
                value={pw} onChange={(e) => setPw(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") submit(); }} placeholder={mode === "up" ? "8+ characters" : ""} />
            </div>
          </div>

          {err && <div className="text-xs mt-3" style={{ color: "var(--red)" }}>{err}</div>}
          {msg && <div className="text-xs mt-3" style={{ color: "var(--green)" }}>{msg}</div>}

          <button className="ui-btn ui-btn-primary w-full justify-center mt-4" disabled={busy} onClick={submit}>
            {busy ? "Sandali…" : mode === "in" ? "Sign in" : "Gumawa ng account"}
          </button>

          <div className="flex items-center justify-between mt-3">
            <button className="ui-btn ui-btn-ghost text-xs" onClick={() => { setMode(mode === "in" ? "up" : "in"); setErr(""); setMsg(""); }}>
              {mode === "in" ? "Wala pang account? Mag-sign up" : "May account na — mag-sign in"}
            </button>
            {mode === "in" && (
              <button className="ui-btn ui-btn-ghost text-xs" onClick={async () => {
                if (!email.trim()) { setErr("Ilagay muna ang email para ma-reset."); return; }
                try { await auth.resetPassword(email.trim()); setMsg("Nagpadala ng reset link sa email mo."); }
                catch (e) { setErr(e.message || "Hindi makapagpadala."); }
              }}>Nakalimutan ang password?</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------
// SETUP + MAIN APP  (Supabase-backed, shared team database)
// ------------------------------------------------------------------
function SetupScreen() {
  return (
    <div id="gp-app" style={{ minHeight: "100vh" }}>
      <style>{CSS}</style>
      <div className="max-w-xl mx-auto px-4 pt-16">
        <div className="ui-eyebrow">Isang beses na setup</div>
        <h1 className="text-2xl font-bold mb-3">Ilagay muna ang 2 susi mula sa Supabase</h1>
        <div className="ui-card p-5 text-sm" style={{ lineHeight: 1.6 }}>
          <p className="mb-2">Kunin sa Supabase mo: <b>Project Settings → API</b> — ang <b>Project URL</b> at ang <b>anon public</b> key.</p>
          <p className="mb-2"><b>Kung GatePass.html ang gamit mo:</b> buksan ang file sa Notepad, hanapin ang bahagi sa itaas:</p>
          <pre className="ui-mono text-xs p-3" style={{ background: "#F3EEE0", borderRadius: 8, overflowX: "auto" }}>{`window.__SUPABASE_URL__ = "...";
window.__SUPABASE_ANON_KEY__ = "...";`}</pre>
          <p className="mt-2">Palitan ang loob ng quotes, i-save, i-refresh ang page.</p>
          <p className="mt-2 opacity-70"><b>Kung Vite project:</b> ilagay sa <span className="ui-mono">.env</span> file. Detalye: README.</p>
        </div>
      </div>
    </div>
  );
}

function makeBlankDraft(s, profile) {
  const who = profile && profile.full_name
    ? profile.full_name + (profile.position ? " / " + profile.position : "")
    : "";
  return {
    id: null, control: "", label: "", person: "", purpose: "",
    items: [{ qty: "1", desc: "", serial: "", out: "" }],
    requestedBy: who, requestedDate: todayFmt(),
    authorizedBy: s.defaultAuthorizedBy, authorizedDate: "", status: "draft",
    ownerId: null, section: profile ? profile.unit : "",
  };
}

export default function GatePassApp() {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [records, setRecords] = useState([]);
  const [inventory, setInventory] = useState([]);
  const [people, setPeople] = useState([]);
  const [loading, setLoading] = useState(CONFIGURED);
  const [dbError, setDbError] = useState(null);
  const [tab, setTab] = useState("editor");
  const [draft, setDraft] = useState(makeBlankDraft(DEFAULT_SETTINGS, null));
  const [printRec, setPrintRec] = useState(null);
  const [printReport, setPrintReport] = useState(null);
  const [printLabels, setPrintLabels] = useState(null);
  const [historyItem, setHistoryItem] = useState(null);
  const [returnRec, setReturnRec] = useState(null);
  const [toastMsg, setToastMsg] = useState("");
  const [backupOpen, setBackupOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [authReady, setAuthReady] = useState(!CONFIGURED);
  const [profileOpen, setProfileOpen] = useState(false);
  const toastTimer = useRef(null);
  const settingsTimer = useRef(null);

  const toast = (m) => {
    setToastMsg(m);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(""), 2800);
  };

  const loadAll = async () => {
    const [recs, inv, ppl, st] = await Promise.all([
      db.listRecords(), db.listInventory(), db.listPeople(), db.getSettings(),
    ]);
    const s = mergeSettings(st);
    setRecords(recs);
    setInventory(inv);
    setPeople(ppl);
    setSettings(s);
    setDraft((d) => (d && d.id ? d : makeBlankDraft(s, profile)));
    return s;
  };

  // auth bootstrap
  useEffect(() => {
    if (!CONFIGURED) { setAuthReady(true); setLoading(false); return; }
    let alive = true;
    (async () => {
      try {
        const sess = await auth.getSession();
        if (!alive) return;
        setSession(sess);
      } catch (e) { /* ignore */ }
      finally { if (alive) setAuthReady(true); }
    })();
    const unsub = auth.onChange((sess) => { setSession(sess); });
    return () => { alive = false; unsub && unsub(); };
  }, []);

  // load data once signed in
  useEffect(() => {
    if (!CONFIGURED) { setLoading(false); return; }
    if (!session) { setLoading(false); setProfile(null); return; }
    let alive = true;
    setLoading(true);
    (async () => {
      try {
        const prof = await auth.getProfile(session.user.id);
        if (!alive) return;
        setProfile(prof);
        await loadAll();
        if (alive) setDbError(null);
      } catch (e) {
        if (alive) setDbError(e && e.message ? e.message : "Hindi maka-connect sa database");
      } finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  // print → mark released (gear now OUT) on first issuance
  useEffect(() => {
    if (!printRec) return;
    const t = setTimeout(async () => {
      try { window.print(); } catch (e) {}
      try {
        let upd = { ...printRec };
        if (printRec.status === "draft" || !printRec.status) {
          upd.status = "released";
          upd.releasedAt = printRec.releasedAt || new Date().toISOString();
        }
        const saved = await db.updateRecord(upd);
        setRecords((prev) => prev.map((r) => (r.id === saved.id ? saved : r)));
        setDraft((d) => (d && d.id === saved.id ? saved : d));
      } catch (e) {}
    }, 350);
    return () => clearTimeout(t);
  }, [printRec]);

  // print a report
  useEffect(() => {
    if (!printReport) return;
    const t = setTimeout(() => {
      try { window.print(); } catch (e) {}
    }, 300);
    const done = () => setPrintReport(null);
    window.addEventListener("afterprint", done);
    return () => { clearTimeout(t); window.removeEventListener("afterprint", done); };
  }, [printReport]);

  // print QR labels
  useEffect(() => {
    if (!printLabels) return;
    const t = setTimeout(() => {
      try { window.print(); } catch (e) {}
    }, 300);
    const done = () => setPrintLabels(null);
    window.addEventListener("afterprint", done);
    return () => { clearTimeout(t); window.removeEventListener("afterprint", done); };
  }, [printLabels]);

  useEffect(() => {
    const done = () => setPrintRec(null);
    window.addEventListener("afterprint", done);
    return () => window.removeEventListener("afterprint", done);
  }, []);

  // items currently OUT on OTHER passes (blocks re-issuing the same serial).
  // MUST stay above the early returns below — all hooks run every render (Rules of Hooks).
  const outMap = useMemo(() => buildOutMap(records, draft ? draft.id : null), [records, draft]);

  // listahan ng sections (AV / DOSTv / ...) — galing settings + aktwal na data
  const sections = useMemo(() => {
    const set = new Set((settings.sections && settings.sections.length ? settings.sections : ["AV", "DOSTv"]));
    inventory.forEach((v) => { if (v.section) set.add(v.section); });
    records.forEach((r) => { if (r.section) set.add(r.section); });
    if (profile && profile.unit) set.add(profile.unit);
    return Array.from(set).filter(Boolean);
  }, [settings.sections, inventory, records, profile]);

  if (!CONFIGURED) return <SetupScreen />;

  if (!authReady) {
    return (
      <div id="gp-app" className="flex items-center justify-center" style={{ minHeight: "100vh" }}>
        <style>{CSS}</style>
        <div className="ui-mono text-sm" style={{ color: "#6B6350" }}>Tinitignan ang session…</div>
      </div>
    );
  }

  if (!session) {
    return <AuthScreen units={(settings.sections && settings.sections.length ? settings.sections : ["AV", "DOSTv"])} onDone={() => {}} />;
  }

  if (loading) {
    return (
      <div id="gp-app" className="flex items-center justify-center" style={{ minHeight: "100vh" }}>
        <style>{CSS}</style>
        <div className="ui-mono text-sm" style={{ color: "#6B6350" }}>Kinukuha ang records mula sa Supabase…</div>
      </div>
    );
  }

  const s = settings;
  const paper = PAPERS[s.paper] || PAPERS.legal;
  const isAdmin = !!(profile && profile.role === "admin");

  const updateSettings = (ns) => {
    setSettings(ns);
    if (settingsTimer.current) clearTimeout(settingsTimer.current);
    settingsTimer.current = setTimeout(() => {
      db.saveSettings(ns).catch(() => toast("Hindi na-save ang format sa server"));
    }, 700);
  };

  const resetSettings = () => {
    const d = { ...DEFAULT_SETTINGS };
    setSettings(d);
    db.saveSettings(d).catch(() => {});
    toast("Naibalik sa DOST default ang format");
  };

  const doSave = async (silent) => {
    const items = draft.items.filter((x) => x.desc || x.serial || x.out || (x.qty && x.qty !== "1"));
    if (!draft.label.trim() && !draft.person.trim() && items.length === 0) {
      toast("Walang laman pa ang pass — lagyan ng pangalan o item");
      return null;
    }
    setSaving(true);
    try {
      const isNew = !draft.id;
      let rec = {
        ...draft,
        items: items.length ? items : [],
        sort: sortKeyFromDate(draft.requestedDate),
        status: draft.status === "imported" ? "imported" : (draft.status || "draft"),
        ownerId: draft.ownerId || (session ? session.user.id : null),
        section: draft.section || (profile ? profile.unit : ""),
      };
      if (isNew && !rec.control && s.controlAuto) {
        try { rec.control = await db.nextControl(s.controlPrefix); } catch (e) {}
      }
      const saved = isNew ? await db.insertRecord(rec) : await db.updateRecord(rec);
      setRecords((prev) => (isNew ? [saved, ...prev] : prev.map((r) => (r.id === saved.id ? saved : r))));
      // learn requestor into people list
      if (rec.requestedBy && rec.requestedBy.indexOf("/") > 0) {
        const nm = rec.requestedBy.split("/")[0].trim();
        const pos = rec.requestedBy.split("/").slice(1).join("/").trim();
        if (nm.length >= 4 && !people.some((p) => p.name.toUpperCase() === nm.toUpperCase())) {
          try { const np = await db.addPerson({ name: nm, position: pos }); setPeople((prev) => [...prev, np]); } catch (e) {}
        }
      }
      setDraft(saved);
      if (!silent) toast(isNew ? "Na-save sa database" : "Na-update");
      return saved;
    } catch (e) {
      toast("Hindi ma-save: " + (e && e.message ? e.message : "error"));
      return null;
    } finally {
      setSaving(false);
    }
  };

  const handlePrintDraft = async () => { const rec = await doSave(true); if (rec) setPrintRec(rec); };
  const handleNew = () => { setDraft(makeBlankDraft(s)); toast("Bagong blankong pass"); };
  const handleEdit = (r) => {
    setDraft({ ...r, items: r.items.length ? r.items.map((x) => ({ ...x })) : [{ qty: "1", desc: "", serial: "", out: "" }] });
    setTab("editor");
  };
  const handleDuplicate = (r) => {
    setDraft({
      ...r, id: null, control: "",
      label: r.label ? r.label + " (kopya)" : "",
      requestedDate: todayFmt(), authorizedDate: "", status: "draft",
      items: r.items.map((x) => ({ ...x })),
      ownerId: null,
      section: profile ? profile.unit : (r.section || ""),
    });
    setTab("editor");
    toast("Ginawang bagong draft — palitan ang detalye");
  };
  const handleDelete = async (id) => {
    try {
      await db.deleteRecord(id);
      setRecords((prev) => prev.filter((r) => r.id !== id));
      if (draft.id === id) handleNew();
      toast("Binura ang record");
    } catch (e) { toast("Hindi mabura: " + (e.message || "error")); }
  };

  const addInventory = async (item) => {
    try {
      const v = await db.addInventory(item);
      setInventory((prev) => [v, ...prev].sort((a, b) => a.desc.toUpperCase().localeCompare(b.desc.toUpperCase())));
    } catch (e) { toast("Hindi na-add sa inventory"); }
  };
  const updateInventory = async (id, patch) => {
    try {
      const saved = await db.updateInventory(id, patch);
      setInventory((prev) => prev.map((v) => (v.id === id ? saved : v)));
    } catch (e) { toast("Hindi na-update: " + (e.message || "error")); }
  };
  const deleteInventory = async (id) => {
    try { await db.deleteInventory(id); setInventory((prev) => prev.filter((v) => v.id !== id)); }
    catch (e) { toast("Hindi mabura ang item"); }
  };

  const restoreAll = async (parsed) => {
    try { await db.restore(parsed); await loadAll(); toast("Na-restore mula sa backup"); }
    catch (e) { toast("Hindi ma-restore: " + (e.message || "error")); }
  };

  const handleMarkReturned = async (rec, { returnedDate, items }) => {
    try {
      const upd = {
        ...rec,
        status: "returned",
        returnedAt: new Date().toISOString(),
        items: items.map((it) => ({
          qty: it.qty || "", desc: it.desc || "", serial: it.serial || "", out: it.out || "",
          returnedCondition: it.returnedCondition || "OK",
          returnedRemarks: it.returnedRemarks || "",
          returnedDate: returnedDate || "",
        })),
      };
      const saved = await db.updateRecord(upd);
      setRecords((prev) => prev.map((r) => (r.id === saved.id ? saved : r)));
      setReturnRec(null);
      const flagged = saved.items.filter((it) => BAD_CONDITIONS.includes(it.returnedCondition)).length;
      toast(flagged ? "Returned — " + flagged + " flagged para sa report" : "Returned — malinis lahat");
    } catch (e) { toast("Hindi ma-mark returned: " + (e.message || "error")); }
  };

  const saveChip = saving ? "sine-save…" : dbError ? "may error sa koneksyon" : "naka-cloud ✓";

  const TABS = [
    { id: "editor", label: "Gate Pass", icon: FileText },
    { id: "records", label: "Records", icon: Archive },
    { id: "inventory", label: "Inventory", icon: Package },
    { id: "reports", label: "Report", icon: ClipboardList },
    { id: "settings", label: "Format", icon: Settings },
  ];

  return (
    <div id="gp-app">
      <style>{CSS}</style>
      <style>{"@page { size: " + paper.w + " " + paper.h + "; margin: 0.23in; }"}</style>

      <div id="app-root" className="max-w-6xl mx-auto px-3 md:px-6 pt-5 pb-16">
        <div className="flex flex-wrap items-end justify-between gap-2 mb-1">
          <div className="min-w-0">
            <div className="ui-eyebrow truncate-1">Shared database · {records.length} records</div>
            <h1 className="text-2xl font-bold truncate-1" style={{ letterSpacing: "-0.01em" }}>{s.appName}</h1>
          </div>
          <div className="flex items-center gap-2 pb-1 min-w-0">
            <span className="ui-mono text-xs opacity-70 truncate-1">{saveChip}</span>
            <button className="ui-btn ui-btn-ghost" onClick={() => setProfileOpen(true)} title="Profile / section">
              {isAdmin && <ShieldCheck size={14} />}
              <span className="truncate-1" style={{ maxWidth: 150 }}>
                {(profile && (profile.full_name || "").trim()) || (session ? session.user.email : "")}
              </span>
              {profile && profile.unit ? <span className="pill pill-unit">{profile.unit}</span> : null}
            </button>
            <button className="ui-btn ui-btn-ghost" title="Sign out"
              onClick={async () => { await auth.signOut(); setSession(null); setProfile(null); setRecords([]); setInventory([]); }}>
              <LogOut size={15} />
            </button>
          </div>
        </div>

        {dbError && (
          <div className="ui-card p-3 mb-3 text-sm" style={{ borderColor: "#D8B0AA", background: "#F9EDEB" }}>
            <b>Database:</b> {dbError}. Suriin ang Supabase URL/key o ang schema/RLS (tingnan ang README).
            <button className="ui-btn ui-btn-ghost ml-2" onClick={() => { setLoading(true); loadAll().then(() => setDbError(null)).catch((e) => setDbError(e.message || "error")).finally(() => setLoading(false)); }}>
              <RotateCcw size={14} /> Subukan ulit
            </button>
          </div>
        )}

        <div className="flex gap-1 overflow-x-auto mt-4" style={{ borderBottom: "1px solid var(--line)" }}>
          {TABS.map((t) => {
            const Ic = t.icon;
            return (
              <button key={t.id} className={"ui-tab" + (tab === t.id ? " active" : "")} onClick={() => setTab(t.id)}>
                <Ic size={15} /> {t.label}
              </button>
            );
          })}
        </div>

        <div className="pt-5">
          {tab === "editor" && draft && (
            <EditorView draft={draft} setDraft={setDraft} data={{ settings: s, inventory, people, outMap, sections, mySection: profile ? profile.unit : "" }}
              onSave={() => doSave(false)} onPrint={handlePrintDraft} onNew={handleNew}
              addInventory={addInventory} toast={toast} />
          )}
          {tab === "records" && (
            <RecordsView data={{ records, overdueDays: s.overdueDays, myId: session ? session.user.id : null, isAdmin, sections }} onEdit={handleEdit} onPrint={(r) => setPrintRec(r)}
              onDuplicate={handleDuplicate} onDelete={handleDelete} onOpenBackup={() => setBackupOpen(true)}
              onReturn={(r) => setReturnRec(r)} />
          )}
          {tab === "inventory" && (
            <InventoryView data={{ inventory, records, sections, mySection: profile ? profile.unit : "AV" }}
              addInventory={addInventory} updateInventory={updateInventory}
              deleteInventory={deleteInventory} toast={toast} isAdmin={isAdmin}
              onHistory={(v) => setHistoryItem(v)} onPrintLabels={(items) => setPrintLabels(items)} />
          )}
          {tab === "reports" && (
            <ReportsView data={{ records, inventory, overdueDays: s.overdueDays, onPrintReport: (rep) => setPrintReport(rep) }} />
          )}
          {tab === "settings" && (
            <SettingsView s={s} setSettings={updateSettings} resetSettings={resetSettings} toast={toast} isAdmin={isAdmin} />
          )}
        </div>
      </div>

      {printRec && (<div id="print-root"><PrintSheet rec={printRec} s={s} /></div>)}
      {printReport && (<div id="print-root"><ReportSheet rep={printReport} s={s} /></div>)}
      {printLabels && (<div id="print-root"><LabelsSheet items={printLabels} /></div>)}
      {historyItem && (<HistoryModal desc={historyItem.desc} serial={historyItem.serial} records={records} onClose={() => setHistoryItem(null)} />)}
      {returnRec && (<ReturnModal rec={returnRec} onClose={() => setReturnRec(null)} onSubmit={(payload) => handleMarkReturned(returnRec, payload)} />)}
      {backupOpen && (<BackupModal data={{ settings: s, records, inventory, people }} onClose={() => setBackupOpen(false)} onRestore={restoreAll} toast={toast} />)}
      {profileOpen && profile && (
        <ProfileModal profile={profile} email={session ? session.user.email : ""} sections={sections}
          onClose={() => setProfileOpen(false)}
          onSave={async (patch) => {
            try {
              const up = await auth.updateProfile(profile.id, patch);
              setProfile(up); setProfileOpen(false); toast("Na-update ang profile");
            } catch (e) { toast("Hindi ma-update: " + (e.message || "error")); }
          }} />
      )}
      {toastMsg && <div className="toast-box">{toastMsg}</div>}
    </div>
  );
}
