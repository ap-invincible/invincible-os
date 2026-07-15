import { useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { Authenticated, AuthLoading, Unauthenticated, useMutation, useQuery } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { Check, ChevronDown, ChevronRight, CircleDollarSign, ClipboardList, KeyRound, Landmark, LogOut, ReceiptText, Settings, ShieldCheck, UserPlus, UsersRound } from "lucide-react";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

type Route = "expense-submit" | "expense-review" | "hire-submit" | "hire-review" | "vendor-submit" | "vendor-review" | "audit" | "settings";
type RequestId = Id<"requests">;
type AuditEntry = { _id: string; step: string; detail: string; timestamp: number };
type ExpenseItem = { _id: string; vendor: string; amount: number; category: string; anomalyFlags: string[]; reasoning: string };
type RequestRecord = { _id: RequestId; status: string; type: string };
type RequestDetail = { request: RequestRecord; audit: AuditEntry[]; expenses: ExpenseItem[]; hire: { newHireEmail: string; githubUsername: string; proposedRepos: string[] } | null; vendor: { vendorName: string; department: string; estimatedCost: number; complianceVerdict: string; complianceReasoning: string; budgetLeftover: number; purpose: string } | null };
type QueueEntry = { request: RequestRecord; audit: AuditEntry[]; expenses: ExpenseItem[]; hire: RequestDetail["hire"]; vendor: RequestDetail["vendor"] };

const nav: { group: string; items: { route: Route; label: string; icon: typeof ReceiptText }[] }[] = [
  { group: "Client service", items: [{ route: "expense-submit", label: "Expense review", icon: ReceiptText }, { route: "hire-submit", label: "New hire access", icon: UserPlus }, { route: "vendor-submit", label: "Vendor request", icon: Landmark }] },
  { group: "Admin panel", items: [{ route: "expense-review", label: "Expense approvals", icon: CircleDollarSign }, { route: "hire-review", label: "Access approvals", icon: KeyRound }, { route: "vendor-review", label: "Vendor approvals", icon: ShieldCheck }] },
  { group: "Other", items: [{ route: "audit", label: "Audit log", icon: ClipboardList }, { route: "settings", label: "Settings", icon: Settings }] },
];

export function App() {
  return <><AuthLoading><div className="centered">Loading session…</div></AuthLoading><Unauthenticated><SignIn /></Unauthenticated><Authenticated><Shell /></Authenticated></>;
}

function SignIn() {
  const { signIn } = useAuthActions();
  const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [mode, setMode] = useState<"signIn" | "signUp">("signIn"); const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault(); setError("");
    try { await signIn("password", { email, password, flow: mode }); } catch (cause) { setError(cause instanceof Error ? cause.message : "Sign-in failed."); }
  }
  return <main className="auth-page"><form className="auth-card" onSubmit={submit}><p className="eyebrow">INVINCIBLE</p><h1>Agent OS</h1><p>Submit work. Review finished draft. Approve once.</p><Field label="Work email"><input value={email} onChange={(e) => setEmail(e.target.value)} type="email" required /></Field><Field label="Password"><input value={password} onChange={(e) => setPassword(e.target.value)} type="password" minLength={8} required /></Field>{error && <p className="error">{error}</p>}<button>{mode === "signIn" ? "Sign in" : "Create account"}</button><button type="button" className="text-button" onClick={() => setMode(mode === "signIn" ? "signUp" : "signIn")}>{mode === "signIn" ? "Need an account?" : "Already have an account?"}</button></form></main>;
}

function Shell() {
  const profile = useQuery(api.profiles.me);
  const initialize = useMutation(api.profiles.initialize);
  const [department, setDepartment] = useState("General");
  const [route, setRoute] = useState<Route>("expense-submit");
  const { signOut } = useAuthActions();
  if (profile === undefined) return <div className="centered">Loading profile…</div>;
  if (!profile) return <main className="auth-page"><section className="auth-card"><h1>Set workspace</h1><p>Your first account receives requester access.</p><Field label="Department"><input value={department} onChange={(e) => setDepartment(e.target.value)} /></Field><button onClick={() => void initialize({ department })}>Continue</button></section></main>;
  return <div className="app-shell"><aside><div className="brand"><span>INVINCIBLE</span><strong>Agent OS</strong></div>{nav.map(({ group, items }) => <section className="nav-group" key={group}><p>{group}</p>{items.map(({ route: target, label, icon: Icon }) => <button className={`nav-item ${route === target ? "active" : ""}`} onClick={() => setRoute(target)} key={target}><Icon size={16} />{label}</button>)}</section>)}<div className="user"><UsersRound size={16} /><span>{profile.email}<small>{profile.role} · {profile.department}</small></span><button aria-label="Sign out" onClick={() => void signOut()}><LogOut size={16} /></button></div></aside><main className="content"><Screen route={route} role={profile.role} /></main></div>;
}

