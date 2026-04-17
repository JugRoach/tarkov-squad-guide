import React from 'react'
import ReactDOM from 'react-dom/client'
import DesktopApp from './DesktopApp.jsx'
import ScannerPopout from './components/ScannerPopout.jsx'
import { supabase } from './supabase.js'


// Generate or retrieve a stable device ID
function getDeviceId() {
  let id = localStorage.getItem('tg-device-id')
  if (!id) {
    id = 'dev_' + crypto.randomUUID()
    localStorage.setItem('tg-device-id', id)
  }
  return id
}

const deviceId = getDeviceId()

// Warn once per session if cross-device sync is silently failing — avoids
// false "my data is synced" belief while also keeping the console quiet.
let syncWarned = false
function warnSyncOnce(op, err) {
  if (syncWarned) return
  syncWarned = true
  console.warn(`[TG] Supabase ${op} failed — data saved locally only. Cross-device sync disabled for this session.`, err)
}

// Cloud-backed storage with localStorage as fast cache
// Falls back to pure localStorage if Supabase is unavailable
window.storage = {
  get: async (key) => {
    // Fast path: read from localStorage
    const local = localStorage.getItem(key)
    if (local !== null) return { key, value: local }

    // Fallback: check Supabase if localStorage is empty
    if (supabase) {
      try {
        const { data } = await supabase
          .from('user_storage')
          .select('value')
          .eq('user_id', deviceId)
          .eq('key', key)
          .single()
        if (data?.value != null) {
          localStorage.setItem(key, data.value)
          return { key, value: data.value }
        }
      } catch (_) {}
    }
    return null
  },

  set: async (key, value) => {
    // Write to localStorage immediately
    localStorage.setItem(key, value)

    // Write-through to Supabase
    if (supabase) {
      try {
        const { error } = await supabase
          .from('user_storage')
          .upsert(
            { user_id: deviceId, key, value, updated_at: new Date().toISOString() },
            { onConflict: 'user_id,key' }
          )
        if (error) warnSyncOnce('write', error)
      } catch (e) {
        warnSyncOnce('write', e)
      }
    }
    return { key, value }
  },

  delete: async (key) => {
    localStorage.removeItem(key)
    if (supabase) {
      try {
        await supabase
          .from('user_storage')
          .delete()
          .eq('user_id', deviceId)
          .eq('key', key)
      } catch (_) {}
    }
    return { key, deleted: true }
  },

  list: async (prefix = '') => {
    const keys = Object.keys(localStorage).filter(k => k.startsWith(prefix))
    return { keys }
  }
}

// Detect if this is the scanner popout window
// Try sync check via __TAURI_INTERNALS__, async fallback via API
function AppRoot() {
  const [isPopout, setIsPopout] = React.useState(() => {
    const label = window.__TAURI_INTERNALS__?.metadata?.currentWebview?.label;
    return label === 'scanner-popout';
  });

  React.useEffect(() => {
    if (isPopout) return;
    (async () => {
      try {
        const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
        if (getCurrentWebviewWindow().label === 'scanner-popout') setIsPopout(true);
      } catch (_) {}
    })();
  }, []);

  return isPopout ? <ScannerPopout /> : <DesktopApp />;
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AppRoot />
  </React.StrictMode>
)
