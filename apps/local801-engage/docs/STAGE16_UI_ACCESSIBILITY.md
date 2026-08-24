# Stage 16 — UI/UX, Visual Polish & Accessibility

## Purpose

Stage 16 improves Local 801 Engage's presentation, usability, responsive behavior, and accessibility after the Stage 15 core-function audit stabilized the product workflows.

The goal is a professional operational application that is fast to scan, easy to use on desktop and mobile, and targets WCAG 2.2 AA without weakening any existing security, authorization, protected-PII, scanner, import, or synthetic-Preview controls.

## Guardrails

Stage 16 does not:

- provision or change Production;
- use real member data;
- modify DocLinks;
- weaken role, organization, assignment, document-visibility, or protected-PII boundaries;
- change the authoritative import execution model;
- add opaque member, organizer, leadership, propensity, or political/union scoring;
- add schema changes merely for presentation;
- redesign the approved MAPE artwork.

The approved `/public/brand/mape-logo.png` remains unchanged and retains its original proportions and clear space.

## Design principles

1. **Operational clarity first.** High-frequency work, status, next actions, and exceptions are visually easier to identify than decorative content.
2. **Consistent hierarchy.** Page headers, sections, cards, forms, tables, filters, actions, and states follow shared patterns.
3. **Responsive by construction.** Layouts use flexible grids and intrinsic sizing rather than fixed two-column assumptions.
4. **Accessible without a separate mode.** Keyboard, screen reader, zoom, reduced-motion, forced-colors, and touch-target needs are part of the default UI.
5. **Brand restraint.** MAPE blue remains primary; burgundy is a complementary/high-attention accent, not a universal action color.
6. **No color-only meaning.** Status always includes text and/or another non-color signal.
7. **No hidden data expansion.** UI polish must not broaden the data fetched or rendered for a role.

## Work phases

### 16A — Shell and visual foundation

- refine page background, surfaces, spacing, typography, shadows, radii, and content width;
- strengthen desktop sidebar/top-bar hierarchy;
- keep Synthetic Preview conspicuous;
- add a keyboard skip link and explicit main-content target;
- ensure focus indicators remain clearly visible.

### 16B — Shared components

- refine `PageHeader`, `SectionCard`, `StatCard`, `StatusBadge`, state panels, alerts, progress, pagination, and tables;
- improve nested-section treatment so complex operational screens do not become cards inside identical cards;
- keep table captions, column headers, and labeled scroll regions.

### 16C — Forms and actions

- align fields using responsive intrinsic grids;
- standardize helper text, checkbox/radio rows, action bars, validation and success messages;
- target at least 44 CSS px for primary interactive controls where applicable;
- ensure disabled, hover, focus, error, and success states are distinguishable without color alone.

### 16D — Operational tables and queues

- improve scanability of Directory, New Hires, Outreach, Follow-ups, Campaigns, CAT Actions, Imports, Team, Audit, and Documents;
- retain horizontal scrolling only where data density genuinely requires it;
- preserve deterministic pagination and authorization scope.

### 16E — Dashboard and Reports

- improve hierarchy between attention items, KPIs, filters, charts/aggregates, and drill-through actions;
- avoid chart or card overload;
- preserve aggregate/person-level reporting permissions.

### 16F — Mobile/PWA polish

- verify bottom navigation, More drawer, safe-area spacing, touch targets, wrapping, and one-column task flows;
- make primary field-work actions reachable without desktop assumptions;
- preserve the existing static-only PWA cache model.

### 16G — Accessibility acceptance

Verify the stabilized Preview against the following acceptance targets.

## Acceptance targets

### Keyboard and focus

- A visible skip link moves focus to the main content.
- Every interactive control is keyboard reachable in a logical order.
- `:focus-visible` remains a high-contrast 3 px indicator.
- No keyboard trap is introduced in mobile navigation or disclosure content.

### Semantics and assistive technology

- Pages retain one meaningful `h1` and logical descendant heading structure.
- Form controls have programmatic labels.
- Validation/error messages use appropriate live/alert semantics.
- Data tables retain captions, column headers, and labeled overflow regions.
- Active navigation uses `aria-current`.
- Progress indicators retain accessible value metadata.

### Zoom, reflow, and responsive behavior

- At 200% browser zoom, primary workflows remain usable without two-dimensional page scrolling.
- Flexible field grids collapse naturally rather than clipping labels or controls.
- Dense tables may scroll inside a labeled region when necessary.
- Mobile primary controls meet the intended 44–50 px touch-target range.

### Contrast and non-color cues

- Normal text and controls target WCAG 2.2 AA contrast.
- Focus, selected navigation, errors, warnings, readiness states, and Preview state are not communicated by color alone.
- Forced-colors/high-contrast environments retain visible borders, focus, and controls.

### Motion

- `prefers-reduced-motion: reduce` suppresses nonessential motion and smooth scrolling.

### Quality gates

Before merge:

- `npm run lint`
- `npm run typecheck`
- full test suite
- `npm run db:migrations:verify`
- `npm audit --omit=dev`
- `npm run build`
- Vercel Preview deployment READY
- rendered Preview retains auth redirect/protection, Synthetic Preview labeling, no-store behavior, and hardened response headers

## Deferred functionality

After Stage 16, advanced workflow functionality can resume in a separate stage. Candidate enhancements include deeper command-center automation, import change explanations, campaign goals, new-hire lifecycle, data-quality workflows, notifications, saved operational views, workload balancing, calendar views, bulk authorized operations, cross-feature handoffs, and further Member 360 improvements.

Opaque scoring remains explicitly excluded. Future prioritization must use understandable facts such as due dates, assignment state, recorded participation, lifecycle events, and user-entered Action Readiness.
