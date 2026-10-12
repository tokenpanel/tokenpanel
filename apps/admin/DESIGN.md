---
name: TokenPanel Admin
description: Admin console for AI spend, access, and limits, built as a well-made appliance.
colors:
  ground: "oklch(0.952 0.004 85)"
  panel: "oklch(0.992 0.002 85)"
  ink: "oklch(0.2 0.006 85)"
  ink-muted: "oklch(0.46 0.008 85)"
  hairline: "oklch(0.875 0.005 85)"
  rule: "oklch(0.915 0.004 85)"
  control-stroke: "oklch(0.82 0.006 85)"
  key-fill: "oklch(0.93 0.004 85)"
  signal-blue: "oklch(0.545 0.245 266)"
  rail-charcoal: "oklch(0.215 0.005 80)"
  rail-legend: "oklch(0.66 0.007 85)"
  rail-led: "oklch(0.66 0.19 266)"
  live-green: "oklch(0.56 0.14 152)"
  attention-orange: "oklch(0.64 0.18 46)"
  stop-red: "oklch(0.54 0.2 27)"
  dark-ground: "oklch(0.155 0.004 85)"
  dark-panel: "oklch(0.205 0.004 85)"
  dark-ink: "oklch(0.935 0.004 85)"
  dark-ink-muted: "oklch(0.71 0.008 85)"
  dark-rail-charcoal: "oklch(0.225 0.005 80)"
  dark-signal: "oklch(0.68 0.17 266)"
typography:
  page-title:
    fontFamily: "Archivo Variable, Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "26px"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.02em"
  panel-title:
    fontFamily: "Archivo Variable, Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.25
  body:
    fontFamily: "Archivo Variable, Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  table:
    fontFamily: "Archivo Variable, Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "13.5px"
    fontWeight: 400
    fontFeature: "tnum"
  legend:
    fontFamily: "Archivo Variable, Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "10.5px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0.08em"
    fontVariation: "'wdth' 112"
  auth-display:
    fontFamily: "Archivo Variable, Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "40px"
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: "-0.025em"
  auth-display-compact:
    fontFamily: "Archivo Variable, Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "34px"
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: "-0.025em"
  section-title:
    fontFamily: "Archivo Variable, Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 600
    lineHeight: 1.3
  readout-xl:
    fontFamily: "Archivo Variable, Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "34px"
    fontWeight: 600
    lineHeight: 1
    fontFeature: "tnum"
    fontVariation: "'wdth' 86"
  readout-lg:
    fontFamily: "Archivo Variable, Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "32px"
    fontWeight: 600
    lineHeight: 1
    fontFeature: "tnum"
    fontVariation: "'wdth' 86"
  readout-price:
    fontFamily: "Archivo Variable, Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "30px"
    fontWeight: 600
    lineHeight: 1
    fontFeature: "tnum"
    fontVariation: "'wdth' 86"
  readout-md:
    fontFamily: "Archivo Variable, Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "22px"
    fontWeight: 600
    lineHeight: 1
    fontFeature: "tnum"
    fontVariation: "'wdth' 86"
  readout-sm:
    fontFamily: "Archivo Variable, Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: 1
    fontFeature: "tnum"
    fontVariation: "'wdth' 86"
  readout-multi:
    fontFamily: "Archivo Variable, Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 600
    lineHeight: 1.1
    fontFeature: "tnum"
    fontVariation: "'wdth' 86"
  readout-xs:
    fontFamily: "Archivo Variable, Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 600
    lineHeight: 1
    fontFeature: "tnum"
    fontVariation: "'wdth' 86"
  readout:
    fontFamily: "Archivo Variable, Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "28px"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "-0.01em"
    fontFeature: "tnum"
    fontVariation: "'wdth' 86"
  mono:
    fontFamily: "JetBrains Mono Variable, JetBrains Mono, ui-monospace, monospace"
    fontSize: "12px"
    fontWeight: 400
rounded:
  mark: "1px"
  thumb: "2px"
  chip: "4px"
  control: "6px"
  inner: "8px"
  panel: "10px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  panel-x: "20px"
  section: "24px"