function Screen({ route, role }: { route: Route; role: string }) {
  if (route === "expense-submit") return <ExpenseSubmit />;
  if (route === "hire-submit") return <HireSubmit />;
  if (route === "vendor-submit") return <VendorSubmit />;
  if (route === "expense-review") return <Queue type="expense_batch" title="Expense approvals" />;
  if (route === "hire-review") return <Queue type="hire_provisioning" title="Access approvals" />;
  if (route === "vendor-review") return <Queue type="vendor_procurement" title="Vendor approvals" />;
  if (route === "audit") return <Audit />;
  return <SettingsPanel enabled={role === "admin"} />;
}

function Page({ kicker, title, children }: { kicker: string; title: string; children: ReactNode }) { return <><header className="page-header"><p className="eyebrow">{kicker}</p><h1>{title}</h1></header>{children}</>; }
function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="field"><span>{label}</span>{children}</label>; }

async function uploadFile(file: File, generateUploadUrl: () => Promise<string>) {
  const uploadUrl = await generateUploadUrl();
  const response = await fetch(uploadUrl, { method: "POST", headers: { "Content-Type": file.type }, body: file });
  if (!response.ok) throw new Error("Upload failed.");
  return (await response.json()).storageId as Id<"_storage">;
}

function ExpenseSubmit() {
  const generate = useMutation(api.files.generateUploadUrl); const submit = useMutation(api.expenses.submit); const [file, setFile] = useState<File | null>(null); const [requestId, setRequestId] = useState<RequestId>(); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  async function send(event: FormEvent) { event.preventDefault(); if (!file) return setError("Choose an .xlsx file."); setBusy(true); setError(""); try { setRequestId(await submit({ fileId: await uploadFile(file, generate) })); } catch (cause) { setError(cause instanceof Error ? cause.message : "Submission failed."); } finally { setBusy(false); } }
  return <Page kicker="CLIENT SERVICE" title="Expense review"><form className="form-panel" onSubmit={send}><p>Upload monthly expense file. Agent extracts rows, applies policy checks, then clears or flags every item.</p><Field label="Expense spreadsheet"><input type="file" accept=".xlsx,.xls" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>{error && <p className="error">{error}</p>}<button disabled={busy}>{busy ? "Submitting…" : "Submit request"}</button></form>{requestId && <RequestTrace requestId={requestId} />}</Page>;
}

function HireSubmit() {
  const submit = useMutation(api.hires.submit); const [email, setEmail] = useState(""); const [username, setUsername] = useState(""); const [requestId, setRequestId] = useState<RequestId>(); const [error, setError] = useState("");
  async function send(event: FormEvent) { event.preventDefault(); try { setError(""); setRequestId(await submit({ newHireEmail: email, githubUsername: username })); } catch (cause) { setError(cause instanceof Error ? cause.message : "Submission failed."); } }
  return <Page kicker="CLIENT SERVICE" title="New hire access"><form className="form-panel" onSubmit={send}><p>Agent proposes standard engineering access. GitHub grants always wait for an approver.</p><Field label="New hire email"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field><Field label="GitHub username"><input value={username} onChange={(e) => setUsername(e.target.value)} required /></Field>{error && <p className="error">{error}</p>}<button>Submit request</button></form>{requestId && <RequestTrace requestId={requestId} />}</Page>;
}

function VendorSubmit() {
  const generate = useMutation(api.files.generateUploadUrl); const submit = useMutation(api.vendors.submit); const [form, setForm] = useState({ vendorName: "", estimatedCost: "", department: "", purpose: "" }); const [file, setFile] = useState<File | null>(null); const [requestId, setRequestId] = useState<RequestId>(); const [error, setError] = useState("");
  function update(key: keyof typeof form, value: string) { setForm({ ...form, [key]: value }); }
  async function send(event: FormEvent) { event.preventDefault(); if (!file) return setError("Choose brochure file."); try { setError(""); setRequestId(await submit({ ...form, estimatedCost: Number(form.estimatedCost), brochureFileId: await uploadFile(file, generate) })); } catch (cause) { setError(cause instanceof Error ? cause.message : "Submission failed."); } }
  return <Page kicker="CLIENT SERVICE" title="Vendor request"><form className="form-panel" onSubmit={send}><p>Agent checks brochure against company rules and current departmental spend before review.</p><Field label="Vendor name"><input value={form.vendorName} onChange={(e) => update("vendorName", e.target.value)} required /></Field><Field label="Brochure"><input type="file" accept=".pdf,.txt" onChange={(e) => setFile(e.target.files?.[0] ?? null)} required /></Field><Field label="Monthly or annual cost"><input type="number" min="0" value={form.estimatedCost} onChange={(e) => update("estimatedCost", e.target.value)} required /></Field><Field label="Department"><input value={form.department} onChange={(e) => update("department", e.target.value)} required /></Field><Field label="Purpose"><textarea value={form.purpose} onChange={(e) => update("purpose", e.target.value)} required /></Field>{error && <p className="error">{error}</p>}<button>Submit request</button></form>{requestId && <RequestTrace requestId={requestId} />}</Page>;
}

