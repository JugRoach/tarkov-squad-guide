import { useEffect, useRef } from "react";
import { supabase } from "../supabase.js";

// Auto-sync the local profile to Supabase so it survives localStorage
// wipes (browser cache clear, app reinstall). Keyed by `tg-device-id` —
// the same ID the squad room uses — so there's no new auth layer and
// the threat model stays consistent with squad_members. Real
// cross-device (email/OTP auth scoped to auth.uid()) is a follow-up.
//
// Protocol:
//   - One-time pull at startup. If local is empty AND cloud has data,
//     restore cloud locally. Otherwise trust local as canonical.
//   - Debounced push on every subsequent profile change.
//   - Suppress the first push after a pull so the pulled data doesn't
//     immediately round-trip back to the cloud.
//   - Silent no-op if the Supabase client is missing, the device_id
//     isn't set, or the table doesn't exist yet (e.g., migration not run).

const DEBOUNCE_MS = 2000;

export function useProfileCloudSync(myProfile, saveMyProfile, profileReady) {
  const deviceId = typeof window !== "undefined"
    ? localStorage.getItem("tg-device-id")
    : null;
  const pullDoneRef = useRef(false);
  const justPulledRef = useRef(false);
  const pushTimerRef = useRef(null);

  // Initial pull: only if local profile is effectively empty.
  useEffect(() => {
    if (!supabase || !deviceId || !profileReady || pullDoneRef.current) return;
    pullDoneRef.current = true;

    const isLocalEmpty = !myProfile?.name && !(myProfile?.tasks?.length);
    if (!isLocalEmpty) return;

    let cancelled = false;
    (async () => {
      try {
        const { data, error } = await supabase
          .from("user_profiles")
          .select("profile")
          .eq("device_id", deviceId)
          .maybeSingle();
        if (error) throw error;
        if (cancelled) return;
        if (data?.profile && typeof data.profile === "object") {
          justPulledRef.current = true;
          // Preserve the local profile's `id` (used as the squad device_id
          // identifier) — it shouldn't be overwritten by whatever happened
          // to be in the cloud copy.
          saveMyProfile({ ...data.profile, id: myProfile?.id || data.profile.id });
        }
      } catch (e) {
        // Silent: table may not exist yet if the migration hasn't been run.
        // The user can still use the app; sync just won't persist.
        // eslint-disable-next-line no-console
        console.warn("Profile cloud pull skipped:", e?.message || e);
      }
    })();
    return () => { cancelled = true; };
  }, [profileReady, deviceId, myProfile, saveMyProfile]);

  // Debounced push on every subsequent change.
  useEffect(() => {
    if (!supabase || !deviceId || !profileReady || !pullDoneRef.current) return;
    // Skip the first push after a pull (would echo the pulled data back).
    if (justPulledRef.current) {
      justPulledRef.current = false;
      return;
    }
    // Skip empty profiles — no point syncing the initial template.
    if (!myProfile?.name && !(myProfile?.tasks?.length)) return;

    if (pushTimerRef.current) clearTimeout(pushTimerRef.current);
    pushTimerRef.current = setTimeout(async () => {
      try {
        await supabase.from("user_profiles").upsert(
          {
            device_id: deviceId,
            profile: myProfile,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "device_id" }
        );
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn("Profile cloud push failed:", e?.message || e);
      }
    }, DEBOUNCE_MS);

    return () => {
      if (pushTimerRef.current) clearTimeout(pushTimerRef.current);
    };
  }, [myProfile, profileReady, deviceId]);
}
