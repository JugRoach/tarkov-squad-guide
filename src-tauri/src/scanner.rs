use screenshots::Screen;
use windows::Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap};
use windows::Media::Ocr::OcrEngine;

#[derive(Clone, Debug)]
struct Word {
    text: String,
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
}

#[derive(Clone, Debug)]
struct Line {
    text: String,
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
    cx: f64,
    cy: f64,
}

/// Capture a region around the cursor, OCR all text, and return candidate
/// item names — the tooltip title if one is detected, otherwise the line
/// closest to the cursor.
#[tauri::command]
pub fn scan_at_cursor() -> Result<Vec<String>, String> {
    let (cx, cy) = get_cursor_pos().map_err(|e| format!("Failed to get cursor pos: {e}"))?;

    // Capture wide enough to include the tooltip, which Tarkov draws to the
    // right (or left if near edge) of the hovered item and can be ~250px wide.
    let region_w: u32 = 400;
    let region_h: u32 = 300;
    let x = (cx as i32 - region_w as i32 / 2).max(0);
    let y = (cy as i32 - region_h as i32 / 2).max(0);

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
        .capture_area(x, y, region_w, region_h)
        .map_err(|e| format!("Screen capture failed: {e}"))?;

    let (width, height) = capture.dimensions();
    let rgba = capture.into_raw();

    let (processed, pw, ph) = preprocess(&rgba, width, height);

    let cursor_local_x = (cx as i32 - x) as f64 * (pw as f64 / width as f64);
    let cursor_local_y = (cy as i32 - y) as f64 * (ph as f64 / height as f64);

    let words = ocr_with_positions(&processed, pw, ph)
        .map_err(|e| format!("OCR failed: {e}"))?;

    let lines = group_into_lines(&words);

    let mut result_lines: Vec<String> = Vec::new();

    // If we can find a tooltip (a stack of ≥3 left-aligned lines), its top
    // line is the item name — much more reliable than cursor proximity.
    if let Some(title) = detect_tooltip_title(&lines) {
        // Trust the tooltip title — do NOT emit individual words. A single
        // token like "Striker" would fuzzy-match "Lucky Strike Cigarettes"
        // and beat the correct multi-token match.
        result_lines.push(title);
        return Ok(result_lines);
    }

    // Fallback: score lines by proximity to cursor, preferring text above
    let mut scored: Vec<(String, f64)> = lines
        .iter()
        .map(|l| {
            let dx = (l.cx - cursor_local_x).abs();
            let dy = l.cy - cursor_local_y;
            let score = if dy < 20.0 {
                dx + dy.abs() * 0.3
            } else {
                dx + dy * 3.0
            };
            (l.text.clone(), score)
        })
        .collect();

    scored.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));

    if let Some((best_line, _)) = scored.first() {
        result_lines.push(best_line.clone());
        for word in best_line.split_whitespace() {
            if word.len() >= 2 {
                result_lines.push(word.to_string());
            }
        }
    }
    if let Some((second_line, score)) = scored.get(1) {
        if *score < 300.0 {
            result_lines.push(second_line.clone());
        }
    }

    Ok(result_lines)
}

/// Group words into text lines by Y position, sorting left-to-right within each.
fn group_into_lines(words: &[Word]) -> Vec<Line> {
    let mut lines: Vec<Line> = Vec::new();
    let mut used = vec![false; words.len()];

    for i in 0..words.len() {
        if used[i] { continue; }
        used[i] = true;
        let mut group: Vec<Word> = vec![words[i].clone()];
        let ref_cy = (words[i].top + words[i].bottom) / 2.0;

        for j in (i + 1)..words.len() {
            if used[j] { continue; }
            let cy_j = (words[j].top + words[j].bottom) / 2.0;
            if (cy_j - ref_cy).abs() < 30.0 {
                used[j] = true;
                group.push(words[j].clone());
            }
        }

        group.sort_by(|a, b| a.left.partial_cmp(&b.left).unwrap_or(std::cmp::Ordering::Equal));

        let text = group.iter().map(|w| w.text.clone()).collect::<Vec<_>>().join(" ");
        let left = group.iter().map(|w| w.left).fold(f64::INFINITY, f64::min);
        let right = group.iter().map(|w| w.right).fold(f64::NEG_INFINITY, f64::max);
        let top = group.iter().map(|w| w.top).fold(f64::INFINITY, f64::min);
        let bottom = group.iter().map(|w| w.bottom).fold(f64::NEG_INFINITY, f64::max);
        lines.push(Line {
            text,
            left,
            top,
            right,
            bottom,
            cx: (left + right) / 2.0,
            cy: (top + bottom) / 2.0,
        });
    }

    lines.sort_by(|a, b| a.top.partial_cmp(&b.top).unwrap_or(std::cmp::Ordering::Equal));
    lines
}