function RequestTrace({ requestId }: { requestId: RequestId }) {
  const detail = useQuery(api.requests.detail, { requestId }) as RequestDetail | undefined; const [open, setOpen] = useState(true);
  if (detail === undefined) return <section className="trace"><p>Agent starting…</p></section>;
  if (!detail) return null;
  return <section className="trace"><button className="trace-title" onClick={() => setOpen(!open)}><span><span className={`badge ${detail.request.status}`}>{detail.request.status.replaceAll("_", " ")}</span> Request {requestId.slice(-6)}</span>{open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</button>{open && <div className="trace-steps">{detail.audit.map((entry, index) => <div className="trace-step" key={entry._id}><span className="trace-icon">{entry.step === "human_pause" ? "◷" : entry.step === "failed" ? "!" : "✓"}</span><div><strong>{friendlyStep(entry.step)}</strong><p>{entry.detail}</p></div>{index < detail.audit.length - 1 && <i />}</div>)}{detail.request.status === "processing" && <div className="trace-step pending"><span className="trace-icon">◌</span><div><strong>Working</strong><p>Next workflow step is queued.</p></div></div>}</div>}</section>;
}

function friendlyStep(step: string) { return ({ submitted: "Request received", extract: "Extracting input", decide: "Applying expense policy", decide_access: "Deciding access scope", retrieve_rules: "Retrieving policy", check_budget: "Checking budget", gate: "Applying approval gate", human_pause: "Waiting for human", human_verdict: "Human decision", execute: "Executing approved work", complete: "Completed", failed: "Needs attention" } as Record<string, string>)[step] ?? step.replaceAll("_", " "); }

function Queue({ type, title }: { type: "expense_batch" | "hire_provisioning" | "vendor_procurement"; title: string }) {
  const queue = useQuery(api.requests.queue, { type }) as QueueEntry[] | undefined;
  return <Page kicker="ADMIN PANEL" title={title}>{queue === undefined ? <p>Loading queue…</p> : !queue.length ? <Empty label="No requests waiting for review." /> : <div className="queue">{queue.map((entry) => <ApprovalCard key={entry.request._id} entry={entry} type={type} />)}</div>}</Page>;
}

function ApprovalCard({ entry, type }: { entry: QueueEntry; type: "expense_batch" | "hire_provisioning" | "vendor_procurement" }) {
  const decide = useMutation(api.approvals.decide); const decideItem = useMutation(api.expenses.decideItem); const [edits, setEdits] = useState(type === "hire_provisioning" ? JSON.stringify(entry.hire?.proposedRepos ?? []) : ""); const [error, setError] = useState("");
  async function decision(value: "approved" | "rejected" | "edited_and_approved") { try { setError(""); await decide({ requestId: entry.request._id, decision: value, editsMade: value === "edited_and_approved" ? edits : undefined }); } catch (cause) { setError(cause instanceof Error ? cause.message : "Decision failed."); } }
  return <article className="approval-card"><div className="card-title"><div><span className="badge pending">awaiting approval</span><h2>{type === "hire_provisioning" ? entry.hire?.newHireEmail : type === "vendor_procurement" ? entry.vendor?.vendorName : `${entry.expenses.length} flagged expenses`}</h2><p>{type === "vendor_procurement" ? `${entry.vendor?.department} · ${currency(entry.vendor?.estimatedCost)} · ${entry.vendor?.complianceVerdict}` : type === "hire_provisioning" ? `@${entry.hire?.githubUsername}` : "Review each flagged row before closing batch."}</p></div></div>{type === "expense_batch" && <div className="item-list">{entry.expenses.map((item) => <div className="expense-row" key={item._id}><div><strong>{item.vendor} · {currency(item.amount)}</strong><p>{item.category} · {item.anomalyFlags.join(", ").replaceAll("_", " ")}<br />{item.reasoning}</p></div><div className="actions"><button className="secondary" onClick={() => void decideItem({ itemId: item._id as Id<"expense_items">, decision: "approved" })}>Approve</button><button className="secondary" onClick={() => void decideItem({ itemId: item._id as Id<"expense_items">, decision: "rejected" })}>Reject</button></div></div>)}</div>}{type === "hire_provisioning" && <Field label="Proposed repositories (JSON array)"><textarea value={edits} onChange={(event) => setEdits(event.target.value)} /></Field>}{type === "vendor_procurement" && <div className="decision-facts"><p><strong>Policy</strong>{entry.vendor?.complianceReasoning}</p><p><strong>Budget remaining</strong>{currency(entry.vendor?.budgetLeftover)}</p><p><strong>Purpose</strong>{entry.vendor?.purpose}</p></div>}<TraceRows audit={entry.audit} />{type !== "expense_batch" && <div className="actions"><button onClick={() => void decision(edits !== JSON.stringify(entry.hire?.proposedRepos ?? []) ? "edited_and_approved" : "approved")}>Approve</button><button className="secondary" onClick={() => void decision("rejected")}>Reject</button></div>}{error && <p className="error">{error}</p>}</article>;
}

function TraceRows({ audit }: { audit: AuditEntry[] }) { const [open, setOpen] = useState(false); return <div className="mini-trace"><button className="text-button" onClick={() => setOpen(!open)}>{open ? "Hide workflow trace" : "Show workflow trace"}</button>{open && audit.map((entry) => <p key={entry._id}><Check size={13} /> <strong>{friendlyStep(entry.step)}</strong> — {entry.detail}</p>)}</div>; }
function currency(value: number | undefined) { return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value ?? 0); }
function Empty({ label }: { label: string }) { return <section className="empty"><Check size={20} /><p>{label}</p></section>; }

