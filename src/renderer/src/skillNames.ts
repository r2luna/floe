import { createContext } from "react";

/**
 * The skills the chat's worktree knows, for drawing `/deploy` as a pill.
 *
 * A context rather than a prop threaded through Log/Entry, for the reason
 * RunInTerminal is one: Log is memoised on its items, and a prop that changes
 * identity would defeat that. Empty anywhere but a chat panel, and then a
 * message is drawn exactly as it was typed.
 */
export const SkillNames = createContext<ReadonlySet<string>>(new Set());
