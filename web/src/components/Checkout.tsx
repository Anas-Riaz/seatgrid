import { useEffect, useState } from "react";
import { api, type Booking, errorMessage, type Hold, pkr } from "../api";

/**
 * Pay for a hold. The idempotency key is created once per hold, so clicking
 * "Pay" twice (or a network retry) can never book or charge twice.
 */
export function Checkout({ hold, onDone }: { hold: Hold; onDone: () => void }) {
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [secondsLeft, setSecondsLeft] = useState(() => secondsUntil(hold.expiresAt));
  const [booking, setBooking] = useState<Booking | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const timer = setInterval(() => setSecondsLeft(secondsUntil(hold.expiresAt)), 1000);
    return () => clearInterval(timer);
  }, [hold.expiresAt]);

  async function pay() {
    setBusy(true);
    setError("");
    try {
      setBooking(
        await api<Booking>("/bookings", {
          method: "POST",
          body: { eventId: hold.eventId, sectionId: hold.sectionId, holdId: hold.holdId, idempotencyKey },
        }),
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function release() {
    await api(`/holds/${hold.holdId}?eventId=${hold.eventId}&sectionId=${hold.sectionId}`, { method: "DELETE" }).catch(
      () => {},
    );
    onDone();
  }

  if (booking) {
    return (
      <div className="checkout success">
        <h3>Booked! Total {pkr(booking.total)}</h3>
        <ul>
          {booking.tickets.map((t) => (
            <li key={t.ticketNo}>
              <code>{t.ticketNo}</code> · seat {t.seatNo} · {pkr(t.price)}
            </li>
          ))}
        </ul>
        <button onClick={onDone}>Done</button>
      </div>
    );
  }

  return (
    <div className="checkout">
      <h3>
        Seats {hold.seats.map((s) => s.seatNo).join(", ")} held for {Math.floor(secondsLeft / 60)}:
        {String(secondsLeft % 60).padStart(2, "0")}
      </h3>
      <p>Total {pkr(hold.total)}, paid from your wallet.</p>
      {error && <p className="error">{error}</p>}
      <div className="controls">
        <button disabled={busy || secondsLeft === 0} onClick={pay}>
          {busy ? "Paying…" : "Pay & confirm"}
        </button>
        <button className="link" onClick={release}>
          Release seats
        </button>
      </div>
    </div>
  );
}

const secondsUntil = (iso: string) => Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 1000));
