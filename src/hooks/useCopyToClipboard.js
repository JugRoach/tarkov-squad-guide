import { useRef, useState } from "react";

// Clipboard-copy helper with a toast-style `copied` flag that flips back to
// false after `resetMs`. Falls back to a hidden-textarea + execCommand path
// for older WebView2 builds where navigator.clipboard isn't available.
export function useCopyToClipboard({ resetMs = 2500 } = {}) {
  const [copied, setCopied] = useState(null);
  const timerRef = useRef(null);

  const copy = async (text, tag = true) => {
    if (!text) return false;
    const flash = () => {
      setCopied(tag);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(null), resetMs);
    };
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        flash();
        return true;
      }
    } catch { /* fall through to legacy path */ }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      flash();
      return true;
    } catch {
      return false;
    }
  };

  return { copied, copy };
}