components:
  button-primary:
    backgroundColor: "{colors.signal-blue}"
    textColor: "{colors.panel}"
    rounded: "{rounded.control}"
    height: "36px"
    padding: "0 14px"
  button-outline:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    height: "36px"
    padding: "0 14px"
  input:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    height: "36px"
    padding: "4px 12px"
  panel:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.panel}"
  status-badge:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.chip}"
    height: "22px"
    padding: "0 8px"
  nav-rail:
    backgroundColor: "{colors.rail-charcoal}"
    textColor: "{colors.panel}"
    width: "248px"
---

# Design System: TokenPanel Admin

## Overview

**Creative North Star: "The Appliance"**

The console is a well-made appliance in the 1960s–70s German industrial tradition: a matte charcoal body holds printed legends and one blue power key, and every ratio worth knowing is read off a graduated scale. It is an Operate surface, so the world lends only type, palette, density, and one signature move; navigation and controls stay the standard web ones.

Density is comfortable-dense: ruled tables with 44px rows, panels separated by hairlines, numbers in condensed tabular figures. Light is the default face; dark follows the system or a manual switch, and the rail stays charcoal in both. Motion is small and physical: a needle settles once, keys depress 1px. There are no gradients, glass, glows, or decorative icon tiles.

**Key Characteristics:**
- Charcoal body rail with printed legend group labels and a blue indicator lamp on the active item.
- Warm light-grey ground, near-white panels, one hairline elevation.
- Graduated tick scales with a single needle for real ratios; a log-time ruler for rolling-limit windows.
- State carried by mark shape plus a word, never hue alone.

## Colors

