import { useCallback, useEffect, useState } from "react";
import { api, getSession, type Profile, pkr, type Session, setSession } from "./api";
import { AccountPanel } from "./components/AccountPanel";
import { EventDetailPanel } from "./components/EventDetailPanel";
import { EventSearch } from "./components/EventSearch";
import { MyTickets } from "./components/MyTickets";
import { TicketLookup } from "./components/TicketLookup";

type Tab = "matches" | "tickets" | "lookup";

export default function App() {
  const [session, updateSession] = useState<Session | null>(getSession());
  const [profile, setProfile] = useState<Profile | null>(null);
  const [tab, setTab] = useState<Tab>("matches");
  const [selectedEventId, setSelectedEventId] = useState<number | null>(null);

  const refreshProfile = useCallback(() => {
    if (!session) return setProfile(null);
    api<Profile>("/me")
      .then(setProfile)
      .catch(() => setProfile(null));
  }, [session]);

  useEffect(refreshProfile, [refreshProfile]);

  function signIn(next: Session | null) {
    setSession(next);
    updateSession(next);
  }

  return (
    <main>
      <header>
        <h1>SeatGrid</h1>
        <nav>
          <button className={tab === "matches" ? "active" : ""} onClick={() => setTab("matches")}>Matches</button>
          <button className={tab === "tickets" ? "active" : ""} onClick={() => setTab("tickets")}>My tickets</button>
          <button className={tab === "lookup" ? "active" : ""} onClick={() => setTab("lookup")}>Find a ticket</button>
        </nav>
        <div className="account">
          {session ? (
            <>
              <span>
                {session.username}
                {profile && ` · ${pkr(profile.balance)} · user shard ${profile.shard}`}
              </span>
              <button className="link" onClick={() => signIn(null)}>Log out</button>
            </>
          ) : (
            <AccountPanel onSignedIn={signIn} />
          )}
        </div>
      </header>

      {tab === "matches" && (
        <div className="layout">
          <EventSearch selectedId={selectedEventId} onSelect={setSelectedEventId} />
          {selectedEventId !== null && (
            <EventDetailPanel eventId={selectedEventId} signedIn={session !== null} onBooked={refreshProfile} />
          )}
        </div>
      )}
      {tab === "tickets" && (session ? <MyTickets /> : <p className="muted">Log in to see your tickets.</p>)}
      {tab === "lookup" && <TicketLookup />}
    </main>
  );
}
