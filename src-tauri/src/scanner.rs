use screenshots::Screen;
use std::fs::File;
use std::io::Write;
use std::path::PathBuf;
use windows::Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap};
use windows::Media::Ocr::OcrEngine;

/// Dump an RGBA buffer as a PPM (P6) so we can inspect what the scanner
/// sees without adding an image-encoding dependency. Only runs in debug
/// builds (cargo check / tauri dev). Files land in %TEMP%.
fn debug_dump_rgba(name: &str, rgba: &[u8], width: u32, height: u32) {
    if !cfg!(debug_assertions) {
        return;
    }
    let Some(tmp) = std::env::var_os("TEMP").map(PathBuf::from) else {
        return;
    };
    let path = tmp.join(format!("tarkov-scan-{name}.ppm"));
    let Ok(mut f) = File::create(&path) else { return };
    let header = format!("P6\n{width} {height}\n255\n");
    if f.write_all(header.as_bytes()).is_err() {
        return;
    }
    // RGBA -> RGB
    let mut rgb = Vec::with_capacity((width * height * 3) as usize);
    for px in rgba.chunks_exact(4) {
        rgb.push(px[0]);
        rgb.push(px[1]);
        rgb.push(px[2]);
    }
    let _ = f.write_all(&rgb);
}

#[derive(Clone, Debug)]
struct PositionedWord {
    text: String,
    cx: f64,
    cy: f64,
}

/// Shared capture logic: grab a region around the cursor, return raw RGBA
/// + dimensions + the cursor's position within the capture's coordinate
/// space. The capture is biased upward (3/4 above cursor) because Tarkov's
/// shortName label sits at the top of an inventory tile.
struct CursorCapture {
    rgba: Vec<u8>,
    width: u32,
    height: u32,
    cursor_x_in_capture: i32,
    cursor_y_in_capture: i32,
}

fn capture_region_around_cursor(region_w: u32, region_h: u32) -> Result<CursorCapture, String> {
    // Standard capture: biased 3/4 above the cursor (tile labels sit at top).
    capture_region_around_cursor_biased(region_w, region_h, 3, 4)
}

fn capture_region_around_cursor_biased(
    region_w: u32,
    region_h: u32,
    top_num: u32,
    top_den: u32,
) -> Result<CursorCapture, String> {
    let (cx, cy) = get_cursor_pos().map_err(|e| format!("Failed to get cursor pos: {e}"))?;
    let rx = (cx as i32 - region_w as i32 / 2).max(0);
    let top_offset = (region_h as i32 * top_num as i32 / top_den as i32).max(0);
    let ry = (cy as i32 - top_offset).max(0);

    let screens = Screen::all().map_err(|e| format!("Failed to enumerate screens: {e}"))?;
    let screen = screens
        .into_iter()
        .find(|s| {
            let di = s.display_info;
            (cx as i32) >= di.x
                && (cx as i32) < di.x + di.width as i32
                && (cy as i32) >= di.y
                && (cy as i32) < di.y + di.height as i32
        })
        .ok_or_else(|| "Cursor not on any screen".to_string())?;

    let capture = screen
        .capture_area(rx, ry, region_w, region_h)
        .map_err(|e| format!("Screen capture failed: {e}"))?;

    let (width, height) = capture.dimensions();
    let rgba = capture.into_raw();
    Ok(CursorCapture {
        rgba,
        width,
        height,
        cursor_x_in_capture: cx as i32 - rx,
        cursor_y_in_capture: cy as i32 - ry,
    })
}

