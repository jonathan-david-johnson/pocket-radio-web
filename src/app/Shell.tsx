import { useMemo, useState } from "react";
import { Navigate, NavLink, Route, Routes, useParams } from "react-router";
import { api, post } from "../experiment-api";
import { renderLayout, type DestinationId } from "../nav/render";
import { isPlaylistAvailable, labelFor, MORE_PATH, pathFor, TAB_CAPACITY, type PlaylistNames } from "./destinations";
import { useLayout } from "./useLayout";
import { useNarrow } from "./useNarrow";

interface ShellProps {
  email: string;
  /** Playlist names by UUID once loaded, or `null` until then. */
  playlists: PlaylistNames;
  onSignedOut: () => void;
}

export default function Shell({ email, playlists, onSignedOut }: ShellProps) {
  const layout = useLayout();
  const narrow = useNarrow();
  const plan = useMemo(
    () => (layout.slots ? renderLayout(layout.slots, TAB_CAPACITY, uuid => isPlaylistAvailable(playlists, uuid)) : null),
    [layout.slots, playlists],
  );
  const label = (id: DestinationId) => labelFor(id, playlists);
  const first = plan?.sidebar[0];

  return (
    <div className={narrow ? "shell shell-narrow" : "shell"}>
      {!narrow && plan && <Sidebar plan={plan} label={label} />}
      <div className="shell-main">
        <AccountMenu email={email} onSignedOut={onSignedOut} />
        {layout.failed && <p role="status">Couldn't refresh your Layout. Showing the last one.</p>}
        {!plan && <p role="status">{layout.failed ? "Couldn't load your Layout." : "Loading your Layout…"}</p>}
        <Routes>
          <Route path="/" element={first ? <Navigate to={pathFor(first)} replace /> : null} />
          <Route path="/podcasts" element={<Placeholder title="Podcasts" />} />
          <Route path="/playlists" element={<Placeholder title="Playlists" />} />
          <Route path="/discover" element={<Placeholder title="Discover" />} />
          <Route path="/streams" element={<Placeholder title="Streams" />} />
          <Route path="/profile" element={<Placeholder title="Profile" />} />
          <Route path="/up-next" element={<Placeholder title="Up Next" />} />
          <Route path="/playlist/:uuid" element={<PlaylistScreen playlists={playlists} />} />
          <Route path={MORE_PATH} element={!plan ? null : narrow ? <More more={plan.more} label={label} /> : <Navigate to="/" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
      {narrow && plan && <TabBar plan={plan} label={label} />}
    </div>
  );
}

type Plan = NonNullable<ReturnType<typeof renderLayout>>;

function Sidebar({ plan, label }: { plan: Plan; label: (id: DestinationId) => string }) {
  return (
    <nav aria-label="Destinations" className="sidebar">
      <ul>
        {plan.sidebar.map((id, index) => (
          <li key={`${index}:${id}`} className="sidebar-row">
            {index === plan.barLineAfter && <hr role="separator" className="bar-line" />}
            <NavLink to={pathFor(id)}>{label(id)}</NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function TabBar({ plan, label }: { plan: Plan; label: (id: DestinationId) => string }) {
  return (
    <nav aria-label="Tabs" className="tabbar">
      <ul>
        {plan.bar.map((id, index) => (
          <li key={`${index}:${id}`}><NavLink to={pathFor(id)}>{label(id)}</NavLink></li>
        ))}
        {plan.more.length > 0 && <li><NavLink to={MORE_PATH}>More</NavLink></li>}
      </ul>
    </nav>
  );
}

function More({ more, label }: { more: DestinationId[]; label: (id: DestinationId) => string }) {
  return (
    <section aria-label="More">
      <h1>More</h1>
      <ul>
        {more.map((id, index) => (
          <li key={`${index}:${id}`}><NavLink to={pathFor(id)}>{label(id)}</NavLink></li>
        ))}
      </ul>
    </section>
  );
}

function Placeholder({ title }: { title: string }) {
  return (
    <section>
      <h1>{title}</h1>
      <p>This screen arrives in a later milestone.</p>
    </section>
  );
}

function PlaylistScreen({ playlists }: { playlists: PlaylistNames }) {
  const { uuid = "" } = useParams();
  if (playlists !== null && !playlists.has(uuid)) {
    return <section><h1>Playlist</h1><p>This playlist isn't available</p></section>;
  }
  const title = playlists?.get(uuid) ?? "Playlist";
  return <Placeholder title={title} />;
}

function AccountMenu({ email, onSignedOut }: { email: string; onSignedOut: () => void }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  async function signOut(everywhere: boolean) {
    if (busy) return;
    setBusy(true); setProblem("");
    try {
      await api(everywhere ? "/api/signout/everywhere" : "/api/signout", post());
      onSignedOut();
    } catch { setProblem("Couldn't sign out. Try again."); setBusy(false); }
  }
  return (
    <section aria-label="Account" className="account">
      <span>{email}</span>
      <button disabled={busy} onClick={() => void signOut(false)}>Sign out</button>
      <button disabled={busy} onClick={() => void signOut(true)}>Sign out everywhere</button>
      {problem && <span role="alert">{problem}</span>}
    </section>
  );
}
