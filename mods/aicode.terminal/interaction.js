/** Quote references for the shell without submitting the current prompt. */
export function fileReferences(paths, shell = "") {
  return paths.map((path) => {
    if (/[\x00-\x1f\x7f]/.test(path)) throw new Error("File paths with control characters cannot be pasted into the terminal.");
    if (/^[\w@%+=:,./\\-]+$/.test(path)) return path;
    if (/(?:^|[\\/])(?:pwsh|powershell)(?:\.exe)?$/i.test(shell)) return `'${path.replace(/'/g, "''")}'`;
    if (/(?:^|[\\/])cmd(?:\.exe)?$/i.test(shell)) return `"${path.replace(/"/g, '""')}"`;
    return `'${path.replace(/'/g, "'\\''")}'`;
  }).join(" ") + " ";
}

/** Keep a pair's total flex weight stable, so resizing leaves other panes alone. */
export function resizePair(leftWeight, rightWeight, leftWidth, rightWidth, delta, minimum = 80) {
  const width = leftWidth + rightWidth;
  if (width <= 0) return [leftWeight, rightWeight];
  const min = Math.min(minimum, width / 2);
  const left = Math.max(min, Math.min(width - min, leftWidth + delta));
  const total = leftWeight + rightWeight;
  return [total * left / width, total * (width - left) / width];
}
