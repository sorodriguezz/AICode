// A split tree keeps rows and columns independent. Leaves own existing terminal sessions.
const directions = { left: ["row", true], right: ["row", false], above: ["column", true], below: ["column", false] };

export function layoutTerms(node) {
  if (!node) return [];
  return node.term ? [node.term] : [...layoutTerms(node.first), ...layoutTerms(node.second)];
}

export function insertPane(node, target, term, direction = "right") {
  const placement = directions[direction];
  if (!placement) throw new Error(`Unknown terminal split direction: ${direction}`);
  const leaf = { term };
  if (!node) return leaf;
  if (!target || node.term === target) {
    const [axis, before] = placement;
    return { axis, ratio: 0.5, first: before ? leaf : node, second: before ? node : leaf };
  }
  if (node.term) return node;
  // Reuse untouched branches, including their resize ratios.
  const first = insertPane(node.first, target, term, direction);
  const second = insertPane(node.second, target, term, direction);
  return first === node.first && second === node.second ? node : { ...node, first, second };
}

export function removePane(node, term) {
  if (!node || node.term === term) return null;
  if (node.term) return node;
  const first = removePane(node.first, term);
  const second = removePane(node.second, term);
  if (!first) return second;
  if (!second) return first;
  return first === node.first && second === node.second ? node : { ...node, first, second };
}

function line(terms, axis) {
  if (!terms.length) return null;
  if (terms.length === 1) return { term: terms[0] };
  const middle = Math.ceil(terms.length / 2);
  return { axis, ratio: middle / terms.length, first: line(terms.slice(0, middle), axis), second: line(terms.slice(middle), axis) };
}

export function arrangeLayout(terms, preset) {
  if (terms.length < 2) return line(terms, "row");
  if (preset === "columns") return line(terms, "row");
  if (preset === "rows") return line(terms, "column");
  if (preset === "grid") {
    const middle = Math.ceil(terms.length / 2);
    return { axis: "column", ratio: 0.5, first: line(terms.slice(0, middle), "row"), second: line(terms.slice(middle), "row") };
  }
  if (preset === "bottom" || preset === "right") {
    return { axis: preset === "bottom" ? "column" : "row", ratio: 0.5,
      first: line(terms.slice(0, -1), preset === "bottom" ? "row" : "column"), second: { term: terms.at(-1) } };
  }
  throw new Error(`Unknown terminal layout: ${preset}`);
}