function Audit() {
  const [request, setRequest] = useState(""); const all = useQuery(api.requests.audit, {}) as AuditEntry[] | undefined; const selected = useQuery(api.requests.detail, request ? { requestId: request as RequestId } : "skip") as RequestDetail | null | undefined;
  return <Page kicker="OTHER" title="Audit log"><div className="audit-search"><Field label="Request ID"><input value={request} onChange={(e) => setRequest(e.target.value.trim())} placeholder="Paste request ID to inspect full trace" /></Field></div>{request ? selected === undefined ? <p>Loading request…</p> : selected ? <RequestTrace requestId={selected.request._id} /> : <p className="error">Request unavailable.</p> : <section className="audit-list">{all === undefined ? <p>Loading audit log…</p> : all.map((entry) => <p key={entry._id}><span>{new Date(entry.timestamp).toLocaleString()}</span><strong>{friendlyStep(entry.step)}</strong>{entry.detail}</p>)}</section>}</Page>;
}

function SettingsPanel({ enabled }: { enabled: boolean }) {
  const setBudget = useMutation(api.vendors.setBudget); const addRule = useMutation(api.vendors.addRule); const [budget, setBudgetState] = useState({ department: "General", month: new Date().toISOString().slice(0, 7), amount: "" }); const [rule, setRule] = useState({ text: "", sourceDoc: "Manual policy" }); const [message, setMessage] = useState("");
  if (!enabled) return <Page kicker="OTHER" title="Settings"><Empty label="Admin access required for policy and budget settings." /></Page>;
  return <Page kicker="OTHER" title="Settings"><div className="settings-grid"><form className="form-panel" onSubmit={(event) => { event.preventDefault(); void setBudget({ ...budget, amount: Number(budget.amount) }).then(() => setMessage("Budget saved.")); }}><h2>Monthly budget</h2><Field label="Department"><input value={budget.department} onChange={(e) => setBudgetState({ ...budget, department: e.target.value })} /></Field><Field label="Month"><input type="month" value={budget.month} onChange={(e) => setBudgetState({ ...budget, month: e.target.value })} /></Field><Field label="Budget amount"><input type="number" value={budget.amount} onChange={(e) => setBudgetState({ ...budget, amount: e.target.value })} required /></Field><button>Save budget</button></form><form className="form-panel" onSubmit={(event) => { event.preventDefault(); void addRule(rule).then(() => { setMessage("Policy rule saved."); setRule({ ...rule, text: "" }); }); }}><h2>Company rule</h2><Field label="Policy text"><textarea value={rule.text} onChange={(e) => setRule({ ...rule, text: e.target.value })} required /></Field><Field label="Source"><input value={rule.sourceDoc} onChange={(e) => setRule({ ...rule, sourceDoc: e.target.value })} /></Field><button>Save rule</button></form></div>{message && <p className="success">{message}</p>}</Page>;
}