/// Raw pixel capture for icon-hash based recognition. Returns RGBA bytes
/// plus dimensions and the cursor's position within the capture — the
/// JS side needs the cursor point to isolate the tile icon before
/// hashing. Runs in parallel with `scan_at_cursor` so OCR and dHash
/// matching can cross-check each other.
#[tauri::command]
pub fn capture_rgba_at_cursor() -> Result<serde_json::Value, String> {
    // Same capture region as scan_at_cursor — keeps both paths seeing
    // the same pixels.
    let cap = capture_region_around_cursor(220, 130)?;
    // Run tile detection so the JS side can crop dHash to the actual
    // tile rect (matches multi-slot item aspect ratios correctly)
    // rather than a fixed 80px square centered on the cursor.
    let tile = detect_highlighted_tile(
        &cap.rgba,
        cap.width,
        cap.height,
        cap.cursor_x_in_capture,
        cap.cursor_y_in_capture,
    );
    let tile_json = match tile {
        Some(r) => serde_json::json!({"x": r.x, "y": r.y, "w": r.w, "h": r.h}),
        None => serde_json::Value::Null,
    };
    Ok(serde_json::json!({
        "rgba": cap.rgba,
        "width": cap.width,
        "height": cap.height,
        "cursorX": cap.cursor_x_in_capture,
        "cursorY": cap.cursor_y_in_capture,
        "tile": tile_json,
    }))
}

/// Wide OCR capture for tooltip verification. Captures a larger region with
/// less upward bias (tooltips appear near or below the cursor) and returns
/// OCR LINES rather than individual words — the JS side wants to match full
/// item names like "Aseptic bandage" against each line. Intended to run on
/// a slower cadence (~1 Hz) alongside the fast scan to confirm or correct
/// its picks once the tooltip has had time to appear.
///
/// Tile-anchored: after capture, detects the highlighted inventory tile and
/// masks it (plus everything above-left of the cursor) to black before OCR.
/// This prevents neighboring-tile labels and the hovered tile's own
/// shortName from leaking into the OCR lines, which was causing adjacent
/// item names to spuriously "verify" the wrong candidate.
#[tauri::command]
pub fn ocr_tooltip_region() -> Result<Vec<String>, String> {
    let region_w: u32 = 420;
    let region_h: u32 = 320;
    // 1/4 above cursor, 3/4 below — inverted from the fast-scan bias so
    // the Tarkov tooltip (which flows down-right from the cursor) lands
    // inside the capture rectangle.
    let cap = capture_region_around_cursor_biased(region_w, region_h, 1, 4)?;

    // If the cursor isn't on a tile, the tooltip isn't up — don't pay for
    // OCR. This both saves CPU and prevents stray UI text from being fed
    // to the verify pass.
    let tile = detect_highlighted_tile(
        &cap.rgba,
        cap.width,
        cap.height,
        cap.cursor_x_in_capture,
        cap.cursor_y_in_capture,
    );
    if tile.is_none() {
        return Ok(Vec::new());
    }
    let tile = tile.unwrap();

    // Mask out the tile itself — its shortName label would otherwise
    // match single-word items like "Lamp" and pre-empt the tooltip's full
    // name. We deliberately do NOT mask above/left of the cursor, since
    // Tarkov flips tooltip direction near screen edges (up-left from
    // bottom-right corner, etc.). The JS-side token-bag subset +
    // shortName-agreement filters already catch neighboring-tile leakage.
    let mut masked = cap.rgba.clone();
    mask_region_to_black(&mut masked, cap.width, cap.height, tile.x, tile.y, tile.w, tile.h);

    const SCALE: u32 = 3;
    let (processed, pw, ph) = preprocess(&masked, cap.width, cap.height, SCALE);
    debug_dump_rgba("tooltip", &processed, pw, ph);

    let lines = ocr_lines(&processed, pw, ph).map_err(|e| format!("OCR failed: {e}"))?;
    Ok(lines)
}

/// Zero out the alpha and RGB bytes inside a rect. Used to hide the
/// hovered tile + above-left quadrant from the tooltip OCR pass.
fn mask_region_to_black(rgba: &mut [u8], width: u32, height: u32, rx: u32, ry: u32, rw: u32, rh: u32) {
    let x0 = rx.min(width);
    let y0 = ry.min(height);
    let x1 = (rx + rw).min(width);
    let y1 = (ry + rh).min(height);
    for y in y0..y1 {
        let row_start = (y * width + x0) as usize * 4;
        let row_end = (y * width + x1) as usize * 4;
        for b in &mut rgba[row_start..row_end] {
            *b = 0;
        }
    }
}


