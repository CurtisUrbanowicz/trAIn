import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { pushLog } from "@/lib/debugLog";

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

    if (unsummarised.length === 0) {
      return NextResponse.json({ generated: 0 });
    }

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

Write in first person as the coach. Use YYYY-MM-DD dates. Under 100 words.

Include: specific sessions with actual numbers. How the athlete felt — their exact words where revealing. Recovery data if mentioned. Life context. Any plan changes and why. Any patterns or flags worth noting.

The bar: "Athlete said 'I just can't face the gym today' despite 81 HRV and 58 RHR — third time this month subjective fatigue has contradicted recovery metrics" is useful. "Athlete reported fatigue" is not.`;

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

    return NextResponse.json({ generated });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[summarise] route error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
