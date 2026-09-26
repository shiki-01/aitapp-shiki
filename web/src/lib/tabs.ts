export type Tab = 'home' | 'notices' | 'calendar' | 'assignments' | 'more';

export const TAB_PATH: Record<Tab, string> = {
  home: '/',
  notices: '/notices',
  calendar: '/calendar',
  assignments: '/assignments',
  more: '/more',
};

export function pathToTab(pathname: string): Tab | undefined {
  const normalized = pathname.endsWith('/') && pathname.length > 1 ? pathname.slice(0, -1) : pathname;
  const entry = Object.entries(TAB_PATH).find(([, path]) => path === normalized);
  return entry ? (entry[0] as Tab) : undefined;
}

/** ナビの並び順（ページ切替の左右スライドの方向に使う）。BottomNav / SideNav の ITEMS と揃えること。 */
export const MOBILE_TAB_ORDER: Tab[] = ['notices', 'calendar', 'home', 'assignments', 'more'];
export const DESKTOP_TAB_ORDER: Tab[] = ['home', 'notices', 'calendar', 'assignments', 'more'];
