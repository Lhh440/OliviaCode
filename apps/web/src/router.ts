import { useEffect, useState } from 'react';

export type Route = 'chat' | 'workflow' | 'git' | 'settings';

const ROUTES: Route[] = ['chat', 'workflow', 'git', 'settings'];

function parse(hash: string): Route {
  const value = hash.replace(/^#\/?/, '').split('?')[0];
  return (ROUTES.find((r) => r === value) ?? 'chat') as Route;
}

export function navigate(route: Route): void {
  if (window.location.hash === `#/${route}`) return;
  window.location.hash = `#/${route}`;
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parse(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parse(window.location.hash));
    window.addEventListener('hashchange', onChange);
    if (!window.location.hash) window.location.hash = '#/chat';
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
