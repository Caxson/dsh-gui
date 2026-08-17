'use strict';

/*
 * Line-level diff for the files pane — real LCS diff with hunk folding,
 * sized for agent edit fragments (str_replace old/new pairs), not whole files.
 * Exposes window.dshDiff.compute(oldText, newText) → row list or null when
 * the input is too large to diff comfortably in the render thread.
 */
(function () {
  // Above this we skip the O(n·m) LCS and let the caller fall back.
  const MAX_LINES = 400;
  // Context runs longer than this fold into a "⋯ N 行" separator row.
  const CONTEXT = 2;

  function splitLines(text) {
    const lines = (text ?? '').split('\n');
    // A trailing newline produces a phantom empty last line — drop it.
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    return lines;
  }

  /** Classic DP LCS producing edit ops: {kind: 'ctx'|'add'|'rem', text}. */
  function lcsOps(oldLines, newLines) {
    const n = oldLines.length;
    const m = newLines.length;
    // dp[i][j] = LCS length of oldLines[i..] vs newLines[j..]
    const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] =
          oldLines[i] === newLines[j]
            ? dp[i + 1][j + 1] + 1
            : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const ops = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (oldLines[i] === newLines[j]) {
        ops.push({ kind: 'ctx', text: oldLines[i] });
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        ops.push({ kind: 'rem', text: oldLines[i] });
        i++;
      } else {
        ops.push({ kind: 'add', text: newLines[j] });
        j++;
      }
    }
    while (i < n) ops.push({ kind: 'rem', text: oldLines[i++] });
    while (j < m) ops.push({ kind: 'add', text: newLines[j++] });
    return ops;
  }

  /** Fold long unchanged runs into {kind: 'skip', count} rows. */
  function foldContext(ops) {
    const rows = [];
    let run = [];
    const flushRun = (isEdge) => {
      if (run.length === 0) return;
      const keepHead = isEdge === 'start' ? 0 : CONTEXT;
      const keepTail = isEdge === 'end' ? 0 : CONTEXT;
      if (run.length > keepHead + keepTail + 1) {
        rows.push(...run.slice(0, keepHead));
        const folded = run.slice(keepHead, run.length - keepTail);
        // Carry the folded lines with the separator rather than discarding
        // them: the reader can then open the gap in place instead of being
        // told what they are missing and having no way to see it. Bounded by
        // MAX_LINES upstream, so this cannot grow without limit.
        rows.push({ kind: 'skip', count: folded.length, lines: folded });
        rows.push(...run.slice(run.length - keepTail));
      } else {
        rows.push(...run);
      }
      run = [];
    };
    let seenChange = false;
    for (const op of ops) {
      if (op.kind === 'ctx') {
        run.push(op);
      } else {
        flushRun(seenChange ? 'middle' : 'start');
        seenChange = true;
        rows.push(op);
      }
    }
    flushRun('end');
    return rows;
  }

  function compute(oldText, newText) {
    const oldLines = splitLines(oldText);
    const newLines = splitLines(newText);
    if (oldLines.length > MAX_LINES || newLines.length > MAX_LINES) return null;
    const ops = lcsOps(oldLines, newLines);
    const rows = foldContext(ops);
    const adds = ops.filter((o) => o.kind === 'add').length;
    const dels = ops.filter((o) => o.kind === 'rem').length;
    return { rows, adds, dels };
  }

  window.dshDiff = { compute, splitLines };
})();
