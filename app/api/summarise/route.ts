import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { pushLog } from "@/lib/debugLog";
import { getWeekStartMondayUtc } from "@/lib/context";

const DAY_KEYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

function addUtcCalendarDays(ymd: string, deltaDays: number): string {
  const [y, mo, d] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(y!, mo! - 1, d!));
  date.setUTCDate(date.getUTCDate() + deltaDays);
  const yy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

export async function POST(request: Request) {
  try {
    const { athleteId, localDate } = (await request.json()) as {
      athleteId: string;
      localDate: string;
    };

    if (!athleteId || !localDate) {
      return NextResponse.json(
        { error: "athleteId and localDate are required" },
        { status: 400 }
      );
    }

    // Find dates with messages but no daily_summary, excluding today
    const { data: messageDates } = await supabase
      .from("messages")
      .select("date")
      .eq("athlete_id", athleteId)
      .lt("date", localDate)
      .order("date", { ascending: false });

    if (!messageDates || messageDates.length === 0) {
      return NextResponse.json({ generated: 0 });
    }

    // Deduplicate dates
    const uniqueDates = Array.from(
      new Set(messageDates.map((r: { date: string }) => r.date))
    );

    // Check which dates already have summaries
    const { data: existingSummaries } = await supabase
      .from("daily_summaries")
      .select("date")
      .eq("athlete_id", athleteId)
      .in("date", uniqueDates);

    const summarisedDates = new Set(
      (existingSummaries ?? []).map((r: { date: string }) => r.date)
    );

    const unsummarised = uniqueDates
      .filter((d) => !summarisedDates.has(d))
      .slice(0, 3);

    const anthropic = new Anthropic();
    let generated = 0;

    for (const date of unsummarised) {
      try {
        // Idempotency check — re-verify before generating
        const { data: existing } = await supabase
          .from("daily_summaries")
          .select("date")
          .eq("athlete_id", athleteId)
          .eq("date", date)
          .limit(1);

        if (existing && existing.length > 0) continue;

        // Fetch all data for this date in parallel
        const [messagesResult, runsResult, setsResult] = await Promise.all([
          supabase
            .from("messages")
            .select("tab, role, content")
            .eq("athlete_id", athleteId)
            .eq("date", date)
            .order("timestamp", { ascending: true }),
          supabase
            .from("runs")
            .select("*")
            .eq("athlete_id", athleteId)
            .eq("date", date),
          supabase
            .from("sets")
            .select("*")
            .eq("athlete_id", athleteId)
            .eq("date", date),
        ]);

        // Format user message content
        const sections: string[] = [];

        const messages = messagesResult.data ?? [];
        if (messages.length > 0) {
          const formatted = messages
            .map(
              (m: { tab: string; role: string; content: string }) =>
                `[${m.tab}] ${m.role}: ${m.content}`
            )
            .join("\n");
          sections.push(`MESSAGES:\n${formatted}`);
        }

        const runs = runsResult.data ?? [];
        if (runs.length > 0) {
          sections.push(`RUNS:\n${JSON.stringify(runs, null, 2)}`);
        }

        const sets = setsResult.data ?? [];
        if (sets.length > 0) {
          sections.push(`SETS:\n${JSON.stringify(sets, null, 2)}`);
        }

        if (sections.length === 0) continue;

        const systemPrompt = `You are writing your coaching notes for ${date}. Review everything that happened today across all conversations and training data.
The purpose of this summary is to inform a longitudinal view of the athlete. Capture what serves that, omit what doesn't.

Capture: specific sessions with actual numbers. When a session was prescribed, capture both the plan and the execution, even when they match. If a planned session didn't happen, was cut short, or was materially modified, log it with the same rigor as one that did. How the athlete felt. Recovery data if mentioned. Life context. Plan changes and why.

The athlete's voice is important to capture. Preserve their exact words in moments of inflection — how they describe effort, what they believe, what they doubt, how they react in the moment. These quotes are how future coaching hears this person. Capture as many as the day warrants.

If today connects meaningfully to recent days — residue from a PR, travel, a flag that proved right or wrong, a pattern confirming — name the link.

Flag anything that will help you understand this athlete better in the future — patterns forming, beliefs expressed, doubts voiced, breakthroughs happening.

Useful notes name the specific thing and its context. Unuseful notes state the generic fact.

Write in first person as the coach. Use YYYY-MM-DD dates. No markdown formatting. Every word earns its place. Aim for under 100 words unless there's meaningful signal to capture. Prioritize density of facts and quotes over readability.`;

        const response = await anthropic.messages.create({
          model: "claude-sonnet-4-6",
          max_tokens: 500,
          system: systemPrompt,
          messages: [
            {
              role: "user",
              content: sections.join("\n\n"),
            },
          ],
        });

        let summary = "";
        for (const block of response.content) {
          if (block.type === "text") summary += block.text;
        }

        if (summary) {
          const { error } = await supabase.from("daily_summaries").insert({
            athlete_id: athleteId,
            date,
            summary,
            timestamp: new Date().toISOString(),
          });

          if (error) {
            console.error(`[summarise] failed to write summary for ${date}:`, error.message);
            pushLog("error", { date, message: error.message });
          } else {
            generated++;
            pushLog("summary_generated", {
              date,
              summaryText: summary.length > 200 ? summary.slice(0, 200) + "…" : summary,
            });
            console.log(`[summarise] generated summary for ${date}`);
          }
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        pushLog("error", { date, message: errMsg });
        console.error(`[summarise] failed for ${date}:`, errMsg);
        // Continue to next date
      }
    }

    // Gap-fill: synthesise summaries for planned days with no activity
    const thisMonday = getWeekStartMondayUtc(localDate);
    const prevMonday = addUtcCalendarDays(thisMonday, -7);

    const { data: planRows } = await supabase
      .from("weekly_plans")
      .select("week_start, days")
      .eq("athlete_id", athleteId)
      .in("week_start", [thisMonday, prevMonday])
      .order("timestamp", { ascending: false });

    const latestByWeek = new Map<string, Record<string, { session_type?: string; notes?: string }>>();
    for (const row of (planRows ?? []) as Array<{
      week_start: string;
      days: Record<string, { session_type?: string; notes?: string }>;
    }>) {
      if (!latestByWeek.has(row.week_start)) {
        latestByWeek.set(row.week_start, row.days);
      }
    }

    const candidates: Array<{ date: string; sessionType: string | undefined }> = [];
    for (const [weekStart, days] of Array.from(latestByWeek)) {
      DAY_KEYS.forEach((key, i) => {
        const dayDate = addUtcCalendarDays(weekStart, i);
        if (dayDate >= localDate) return;
        candidates.push({ date: dayDate, sessionType: days?.[key]?.session_type });
      });
    }

    for (const { date, sessionType } of candidates) {
      try {
        const [existingSummary, dayMessages, dayRuns, daySets] = await Promise.all([
          supabase
            .from("daily_summaries")
            .select("date")
            .eq("athlete_id", athleteId)
            .eq("date", date)
            .limit(1),
          supabase
            .from("messages")
            .select("date")
            .eq("athlete_id", athleteId)
            .eq("date", date)
            .limit(1),
          supabase
            .from("runs")
            .select("date")
            .eq("athlete_id", athleteId)
            .eq("date", date)
            .limit(1),
          supabase
            .from("sets")
            .select("date")
            .eq("athlete_id", athleteId)
            .eq("date", date)
            .limit(1),
        ]);

        if ((existingSummary.data ?? []).length > 0) continue;
        if ((dayMessages.data ?? []).length > 0) continue;
        if ((dayRuns.data ?? []).length > 0) continue;
        if ((daySets.data ?? []).length > 0) continue;

        if (!sessionType) continue;
        const isRest = sessionType === "rest" || sessionType === "Rest";
        const summary = isRest
          ? "Rest day — planned."
          : `Planned ${sessionType} — no activity logged.`;

        const { error } = await supabase.from("daily_summaries").insert({
          athlete_id: athleteId,
          date,
          summary,
          timestamp: new Date().toISOString(),
        });

        if (error) {
          console.error(`[summarise] gap-fill failed for ${date}:`, error.message);
          pushLog("error", { date, message: error.message });
        } else {
          generated++;
          pushLog("summary_gap_filled", { date, summary });
          console.log(`[summarise] gap-filled summary for ${date}`);
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        pushLog("error", { date, message: errMsg });
        console.error(`[summarise] gap-fill error for ${date}:`, errMsg);
      }
    }

    return NextResponse.json({ generated });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[summarise] route error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
