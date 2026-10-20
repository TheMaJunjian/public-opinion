export const LEADERBOARD_PREFERENCES_KEY = 'gonglun:leaderboard-preferences:v1';

export interface LeaderboardWindowSize {
  width: number;
  height: number;
}

export interface LeaderboardPreferences {
  pageSize: number;
  windowSize: LeaderboardWindowSize | null;
  columnWidths: { user: Record<string, number>; message: Record<string, number> };
}

function readWidths(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] =>
    typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] >= 48 && entry[1] <= 1200));
}

export function readLeaderboardPreferences(): LeaderboardPreferences {
  const defaults: LeaderboardPreferences = { pageSize: 20, windowSize: null, columnWidths: { user: {}, message: {} } };
  try {
    const saved = JSON.parse(localStorage.getItem(LEADERBOARD_PREFERENCES_KEY) ?? 'null');
    if (!saved || typeof saved !== 'object') return defaults;
    const size = saved.windowSize;
    const userWidths = readWidths(saved.columnWidths?.user);
    const messageWidths = readWidths(saved.columnWidths?.message);
    if (userWidths['与会者'] === undefined && userWidths['与会者名'] !== undefined) userWidths['与会者'] = userWidths['与会者名'];
    if (messageWidths['议事人'] === undefined && messageWidths['议事人名'] !== undefined) messageWidths['议事人'] = messageWidths['议事人名'];
    delete userWidths['与会者名'];
    delete messageWidths['议事人名'];
    return {
      pageSize: [20, 50, 100].includes(saved.pageSize) ? saved.pageSize : 20,
      windowSize: size && typeof size.width === 'number' && typeof size.height === 'number'
        && Number.isFinite(size.width) && Number.isFinite(size.height)
        && size.width >= 480 && size.width <= 20000 && size.height >= 240 && size.height <= 20000
        ? { width: size.width, height: size.height } : null,
      columnWidths: { user: userWidths, message: messageWidths },
    };
  } catch {
    return defaults;
  }
}

export function saveLeaderboardPreferences(preferences: LeaderboardPreferences): void {
  try {
    localStorage.setItem(LEADERBOARD_PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    // Keep the window usable when browser storage is unavailable or full.
  }
}