A restrained warm-neutral appliance body with one signal blue taken from the TP logo (#2C5CFD) and three state colours used only where they carry meaning.

### Primary
- **Signal Blue** (oklch(0.545 0.245 266); dark oklch(0.565 0.225 266) for fills, oklch(0.68 0.17 266) for marks): the power key. Primary buttons, scale needles, selection, focus rings, the active-nav lamp. Matches the logo's circuit blue.

### Neutral
- **Warm Ground** (oklch(0.952 0.004 85); dark oklch(0.155 0.004 85)): page background.
- **Face Plate** (oklch(0.992 0.002 85); dark oklch(0.205 0.004 85)): panels, inputs, dialogs.
- **Ink** (oklch(0.2 0.006 85); dark oklch(0.935 0.004 85)) and **Muted Ink** (oklch(0.46 0.008 85); dark oklch(0.71 0.008 85)): text and secondary text.
- **Hairline** (oklch(0.875 0.005 85)) and **Rule** (oklch(0.915 0.004 85)): panel borders and internal row rules.
- **Rail Charcoal** (oklch(0.215 0.005 80); dark oklch(0.225 0.005 80)) with **Rail Legend** (oklch(0.66 0.007 85)): the body rail and its printed labels, plus the auth front plate.

### State
- **Live Green** (oklch(0.56 0.14 152)): active, OK, cache hit.
- **Attention Orange** (oklch(0.64 0.18 46)): pending, suspended, warnings.
- **Stop Red** (oklch(0.54 0.2 27)): revoked, deleted, negative money, destructive actions.

### Named Rules
**The One Key Rule.** Signal blue marks the primary action, the current selection, and instrument needles. Nothing decorative is blue.
**The Body Rule.** The rail is one solid charcoal field in both themes and sits visibly apart from the ground; colour owns the region, not a stripe.

## Typography

**UI Font:** Archivo Variable (self-hosted via @fontsource, width axis used)
**Mono Font:** JetBrains Mono Variable (ids, keys, scopes, URLs, code only)

**Character:** One industrial grotesque carries every role. Width does the expressive work: legends are set wide and tracked, readouts condensed.

### Hierarchy
- **Page title** (600, 26px, -0.02em): one per page, left, with a one-line purpose below (max 72ch, pretty wrap).
- **Panel title** (600, 15px): titles of panels and drawer sections.
- **Body** (400, 14px/1.5): copy, form labels at 13px medium.
- **Table** (13.5px, tabular figures): all data rows.
- **Legend** (600, 10.5px, 0.08em, uppercase, wdth 112): printed labels on panels, table headers, nav groups. Never above a page heading.
- **Section title** (600, 17px): dialog, drawer, plan-card, and editor section titles.
- **Readout** (600, wdth 86, tabular): instrument numbers on a fixed ladder: 34px balance in the drawer, 32px dashboard money, 30px plan price, 28px strip readouts, 22px secondary dashboard readouts, 20px small trio readouts, 18px stacked multi-currency lines, 17px usage summary cells.
- **Auth display** (600, 34px → 40px at xl, -0.025em): the front-plate statement on sign-in screens only.

### Named Rules
**The Tabular Rule.** Money and counts always use tabular figures and right alignment in columns; a column of money shares one precision (formatMicrosFixed + columnDecimals) with the exact value in the title.

## Layout

Fixed 248px rail (collapsible to 52px icons; an off-canvas sheet below 768px), a 48px top bar with org / page location, and content in a centred column up to 1440px with 16/24/32px gutters by breakpoint. Pages stack panels with 24px gaps. Panel interiors use 20px side padding and hairline rules between rows. Grouped readouts live in one ruled strip (2 columns on mobile, 4 on desktop), never in rows of separate cards. Below `sm`, tables hide secondary columns, fold status under the identity cell, and collapse row actions into a "…" menu.

## Elevation & Depth

Flat by default with one elevation: a 1px hairline. Panels never carry shadows. Shadows appear only on floating layers (menus, dialogs, drawers: `0 18px 40px -8px` soft, offset) and as a 1px under-shadow on keys. Dark mode lifts panels a step above the ground instead of relying on shadows.

### Named Rules
**The One Elevation Rule.** A surface has a border or a shadow, never both, and panels never nest inside panels; groups inside a panel are separated by top rules, not boxes.

## Shapes

Modest appliance radii: 1px status squares and 2px fader thumbs (marks), 4px chips and badges, 6px controls, 8px inner elements, 10px panels and dialogs. Hairline 1px borders throughout. The only round shapes are status discs, the nav lamp, avatars, and switch thumbs.

## Components

### Buttons
- **Shape:** gently squared keys (6px).
- **Primary:** signal-blue fill, white label, inset bottom shade; hover darkens 12%; press moves 1px down.
- **Outline:** face-plate fill with control-stroke border; secondary actions and toolbar keys.
- **Ghost / Ghost-destructive:** text-only for tertiary and in-row actions; destructive reads red and confirms through a dialog.
- **Focus:** 3px signal ring.

### Status badges
- **Style:** 22px face-plate chip with hairline border and ink text; the leading 7px mark encodes state by shape: filled green disc (live), hollow orange ring (pending/suspended), filled red square (revoked/closed), hollow grey ring (off), blue diamond (info/current).

### Panels
- **Corner Style:** 10px. **Background:** face plate. **Border:** hairline. **Header:** panel title + muted description left, actions right, rule below.

### Inputs / Fields
- **Style:** face-plate fill, control-stroke border, 6px radius, faint inset shade.
- **Focus:** border turns signal blue with a 3px ring. **Error:** red border and a red message under the field.

### Navigation
- **Rail:** legend group labels; items 32px, icon + label; active item gets a lighter charcoal fill and a blue lamp at the right. Footer holds the System / Light / Dark selector switch and the account menu.

### Graduated Scale (signature)
- A tick ruler (major + minor ticks, baseline) with one 2px needle and a 3px filled band from zero, settling from zero once on mount (500ms ease-out-expo). Used only for real ratios: gross margin, prompt-cache hit rate, share of spend. `size="sm"` in table cells.

### Window Ruler (signature)
- A logarithmic time ruler (1h · 5h · 1d · 1w · 30d) with a needle per configured rolling limit and its cap printed beside it; inactive rules are grey and struck. Used on plan cards, the plan editor, the customer subscription, and the sign-in front plate.

## Do's and Don'ts

### Do:
- **Do** read money off graduated scales and readouts only when the API returns the underlying values.
- **Do** carry state as mark shape plus a word.
- **Do** confirm destructive actions with the in-app confirm dialog naming the object and whether it can be undone.
- **Do** show one-time secrets in the OneTimeSecret reveal with copy as the primary key.

### Don't:
- **Don't** put a kicker or eyebrow above a heading, or an icon tile beside a page title.
- **Don't** nest bordered boxes inside panels or build rows of same-size stat cards.
- **Don't** use blue, green, orange, or red decoratively.
- **Don't** invent limit-usage or time-series data; the backend does not expose it.
- **Don't** add page-load choreography; the console loads straight into the task.
