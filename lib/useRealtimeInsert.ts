"use client";

import { useEffect, useRef } from "react";
import { supabase } from "@/lib/supabase";

/**
 * Subscribe to Postgres INSERTs on `table`, optionally filtered
 * (e.g. `athlete_id=eq.<uuid>`). The callback receives the inserted row
 * (callers that only refetch can ignore it) and is captured via ref so
 * changes to it don't retrigger the subscription.
 */
export function useRealtimeInsert(
  channelName: string,
  table: string,
  onInsert: (row: Record<string, unknown>) => void,
  filter?: string,
): void {
  const cbRef = useRef(onInsert);
  useEffect(() => {
    cbRef.current = onInsert;
  }, [onInsert]);

  useEffect(() => {
    const config: {
      event: "INSERT";
      schema: "public";
      table: string;
      filter?: string;
    } = {
      event: "INSERT",
      schema: "public",
      table,
    };
    if (filter) config.filter = filter;

    const channel = supabase
      .channel(channelName)
      .on("postgres_changes", config, (payload) =>
        cbRef.current((payload.new ?? {}) as Record<string, unknown>)
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [channelName, table, filter]);
}
