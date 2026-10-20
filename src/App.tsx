import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { api, pairingResponse, playbackResponse, post, record, retrySeconds, sessionResponse,
  type Pairing, type Playback, type Session } from "./experiment-api";

const message = (error: unknown) => error instanceof Error ? error.message : "Experiment unavailable";
const PROBES = ["user/podcast/list", "user/podcast/episodes", "user/playlist/list", "user/named_settings", "up_next/sync", "sync/update_episode"];

export default function App({ onSessionChange }: { onSessionChange?: (session: Session) => void } = {}) {
  const [session, setSessionState] = useState<Session>({ signedIn: false });
  const setSession = (next: Session) => { setSessionState(next); onSessionChange?.(next); };
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [qr, setQr] = useState("");
  const [status, setStatus] = useState("Checking session…");
  // Serialize cookie-renewing restoration before any new auth transition.
  const [busy, setBusy] = useState(true);
  const [stationId, setStationId] = useState("");
  const [playback, setPlayback] = useState<Playback | null>(null);
  const [playerStatus, setPlayerStatus] = useState("Choose a station with an HTTPS stream.");
  const [endpoint, setEndpoint] = useState(PROBES[0]!);
  const [podcastUuid, setPodcastUuid] = useState("");
  const [probe, setProbe] = useState("");
  const generation = useRef(0);
  const audio = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const abort = new AbortController();
    const epoch = generation.current;
    void api("/api/session", { signal: abort.signal }).then(({ data }) => {
      if (abort.signal.aborted || epoch !== generation.current) return;
      const result = sessionResponse(data);
      setSession(result);
      setStatus(result.signedIn ? "Session restored." : "Ready to pair.");
    }).catch(error => { if (!abort.signal.aborted && epoch === generation.current) setStatus(message(error)); })
      .finally(() => { if (!abort.signal.aborted && epoch === generation.current) setBusy(false); });
    return () => abort.abort();
  }, []);

  useEffect(() => {
    setQr("");
    if (!pairing) return;
    let active = true;
    void QRCode.toDataURL(pairing.pairingUri, { width: 240, margin: 4, errorCorrectionLevel: "M" })
      .then(url => { if (active) setQr(url); })
      .catch(() => { if (active) setStatus("QR generation failed. The approval code is still available."); });
    return () => { active = false; };
  }, [pairing]);

  useEffect(() => {
    if (!pairing) return;
    const abort = new AbortController();
    const epoch = generation.current;
    const deadline = Date.now() + pairing.expiresIn * 1000;
    let timer: ReturnType<typeof setTimeout>;
    const current = () => !abort.signal.aborted && epoch === generation.current;
    const poll = async () => {
      if (!current()) return;
      if (Date.now() >= deadline) { setPairing(null); setStatus("Pairing expired. Start again."); return; }
      try {
        const result = await api("/api/pair/poll", { signal: abort.signal });
        if (!current()) return;
        const data = record(result.data);
        if (data.status === "pending") {
          timer = setTimeout(() => void poll(), retrySeconds(result.retryAfter, pairing.interval) * 1000);
        } else if (data.status === "approved") {
          setBusy(true);
          const account = await api("/api/session", { signal: abort.signal });
          if (!current()) return;
          setSession(sessionResponse(account.data)); setPairing(null); setBusy(false); setStatus("Pairing approved.");
        } else { setPairing(null); setStatus("Pairing ended or failed. Start again; JSON support is still an experiment."); }
      } catch (error) { if (current()) { setPairing(null); setBusy(false); setStatus(message(error)); } }
    };
    timer = setTimeout(() => void poll(), pairing.interval * 1000);
    return () => { abort.abort(); clearTimeout(timer); };
  }, [pairing]);

  useEffect(() => {
    const player = audio.current;
    return () => {
      if (player) { player.pause(); player.removeAttribute("src"); player.load(); }
    };
  }, [playback]);

  async function startPairing() {
    if (busy) return;
    const epoch = ++generation.current;
    setBusy(true); setPairing(null); setStatus("Requesting approval code…");
    try {
      const result = await api("/api/pair/start", post());
      if (epoch !== generation.current) return;
      setPairing(pairingResponse(result.data)); setStatus("Scan with the iPhone camera and approve in PocketRadio.");
    } catch (error) { if (epoch === generation.current) setStatus(message(error)); }
    finally { if (epoch === generation.current) setBusy(false); }
  }
  async function signout(everywhere: boolean) {
    if (busy) return;
    ++generation.current; setPairing(null); setPlayback(null); setPlayerStatus("Playback stopped."); setBusy(true);
    try {
      await api(everywhere ? "/api/signout/everywhere" : "/api/signout", post());
      setSession({ signedIn: false }); setProbe(""); setStatus(everywhere ? "All web sessions signed out." : "Signed out.");
    } catch (error) { setStatus(message(error)); }
    finally { setBusy(false); }
  }
  async function loadStation() {
    if (busy || !session.signedIn) return;
    const epoch = ++generation.current;
    const id = stationId.trim().toLowerCase();
    setBusy(true); setPlayback(null); setPlayerStatus("Looking up HTTPS station…");
    try {
      const result = await api(`/api/playback?${new URLSearchParams({ stationId: id })}`);
      if (epoch !== generation.current) return;
      setPlayback(playbackResponse(result.data, id, window.location.origin));
      setPlayerStatus("HTTPS stream ready. Press Play to connect directly to the station.");
    } catch (error) { if (epoch === generation.current) setPlayerStatus(message(error)); }
    finally { if (epoch === generation.current) setBusy(false); }
  }
  async function runProbe() {
    if (busy) return;
    setBusy(true); setProbe(`Running ${endpoint}…`);
    try {
      const params = new URLSearchParams({ endpoint });
      if (endpoint === "user/podcast/episodes") params.set("podcastUuid", podcastUuid.trim());
      const result = await api(`/api/probes?${params}`);
      setProbe(JSON.stringify(result.data, null, 2));
    } catch (error) {
      setProbe(message(error)); setStatus(message(error));
    }
    finally { setBusy(false); }
  }

  return (
    <main>
      <h1>PocketRadio Web</h1>
      <p>M1 feasibility page — not the finished player.</p>
      <aside>Direct HTTPS playback: audio goes from the station to your browser, not through our server. HTTP-only streams and ICY track titles are unavailable. Local tests do not prove live browser playback, deployment or permission to use a station. Installable app support is planned for M3.</aside>
      <p role="status" aria-live="polite">{status}</p>
      <section aria-labelledby="pairing-heading">
        <h2 id="pairing-heading">Pairing and session</h2>
        {session.signedIn ? <p>Signed in as {session.email}</p> : <button disabled={busy} onClick={() => void startPairing()}>Start Pairing</button>}
        {pairing && <div>
          {qr && <img src={qr} width="240" height="240" alt="Pairing QR code for the PocketRadio iPhone app" />}
          <p>Approval code: <strong>{pairing.userCode}</strong></p>
          <p><a href={pairing.pairingUri}>Open approval on this phone</a>. If scanning fails, enter the code in the phone’s approval screen.</p>
        </div>}
        <div className="actions">
          <button disabled={busy} onClick={() => void signout(false)}>Sign out / cancel Pairing</button>
          <button disabled={busy || !session.signedIn} onClick={() => void signout(true)}>Sign out everywhere</button>
        </div>
      </section>
      <section aria-labelledby="playback-heading">
        <h2 id="playback-heading">Direct playback</h2>
        <label>Radio-browser station UUID<input value={stationId} onChange={event => setStationId(event.target.value)} placeholder="Station ID, never a URL" /></label>
        <p>Choose a permitted HTTPS station. Your browser connects to its public stream and reveals your IP to the station. We do not upgrade HTTP URLs or use an audio fallback relay.</p>
        <button disabled={busy || !session.signedIn || !stationId.trim()} onClick={() => void loadStation()}>Load HTTPS station</button>
        <p role="status" aria-live="polite">{playerStatus}</p>
        {playback && <div>
          <audio key={playback.stationId + playback.streamUrl} ref={audio} src={playback.streamUrl} controls preload="none"
            onPlay={event => { if (event.currentTarget === audio.current) setPlayerStatus("Playing directly from the station."); }}
            onError={event => {
              if (event.currentTarget !== audio.current) return;
              setPlayback(null); setPlayerStatus("The browser could not play this stream. It may be offline, redirect to HTTP, or use an unsupported format. No relay fallback was attempted.");
            }} />
          <button disabled={busy} onClick={() => { setPlayback(null); setPlayerStatus("Playback stopped."); }}>Stop playback</button>
        </div>}
        <p>Track titles are unavailable in direct playback. No station metadata feed or lyrics source is connected.</p>
      </section>
      <section aria-labelledby="probes-heading">
        <h2 id="probes-heading">Pocket Casts JSON probes</h2>
        <label>Endpoint<select value={endpoint} onChange={event => setEndpoint(event.target.value)}>{PROBES.map(path => <option key={path}>{path}</option>)}</select></label>
        {endpoint === "user/podcast/episodes" && <label>Podcast UUID<input value={podcastUuid} onChange={event => setPodcastUuid(event.target.value)} /></label>}
        <button disabled={busy || !session.signedIn} onClick={() => void runProbe()}>Run selected probe</button>
        {!session.signedIn && <p>Pair first to enable probes.</p>}
        <p>Choose an endpoint, then click Run selected probe. Results show format/status only, not your podcast or playlist contents. Server probes are limited to one per 30 seconds. Write-capable endpoints remain manual and pending.</p>
        <pre role="status" aria-live="polite">{probe || "No probe run yet."}</pre>
      </section>
    </main>
  );
}
