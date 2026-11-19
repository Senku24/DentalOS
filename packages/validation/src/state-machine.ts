/**
 * Tiny, pure state-machine helpers shared by the M2 transition tables (appointments, plan items,
 * plans). Tables map each state to the states it may move to; a state with no exits is terminal.
 * A same-state "move" is never a transition (callers treat it as a no-op or 409, not a write).
 */
export type TransitionTable<S extends string> = Readonly<Record<S, readonly S[]>>;

export function canTransition<S extends string>(
  table: TransitionTable<S>,
  from: S,
  to: S,
): boolean {
  return from !== to && (table[from] ?? []).includes(to);
}

export function allowedTransitions<S extends string>(
  table: TransitionTable<S>,
  from: S,
): readonly S[] {
  return table[from] ?? [];
}

export function isTerminalState<S extends string>(table: TransitionTable<S>, s: S): boolean {
  return allowedTransitions(table, s).length === 0;
}
