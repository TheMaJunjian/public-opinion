import { useRef, type ReactNode } from 'react';
import { Routes, useLocation, useNavigationType, type Location, type NavigationType } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import RecentWorkbenchViews from './RecentWorkbenchViews';

function PageRoutes({ location, navigationType, children }: {
  location: Location; navigationType: NavigationType; children: ReactNode;
}) {
  const viewerState = useRef(location.state);
  if (navigationType !== 'POP') viewerState.current = location.state;
  // Native Back clones route state. The retained file must keep its live data identity.
  const route = location.pathname === '/viewer' ? { ...location, state: viewerState.current } : location;
  return <Routes location={route}>{children}</Routes>;
}

/** Keep workbenches and their portals alive while ordinary pages use the same browser history. */
export default function RetainedAppRoutes({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigationType = useNavigationType();
  const { user } = useAuth();
  const viewKey = location.pathname === '/viewer'
    ? `viewer:${location.state?.viewerInstanceKey ?? location.key}`
    : /^\/messages(\/|$)/.test(location.pathname) ? `online:${location.pathname}` : 'page';
  return <>
    <RecentWorkbenchViews viewKey={viewKey} ownerKey={user?.id ?? null} deferParking preserveScroll>
      {viewKey !== 'page' && <PageRoutes location={location} navigationType={navigationType}>{children}</PageRoutes>}
    </RecentWorkbenchViews>
    {viewKey === 'page' && <Routes location={location}>{children}</Routes>}
  </>;
}
