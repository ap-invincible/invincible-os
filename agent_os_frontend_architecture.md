# Agent OS — front-end architecture

## Design tokens

```css
--nav-bg: #F7F7F5;        /* exact match, image 1 */
--panel-bg: #FFFFFF;      /* exact match, image 2 */
--text-primary: #2C2C2A;
--text-secondary: #5F5E5A;
--text-muted: #888780;
--border-hairline: rgba(0,0,0,0.08);
--accent: #2C2C2A;        /* dark neutral, used for the single primary CTA — no color accent, stays quiet and professional */

--font-display: "Anthropic Serif", "Tiempos Headline", Georgia, serif;
--font-body: "Anthropic Serif", "Tiempos Text", Georgia, serif;
```
Note: "Anthropic Serif" is Anthropic's internally-hosted webfont name; the glyphs are Tiempos (Klim Type Foundry), which isn't publicly licensed. Ship the stack above so the layout is correct today and upgrades automatically if you ever license Tiempos directly. Do not mix in a sans-serif anywhere — one typeface, light theme only, no dark mode variant needed.

## Layout grid

Two-column grid, fixed ratio, full viewport height:
```css
display: grid;
grid-template-columns: 1fr 5.5fr;   /* navbar : content, exactly as specified */
min-height: 100vh;
```
Navbar is `position: sticky; top: 0` — content scrolls independently, navbar never moves.

## Navbar (three groups, fixed order, icon + label rows — no nested menus)

1. **Client service** — Expense review · New hire access · Vendor request → each opens that agent's requester form directly (one click, no intermediate landing page).
2. **Admin panel** — Expense approvals · Access approvals · Vendor approvals → each opens that agent's approver queue directly.
3. **Other** — Audit log, Settings. Anything added later goes here, not into groups 1–2, to keep the two "portal" groups exactly 3 items each and scannable at a glance.

Active item: `background: rgba(0,0,0,0.045)` on the row, no color accent, no icon-only shrinking — label always visible (this is a 6.5-unit-wide rail, not a collapsed icon dock).

## The minimal-input principle, applied concretely

Every requester screen follows the same shape, and it's the main lever for "short and meaningful":

- **One screen, one primary action.** No multi-step wizards. The form for each agent is exactly the fields that agent actually needs (2 for hire access, a handful for vendor + brochure upload, a single file picker for expense review) — nothing collected "just in case."
- **One primary button per screen**, verb-first ("Submit request"), everything else is plain text or a secondary link.
- **No confirmation modals** for submission — submitting shows the status inline immediately (the agent starts working; reactive Convex queries update the screen the moment it finishes, no refresh, no "check back later").
- **Approver screens are review-only, not build-only.** The agent's draft output is pre-filled and editable in place — the admin never types a decision from scratch, only adjusts what's already there and clicks Approve / Reject.

## Component conventions

- **Buttons**: one filled dark button per screen max (the primary action); everything else is a bordered/ghost button or plain link. No color-coded buttons — status is communicated with a small text badge, not button color.
- **Status badges**: `pending` = muted gray text, `approved` = dark text with a small check icon, `flagged`/`rejected` = dark text with a small alert icon. Keep these monochrome too — the brief is professional and quiet, not a traffic-light dashboard.
- **Forms**: label above field, 36px input height, generous vertical spacing (18–24px between fields) — density stays low throughout, this is not a data-entry-heavy tool.
- **Cards** (used for approver queue items): white surface, 0.5px hairline border, 12px radius, no shadow.

## Live workflow trace (Claude-web style)

Every in-flight and completed request shows a live, step-by-step trace of what the agent is actually doing — same component, embedded on both the requester's status view and the approver's queue item, not a separate screen. It's a direct reactive read of the `audit_log` table by `requestId` (see the Convex architecture doc), so it updates the instant a step lands — no polling, no refresh.

**Per-step row shows:**
- **What step it's on** — plain-language label ("Deciding access scope"), not internal function names.
- **The approach it's taking** — the one-sentence reasoning already produced by the agent's Explain step, shown inline under the label (this is the same text that goes to the audit log — one write, two readers).
- **Tool calls, distinctly** — a monospace mini-block showing which external system was called and the result (e.g. `github.get_repo_permissions → 4 existing collaborators`), visually separated from reasoning steps so a human can tell "the agent is thinking" apart from "the agent is doing."
- **Current step** — a subtle pulsing indicator, nothing else animated. Completed steps get a plain checkmark; steps that haven't started yet render faded with a dashed connector, visible but clearly not-yet-run (queued), the same way Claude's own trace shows upcoming/pending work.
- **The human-pause point** — rendered as a distinct "waiting" state (clock icon, paused connector), not just another step, so it's visually obvious the workflow is stopped on a person rather than still running.

Stays monochrome, same tokens as the rest of the UI — no color-coding by step type, consistent with the "quiet, professional" rule elsewhere in this doc. Once a workflow completes, the trace collapses to just the final outcome line by default, expandable back to the full step list on click — same pattern as Claude's own finished-thinking blocks.

## Screen inventory (7 screens total)

| Screen | Route | Primary action |
|---|---|---|
| Expense review (requester) | `/expense/submit` | Upload xlsx → submit |
| Expense approvals (admin) | `/expense/review` | Approve / edit / reject per flagged row |
| New hire access (requester) | `/hire/submit` | Email + GitHub username → submit |
| Access approvals (admin) | `/hire/review` | Approve / edit repo list / reject |
| Vendor request (requester) | `/vendor/submit` | Vendor + brochure + cost → submit |
| Vendor approvals (admin) | `/vendor/review` | Approve / reject (only reaches this screen if budget + compliance already passed) |
| Audit log | `/audit` | Search by request ID, read-only trace view |

No home/dashboard screen by design — the navbar itself is the entry point, so landing anywhere adds a click the requirement doesn't need. The live trace (above) isn't a route either — it renders inline wherever a request is visible, on both requester and approver screens.
