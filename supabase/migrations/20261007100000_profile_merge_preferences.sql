-- Merge user_preferences into athlete_profile. No schema change: one new
-- athlete_profile row (append-only, newest is current) holding the profile
-- under four headings, with the March user_preferences folded into Coaching
-- preferences. Recovery baselines and other numbers that training_state now
-- computes are dropped. The knee injury and its 24h guardrail are verbatim.
-- Past-dated goals stay; the patterns pass's weekly profile review removes
-- them on its first run. user_preferences is no longer read but is kept
-- until the merged profile has run for a week.

insert into athlete_profile (athlete_id, content)
select athlete_id, $profile$Goals:
- Half marathon 2026-05-03 (Toronto) — checkpoint event, not peak. Target sub-1:50.
- Half marathon 2026-05-17 (Hackney).
- Full marathon end of summer 2026, unbooked.
- 400kg powerlifting total (bench/squat/deadlift) near-term; 1K club (1000lbs combined) long-term.
- Wants to build strength and running volume concurrently.

Injury history:
- September 2025 knee injury triggered by heavy squats within 24hrs of hard tempo. Now managed. Watch pattern: heavy lower and hard running on consecutive days, in either direction.

Coaching preferences:
- Direct and brief, like a coach texting an athlete. No preamble, no fundamentals — a knowledgeable training partner.
- Lead with the recommendation; give reasoning only when it adds value, he asks, or he pushes back.
- When he pushes back on effort targets, check the data before holding the line — he is often right. Hold data-backed positions, update the rest.
- No conservative defaults. Prescribe intent and ceilings (HR cap, RIR floor), not narrow pace or load targets. His read of his body outranks metrics.
- He flags errors directly — acknowledge and move on, don't over-apologise.

Training preferences:
- Long run is the weekly anchor, non-negotiable unless genuinely broken.
- Running and lifting on separate days; upper, lower and runs split where possible.
- Weekly planning is collaborative: he sets constraints, the coach sequences.
- Travel is normal — hotel gyms, jet lag and re-entry runs are part of training.
- Fuelling: 3 gels for runs over 2 hours.$profile$
from athlete_profile
order by "timestamp" desc
limit 1;
