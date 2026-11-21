/** Word-level diff of two message bodies (LCS), for the template version history. Pure. */
export type DiffSegment = { id: number; kind: "same" | "add" | "del"; text: string };

const tokens = (s: string) => s.split(/(\s+)/).filter((t) => t.length > 0);

export function diffText(before: string, after: string): DiffSegment[] {
  const a = tokens(before);
  const b = tokens(after);
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = length of the LCS of a[i..] and b[j..]
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  const at = (i: number, j: number) => (lcs[i] as number[])[j] as number;
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      (lcs[i] as number[])[j] =
        a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
  const out: DiffSegment[] = [];
  const push = (kind: DiffSegment["kind"], text: string) => {
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += text;
    else out.push({ id: out.length, kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push("same", a[i] as string);
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      push("del", a[i++] as string);
    } else {
      push("add", b[j++] as string);
    }
  }
  while (i < n) push("del", a[i++] as string);
  while (j < m) push("add", b[j++] as string);
  return out;
}