#[derive(Clone, Copy, Debug)]
struct TileRect {
    x: u32,
    y: u32,
    w: u32,
    h: u32,
}

/// "Is the cursor actually on an inventory tile, and if so, where?". Two-stage:
///   1. Fast patch-luminance gate — rejects cursor-over-empty-space before
///      paying for the ray cast. Percentile-based so HDR doesn't break it
///      (compares patch against the capture's own darkness floor, not a
///      fixed luma value that shifts with display gamma).
///   2. Ray-cast from the cursor in four cardinal directions, stopping when
///      luminance drops below the darkness floor for 4 consecutive pixels
///      (the tile-to-tile gap). The four stops frame the tile's bounds.
///
/// Returned rect is in capture-pixel coords and slightly padded so the crop
/// includes the tile's darker border pixels, matching the framing of the
/// tarkov.dev reference icons that dHash compares against.
fn detect_highlighted_tile(
    rgba: &[u8],
    width: u32,
    height: u32,
    cursor_x: i32,
    cursor_y: i32,
) -> Option<TileRect> {
    if width == 0 || height == 0 {
        return None;
    }
    let src_len = (width * height) as usize;
    if rgba.len() < src_len * 4 {
        return None;
    }
    let w = width as i32;
    let h = height as i32;
    if cursor_x < 0 || cursor_y < 0 || cursor_x >= w || cursor_y >= h {
        return None;
    }

    // --- 5th-percentile luminance = darkness floor (inventory background).
    let mut hist = [0u32; 256];
    for i in 0..src_len {
        let idx = i * 4;
        let r = rgba[idx] as u32;
        let g = rgba[idx + 1] as u32;
        let b = rgba[idx + 2] as u32;
        let lum = (r * 299 + g * 587 + b * 114) / 1000;
        hist[lum as usize] += 1;
    }
    let lo_target = src_len as u32 / 20;
    let mut lo: u32 = 0;
    let mut acc: u32 = 0;
    for (v, &count) in hist.iter().enumerate() {
        acc += count;
        if acc >= lo_target {
            lo = v as u32;
            break;
        }
    }

    // --- Patch gate: 21×21 around cursor. Big enough to survive cursor-near-
    // edge positioning inside a tile; small enough to stay within one tile.
    const RADIUS: i32 = 10;
    let x0 = (cursor_x - RADIUS).max(0) as u32;
    let y0 = (cursor_y - RADIUS).max(0) as u32;
    let x1 = (cursor_x + RADIUS).min(w - 1) as u32;
    let y1 = (cursor_y + RADIUS).min(h - 1) as u32;
    let mut sum: u32 = 0;
    let mut count: u32 = 0;
    let mut max_lum: u32 = 0;
    for y in y0..=y1 {
        for x in x0..=x1 {
            let idx = ((y * width + x) * 4) as usize;
            let r = rgba[idx] as u32;
            let g = rgba[idx + 1] as u32;
            let b = rgba[idx + 2] as u32;
            let lum = (r * 299 + g * 587 + b * 114) / 1000;
            sum += lum;
            count += 1;
            if lum > max_lum {
                max_lum = lum;
            }
        }
    }
    if count == 0 {
        return None;
    }
    let patch_mean = sum / count;
    // mean+25 rejects mostly-dark patches with stray bright pixels;
    // max+50 rejects uniformly dim-but-not-pitch-black patches with no
    // actual tile content.
    if patch_mean < lo + 25 || max_lum < lo + 50 {
        return None;
    }

    // --- Ray cast: walk outward until the tile-boundary dark run appears.
    let edge_threshold = lo + 15;
    const MAX_STEPS: i32 = 120;
    const DARK_STREAK_REQ: i32 = 4;
    let ray = |dx: i32, dy: i32| -> i32 {
        let mut x = cursor_x;
        let mut y = cursor_y;
        let mut dark_streak = 0i32;
        let mut last_bright = 0i32;
        for step in 1..=MAX_STEPS {
            let nx = x + dx;
            let ny = y + dy;
            if nx < 0 || ny < 0 || nx >= w || ny >= h {
                return last_bright;
            }
            x = nx;
            y = ny;
            let idx = ((y as u32 * width + x as u32) * 4) as usize;
            let r = rgba[idx] as u32;
            let g = rgba[idx + 1] as u32;
            let b = rgba[idx + 2] as u32;
            let lum = (r * 299 + g * 587 + b * 114) / 1000;
            if lum < edge_threshold {
                dark_streak += 1;
                if dark_streak >= DARK_STREAK_REQ {
                    return last_bright;
                }
            } else {
                dark_streak = 0;
                last_bright = step;
            }
        }
        MAX_STEPS
    };
    let d_left = ray(-1, 0);
    let d_right = ray(1, 0);
    let d_up = ray(0, -1);
    let d_down = ray(0, 1);

    // Reject tight rects — usually means the cursor caught a stray bright
    // speck rather than a real tile.
    let raw_w = (d_left + d_right + 1) as u32;
    let raw_h = (d_up + d_down + 1) as u32;
    if raw_w < 20 || raw_h < 20 {
        return None;
    }

    // Pad by 3px to match reference-icon framing (they include the darker
    // tile border). Clamp to capture bounds.
    const PAD: i32 = 3;
    let rx0 = (cursor_x - d_left - PAD).max(0) as u32;
    let ry0 = (cursor_y - d_up - PAD).max(0) as u32;
    let rx1 = (cursor_x + d_right + PAD).min(w - 1) as u32;
    let ry1 = (cursor_y + d_down + PAD).min(h - 1) as u32;

    Some(TileRect {
        x: rx0,
        y: ry0,
        w: rx1 - rx0 + 1,
        h: ry1 - ry0 + 1,
    })
}

