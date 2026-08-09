export const PROFILE_TAB_COUNT_LIMIT = 1024;

export async function measureProfileTabCount(
  queryTabs: () => Promise<readonly unknown[]>
): Promise<number> {
  const tabs = await queryTabs();
  if (tabs.length > PROFILE_TAB_COUNT_LIMIT) {
    throw new Error("BROWSER_PROFILE_TAB_LIMIT_EXCEEDED");
  }
  return tabs.length;
}
