import { useEffect, useState } from "react";
import { Route, Routes } from "react-router";
import App from "./App";
import Shell from "./app/Shell";
import { api, sessionResponse, type Session } from "./experiment-api";

/**
 * Signed out: the Pairing page. Signed in: the app shell. `/experiments` keeps the M1
 * page (probes, direct playback test) reachable while those screens are built.
 */
export default function AppRoot() {
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    void api("/api/session", { signal: abort.signal })
      .then(({ data }) => { if (!abort.signal.aborted) setSession(sessionResponse(data)); })
      .catch(() => { if (!abort.signal.aborted) setSession({ signedIn: false }); });
    return () => abort.abort();
  }, []);

  if (session === null) return <p role="status">Checking session…</p>;
  if (!session.signedIn) return <App onSessionChange={setSession} />;
  return (
    <Routes>
      <Route path="/experiments" element={<App onSessionChange={setSession} />} />
      <Route
        path="*"
        element={<Shell email={session.email} onSignedOut={() => setSession({ signedIn: false })} />}
      />
    </Routes>
  );
}