/// Capture a focused region around the cursor biased upward (the shortName
/// label lives at the top of Tarkov inventory tiles), OCR it, and return
/// candidate words sorted by distance from cursor with a strong preference
/// for words ABOVE cursor (the label is at the top of the tile). This
/// disambiguates adjacent tiles — e.g., Hawk vs Eagle gunpowder side by
/// side: both labels get OCR'd, but only Hawk's is directly above cursor.
#[tauri::command]
pub fn scan_at_cursor() -> Result<Vec<String>, String> {
    let region_w: u32 = 220;
    let region_h: u32 = 130;
    let cap = capture_region_around_cursor(region_w, region_h)?;

    let width = cap.width;
    let height = cap.height;
    let rgba = cap.rgba;
    debug_dump_rgba("capture", &rgba, width, height);

    // Tile gate — short-circuits before preprocess+OCR when the cursor
    // isn't on anything tile-shaped. OCR is the expensive step so
    // bailing here is a real perf win on non-hover ticks.
    if detect_highlighted_tile(
        &rgba,
        width,
        height,
        cap.cursor_x_in_capture,
        cap.cursor_y_in_capture,
    )
    .is_none()
    {
        return Ok(vec!["__NO_TILE__".to_string()]);
    }

    const SCALE: u32 = 4;
    let (processed, pw, ph) = preprocess(&rgba, width, height, SCALE);
    debug_dump_rgba("processed", &processed, pw, ph);

    let words = ocr_words_positioned(&processed, pw, ph)
        .map_err(|e| format!("OCR failed: {e}"))?;

    if words.is_empty() {
        return Ok(vec!["__NO_OCR__".to_string()]);
    }

    // Cursor position in the processed (upscaled) coordinate space
    let cursor_px = cap.cursor_x_in_capture as f64 * SCALE as f64;
    let cursor_py = cap.cursor_y_in_capture as f64 * SCALE as f64;

    // Score each word by distance from cursor. Words below the cursor get
    // a large penalty — the shortName label sits ABOVE the cursor when
    // hovering a tile, so anything below is almost certainly a different
    // item or an irrelevant UI element.
    let mut scored: Vec<(f64, PositionedWord)> = words
        .into_iter()
        .map(|w| {
            let dx = (w.cx - cursor_px).abs();
            let dy = w.cy - cursor_py;
            let score = if dy > 0.0 {
                1000.0 + dx + dy
            } else {
                dx + dy.abs() * 0.5
            };
            (score, w)
        })
        .collect();
    scored.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

    let ranked: Vec<PositionedWord> = scored.into_iter().map(|(_, w)| w).collect();

    // Emit candidates in priority order: closest word first (the label for
    // the hovered tile), then each subsequent word, then a joined string of
    // all words above the cursor as a multi-token fallback (helps with
    // names like "AK-74N" that OCR might split into "AK" "74N").
    let above_joined: String = ranked
        .iter()
        .filter(|w| w.cy <= cursor_py)
        .map(|w| w.text.clone())
        .collect::<Vec<_>>()
        .join(" ");

    let mut out: Vec<String> = Vec::with_capacity(ranked.len() + 1);
    for w in &ranked {
        if w.text.len() >= 2 {
            out.push(w.text.clone());
        }
    }
    if !above_joined.is_empty() && above_joined.split_whitespace().count() > 1 {
        out.push(above_joined);
    }
    Ok(out)
}