/// Detect the Tarkov tooltip: a vertical stack of ≥2 lines with aligned left
/// edges (the tooltip is left-justified) and reasonable vertical spacing.
/// Returns the TOP line's text (the bolded item name).
///
/// MIN_CHAIN_LEN is 2 so short tooltips (ammo, simple consumables — often
/// just name + 1 stat line) still use the title path instead of falling back
/// to cursor proximity, which is less accurate for multi-slot items.
fn detect_tooltip_title(lines: &[Line]) -> Option<String> {
    if lines.len() < 2 {
        return None;
    }

    // Typical tooltip line height in 2x space is ~30-50px; gap between lines
    // ~5-30px. So line-top-to-line-top spacing is roughly 30-80px.
    const LEFT_TOLERANCE: f64 = 20.0;
    const MIN_GAP: f64 = 15.0;
    const MAX_GAP: f64 = 90.0;
    const MIN_CHAIN_LEN: usize = 2;

    let mut best_chain: Vec<usize> = Vec::new();

    for start in 0..lines.len() {
        let mut chain = vec![start];
        let mut last_idx = start;
        loop {
            let last = &lines[last_idx];
            let mut next: Option<usize> = None;
            for j in (last_idx + 1)..lines.len() {
                let cand = &lines[j];
                let gap = cand.top - last.bottom;
                if gap < -5.0 { continue; } // overlapping / out of order
                if gap > MAX_GAP { break; } // sorted by top, so no later line qualifies
                if gap < MIN_GAP && gap > -5.0 {
                    // Could still be a valid next line, but very tight — accept
                }
                if (cand.left - last.left).abs() <= LEFT_TOLERANCE && gap <= MAX_GAP {
                    next = Some(j);
                    break;
                }
            }
            match next {
                Some(j) => {
                    chain.push(j);
                    last_idx = j;
                }
                None => break,
            }
        }
        if chain.len() > best_chain.len() {
            best_chain = chain;
        }
    }

    if best_chain.len() >= MIN_CHAIN_LEN {
        // Sanity: reject chains of single short tokens (e.g. a vertical column
        // of inventory slot numbers). Tooltip body lines are usually wordy.
        let title_line = &lines[best_chain[0]];
        if title_line.text.trim().len() >= 3 {
            return Some(title_line.text.clone());
        }
    }
    None
}

/// 2x upscale + luminance contrast stretch. Output is BGRA (ready for
/// SoftwareBitmap), since the OCR path expects BGRA anyway.
///
/// Thresholds are auto-calibrated from the capture's histogram (5th/95th
/// percentile) so the stretch adapts to the user's display brightness, HDR,
/// and in-game gamma instead of relying on hardcoded LO/HI values.
fn preprocess(rgba: &[u8], width: u32, height: u32) -> (Vec<u8>, u32, u32) {
    let scale: u32 = 2;
    let new_w = width * scale;
    let new_h = height * scale;
    let mut out = vec![0u8; (new_w * new_h * 4) as usize];

    // Build a luminance histogram of the source pixels.
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

    // Pick LO = 5th percentile, HI = 95th percentile. Clamp to sane defaults
    // if the capture is near-uniform (all-black startup screen, etc.).
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
    // Require a minimum contrast window so a near-uniform capture doesn't
    // collapse to a degenerate lo==hi stretch that divides by zero.
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

/// Run Windows OCR and return each word with its bounding rect.
fn ocr_with_positions(
    bgra: &[u8],
    width: u32,
    height: u32,
) -> Result<Vec<Word>, String> {
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
                    let s = text.to_string_lossy();
                    if s.trim().is_empty() {
                        continue;
                    }
                    if let Ok(rect) = word.BoundingRect() {
                        let left = rect.X as f64;
                        let top = rect.Y as f64;
                        words.push(Word {
                            text: s.trim().to_string(),
                            left,
                            top,
                            right: left + rect.Width as f64,
                            bottom: top + rect.Height as f64,
                        });
                    }
                }
            }
        }
    }

    Ok(words)
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
