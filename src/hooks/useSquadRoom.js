import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "../supabase.js";
import { PLAYER_COLORS } from "../theme.js";

export const ROOM_WORDS = ["ALPHA","BRAVO","CHARLIE","DELTA","ECHO","FOXTROT","GHOST","HUNTER","IRON","JACKAL","KILO","LIMA","MIKE","NOVA","OSCAR","PAPA","QUEST","RAVEN","SIERRA","TANGO","ULTRA","VIPER","WOLF","XRAY","YANK","ZULU"];
export function generateRoomCode() {
  const word = ROOM_WORDS[Math.floor(Math.random() * ROOM_WORDS.length)];
  const num = Math.floor(Math.random() * 900 + 100);
  return `${word}-${num}`;
}

export function useSquadRoom(myProfile) {
  const deviceId = localStorage.getItem("tg-device-id") || "unknown";
  const [roomId, setRoomId] = useState(null);
  const [roomCode, setRoomCode] = useState(null);
  const [members, setMembers] = useState([]);
  const [status, setStatus] = useState("idle"); // idle | creating | joining | connected | error
  const [error, setError] = useState(null);
  const [leaderId, setLeaderId] = useState(null); // device_id of leader, null = no leader
  const [sharedRoute, setSharedRoute] = useState(null); // route broadcast from leader
  const [sharedRouteConfig, setSharedRouteConfig] = useState(null); // {mapId, faction, routeMode, ...}
  const [leaderStale, setLeaderStale] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const subRef = useRef(null);
  const roomSubRef = useRef(null);
  const heartbeatRef = useRef(null);
  const healthCheckRef = useRef(null);
  const reconnectBackoffRef = useRef(1000);
  const subscribeRef = useRef(null);

  const isLeader = leaderId === deviceId;
  const hasLeader = leaderId !== null;

  // Push profile + preferences to room whenever they change. pmcLevel,
  // traderLevels, and raidHistory come from the log watcher / manual profile
  // edits — including them here means squad members see each other's
  // progression and raid history live without any extra sync plumbing.
  useEffect(() => {
    if (!supabase || !roomId || !myProfile?.name) return;
    const profileData = {
      name: myProfile.name,
      color: myProfile.color,
      tasks: myProfile.tasks || [],
      progress: myProfile.progress || {},
      pmcLevel: myProfile.pmcLevel ?? 1,
      traderLevels: myProfile.traderLevels || {},
      raidHistory: myProfile.raidHistory || [],
      lastLogSync: myProfile.lastLogSync || null,
    };
    supabase.from("squad_members").upsert(
      { room_id: roomId, device_id: deviceId, profile: profileData, updated_at: new Date().toISOString() },
      { onConflict: "room_id,device_id" }
    ).then(({ error: e }) => { if (e && import.meta.env.DEV) console.warn("[TG] Room profile sync failed:", e); });
  }, [
    roomId,
    myProfile?.name,
    myProfile?.color,
    myProfile?.tasks?.length,
    myProfile?.pmcLevel,
    myProfile?.lastLogSync,
    JSON.stringify(myProfile?.progress),
    JSON.stringify(myProfile?.traderLevels),
    myProfile?.raidHistory?.length,
  ]);

  // Leader heartbeat: update heartbeat_at in route_config every 15s
  useEffect(() => {
    if (!supabase || !roomId || !isLeader) {
      if (heartbeatRef.current) { clearInterval(heartbeatRef.current); heartbeatRef.current = null; }
      return;
    }
    const sendHeartbeat = async () => {
      const { data } = await supabase.from("squad_rooms").select("route_config").eq("id", roomId).single();
      const existing = data?.route_config || {};
      await supabase.from("squad_rooms").update({ route_config: { ...existing, heartbeat_at: new Date().toISOString() } }).eq("id", roomId);
    };
    sendHeartbeat(); // send immediately on becoming leader
    heartbeatRef.current = setInterval(sendHeartbeat, 15000);
    return () => { if (heartbeatRef.current) { clearInterval(heartbeatRef.current); heartbeatRef.current = null; } };
  }, [roomId, isLeader]);

  // Leader health check: non-leaders check heartbeat_at every 20s
  useEffect(() => {
    if (!supabase || !roomId || isLeader || !hasLeader) {
      setLeaderStale(false);
      if (healthCheckRef.current) { clearInterval(healthCheckRef.current); healthCheckRef.current = null; }
      return;
    }
    const checkHealth = async () => {
      const { data } = await supabase.from("squad_rooms").select("route_config").eq("id", roomId).single();
      const hb = data?.route_config?.heartbeat_at;
      if (!hb) { setLeaderStale(true); return; }
      const age = Date.now() - new Date(hb).getTime();
      setLeaderStale(age > 45000);
    };
    checkHealth(); // check immediately
    healthCheckRef.current = setInterval(checkHealth, 20000);
    return () => { if (healthCheckRef.current) { clearInterval(healthCheckRef.current); healthCheckRef.current = null; } };
  }, [roomId, isLeader, hasLeader]);

  // Push preferences (extract vote, ready state) separately so they don't conflict with profile syncs
  const updatePreferences = useCallback(async (prefs) => {
    if (!supabase || !roomId) return;
    // Merge with existing preferences
    const { data: current } = await supabase.from("squad_members").select("preferences").eq("room_id", roomId).eq("device_id", deviceId).single();
    const merged = { ...(current?.preferences || {}), ...prefs };
    await supabase.from("squad_members").update({ preferences: merged }).eq("room_id", roomId).eq("device_id", deviceId);
  }, [roomId, deviceId]);

  // Reconnect a channel with exponential backoff (uses subscribeRef to avoid circular deps)
  const reconnectChannel = useCallback((rid, channelType) => {
    const delay = reconnectBackoffRef.current;
    setReconnecting(true);
    if (import.meta.env.DEV) console.warn(`[TG] ${channelType} channel disconnected, retrying in ${delay}ms`);
    setTimeout(() => {
      if (subscribeRef.current) subscribeRef.current(rid);
    }, delay);
    reconnectBackoffRef.current = Math.min(delay * 2, 30000);
  }, []);

  // Subscribe to room members AND room changes (for leader/route)
  const subscribeToRoom = useCallback((rid) => {
    if (!supabase) return;
    if (subRef.current) { supabase.removeChannel(subRef.current); subRef.current = null; }
    if (roomSubRef.current) { supabase.removeChannel(roomSubRef.current); roomSubRef.current = null; }

    // Initial fetch — members
    supabase.from("squad_members").select("*").eq("room_id", rid).then(({ data }) => {
      if (data) setMembers(data.filter(m => m.device_id !== deviceId));
    });

    // Initial fetch — room (leader, route)
    supabase.from("squad_rooms").select("leader_id, route, route_config").eq("id", rid).single().then(({ data }) => {
      if (data) {
        setLeaderId(data.leader_id || null);
        setSharedRoute(data.route || null);
        setSharedRouteConfig(data.route_config || null);
      }
    });

    // Realtime: members
    const memberChannel = supabase.channel(`room-members-${rid}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "squad_members", filter: `room_id=eq.${rid}` }, (payload) => {
        if (payload.eventType === "DELETE") {
          setMembers(prev => prev.filter(m => m.id !== payload.old.id));
        } else {
          const row = payload.new;
          if (row.device_id === deviceId) return;
          setMembers(prev => {
            const exists = prev.findIndex(m => m.id === row.id);
            if (exists >= 0) { const next = [...prev]; next[exists] = row; return next; }
            return [...prev, row];
          });
        }
      })
      .subscribe((status) => {
        if (status === "SUBSCRIBED") { setReconnecting(false); reconnectBackoffRef.current = 1000; }
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") { reconnectChannel(rid, "members"); }
      });
    subRef.current = memberChannel;

    // Realtime: room (leader changes, route broadcasts)
    const roomChannel = supabase.channel(`room-state-${rid}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "squad_rooms", filter: `id=eq.${rid}` }, (payload) => {
        const row = payload.new;
        setLeaderId(row.leader_id || null);
        setSharedRoute(row.route || null);
        setSharedRouteConfig(row.route_config || null);
      })
      .subscribe((status) => {
        if (status === "SUBSCRIBED") { setReconnecting(false); reconnectBackoffRef.current = 1000; }
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") { reconnectChannel(rid, "room-state"); }
      });
    roomSubRef.current = roomChannel;
  }, [deviceId, reconnectChannel]);

  // Keep ref in sync so reconnectChannel can call latest subscribeToRoom
  useEffect(() => { subscribeRef.current = subscribeToRoom; }, [subscribeToRoom]);

  const createRoom = useCallback(async () => {
    if (!supabase) { setError("Supabase not configured"); return; }
    setStatus("creating"); setError(null);
    try {
      const code = generateRoomCode();
      const { data, error: e } = await supabase.from("squad_rooms").insert({ code, created_by: deviceId }).select().single();
      if (e) throw e;
      setRoomId(data.id); setRoomCode(data.code); setStatus("connected");
      subscribeToRoom(data.id);
    } catch (e) { setError(e.message); setStatus("error"); }
  }, [deviceId, subscribeToRoom]);

  const joinRoom = useCallback(async (code) => {
    if (!supabase) { setError("Supabase not configured"); return; }
    setStatus("joining"); setError(null);
    try {
      const { data, error: e } = await supabase.from("squad_rooms").select("id, code, leader_id, route, route_config").eq("code", code.trim().toUpperCase()).single();
      if (e || !data) throw new Error("Room not found — check the code and try again.");
      setRoomId(data.id); setRoomCode(data.code); setStatus("connected");
      setLeaderId(data.leader_id || null);
      setSharedRoute(data.route || null);
      setSharedRouteConfig(data.route_config || null);
      subscribeToRoom(data.id);
    } catch (e) { setError(e.message); setStatus("error"); }
  }, [subscribeToRoom]);

  const leaveRoom = useCallback(async () => {
    if (heartbeatRef.current) { clearInterval(heartbeatRef.current); heartbeatRef.current = null; }
    if (healthCheckRef.current) { clearInterval(healthCheckRef.current); healthCheckRef.current = null; }
    if (subRef.current && supabase) { supabase.removeChannel(subRef.current); subRef.current = null; }
    if (roomSubRef.current && supabase) { supabase.removeChannel(roomSubRef.current); roomSubRef.current = null; }
    if (supabase && roomId) {
      // If leaving leader, clear leader
      if (isLeader) await supabase.from("squad_rooms").update({ leader_id: null, route: null, route_config: null }).eq("id", roomId);
      await supabase.from("squad_members").delete().eq("room_id", roomId).eq("device_id", deviceId);
    }
    setRoomId(null); setRoomCode(null); setMembers([]); setStatus("idle"); setError(null);
    setLeaderId(null); setSharedRoute(null); setSharedRouteConfig(null);
    setLeaderStale(false); setReconnecting(false);
    reconnectBackoffRef.current = 1000;
  }, [roomId, deviceId, isLeader]);

  // Claim / release leadership
  const claimLeader = useCallback(async () => {
    if (!supabase || !roomId) return;
    await supabase.from("squad_rooms").update({ leader_id: deviceId, route: null, route_config: null }).eq("id", roomId);
  }, [roomId, deviceId]);

  const releaseLeader = useCallback(async () => {
    if (!supabase || !roomId) return;
    if (heartbeatRef.current) { clearInterval(heartbeatRef.current); heartbeatRef.current = null; }
    await supabase.from("squad_rooms").update({ leader_id: null, route: null, route_config: null }).eq("id", roomId);
  }, [roomId]);

  // Broadcast route (leader only)
  const broadcastRoute = useCallback(async (route, config) => {
    if (!supabase || !roomId || !isLeader) return;
    await supabase.from("squad_rooms").update({ route, route_config: config }).eq("id", roomId);
  }, [roomId, isLeader]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (heartbeatRef.current) clearInterval(heartbeatRef.current);
      if (healthCheckRef.current) clearInterval(healthCheckRef.current);
      if (subRef.current && supabase) supabase.removeChannel(subRef.current);
      if (roomSubRef.current && supabase) supabase.removeChannel(roomSubRef.current);
    };
  }, []);

  // Convert members to squad profiles format
  const roomSquad = members.map(m => ({
    id: "room_" + m.device_id,
    name: m.profile?.name || "???",
    color: m.profile?.color || PLAYER_COLORS[1],
    tasks: m.profile?.tasks || [],
    progress: m.profile?.progress || {},
    imported: true,
    importedAt: new Date(m.updated_at).getTime(),
    isRoomMember: true,
    deviceId: m.device_id,
    preferences: m.preferences || {},
  }));

  return {
    roomId, roomCode, roomSquad, status, error,
    createRoom, joinRoom, leaveRoom,
    // Leader
    leaderId, isLeader, hasLeader, claimLeader, releaseLeader,
    // Leader health
    leaderStale, reconnecting,
    // Route broadcast
    sharedRoute, sharedRouteConfig, broadcastRoute,
    // Preferences
    updatePreferences,
    deviceId,
  };
}