/// Upscale by `scale`x + luminance contrast stretch. Output is BGRA (ready
/// for SoftwareBitmap). Thresholds are auto-calibrated from the capture's
/// luminance histogram (5th/95th percentile) so the stretch adapts to
/// display brightness, HDR, and in-game gamma.
fn preprocess(rgba: &[u8], width: u32, height: u32, scale: u32) -> (Vec<u8>, u32, u32) {
    let new_w = width * scale;
    let new_h = height * scale;
    let mut out = vec![0u8; (new_w * new_h * 4) as usize];

    let mut hist = [0u32; 256];
    let src_len = (width * height) as usize;
    for i in 0..src_len {
        let idx = i * 4;
        let r = rgba[idx] as u32;
        let g = rgba[idx + 1] as u32;
        let b = rgba[idx + 2] as u32;
        let lum = (r * 299 + g * 587 + b * 114) / 1000;
        hist[lum as usize] += 1;
    }

    let total = src_len as u32;
    let lo_target = total / 20;
    let hi_target = total - total / 20;
    let mut lo: i32 = 0;
    let mut hi: i32 = 255;
    let mut acc: u32 = 0;
    let mut lo_set = false;
    for (v, &count) in hist.iter().enumerate() {
        acc += count;
        if !lo_set && acc >= lo_target {
            lo = v as i32;
            lo_set = true;
        }
        if acc >= hi_target {
            hi = v as i32;
            break;
        }
    }
    if hi - lo < 40 {
        lo = (lo - 20).max(0);
        hi = (hi + 20).min(255);
    }
    let range = (hi - lo).max(1);

    for y in 0..new_h {
        let src_y = y / scale;
        for x in 0..new_w {
            let src_x = x / scale;
            let src_idx = ((src_y * width + src_x) * 4) as usize;
            let r = rgba[src_idx] as i32;
            let g = rgba[src_idx + 1] as i32;
            let b = rgba[src_idx + 2] as i32;
            let lum = (r * 299 + g * 587 + b * 114) / 1000;
            let stretched = if lum <= lo {
                0
            } else if lum >= hi {
                255
            } else {
                ((lum - lo) * 255 / range).clamp(0, 255)
            } as u8;

            let dst_idx = ((y * new_w + x) * 4) as usize;
            out[dst_idx] = stretched;
            out[dst_idx + 1] = stretched;
            out[dst_idx + 2] = stretched;
            out[dst_idx + 3] = 255;
        }
    }
    (out, new_w, new_h)
}

