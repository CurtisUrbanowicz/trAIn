# Design Tokens — Training App V2

Based on the Linear/Modern design system, adapted for a mobile-first coaching app. Stripped of desktop showcase elements (animated blobs, mouse tracking, parallax, noise textures). Clean, fast, precise.

## Philosophy

Premium tool you use every day. The UI disappears and lets the conversation breathe. Dark, precise, layered depth, monochromatic with one accent. Software that feels expensive without feeling ostentatious. Nothing bouncy, nothing decorative — every element earns its place.

Mobile-first. The athlete opens this at 6am half awake, between sets with chalk on their hands, mid-run glancing at their phone.

## Colours

### Backgrounds
- Page background: `#050506`
- Surface (cards, containers, grid cells): `rgba(255,255,255,0.05)`
- Surface hover: `rgba(255,255,255,0.08)`

### Chat bubbles
- Coach message: `rgba(255,255,255,0.08)` (surface, 0.5px default border)
- Athlete message: `rgba(94,106,210,0.32)` with `rgba(94,106,210,0.4)` border — intentionally more saturated than the coach bubble so authorship reads at a glance

### Text
- Primary: `#EDEDEF`
- Secondary/muted: `#8A8F98`
- Streaming/thinking state: primary text at 70% opacity

### Accent
- Primary: `#5E6AD2` (indigo)
- Hover: `#6872D9`
- Use sparingly — interactive elements, active nav icon, data highlights. Most of the UI is monochromatic.

### Borders
- Default: `rgba(255,255,255,0.06)` at 0.5px
- Hover: `rgba(255,255,255,0.10)`

### Navigation
- Background: `#050506` with top border `rgba(255,255,255,0.06)`
- Inactive icon: `#8A8F98`
- Active icon: `#5E6AD2`

### Season tab specific
- Training calendar: planned and completed day = `#5E6AD2` at ~30% opacity. Unplanned/missed = base background.
- Chart data lines/bars: `#5E6AD2`
- Chart toggle buttons: active = `#EDEDEF`, inactive = `#8A8F98` (not indigo — avoid overuse)
- PR markers on charts: `#5E6AD2` solid dots

## Typography

Fonts: Inter (sans, UI default), Source Serif 4 (serif, coach voice only).

**Serif for coach voice.** Source Serif 4 (weights 400, 500) is used *only* for assistant/coach messages, plan-card titles, and stat values (HRV / RHR / Sleep numerals, recovery-score numeral in the orb). Everything else — UI chrome, user messages, buttons, labels — stays Inter. The serif is a voice marker, not a display font.

### Scale
- Chat messages: 15px, weight 400, line-height 1.5
- Headings (grid labels, chart titles): 13px, weight 600, tracking tight
- Small labels/metadata: 12px, weight 400, muted colour
- Tab labels in nav: 10px, weight 500
- Loading screen "train": 28-32px, weight 600

### Principles
- No custom formatting for numbers or data in chat — plain text
- Coach and athlete text styled identically — differentiation is bubble colour and alignment only
- No bold, italic, or special treatments in chat messages unless the AI uses markdown naturally

## Spacing

### Chat
- Bubble padding: 12px 16px
- Bubble max width: ~80% of container
- Gap between messages (same sender): 4px
- Gap between messages (different sender): 16px

### Input bar
- Min height: 44px
- Horizontal padding: 12px
- Expands with text up to ~120px, then internal scroll
- Lock-in button: bottom-left, same row as input. Small, contextual — appears when there's something to confirm.
- Send button: right side, indigo arrow icon, appears only when input has text.

### Bottom nav
- Height: 49px + safe area inset (env(safe-area-inset-bottom))
- 5 tabs: Today | Week | Season | Session | Coach
- Icons + labels

### General
- Max content width: 640px centred on wider screens
- Page-level horizontal padding: 16px

## Borders & Radius

- Cards/containers: 12px radius
- Chat bubbles: 16px radius, flattened on sender's side (4px bottom-left for coach, 4px bottom-right for athlete)
- Buttons: 8px radius
- Input field: 8px radius
- All borders: 0.5px, `rgba(255,255,255,0.06)`

## Interactive Elements

### Buttons
- Primary (lock-in, confirm): `#5E6AD2` background, white text, 8px radius, 36px height
- Ghost/secondary: transparent background, muted text, hover to surface background
- All transitions: 200-300ms, ease-out

### Streaming
- Text streams at 70% opacity
- Blinking indigo cursor (2px bar) at the end of streaming text
- Snaps to 100% opacity when complete

### Charts (Season tab)
- Library: Recharts
- Minimal styling: no gridlines, muted axis labels, clean data lines
- Indigo for primary data series
- Toggle buttons: small text, not indigo — active in primary text, inactive in muted

## Loading Screen

- Background: `#050506`
- "train" centred — "tr" and "n" in `#EDEDEF`, "ai" in `#5E6AD2`
- Personalised subtitle below in muted text: "Catching up on yesterday's session..."
- Fade-in: 300ms
- Triggers on first open of the day (check localStorage for last-open date)
- Runs daily summary generation and context build behind the screen

## Tab-Specific UI Elements

### Today
- Pure chat. No additional UI elements.

### Session
- Plan card at top of chat (scrolls with content). Surface background, 12px radius, 0.5px border.
- Lifting: exercise list with target weights/reps, one line per exercise, muted text, compact.
- Running: run type, distance, effort/HR targets, 2-3 lines.
- No plan: card doesn't render.

### Week
- Collapsed week bar at top. Always present regardless of plan state.
- No plan: "Week of Apr 6 — no sessions planned"
- Plan exists: "Week of Apr 6 — 4 sessions planned" (collapsed) or expanded vertical list
- Expanded list: full-width rows, ~36-40px height. Day+date left, session type right. Rest days muted. Training days surface background. Today marked with indigo left border.
- Swipeable between current week and next week. Two stops only.
- Chevron to expand/collapse.
- Chat below the bar.

### Season
- Meso indicator bar at top. Slim. "Base build — Week 11 of 15" with indigo progress fill. Or "No active block."
- Training calendar: two months side by side (last month + this month). Calendar grid, 7 columns (Mon-Sun). Cells filled indigo for planned+completed days. Base background for empty/missed. Offset for month start day.
- Lifting trends: line chart per compound, toggle between lifts. Default 4 weeks, expandable to 12w or 52w. PR dots in indigo.
- Running volume: bar chart, weekly total. Default 4 weeks, expandable to 12w or 52w.
- Chat minimised below all charts. Expands when athlete engages.

### Coach
- Pure chat. Identical to Today layout.

## Anti-Patterns

- No semantic colours (success green, warning amber, error red). The AI communicates context through language, not colour.
- No badges, status indicators, or notification dots.
- No gradients, shadows beyond multi-layer card shadows, or glow effects on mobile.
- No animated backgrounds, floating elements, or parallax.
- Indigo is for interactive elements and data — not decoration. When in doubt, use monochromatic.
