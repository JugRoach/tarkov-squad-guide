// API and app-wide constants
export const API_URL = "https://api.tarkov.dev/graphql";
export const CODE_VERSION = "TG2";
export const BUILD_CODE_VERSION = "TGB";

// Default minimum "worth picking up" value per slot (roubles). Used by the
// scanner popout + profile settings + the upcoming green/red picker feature.
export const DEFAULT_SCANNER_THRESHOLD = 20000;

// Timings (milliseconds)
export const TOAST_MS = 2500;        // copy-to-clipboard "copied" flash
export const UPDATER_CHECK_DELAY_MS = 2000;
export const SQUAD_HEALTH_INTERVAL_MS = 20000;
export const LEAFLET_REDRAW_MS = 100;

// In-game trader menu order
export const TRADER_ORDER = ["Prapor","Therapist","Fence","Skier","Peacekeeper","Mechanic","Ragman","Jaeger","Lightkeeper","BTR Driver","Ref","Taran","Radio station","Mr. Kerman","Voevoda"];
export const traderSort = (a, b) => { const ia = TRADER_ORDER.indexOf(a); const ib = TRADER_ORDER.indexOf(b); return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib); };