/// Run Windows OCR and return each recognized word with its bounding-rect
/// center (in the processed image's coordinate system).
fn ocr_words_positioned(
    bgra: &[u8],
    width: u32,
    height: u32,
) -> Result<Vec<PositionedWord>, String> {
    if width == 0 || height == 0 || bgra.len() < (width * height * 4) as usize {
        return Ok(Vec::new());
    }

    let bitmap = SoftwareBitmap::CreateCopyFromBuffer(
        &bytes_to_ibuffer(bgra)?,
        BitmapPixelFormat::Bgra8,
        width as i32,
        height as i32,
    )
    .map_err(|e| format!("Failed to create bitmap: {e}"))?;

    let engine = OcrEngine::TryCreateFromUserProfileLanguages()
        .map_err(|e| format!("OCR engine failed: {e}"))?;

    let result = engine
        .RecognizeAsync(&bitmap)
        .map_err(|e| format!("OCR recognize failed: {e}"))?
        .get()
        .map_err(|e| format!("OCR result failed: {e}"))?;

    let mut words = Vec::new();
    let ocr_lines = result.Lines().map_err(|e| format!("Failed to get lines: {e}"))?;
    for line in ocr_lines {
        if let Ok(line_words) = line.Words() {
            for word in line_words {
                if let Ok(text) = word.Text() {
                    let s = text.to_string_lossy().trim().to_string();
                    if s.is_empty() {
                        continue;
                    }
                    if let Ok(rect) = word.BoundingRect() {
                        let cx = rect.X as f64 + rect.Width as f64 / 2.0;
                        let cy = rect.Y as f64 + rect.Height as f64 / 2.0;
                        words.push(PositionedWord { text: s, cx, cy });
                    }
                }
            }
        }
    }

    Ok(words)
}

/// Run Windows OCR and return complete lines (space-joined words). For
/// tooltip verification we don't care about per-word positions — we want
/// to match "Aseptic bandage" against the full-name field of every item
/// in the DB, so whole lines are the right granularity.
fn ocr_lines(bgra: &[u8], width: u32, height: u32) -> Result<Vec<String>, String> {
    if width == 0 || height == 0 || bgra.len() < (width * height * 4) as usize {
        return Ok(Vec::new());
    }

    let bitmap = SoftwareBitmap::CreateCopyFromBuffer(
        &bytes_to_ibuffer(bgra)?,
        BitmapPixelFormat::Bgra8,
        width as i32,
        height as i32,
    )
    .map_err(|e| format!("Failed to create bitmap: {e}"))?;

    let engine = OcrEngine::TryCreateFromUserProfileLanguages()
        .map_err(|e| format!("OCR engine failed: {e}"))?;

    let result = engine
        .RecognizeAsync(&bitmap)
        .map_err(|e| format!("OCR recognize failed: {e}"))?
        .get()
        .map_err(|e| format!("OCR result failed: {e}"))?;

    let mut lines = Vec::new();
    let ocr_lines = result.Lines().map_err(|e| format!("Failed to get lines: {e}"))?;
    for line in ocr_lines {
        if let Ok(text) = line.Text() {
            let s = text.to_string_lossy().trim().to_string();
            if !s.is_empty() {
                lines.push(s);
            }
        }
    }
    Ok(lines)
}

/// Get current cursor position (screen coordinates)
fn get_cursor_pos() -> Result<(u32, u32), String> {
    #[repr(C)]
    struct POINT {
        x: i32,
        y: i32,
    }
    extern "system" {
        fn GetCursorPos(lp_point: *mut POINT) -> i32;
    }
    let mut point = POINT { x: 0, y: 0 };
    let result = unsafe { GetCursorPos(&mut point) };
    if result == 0 {
        return Err("GetCursorPos failed".into());
    }
    Ok((point.x as u32, point.y as u32))
}

/// Convert a byte slice to a Windows IBuffer
fn bytes_to_ibuffer(data: &[u8]) -> Result<windows::Storage::Streams::IBuffer, String> {
    use windows::Storage::Streams::{DataWriter, InMemoryRandomAccessStream};

    let stream = InMemoryRandomAccessStream::new().map_err(|e| format!("Stream error: {e}"))?;
    let writer =
        DataWriter::CreateDataWriter(&stream).map_err(|e| format!("Writer error: {e}"))?;
    writer
        .WriteBytes(data)
        .map_err(|e| format!("WriteBytes error: {e}"))?;
    let buffer = writer
        .DetachBuffer()
        .map_err(|e| format!("DetachBuffer error: {e}"))?;
    Ok(buffer)
}
