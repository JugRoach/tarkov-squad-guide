import { Component } from "react";

// ─── GLOBAL CSS (hover/focus states, Leaflet theme) ─────────────────────
if (typeof document !== "undefined" && !document.getElementById("tg-global-css")) {
  const style = document.createElement("style");
  style.id = "tg-global-css";
  style.textContent = `
    /* Focus & hover states for accessibility */
    button:focus-visible, a:focus-visible, input:focus-visible, textarea:focus-visible { outline: 2px solid #d2af78; outline-offset: 2px; }
    button:hover { filter: brightness(1.15); }
    button:active { filter: brightness(0.9); }
    input:focus, textarea:focus { border-color: #d2af78 !important; }
    /* Leaflet dark theme */
    .tg-popup .leaflet-popup-content-wrapper { background: rgba(13,17,23,0.95); color: #f0ead8; border: 1px solid #3d3930; border-radius: 4px; box-shadow: 0 2px 8px rgba(0,0,0,0.6); }
    .tg-popup .leaflet-popup-content { margin: 8px 10px; font-family: 'Courier New', Consolas, monospace; font-size: 12px; }
    .tg-popup .leaflet-popup-tip { background: rgba(13,17,23,0.95); border: 1px solid #3d3930; }
    .leaflet-container { background: #0d0e10 !important; }
    .leaflet-control-zoom a { background: #1a1917 !important; color: #d2af78 !important; border-color: #2d2a24 !important; }
    .leaflet-control-zoom a:hover { background: #2a2720 !important; }
  `;
  document.head.appendChild(style);
}

// ─── ERROR BOUNDARY ─────────────────────────────────────────
export default class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { hasError: false, error: null }; }
  static getDerivedStateFromError(error) { return { hasError: true, error }; }
  render() {
    if (this.state.hasError) return (
      <div role="alert" style={{ height: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "#0d0e10", color: "#c7c5b3", fontFamily: "'Courier New', monospace", padding: 20, textAlign: "center" }}>
        <div style={{ fontSize: 24, color: "#d2af78", marginBottom: 12 }}>Something went wrong</div>
        <div style={{ fontSize: 14, color: "#8a8070", marginBottom: 20, maxWidth: 400 }}>{String(this.state.error?.message || "Unknown error")}</div>
        <button onClick={() => window.location.reload()} style={{ background: "#d2af78", color: "#0d0e10", border: "none", padding: "12px 24px", fontSize: 16, cursor: "pointer", fontFamily: "'Courier New', monospace", fontWeight: "bold" }}>RELOAD APP</button>
      </div>
    );
    return this.props.children;
  }
}
