import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { api, pairingResponse, post, record, relayResponse, retrySeconds, sessionResponse,
  type Pairing, type Relay, type Session } from "./experiment-api";

const message = (error: unknown) => error instanceof Error ? error.message : "Experiment unavailable";
const PROBES = ["user/podcast/list", "user/podcast/episodes", "user/playlist/list", "user/named_settings", "up_next/sync", "sync/update_episode"];

export default function App() {
  const [session, setSession] = useState<Session>({ signedIn: false });
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [qr, setQr] = useState("");
  const [status, setStatus] = useState("Checking session…");
  // Serialize cookie-renewing restoration before any new auth transition.
  const [busy, setBusy] = useState(true);
  const [stationId, setStationId] = useState("");
  const [relay, setRelay] = useState<Relay | null>(null);
  const [title, setTitle] = useState("");
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
    setTitle("");
    if (!relay) return;
    const player = audio.current;
    let active = true;
    const events = new EventSource(relay.eventsUrl);
    events.addEventListener("reset", () => { if (active) setTitle(""); });
    events.addEventListener("title", event => {
      if (!active) return;
      try {
        const data = record(JSON.parse((event as MessageEvent<string>).data));
        if (typeof data.title === "string") setTitle(data.title);
      } catch { setTitle(""); }
    });
    events.addEventListener("stopped", () => { if (active) { events.close(); setRelay(null); setTitle(""); } });
    events.onerror = () => {
      if (!active) return;
      events.close(); setTitle(""); setRelay(null);
      setStatus("Relay events ended. Start a new relay; do not reuse the old audio URL.");
    };
    return () => {
      active = false;
      events.close();
      if (player) { player.pause(); player.removeAttribute("src"); player.load(); }
      void api(`/api/relay/${relay.relayId}/stop`, { ...post(), keepalive: true }).catch(() => {});
    };
  }, [relay]);

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
    ++generation.current; setPairing(null); setRelay(null); setTitle(""); setBusy(true);
    try {
      await api(everywhere ? "/api/signout/everywhere" : "/api/signout", post());
      setSession({ signedIn: false }); setProbe(""); setStatus(everywhere ? "All web sessions signed out." : "Signed out.");
    } catch (error) { setStatus(message(error)); }
    finally { setBusy(false); }
  }
  async function startRelay() {
    if (busy) return;
    setBusy(true); setRelay(null);
    try {
      const result = await api("/api/relay/start", post({ stationId: stationId.trim() }));
      setRelay(relayResponse(result.data));
      setStatus("Press Play within 30 seconds. Titles are receipt-time observations, not measured audio alignment.");
    } catch (error) { setStatus(message(error)); }
    finally { setBusy(false); }
  }
  async function runProbe() {
    if (busy) return;
    setBusy(true); setProbe("");
    try {
      const params = new URLSearchParams({ endpoint });
      if (endpoint === "user/podcast/episodes") params.set("podcastUuid", podcastUuid.trim());
      const result = await api(`/api/probes?${params}`);
      setProbe(JSON.stringify(result.data, null, 2));
    } catch (error) { setStatus(message(error)); }
    finally { setBusy(false); }
  }

  return (
    <main>
      <h1>PocketRadio Web</h1>
      <p>M1 feasibility page — not the finished player.</p>
      <aside>Local tests are not live approval, deployment, or playback evidence. Production audio needs Cloudflare terms and station-rights clearance. This spike permits only two SomaFM hosts, not arbitrary Browse results.</aside>
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
      <section aria-labelledby="relay-heading">
        <h2 id="relay-heading">Stream relay</h2>
        <label>Radio-browser station UUID<input value={stationId} onChange={event => setStationId(event.target.value)} placeholder="Station ID, never a URL" /></label>
        <p>Choose an HTTP or HTTPS MP3 station on <code>ice1.somafm.com</code> or <code>ice2.somafm.com</code>. A public station URL does not establish relay permission.</p>
        <button disabled={busy || !session.signedIn || !stationId.trim()} onClick={() => void startRelay()}>Start relay experiment</button>
        {relay && <div>
          <audio ref={audio} src={relay.audioUrl} controls preload="none" onError={() => { setRelay(null); setStatus("Audio failed. Start a new relay."); }} />
          <button onClick={() => setRelay(null)}>Stop relay</button>
        </div>}
        <p aria-live="polite">Track title: {title || "No current title"}</p>
      </section>
      <section aria-labelledby="probes-heading">
        <h2 id="probes-heading">Pocket Casts JSON probes</h2>
        <label>Endpoint<select value={endpoint} onChange={event => setEndpoint(event.target.value)}>{PROBES.map(path => <option key={path}>{path}</option>)}</select></label>
        {endpoint === "user/podcast/episodes" && <label>Podcast UUID<input value={podcastUuid} onChange={event => setPodcastUuid(event.target.value)} /></label>}
        <button disabled={busy || !session.signedIn} onClick={() => void runProbe()}>Run selected probe</button>
        <p>Write-capable endpoints remain manual and pending. Results show format/status only, not private upstream data. Server probes are limited to one per 30 seconds.</p>
        {probe && <pre>{probe}</pre>}
      </section>
    </main>
  );
}
