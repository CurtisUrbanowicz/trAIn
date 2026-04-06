import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

// Client-side safe because it only uses public env vars (`NEXT_PUBLIC_*`).
export const supabase = createClient(supabaseUrl, supabaseAnonKey);

